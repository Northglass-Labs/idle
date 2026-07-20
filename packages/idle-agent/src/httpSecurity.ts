export const AUTH_HTTP_CONFIG = Object.freeze({
    timeout: 15_000,
    maxContentLength: 64 * 1024,
    maxBodyLength: 4 * 1024,
    maxRedirects: 0,
});

export const BEARER_HTTP_CONFIG = Object.freeze({
    timeout: 30_000,
    maxContentLength: 20 * 1024 * 1024,
    maxBodyLength: 1024 * 1024,
    maxRedirects: 0,
});

export const SESSION_CREATE_HTTP_CONFIG = Object.freeze({
    ...BEARER_HTTP_CONFIG,
    maxContentLength: 256 * 1024,
    maxBodyLength: 128 * 1024,
});
