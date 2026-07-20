function parseContentLength(response: Response): number | null {
    const value = response.headers.get('content-length');
    if (value === null || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function responseLimitError(maxBytes: number): Error {
    return new Error(`Response exceeds ${maxBytes}-byte response limit`);
}

function validateLimit(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new Error('Invalid response limit');
    }
}

export async function readBoundedResponseBytes(
    response: Response,
    maxBytes: number,
): Promise<Uint8Array> {
    validateLimit(maxBytes);

    const declaredLength = parseContentLength(response);
    if (declaredLength !== null && declaredLength > maxBytes) {
        throw responseLimitError(maxBytes);
    }

    if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const parts: Uint8Array[] = [];
        let receivedBytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                receivedBytes += value.byteLength;
                if (receivedBytes > maxBytes) {
                    try {
                        await reader.cancel();
                    } catch {
                        // Preserve the allocation-boundary error even if the
                        // transport cannot acknowledge cancellation.
                    }
                    throw responseLimitError(maxBytes);
                }
                parts.push(value);
            }
            const body = new Uint8Array(receivedBytes);
            let offset = 0;
            for (const part of parts) {
                body.set(part, offset);
                offset += part.byteLength;
            }
            return body;
        } finally {
            reader.releaseLock();
        }
    }

    // A header cannot enforce an actual transfer cap: a compromised or broken
    // peer can omit it or send more bytes than declared. Native callers use
    // Expo's streaming fetch implementation; unsupported transports fail
    // closed instead of invoking a whole-body text allocator.
    throw new Error('Bounded response requires a readable byte stream');
}

export async function readBoundedTextResponse(
    response: Response,
    maxBytes: number,
): Promise<string> {
    return new TextDecoder().decode(
        await readBoundedResponseBytes(response, maxBytes),
    );
}

export async function readBoundedJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
    return JSON.parse(await readBoundedTextResponse(response, maxBytes));
}
