const MAX_REMOTE_IMAGE_URL_LENGTH = 2_048;
const MAX_INLINE_IMAGE_URL_LENGTH = 3_000_000;
const SAFE_INLINE_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export type MarkdownImagePolicy =
    | { kind: 'blocked' }
    | { kind: 'inline'; uri: string }
    | { kind: 'remote'; hostname: string; uri: string };

export function classifyMarkdownImage(rawUri: string): MarkdownImagePolicy {
    const uri = rawUri.trim();

    if (uri.length <= MAX_INLINE_IMAGE_URL_LENGTH && SAFE_INLINE_IMAGE_PATTERN.test(uri)) {
        return { kind: 'inline', uri };
    }

    if (uri.length === 0 || uri.length > MAX_REMOTE_IMAGE_URL_LENGTH) {
        return { kind: 'blocked' };
    }

    try {
        const url = new URL(uri);
        if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
            return { kind: 'blocked' };
        }

        return {
            kind: 'remote',
            hostname: url.hostname,
            uri: url.toString(),
        };
    } catch {
        return { kind: 'blocked' };
    }
}

export function getMarkdownImageRenderUri(
    policy: MarkdownImagePolicy,
    remoteLoadGranted: boolean,
): string | null {
    if (policy.kind === 'inline') {
        return policy.uri;
    }

    if (policy.kind === 'remote' && remoteLoadGranted) {
        return policy.uri;
    }

    return null;
}
