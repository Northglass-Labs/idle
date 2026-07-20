export const MESSAGE_HISTORY_CONTENT_BYTE_LIMIT = 16 * 1024 * 1024;
export const MESSAGE_HISTORY_RESPONSE_BYTE_LIMIT = 20 * 1024 * 1024;

type HistoryMode = 'legacy' | 'paginated';

interface HistoryMetadata {
    id: string;
    seq: number;
    localId: string | null;
    contentBytes: number;
    createdAt: Date;
    updatedAt: Date;
}

interface HistoryContent {
    id: string;
    content: unknown;
    contentBytes: number;
}

type HistoryStore = Pick<Tx, 'sessionMessage'>;

export interface BoundedHistoryMessage extends HistoryMetadata {
    content: unknown;
}

export class HistoryResponseLimitError extends Error {
    readonly code = 'MESSAGE_HISTORY_RESPONSE_LIMIT';

    constructor(message = 'Message history exceeds the response limit') {
        super(message);
        this.name = 'HistoryResponseLimitError';
    }
}

function validateMetadata(candidate: HistoryMetadata, contentByteLimit: number): void {
    if (
        typeof candidate.id !== 'string'
        || !Number.isSafeInteger(candidate.seq)
        || !Number.isSafeInteger(candidate.contentBytes)
        || candidate.contentBytes < 0
        || candidate.contentBytes > contentByteLimit
        || !(candidate.createdAt instanceof Date)
        || !(candidate.updatedAt instanceof Date)
    ) {
        throw new HistoryResponseLimitError('Stored message metadata is invalid');
    }
}

function actualCiphertextBytes(content: unknown): number | null {
    if (
        content === null
        || typeof content !== 'object'
        || (content as { t?: unknown }).t !== 'encrypted'
        || typeof (content as { c?: unknown }).c !== 'string'
    ) {
        return null;
    }
    return Buffer.byteLength((content as { c: string }).c, 'utf8');
}

export async function readBoundedMessageHistory(
    store: HistoryStore,
    options: {
        where: Record<string, unknown>;
        orderBy: Record<string, unknown> | Array<Record<string, unknown>>;
        limit: number;
        mode: HistoryMode;
        contentByteLimit?: number;
    },
): Promise<{ messages: BoundedHistoryMessage[]; hasMore: boolean }> {
    const contentByteLimit = options.contentByteLimit ?? MESSAGE_HISTORY_CONTENT_BYTE_LIMIT;
    if (
        !Number.isSafeInteger(options.limit)
        || options.limit < 1
        || !Number.isSafeInteger(contentByteLimit)
        || contentByteLimit < 1
    ) {
        throw new HistoryResponseLimitError('Message history limit is invalid');
    }

    const candidates = await store.sessionMessage.findMany({
        where: options.where,
        orderBy: options.orderBy,
        take: options.mode === 'paginated' ? options.limit + 1 : options.limit,
        select: {
            id: true,
            seq: true,
            localId: true,
            contentBytes: true,
            createdAt: true,
            updatedAt: true,
        },
    }) as HistoryMetadata[];

    const selected: HistoryMetadata[] = [];
    let selectedBytes = 0;
    for (const candidate of candidates.slice(0, options.limit)) {
        validateMetadata(candidate, contentByteLimit);
        if (selectedBytes + candidate.contentBytes > contentByteLimit) {
            if (options.mode === 'legacy') throw new HistoryResponseLimitError();
            break;
        }
        selected.push(candidate);
        selectedBytes += candidate.contentBytes;
    }

    if (selected.length === 0) {
        return {
            messages: [],
            hasMore: options.mode === 'paginated' && candidates.length > 0,
        };
    }

    const ids = selected.map((message) => message.id);
    const contentRows = await store.sessionMessage.findMany({
        where: { ...options.where, id: { in: ids } },
        select: { id: true, content: true, contentBytes: true },
    }) as HistoryContent[];
    const contentById = new Map(contentRows.map((message) => [message.id, message]));

    const messages = selected.map((metadata) => {
        const stored = contentById.get(metadata.id);
        const actualBytes = stored ? actualCiphertextBytes(stored.content) : null;
        if (
            !stored
            || stored.contentBytes !== metadata.contentBytes
            || actualBytes !== metadata.contentBytes
        ) {
            throw new HistoryResponseLimitError('Stored message size accounting is inconsistent');
        }
        return { ...metadata, content: stored.content };
    });

    return {
        messages,
        hasMore: options.mode === 'paginated' && candidates.length > selected.length,
    };
}

export function serializeBoundedMessageHistory(
    body: unknown,
    responseByteLimit = MESSAGE_HISTORY_RESPONSE_BYTE_LIMIT,
): string {
    const serialized = JSON.stringify(body);
    if (
        !Number.isSafeInteger(responseByteLimit)
        || responseByteLimit < 1
        || Buffer.byteLength(serialized, 'utf8') > responseByteLimit
    ) {
        throw new HistoryResponseLimitError();
    }
    return serialized;
}
import type { Tx } from '@/storage/inTx';
