/**
 * Attachment upload/download routes for image attachments in chat sessions.
 *
 * Two storage modes:
 * - S3: Returns presigned PUT/GET URLs. Server never touches file bytes.
 * - Local: Server accepts/serves encrypted blobs directly.
 *
 * Every upload location is backed by a short-lived database reservation.
 * Reservations and retained blobs count against account and session quotas.
 */
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { Fastify } from '../types';
import {
    deleteAttachmentObjects,
    isLocalStorage,
    LocalFileSizeError,
    openBoundedLocalFile,
    putLocalFileStream,
    s3bucket,
    s3client,
    statAttachmentObject,
} from '@/storage/files';
import { ATTACHMENT_BODY_LIMIT } from '../requestSecurity';
import {
    AttachmentLifecycleError,
    adoptLegacyAttachment,
    assertAttachmentSessionOwner,
    cancelPendingAttachment,
    claimLocalAttachmentBeforeBody,
    completeLocalAttachment,
    confirmS3Attachment,
    deleteExpiredAttachmentReservations,
    getOwnedAttachment,
    listExpiredAttachmentReservations,
    releaseLocalAttachment,
    reserveAttachment,
    type AttachmentRecord,
} from '@/app/attachments/attachmentLifecycle';
import { attachmentTransferLimiter } from '@/app/api/attachmentTransferLimit';
import { IdSchema, UrlSchema } from './_schemas';

const MAX_FILE_SIZE = ATTACHMENT_BODY_LIMIT;
const PRESIGNED_TTL_SECONDS = 15 * 60; // 15 minutes (design spec)

// Per-account, per-process upload-capability budget. Every connection and
// sibling socket for an account shares this state on the relay process.
const UPLOAD_RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_MAX = 60;
const UPLOAD_RATE_MAX_ACCOUNTS = 10_000;
const ATTACHMENT_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$/;
const ATTACHMENT_REF_PATTERN = /^sessions\/[A-Za-z0-9_-]{1,64}\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$/;
const AttachmentSessionIdSchema = IdSchema.regex(/^[A-Za-z0-9_-]+$/);
const AttachmentFileSchema = z.string().min(1).max(64);
const AttachmentRefSchema = z.string().min(1).max(160).regex(ATTACHMENT_REF_PATTERN);
const AttachmentDisplayNameSchema = z.string().min(1).max(255).refine((value) => (
    value === value.trim()
    && !/[\/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
), { message: 'Attachment filename is invalid' });
const AttachmentUrlSchema = UrlSchema.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
}, { message: 'Attachment URL must use HTTP or HTTPS' });
const AttachmentFormFieldsSchema = z.record(
    z.string().min(1).max(128),
    z.string().max(4096),
).refine((fields) => Object.keys(fields).length <= 32, {
    message: 'Too many attachment form fields',
});

interface AttachmentUploadRateBucket {
    count: number;
    windowStart: number;
    lastSeenAt: number;
}

export class AttachmentUploadRateLimiter {
    private readonly buckets = new Map<string, AttachmentUploadRateBucket>();

    constructor(
        private readonly maxPerWindow = UPLOAD_RATE_MAX,
        private readonly windowMs = UPLOAD_RATE_WINDOW_MS,
        private readonly maxAccounts = UPLOAD_RATE_MAX_ACCOUNTS,
    ) {
        if (!Number.isSafeInteger(maxPerWindow) || maxPerWindow < 1) {
            throw new Error('Attachment upload limit must be a positive safe integer');
        }
        if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
            throw new Error('Attachment upload window must be a positive safe integer');
        }
        if (!Number.isSafeInteger(maxAccounts) || maxAccounts < 1) {
            throw new Error('Attachment upload account cap must be a positive safe integer');
        }
    }

    allow(accountId: string, now = Date.now()): boolean {
        let bucket = this.buckets.get(accountId);
        if (!bucket) {
            this.prune(now);
            if (this.buckets.size >= this.maxAccounts) return false;
            bucket = { count: 0, windowStart: now, lastSeenAt: now };
            this.buckets.set(accountId, bucket);
        }

        // A backwards wall-clock step cannot reset or extend the budget.
        const effectiveNow = Math.max(now, bucket.lastSeenAt);
        if (effectiveNow - bucket.windowStart >= this.windowMs) {
            bucket.count = 0;
            bucket.windowStart = effectiveNow;
        }
        bucket.lastSeenAt = effectiveNow;

        if (bucket.count >= this.maxPerWindow) return false;
        bucket.count += 1;
        return true;
    }

    private prune(now: number): void {
        const cutoff = now - this.windowMs;
        for (const [accountId, bucket] of this.buckets) {
            if (bucket.lastSeenAt < cutoff) this.buckets.delete(accountId);
        }
    }
}

const attachmentUploadRateLimiter = new AttachmentUploadRateLimiter();

/**
 * Build a clean origin for local-mode upload/download capabilities. Fastify's
 * protocol, hostname, and port already honor only the proxy hops configured in
 * startApi; raw forwarding headers never enter this decision.
 */
function normalizePublicOrigin(raw: string): string {
    if (raw !== raw.trim() || raw.length < 1 || raw.length > 2048) {
        throw new Error('Attachment public origin is invalid');
    }
    const parsed = new URL(raw);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.pathname !== '/'
        || parsed.search !== ''
        || parsed.hash !== ''
        || parsed.hostname.length < 1
        || parsed.hostname.length > 253) {
        throw new Error('Attachment public origin is invalid');
    }
    return parsed.origin;
}

function resolveBaseUrl(request: Pick<FastifyRequest, 'hostname' | 'port' | 'protocol'>): string {
    if (process.env.PUBLIC_URL) return normalizePublicOrigin(process.env.PUBLIC_URL);
    const hostname = request.hostname;
    const host = hostname.includes(':') ? `[${hostname}]` : hostname;
    const isDefaultPort = request.port === null
        || (request.protocol === 'http' && request.port === 80)
        || (request.protocol === 'https' && request.port === 443);
    const port = isDefaultPort ? '' : `:${request.port}`;
    return normalizePublicOrigin(`${request.protocol}://${host}${port}`);
}

function checkUploadRate(userId: string): boolean {
    return attachmentUploadRateLimiter.allow(userId);
}

async function cleanupExpiredReservations(accountId: string): Promise<void> {
    const expired = await listExpiredAttachmentReservations(accountId);
    if (expired.length === 0) return;
    // Delete exact object keys first. If storage cleanup fails, keep the rows as
    // tombstones so a known expired ref cannot be lazily adopted as legacy.
    await deleteAttachmentObjects(expired.map((attachment) => attachment.ref));
    await deleteExpiredAttachmentReservations(accountId, expired.map((attachment) => attachment.id));
}

async function authorizeExistingAttachment(
    accountId: string,
    sessionId: string,
    ref: string,
): Promise<AttachmentRecord> {
    let tracked: AttachmentRecord | null = null;
    try {
        tracked = await getOwnedAttachment(accountId, sessionId, ref);
    } catch (error) {
        if (!(error instanceof AttachmentLifecycleError) || error.code !== 'NOT_FOUND') throw error;
    }

    if (!tracked) {
        await assertAttachmentSessionOwner(accountId, sessionId);
    }
    const object = await statAttachmentObject(ref);
    if (!object) throw new AttachmentLifecycleError('NOT_FOUND', 'Attachment not found');

    if (!tracked) {
        // Before the quota table existed, encrypted blobs were identified only
        // by their generated ref. Adopt those blobs lazily so upgrades preserve
        // access while bringing each object under the new ownership and quota
        // boundary at its first post-upgrade download.
        return adoptLegacyAttachment(accountId, sessionId, ref, object.size);
    }

    if (isLocalStorage()) {
        if (tracked.status !== 'UPLOADED' || tracked.size !== object.size) {
            throw new AttachmentLifecycleError('NOT_FOUND', 'Attachment is incomplete');
        }
        return tracked;
    }

    return confirmS3Attachment(accountId, sessionId, ref, object.size);
}

function attachmentErrorReply(error: unknown, reply: FastifyReply, context: 'upload' | 'download') {
    if (!(error instanceof AttachmentLifecycleError)) throw error;
    if (error.code === 'QUOTA') {
        return reply.code(429).send({ error: 'Attachment storage quota exceeded' });
    }
    if (context === 'upload' && error.code === 'SIZE_MISMATCH') {
        return reply.code(409).send({ error: 'Attachment size does not match reservation' });
    }
    if (context === 'upload' && error.code === 'CONFLICT') {
        return reply.code(409).send({ error: 'Attachment reservation already consumed' });
    }
    return reply.code(404).send({ error: 'Attachment not found' });
}

type LocalUploadAdmission = {
    accountId: string;
    attachment: AttachmentRecord;
    ref: string;
    releaseTransfer: () => void;
    abortController: AbortController;
    onAbort: () => void;
    completed: boolean;
    cleanupPromise?: Promise<void>;
};

const localUploadAdmissions = new WeakMap<FastifyRequest, LocalUploadAdmission>();

async function cleanupLocalUpload(request: FastifyRequest): Promise<void> {
    const admission = localUploadAdmissions.get(request);
    if (!admission) return;
    if (admission.cleanupPromise) return admission.cleanupPromise;

    admission.cleanupPromise = (async () => {
        request.raw.off('aborted', admission.onAbort);
        localUploadAdmissions.delete(request);
        if (!admission.completed) admission.abortController.abort();
        admission.releaseTransfer();

        if (!admission.completed) {
            try {
                await deleteAttachmentObjects([admission.ref]);
                await releaseLocalAttachment(admission.accountId, admission.attachment.id);
            } catch {
                // Keep the WRITING row charged as a cleanup tombstone when
                // storage is unavailable. It cannot be reaped on a timer
                // because another replica may still be completing the write;
                // owner deletion retains the exact ref in the durable outbox.
            }
        }
    })();
    return admission.cleanupPromise;
}

function trackLocalUpload(
    request: FastifyRequest,
    admission: Omit<LocalUploadAdmission, 'onAbort' | 'completed'>,
): void {
    const tracked = {
        ...admission,
        completed: false,
        onAbort: () => {
            admission.abortController.abort();
            void cleanupLocalUpload(request);
        },
    };
    localUploadAdmissions.set(request, tracked);
    request.raw.once('aborted', tracked.onAbort);
}

function streamLocalAttachment(
    request: FastifyRequest,
    reply: FastifyReply,
    stream: Readable,
    releaseTransfer: () => void,
): void {
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        request.raw.off('aborted', onAbort);
        reply.raw.off('close', onClose);
        releaseTransfer();
    };
    const onAbort = () => {
        stream.destroy(new Error('Attachment download aborted'));
        release();
    };
    const onClose = () => {
        if (!stream.destroyed) stream.destroy();
        release();
    };
    request.raw.once('aborted', onAbort);
    reply.raw.once('close', onClose);
    stream.once('close', release);
    stream.once('error', release);
}

export function attachmentRoutes(app: Fastify) {

    /**
     * Request an upload URL for an attachment.
     * Returns a ref (storage path) and an uploadUrl to PUT the encrypted blob to.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-upload', {
        schema: {
            params: z.object({
                sessionId: AttachmentSessionIdSchema,
            }).strict(),
            body: z.object({
                filename: AttachmentDisplayNameSchema,
                size: z.number().int().positive(),
            }).strict(),
            response: {
                200: z.object({
                    ref: AttachmentRefSchema,
                    uploadUrl: AttachmentUrlSchema,
                    method: z.enum(['PUT', 'POST']),
                    formFields: AttachmentFormFieldsSchema.optional(),
                }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
                429: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { size } = request.body;
        const userId = request.userId;
        const localStorage = isLocalStorage();
        const localBaseUrl = localStorage ? resolveBaseUrl(request) : null;

        if (!checkUploadRate(userId)) {
            return reply.code(429).send({ error: 'Too many upload requests. Try again in a minute.' });
        }
        if (size > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        let reservation: AttachmentRecord;
        try {
            await cleanupExpiredReservations(userId);
            reservation = await reserveAttachment(
                userId,
                sessionId,
                size,
                localStorage ? 'RELAY' : 'DIRECT',
            );
        } catch (error) {
            return attachmentErrorReply(error, reply, 'upload');
        }
        const { ref } = reservation;
        const attachmentFile = ref.slice(ref.lastIndexOf('/') + 1);

        if (localStorage) {
            // Local mode: client uploads to our own PUT endpoint (the server
            // preclaims this capability and streams exactly the reserved size
            // into an atomic temporary file).
            const uploadUrl = `${localBaseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
            return reply.send({ ref, uploadUrl, method: 'PUT' });
        } else {
            // S3 mode: presigned POST policy with content-length-range so S3
            // itself rejects oversize uploads — a presigned PUT cannot enforce
            // size and would let a client honest about size in the auth call
            // PUT 500MB at the URL afterwards.
            try {
                const policy = s3client.newPostPolicy();
                policy.setBucket(s3bucket);
                policy.setKey(ref);
                policy.setExpires(new Date(Date.now() + PRESIGNED_TTL_SECONDS * 1000));
                // Exact length binds the presigned capability to the bytes counted
                // by the durable reservation, not merely the 10 MiB ceiling.
                policy.setContentLengthRange(size, size);
                const { postURL, formData } = await s3client.presignedPostPolicy(policy);
                const uploadUrl = AttachmentUrlSchema.parse(postURL);
                const formFields = AttachmentFormFieldsSchema.parse(formData);
                return reply.send({
                    ref,
                    uploadUrl,
                    method: 'POST',
                    formFields,
                });
            } catch (error) {
                await cancelPendingAttachment(userId, reservation.id).catch(() => undefined);
                throw error;
            }
        }
    });

    /**
     * Local storage: accept encrypted blob upload via PUT.
     * Only active when S3 is not configured.
     */
    app.put('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        // Authentication, the single-use capability claim, and an aggregate
        // byte lease all precede the streaming content parser.
        bodyLimit: MAX_FILE_SIZE,
        onRequest: app.authenticate,
        preParsing: async (request, reply, payload) => {
            if (!isLocalStorage()) {
                await reply.code(404).send({ error: 'Direct upload not available in S3 mode' });
                return payload;
            }

            const { sessionId, attachmentFile } = request.params as {
                sessionId: string;
                attachmentFile: string;
            };
            if (
                !AttachmentSessionIdSchema.safeParse(sessionId).success
                || !AttachmentFileSchema.safeParse(attachmentFile).success
                || !ATTACHMENT_FILE_PATTERN.test(attachmentFile)
            ) {
                await reply.code(404).send({ error: 'Invalid attachment file' });
                return payload;
            }

            const contentLength = request.headers['content-length'];
            if (
                contentLength !== undefined
                && /^\d+$/.test(contentLength)
                && Number(contentLength) > MAX_FILE_SIZE
            ) {
                await reply.code(413).send({ error: 'File too large (max 10MB)' });
                return payload;
            }

            const accountId = request.userId;
            const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;
            let attachment: AttachmentRecord;
            try {
                attachment = await claimLocalAttachmentBeforeBody(accountId, sessionId, ref);
            } catch (error) {
                attachmentErrorReply(error, reply, 'upload');
                return payload;
            }

            if (
                contentLength !== undefined
                && (!/^\d+$/.test(contentLength) || Number(contentLength) !== attachment.size)
            ) {
                await releaseLocalAttachment(accountId, attachment.id).catch(() => undefined);
                await reply.code(409).send({ error: 'Attachment size does not match reservation' });
                return payload;
            }

            const releaseTransfer = attachmentTransferLimiter.tryAcquire(accountId, attachment.size);
            if (!releaseTransfer) {
                await releaseLocalAttachment(accountId, attachment.id).catch(() => undefined);
                await reply.code(429).send({ error: 'Too many attachment transfers are in progress' });
                return payload;
            }

            trackLocalUpload(request, {
                accountId,
                attachment,
                ref,
                releaseTransfer,
                abortController: new AbortController(),
            });
            return payload;
        },
        onError: async (request) => {
            await cleanupLocalUpload(request);
        },
        onResponse: async (request) => {
            await cleanupLocalUpload(request);
        },
        schema: {
            params: z.object({
                sessionId: AttachmentSessionIdSchema,
                attachmentFile: AttachmentFileSchema,
            }).strict(),
            response: {
                200: z.object({ ok: z.boolean() }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
                409: z.object({ error: z.string() }),
                429: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const admission = localUploadAdmissions.get(request);
        if (!admission) throw new Error('Attachment upload admission is missing');
        const body = request.body as Readable;

        try {
            await putLocalFileStream(
                admission.ref,
                body,
                admission.attachment.size,
                admission.abortController.signal,
            );
            await completeLocalAttachment(admission.accountId, admission.attachment.id);
            admission.completed = true;
        } catch (error) {
            if (error instanceof LocalFileSizeError) {
                return reply.code(409).send({ error: 'Attachment size does not match reservation' });
            }
            throw error;
        }

        return reply.send({ ok: true });
    });

    /**
     * Request a download URL for an attachment by ref. The client follows the
     * returned URL with a normal HTTP GET — in local mode it points back at
     * this server (auth-required), in S3 mode it is a presigned GET URL.
     * Pairs with /request-upload as the design-spec endpoint.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-download', {
        schema: {
            params: z.object({
                sessionId: AttachmentSessionIdSchema,
            }).strict(),
            body: z.object({
                ref: AttachmentRefSchema,
            }).strict(),
            response: {
                200: z.object({
                    downloadUrl: AttachmentUrlSchema,
                }),
                400: z.object({ error: z.string() }),
                404: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { ref } = request.body;
        const userId = request.userId;

        let attachment: AttachmentRecord;
        try {
            attachment = await authorizeExistingAttachment(userId, sessionId, ref);
        } catch (error) {
            return attachmentErrorReply(error, reply, 'download');
        }
        const attachmentFile = attachment.ref.slice(attachment.ref.lastIndexOf('/') + 1);

        if (isLocalStorage()) {
            const baseUrl = resolveBaseUrl(request);
            const downloadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
            return reply.send({ downloadUrl });
        }
        const downloadUrl = AttachmentUrlSchema.parse(
            await s3client.presignedGetObject(s3bucket, attachment.ref, PRESIGNED_TTL_SECONDS),
        );
        return reply.send({ downloadUrl });
    });

    /**
     * Download an attachment. Returns the encrypted blob directly (local)
     * or a presigned GET URL redirect (S3). Backs the URL returned by
     * /request-download in local mode; clients can also call this directly.
     */
    app.get('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        schema: {
            params: z.object({
                sessionId: AttachmentSessionIdSchema,
                attachmentFile: AttachmentFileSchema,
            }).strict(),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId, attachmentFile } = request.params;
        const userId = request.userId;

        if (!ATTACHMENT_FILE_PATTERN.test(attachmentFile)) {
            return reply.code(404).send({ error: 'Invalid attachment file' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;
        let attachment: AttachmentRecord;
        try {
            attachment = await authorizeExistingAttachment(userId, sessionId, ref);
        } catch (error) {
            return attachmentErrorReply(error, reply, 'download');
        }

        if (isLocalStorage()) {
            const releaseTransfer = attachmentTransferLimiter.tryAcquire(userId, attachment.size);
            if (!releaseTransfer) {
                return reply.code(429).send({ error: 'Too many attachment transfers are in progress' });
            }
            try {
                const opened = await openBoundedLocalFile(ref, MAX_FILE_SIZE);
                if (opened.size !== attachment.size) {
                    opened.stream.destroy();
                    releaseTransfer();
                    return reply.code(404).send({ error: 'Attachment not found' });
                }
                streamLocalAttachment(request, reply, opened.stream, releaseTransfer);
                reply.header('Content-Length', String(opened.size));
                return reply.type('application/octet-stream').send(opened.stream);
            } catch (error) {
                releaseTransfer();
                throw error;
            }
        } else {
            // S3 mode: redirect to presigned GET URL (15 min, per design).
            const url = AttachmentUrlSchema.parse(
                await s3client.presignedGetObject(s3bucket, ref, PRESIGNED_TTL_SECONDS),
            );
            return reply.redirect(url);
        }
    });
}
