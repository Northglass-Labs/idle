import { z } from 'zod';

export interface BoundedResponseOptions {
    maxBytes: number;
    allowedContentTypes?: readonly string[];
}

function normalizedContentType(response: Response): string {
    return (response.headers.get('content-type') ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
}

function assertByteLimit(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new Error('Invalid upstream response byte limit');
    }
}

function assertDeclaredLength(response: Response, maxBytes: number): void {
    const header = response.headers.get('content-length');
    if (header === null) {
        return;
    }
    const value = header.trim();
    if (!/^\d+$/.test(value)) {
        throw new Error('Invalid upstream response content length');
    }
    const declaredLength = Number(value);
    if (!Number.isSafeInteger(declaredLength)) {
        throw new Error('Invalid upstream response content length');
    }
    if (declaredLength > maxBytes) {
        throw new Error('Upstream response exceeded the byte limit');
    }
}

function assertAllowedContentType(response: Response, allowed: readonly string[]): void {
    const actual = normalizedContentType(response);
    const normalizedAllowed = allowed.map((value) => value.toLowerCase());
    if (!actual || !normalizedAllowed.includes(actual)) {
        throw new Error('Unexpected upstream response content type');
    }
}

/**
 * Reads an upstream fetch body without trusting Content-Length. Fetch may
 * transparently decompress a response, so the decoded stream itself is the
 * security boundary and is counted before any aggregate buffer is allocated.
 */
export async function readBoundedResponseBytes(
    response: Response,
    options: BoundedResponseOptions,
): Promise<Uint8Array> {
    const { maxBytes, allowedContentTypes } = options;
    assertByteLimit(maxBytes);
    assertDeclaredLength(response, maxBytes);
    if (allowedContentTypes) {
        assertAllowedContentType(response, allowedContentTypes);
    }

    const body = response.body;
    if (!body) {
        throw new Error('Upstream response body was unavailable');
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (!value || value.byteLength === 0) {
                continue;
            }
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new Error('Upstream response exceeded the byte limit');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

export async function readBoundedJsonResponse<T>(
    response: Response,
    maxBytes: number,
    schema: z.ZodType<T>,
): Promise<T> {
    const contentType = normalizedContentType(response);
    if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
        throw new Error('Unexpected upstream response content type');
    }

    const bytes = await readBoundedResponseBytes(response, { maxBytes });
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return schema.parse(JSON.parse(text));
    } catch {
        throw new Error('Invalid upstream JSON response');
    }
}
