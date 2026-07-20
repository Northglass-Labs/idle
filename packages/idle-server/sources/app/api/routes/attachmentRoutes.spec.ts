import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

function credentialedTestUrl(hostAndPath: string): string {
    const url = new URL(`https://${hostAndPath}`);
    url.username = "test-user";
    url.password = "test-password";
    return url.toString();
}

const {
    state,
    dbMock,
    filesMock,
    lifecycleMock,
    resetState,
    seedSession,
    seedReservation,
} = vi.hoisted(() => {
    type AttachmentRow = {
        id: string;
        accountId: string;
        sessionId: string;
        ref: string;
        size: number;
        status: 'PENDING' | 'WRITING' | 'UPLOADED';
        transport: 'DIRECT' | 'RELAY';
        expiresAt: Date;
        uploadedAt: Date | null;
    };
    class MockAttachmentLifecycleError extends Error {
        constructor(public code: string) {
            super(code);
        }
    }
    class MockLocalFileSizeError extends Error {}
    const state = {
        sessions: [] as Array<{ id: string; accountId: string }>,
        attachments: [] as AttachmentRow[],
        uploads: new Map<string, Buffer>(),
        s3Objects: new Map<string, number>(),
        useLocalStorage: true,
        s3PostUrl: "https://s3.test/post-url",
        s3GetUrl: "https://s3.test/get-url",
        s3FormData: { key: "stub-key", policy: "stub-policy" } as Record<string, string>,
        s3PolicyMinLength: 0,
        s3PolicyMaxLength: 0,
        octetParserCalls: 0,
    };

    const resetState = () => {
        state.sessions = [];
        state.attachments = [];
        state.uploads = new Map();
        state.s3Objects = new Map();
        state.useLocalStorage = true;
        state.s3PostUrl = "https://s3.test/post-url";
        state.s3GetUrl = "https://s3.test/get-url";
        state.s3FormData = { key: "stub-key", policy: "stub-policy" };
        state.s3PolicyMinLength = 0;
        state.s3PolicyMaxLength = 0;
        state.octetParserCalls = 0;
        delete process.env.PUBLIC_URL;
        vi.clearAllMocks();
    };

    const seedSession = (id: string, accountId: string) => {
        state.sessions.push({ id, accountId });
    };

    const sessionFindFirst = vi.fn(async (args: any) => {
        return state.sessions.find((s) =>
            s.id === args?.where?.id && s.accountId === args?.where?.accountId,
        ) ?? null;
    });

    const dbMock = { session: { findFirst: sessionFindFirst } };

    const seedReservation = (
        sessionId: string,
        accountId: string,
        attachmentFile: string,
        size: number,
        status: AttachmentRow['status'] = 'PENDING',
        transport: AttachmentRow['transport'] = 'RELAY',
    ) => {
        const id = attachmentFile.slice(0, -'.enc'.length);
        const row: AttachmentRow = {
            id,
            accountId,
            sessionId,
            ref: `sessions/${sessionId}/attachments/${attachmentFile}`,
            size,
            status,
            transport,
            expiresAt: new Date(Date.now() + 60_000),
            uploadedAt: status === 'UPLOADED' ? new Date() : null,
        };
        state.attachments.push(row);
        return row;
    };

    const lifecycleMock = {
        AttachmentLifecycleError: MockAttachmentLifecycleError,
        reserveAttachment: vi.fn(async (
            accountId: string,
            sessionId: string,
            size: number,
            transport: AttachmentRow['transport'] = 'DIRECT',
        ) => {
            if (!state.sessions.some((session) => session.id === sessionId && session.accountId === accountId)) {
                throw new MockAttachmentLifecycleError('NOT_FOUND');
            }
            return seedReservation(sessionId, accountId, `${crypto.randomUUID()}.enc`, size, 'PENDING', transport);
        }),
        getOwnedAttachment: vi.fn(async (accountId: string, sessionId: string, ref: string) => {
            const prefix = `sessions/${sessionId}/attachments/`;
            const file = ref.startsWith(prefix) ? ref.slice(prefix.length) : '';
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$/i.test(file)) {
                throw new MockAttachmentLifecycleError('INVALID');
            }
            const row = state.attachments.find((candidate) => candidate.accountId === accountId
                && candidate.sessionId === sessionId && candidate.ref === ref);
            if (!row) throw new MockAttachmentLifecycleError('NOT_FOUND');
            return row;
        }),
        assertAttachmentSessionOwner: vi.fn(async (accountId: string, sessionId: string) => {
            if (!state.sessions.some((session) => session.id === sessionId && session.accountId === accountId)) {
                throw new MockAttachmentLifecycleError('NOT_FOUND');
            }
        }),
        adoptLegacyAttachment: vi.fn(async (accountId: string, sessionId: string, ref: string, size: number) => {
            if (!state.sessions.some((session) => session.id === sessionId && session.accountId === accountId)) {
                throw new MockAttachmentLifecycleError('NOT_FOUND');
            }
            const file = ref.slice(ref.lastIndexOf('/') + 1);
            return seedReservation(sessionId, accountId, file, size, 'UPLOADED');
        }),
        claimLocalAttachmentBeforeBody: vi.fn(async (accountId: string, sessionId: string, ref: string) => {
            const row = state.attachments.find((candidate) => candidate.accountId === accountId
                && candidate.sessionId === sessionId && candidate.ref === ref);
            if (!row) throw new MockAttachmentLifecycleError('NOT_FOUND');
            if (row.status !== 'PENDING') throw new MockAttachmentLifecycleError('CONFLICT');
            row.status = 'WRITING';
            return row;
        }),
        completeLocalAttachment: vi.fn(async (accountId: string, id: string) => {
            const row = state.attachments.find((candidate) => candidate.accountId === accountId && candidate.id === id);
            if (!row || row.status !== 'WRITING') throw new MockAttachmentLifecycleError('CONFLICT');
            row.status = 'UPLOADED';
            row.uploadedAt = new Date();
        }),
        releaseLocalAttachment: vi.fn(async (accountId: string, id: string) => {
            state.attachments = state.attachments.filter((row) => row.accountId !== accountId || row.id !== id);
        }),
        cancelPendingAttachment: vi.fn(async (accountId: string, id: string) => {
            state.attachments = state.attachments.filter((row) => row.accountId !== accountId || row.id !== id || row.status !== 'PENDING');
        }),
        confirmS3Attachment: vi.fn(async (accountId: string, sessionId: string, ref: string, size: number) => {
            const row = state.attachments.find((candidate) => candidate.accountId === accountId
                && candidate.sessionId === sessionId && candidate.ref === ref);
            if (!row) throw new MockAttachmentLifecycleError('NOT_FOUND');
            if (row.size !== size) throw new MockAttachmentLifecycleError('SIZE_MISMATCH');
            row.status = 'UPLOADED';
            row.uploadedAt = new Date();
            return row;
        }),
        listExpiredAttachmentReservations: vi.fn(async (accountId: string) => state.attachments
            .filter((row) => row.accountId === accountId
                && row.transport === 'RELAY'
                && row.status === 'PENDING'
                && row.expiresAt <= new Date())
            .slice(0, 100)),
        deleteExpiredAttachmentReservations: vi.fn(async (accountId: string, ids: string[]) => {
            state.attachments = state.attachments.filter((row) => row.accountId !== accountId
                || row.transport !== 'RELAY'
                || row.status !== 'PENDING'
                || row.expiresAt > new Date()
                || !ids.includes(row.id));
        }),
    };

    const filesMock = {
        LocalFileSizeError: MockLocalFileSizeError,
        s3client: {
            newPostPolicy: () => {
                const policy = {
                    bucket: "",
                    key: "",
                    expires: new Date(),
                    minLen: 0,
                    maxLen: 0,
                    setBucket(b: string) { policy.bucket = b; },
                    setKey(k: string) { policy.key = k; },
                    setExpires(d: Date) { policy.expires = d; },
                    setContentLengthRange(min: number, max: number) {
                        policy.minLen = min;
                        policy.maxLen = max;
                        state.s3PolicyMinLength = min;
                        state.s3PolicyMaxLength = max;
                    },
                };
                return policy;
            },
            presignedPostPolicy: vi.fn(async (_policy: any) => ({
                postURL: state.s3PostUrl,
                formData: { ...state.s3FormData, key: _policy.key },
            })),
            presignedGetObject: vi.fn(async (_bucket: string, _key: string, _ttl: number) => state.s3GetUrl),
        },
        s3bucket: "test-bucket",
        isLocalStorage: vi.fn(() => state.useLocalStorage),
        getLocalFilesDir: vi.fn(() => "/tmp/test-files"),
        putLocalFile: vi.fn(async (filePath: string, data: Buffer) => {
            state.uploads.set(filePath, data);
        }),
        putLocalFileStream: vi.fn(async (filePath: string, source: Readable, expectedBytes: number) => {
            const chunks: Buffer[] = [];
            for await (const chunk of source) chunks.push(Buffer.from(chunk));
            const data = Buffer.concat(chunks);
            if (data.length !== expectedBytes) throw new MockLocalFileSizeError();
            state.uploads.set(filePath, data);
        }),
        openBoundedLocalFile: vi.fn(async (filePath: string, maxBytes: number) => {
            const data = state.uploads.get(filePath);
            if (!data || data.length > maxBytes) throw new Error("Attachment not found");
            return { size: data.length, stream: Readable.from(data) };
        }),
        statAttachmentObject: vi.fn(async (filePath: string) => {
            if (state.useLocalStorage) {
                const body = state.uploads.get(filePath);
                return body ? { size: body.length } : null;
            }
            const size = state.s3Objects.get(filePath);
            return size === undefined ? null : { size };
        }),
        deleteAttachmentObjects: vi.fn(async (refs: string[]) => {
            for (const ref of refs) {
                state.uploads.delete(ref);
                state.s3Objects.delete(ref);
            }
        }),
    };

    return { state, dbMock, filesMock, lifecycleMock, resetState, seedSession, seedReservation };
});

// Use relative paths — tsconfig aliases don't resolve in vi.mock
vi.mock("../../../storage/db", () => ({ db: dbMock }));
vi.mock("../../../storage/files", () => filesMock);
vi.mock("../../attachments/attachmentLifecycle", () => lifecycleMock);

import { AttachmentUploadRateLimiter, attachmentRoutes } from "./attachmentRoutes";

const ATTACHMENT_A = "11111111-1111-4111-8111-111111111111.enc";
const ATTACHMENT_B = "22222222-2222-4222-8222-222222222222.enc";
const GLOBAL_BODY_LIMIT = 1024 * 1024;

async function createApp() {
    // Match the production public-request limit. The authenticated local
    // attachment route must opt into its own bounded allowance.
    const app = fastify({ bodyLimit: GLOBAL_BODY_LIMIT });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    // Octet-stream parser is normally registered in api.ts startApi() — mirror
    // its streaming behavior here.
    app.addContentTypeParser(
        "application/octet-stream",
        (_req, body, done) => {
            state.octetParserCalls += 1;
            done(null, body);
        },
    );

    attachmentRoutes(typed);
    await typed.ready();
    return typed;
}

describe("attachmentRoutes — request-upload", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); });
    afterEach(async () => { if (app) await app.close(); });

    it("returns 200 with .enc ref + method=PUT in local mode for the session owner", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "screenshot.exe", size: 1024 },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.method).toBe("PUT");
        expect(body.ref).toMatch(/^sessions\/s1\/attachments\/[A-Fa-f0-9-]+\.enc$/);
        expect(body.uploadUrl).toContain("/v1/sessions/s1/attachments/");
        expect(body.uploadUrl).toMatch(/\.enc$/);
        expect(lifecycleMock.reserveAttachment).toHaveBeenCalledWith('u1', 's1', 1024, 'RELAY');
    });

    it("ignores raw forwarding headers from a direct client when deriving a local URL", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: {
                "x-user-id": "u1",
                host: "relay.test:3443",
                "x-forwarded-host": "attacker.example",
                "x-forwarded-proto": "javascript",
            },
            payload: { filename: "image.enc", size: 1 },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().uploadUrl).toMatch(/^http:\/\/relay\.test:3443\/v1\/sessions\//);
        expect(res.json().uploadUrl).not.toContain("attacker.example");
        expect(res.json().uploadUrl).not.toContain("javascript");
    });

    it("fails closed on a configured URL that is not a clean HTTP origin", async () => {
        seedSession("s1", "u1");
        process.env.PUBLIC_URL = credentialedTestUrl("relay.test/private?query=1#fragment");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "image.enc", size: 1 },
        });

        expect(res.statusCode).toBe(500);
        expect(lifecycleMock.reserveAttachment).not.toHaveBeenCalled();
    });

    it("rejects overlong session identifiers before storage work", async () => {
        app = await createApp();
        const sessionId = "s".repeat(65);

        const res = await app.inject({
            method: "POST",
            url: `/v1/sessions/${sessionId}/attachments/request-upload`,
            headers: { "x-user-id": "u1" },
            payload: { filename: "image.enc", size: 1 },
        });

        expect(res.statusCode).toBe(400);
        expect(lifecycleMock.reserveAttachment).not.toHaveBeenCalled();
    });

    it.each(["../secret.png", "folder/image.png", "image\u0000.png", "   "])(
        "rejects unsafe display filename %j before storage work",
        async (filename) => {
            seedSession("s1", "u1");
            app = await createApp();

            const res = await app.inject({
                method: "POST",
                url: "/v1/sessions/s1/attachments/request-upload",
                headers: { "x-user-id": "u1" },
                payload: { filename, size: 1 },
            });

            expect(res.statusCode).toBe(400);
            expect(lifecycleMock.reserveAttachment).not.toHaveBeenCalled();
        },
    );

    it("returns 200 with method=POST + formFields and a content-length-range policy in S3 mode", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "img.jpg", size: 1024 },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.method).toBe("POST");
        expect(body.uploadUrl).toBe("https://s3.test/post-url");
        expect(body.formFields).toBeDefined();
        expect(state.s3PolicyMinLength).toBe(1024);
        expect(state.s3PolicyMaxLength).toBe(1024);
        expect(lifecycleMock.reserveAttachment).toHaveBeenCalledWith('u1', 's1', 1024, 'DIRECT');
    });

    it.each([
        ["an unsafe upload URL", () => { state.s3PostUrl = "javascript:alert(1)"; }],
        ["too many form fields", () => {
            state.s3FormData = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field-${index}`, "value"]));
        }],
    ])("rejects %s from object storage and releases the reservation", async (_label, arrange) => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        arrange();
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "image.enc", size: 1 },
        });

        expect(res.statusCode).toBe(500);
        expect(lifecycleMock.cancelPendingAttachment).toHaveBeenCalledOnce();
    });

    it("returns 404 when the requesting user is not the session owner", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u2" },
            payload: { filename: "x.png", size: 100 },
        });
        expect(res.statusCode).toBe(404);
        expect(filesMock.statAttachmentObject).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            payload: { filename: "x.png", size: 100 },
        });
        expect(res.statusCode).toBe(401);
    });

    it("returns 413 when the declared size exceeds the 10MB limit", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "huge.bin", size: 10 * 1024 * 1024 + 1 },
        });
        expect(res.statusCode).toBe(413);
    });

    it("deletes a bounded expired reservation and its exact object before reserving again", async () => {
        seedSession("s1", "u1");
        const expired = seedReservation("s1", "u1", ATTACHMENT_A, 1);
        expired.expiresAt = new Date(Date.now() - 1);
        state.uploads.set(expired.ref, Buffer.from("x"));
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "new.png", size: 1 },
        });

        expect(res.statusCode).toBe(200);
        expect(filesMock.deleteAttachmentObjects).toHaveBeenCalledWith([expired.ref]);
        expect(state.uploads.has(expired.ref)).toBe(false);
        expect(state.attachments.some((row) => row.id === expired.id)).toBe(false);
    });

    it("does not reap an expired direct capability before reserving again", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        const expired = seedReservation("s1", "u1", ATTACHMENT_A, 1, 'PENDING', 'DIRECT');
        expired.expiresAt = new Date(Date.now() - 1);
        state.s3Objects.set(expired.ref, 1);
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "new.png", size: 1 },
        });

        expect(res.statusCode).toBe(200);
        expect(filesMock.deleteAttachmentObjects).not.toHaveBeenCalled();
        expect(state.attachments.some((row) => row.id === expired.id)).toBe(true);
    });

    it("releases the durable reservation if S3 cannot mint the upload capability", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        filesMock.s3client.presignedPostPolicy.mockRejectedValueOnce(new Error("storage unavailable"));
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "image.png", size: 1 },
        });

        expect(res.statusCode).toBe(500);
        expect(lifecycleMock.cancelPendingAttachment).toHaveBeenCalledOnce();
        expect(state.attachments).toHaveLength(0);
    });
});

describe("attachmentRoutes — PUT (local-mode upload)", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); });
    afterEach(async () => { if (app) await app.close(); });

    it("rejects an uppercase attachment UUID before claiming or parsing upload bytes", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A.toUpperCase()}`,
            headers: {
                "x-user-id": "u1",
                "content-type": "application/octet-stream",
                "content-length": "1",
            },
            payload: Buffer.from("x"),
        });

        expect(res.statusCode).toBe(404);
        expect(lifecycleMock.claimLocalAttachmentBeforeBody).not.toHaveBeenCalled();
        expect(state.octetParserCalls).toBe(0);
    });

    it("accepts the encrypted blob from the session owner and stores it under the session prefix", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        seedReservation("s1", "u1", ATTACHMENT_A, Buffer.from("encrypted-bytes").length);
        app = await createApp();

        const blob = Buffer.from("encrypted-bytes");
        const res = await app.inject({
            method: "PUT",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: blob,
        });

        expect(res.statusCode).toBe(200);
        expect(state.uploads.get(`sessions/s1/attachments/${ATTACHMENT_A}`)).toEqual(blob);
        expect(state.octetParserCalls).toBe(1);
    });

    it("accepts an authenticated encrypted blob above the global request limit", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        const blob = Buffer.alloc(GLOBAL_BODY_LIMIT + 1, 0x61);
        seedReservation("s1", "u1", ATTACHMENT_A, blob.length);
        app = await createApp();
        const res = await app.inject({
            method: "PUT",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: blob,
        });

        expect(res.statusCode).toBe(200);
        expect(state.uploads.get(`sessions/s1/attachments/${ATTACHMENT_A}`)).toEqual(blob);
    }, 15_000);

    it("authenticates before parsing a body above the global request limit", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.alloc(GLOBAL_BODY_LIMIT + 1, 0x61),
        });

        expect(res.statusCode).toBe(401);
        expect(state.uploads.size).toBe(0);
    });

    it("rejects an authenticated encrypted blob above the attachment limit", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
        });

        expect(res.statusCode).toBe(413);
        expect(state.uploads.size).toBe(0);
    });

    it("rejects path traversal in attachment file segment", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        seedReservation("s1", "u1", ATTACHMENT_A, 1);
        app = await createApp();

        const evil = await app.inject({
            method: "PUT",
            url: "/v1/sessions/s1/attachments/..evil",
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: Buffer.from("x"),
        });
        expect(evil.statusCode).toBe(404);
    });

    it("rejects upload from a non-owner of the session", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u2", "content-type": "application/octet-stream" },
            payload: Buffer.from("x"),
        });
        expect(res.statusCode).toBe(404);
    });

    it("returns 404 for PUT in S3 mode (direct upload not available)", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        seedReservation("s1", "u1", ATTACHMENT_A, 1);
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: Buffer.from("x"),
        });
        expect(res.statusCode).toBe(404);
    });

    it("rejects a canonical local upload that has no durable reservation", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: Buffer.from("x"),
        });

        expect(res.statusCode).toBe(404);
        expect(state.uploads.size).toBe(0);
        expect(state.octetParserCalls).toBe(0);
    });

    it("rejects an actual local upload size that differs from the reserved size", async () => {
        seedSession("s1", "u1");
        seedReservation("s1", "u1", ATTACHMENT_A, 2);
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: Buffer.from("x"),
        });

        expect(res.statusCode).toBe(409);
        expect(state.uploads.size).toBe(0);
        expect(state.octetParserCalls).toBe(0);
        expect(state.attachments).toHaveLength(0);
    });

    it("counts a body with no Content-Length and releases a short upload", async () => {
        seedSession("s1", "u1");
        seedReservation("s1", "u1", ATTACHMENT_A, 2);
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: Readable.from(Buffer.from("x")),
        });

        expect(res.statusCode).toBe(409);
        expect(state.octetParserCalls).toBe(1);
        expect(state.uploads.size).toBe(0);
        expect(state.attachments).toHaveLength(0);
    });

    it("lets only one parallel PUT enter the streaming parser for a single-use reservation", async () => {
        seedSession("s1", "u1");
        seedReservation("s1", "u1", ATTACHMENT_A, 1);
        app = await createApp();

        const responses = await Promise.all([
            app.inject({
                method: "PUT",
                url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
                headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
                payload: Buffer.from("a"),
            }),
            app.inject({
                method: "PUT",
                url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
                headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
                payload: Buffer.from("b"),
            }),
        ]);

        expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
        expect(state.octetParserCalls).toBe(1);
    });
});

describe("attachmentRoutes — POST request-download", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); });
    afterEach(async () => { if (app) await app.close(); });

    it("rejects a case-variant attachment ref before ownership or storage lookup", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: `sessions/s1/attachments/${ATTACHMENT_A.toUpperCase()}` },
        });

        expect(res.statusCode).toBe(400);
        expect(lifecycleMock.getOwnedAttachment).not.toHaveBeenCalled();
        expect(filesMock.statAttachmentObject).not.toHaveBeenCalled();
    });

    it("returns a server-relative downloadUrl for the session owner in local mode", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        state.uploads.set(`sessions/s1/attachments/${ATTACHMENT_A}`, Buffer.from("payload"));
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: `sessions/s1/attachments/${ATTACHMENT_A}` },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.downloadUrl).toContain(`/v1/sessions/s1/attachments/${ATTACHMENT_A}`);
    });

    it("returns a presigned S3 GET URL in S3 mode", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        const ref = `sessions/s1/attachments/${ATTACHMENT_A}`;
        seedReservation("s1", "u1", ATTACHMENT_A, 7);
        state.s3Objects.set(ref, 7);
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().downloadUrl).toBe("https://s3.test/get-url");
    });

    it("rejects a non-HTTP presigned download URL", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        state.s3GetUrl = "data:text/plain,credential";
        const ref = `sessions/s1/attachments/${ATTACHMENT_A}`;
        seedReservation("s1", "u1", ATTACHMENT_A, 7);
        state.s3Objects.set(ref, 7);
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref },
        });

        expect(res.statusCode).toBe(500);
    });

    it("rejects a ref that does not belong to the requested session (cross-session attack)", async () => {
        seedSession("s1", "u1");
        seedSession("s2", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: `sessions/s2/attachments/${ATTACHMENT_B}` },
        });

        expect(res.statusCode).toBe(404);
        expect(filesMock.statAttachmentObject).not.toHaveBeenCalled();
    });

    it("rejects path traversal inside the ref", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: "sessions/s1/attachments/../escape" },
        });

        expect(res.statusCode).toBe(400);
        expect(filesMock.statAttachmentObject).not.toHaveBeenCalled();
    });

    it("returns 404 for a non-owner of the session", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u2" },
            payload: { ref: `sessions/s1/attachments/${ATTACHMENT_A}` },
        });

        expect(res.statusCode).toBe(404);
        expect(filesMock.statAttachmentObject).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            payload: { ref: `sessions/s1/attachments/${ATTACHMENT_A}` },
        });

        expect(res.statusCode).toBe(401);
    });

    it("does not presign a missing S3 object even when a reservation exists", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        seedReservation("s1", "u1", ATTACHMENT_A, 7);
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: `sessions/s1/attachments/${ATTACHMENT_A}` },
        });

        expect(res.statusCode).toBe(404);
        expect(filesMock.s3client.presignedGetObject).not.toHaveBeenCalled();
    });

    it("does not presign an S3 object whose actual size differs from its reservation", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        const ref = `sessions/s1/attachments/${ATTACHMENT_A}`;
        seedReservation("s1", "u1", ATTACHMENT_A, 7);
        state.s3Objects.set(ref, 8);
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref },
        });

        expect(res.statusCode).toBe(404);
        expect(filesMock.s3client.presignedGetObject).not.toHaveBeenCalled();
    });
});

describe("AttachmentUploadRateLimiter", () => {
    it("shares one account budget, caps fresh-account state, prunes stale buckets, and resists clock rollback", () => {
        const limiter = new AttachmentUploadRateLimiter(1, 60_000, 10_000);

        expect(limiter.allow("shared-account", 10_000)).toBe(true);
        expect(limiter.allow("shared-account", 5_000)).toBe(false);
        for (let index = 1; index < 10_000; index += 1) {
            expect(limiter.allow(`account-${index}`, 10_000)).toBe(true);
        }
        expect(limiter.allow("overflow-account", 10_000)).toBe(false);
        expect(limiter.allow("overflow-account", 70_001)).toBe(true);
    });
});

describe("attachmentRoutes — GET (download)", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); });
    afterEach(async () => { if (app) await app.close(); });

    it("rejects an uppercase attachment UUID before ownership or storage lookup", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A.toUpperCase()}`,
            headers: { "x-user-id": "u1" },
        });

        expect(res.statusCode).toBe(404);
        expect(lifecycleMock.getOwnedAttachment).not.toHaveBeenCalled();
        expect(filesMock.statAttachmentObject).not.toHaveBeenCalled();
    });

    it("serves the encrypted blob to the session owner in local mode", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        state.uploads.set(`sessions/s1/attachments/${ATTACHMENT_A}`, Buffer.from("payload"));
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u1" },
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("application/octet-stream");
        expect(res.rawPayload).toEqual(Buffer.from("payload"));
        expect(filesMock.openBoundedLocalFile).toHaveBeenCalledOnce();
    });

    it("redirects to a presigned GET URL in S3 mode for the session owner", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        const ref = `sessions/s1/attachments/${ATTACHMENT_A}`;
        seedReservation("s1", "u1", ATTACHMENT_A, 7);
        state.s3Objects.set(ref, 7);
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u1" },
        });

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe("https://s3.test/get-url");
    });

    it("returns 404 for non-owner", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        state.uploads.set(`sessions/s1/attachments/${ATTACHMENT_A}`, Buffer.from("payload"));
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u2" },
        });
        expect(res.statusCode).toBe(404);
    });

    it("rejects path traversal", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/..evil",
            headers: { "x-user-id": "u1" },
        });
        expect(res.statusCode).toBe(404);
    });

    it("returns 404 when the attachment file is missing in local mode", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: `/v1/sessions/s1/attachments/${ATTACHMENT_A}`,
            headers: { "x-user-id": "u1" },
        });
        expect(res.statusCode).toBe(404);
    });
});
