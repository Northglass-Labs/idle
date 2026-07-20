/** Web/test fallback. Native bundles select streamingFetch.native.ts. */
export function streamingFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    return globalThis.fetch(input, init);
}
