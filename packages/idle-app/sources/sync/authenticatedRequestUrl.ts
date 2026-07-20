const MAX_AUTHENTICATED_REQUEST_PATH_CHARACTERS = 4_096;

function invalidRequestPath(): never {
    throw new Error('Invalid authenticated request path');
}

/**
 * Keep bearer-authenticated requests on the configured relay and prevent a
 * record identifier from turning into URL authority, traversal, or fragment
 * syntax before fetch normalizes it.
 */
export function buildAuthenticatedRequestUrl(endpoint: string, path: string): string {
    if (
        path.length < 1
        || path.length > MAX_AUTHENTICATED_REQUEST_PATH_CHARACTERS
        || !/^\/v(?:1|3)\//.test(path)
        || /[\\#\u0000-\u001F\u007F]/.test(path)
    ) {
        return invalidRequestPath();
    }

    const rawPathname = path.split('?', 1)[0];
    for (const segment of rawPathname.split('/')) {
        let decoded: string;
        try {
            decoded = decodeURIComponent(segment);
        } catch {
            return invalidRequestPath();
        }
        if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
            return invalidRequestPath();
        }
    }

    try {
        const base = new URL(endpoint);
        if (
            (base.protocol !== 'https:' && base.protocol !== 'http:')
            || !base.hostname
            || base.username
            || base.password
            || (base.pathname !== '/' && base.pathname !== '')
            || base.search
            || base.hash
        ) {
            return invalidRequestPath();
        }
        const url = new URL(path, base);
        if (
            url.origin !== base.origin
            || url.username
            || url.password
            || url.hash
        ) {
            return invalidRequestPath();
        }
        return url.toString();
    } catch {
        return invalidRequestPath();
    }
}
