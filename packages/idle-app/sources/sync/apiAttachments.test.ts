import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthCredentials } from '@/auth/tokenStorage';
import {
    downloadEncryptedAttachment,
    isTrustedObjectStorageHostname,
    requestAttachmentUpload,
    uploadEncryptedBlob,
} from './apiAttachments';
import { getAttachmentDiagnostic } from './attachmentDiagnostics';

const { appendFormFile, cleanupFormFile } = vi.hoisted(() => ({
    appendFormFile: vi.fn(),
    cleanupFormFile: vi.fn(),
}));

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://relay.example.test',
}));

vi.mock('./uploadFormFile', () => ({
    appendFormFile,
}));

const credentials: AuthCredentials = {
    token: 'test-token',
    secret: 'test-secret',
};

const storageUrl = 'https://bucket.s3.us-east-1.amazonaws.com/idle/session-1/ref?X-Amz-Signature=s3-secret&policy=secret-policy';
const storageHost = 'bucket.s3.us-east-1.amazonaws.com';
const apiBlobUrl = 'https://relay.example.test/v1/sessions/session-1/attachments/blob?X-Amz-Signature=s3-secret';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    cleanupFormFile.mockReset();
    cleanupFormFile.mockResolvedValue(undefined);
    appendFormFile.mockReset();
    appendFormFile.mockResolvedValue(cleanupFormFile);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('object storage hostname policy', () => {
    it('matches supported S3 endpoints in linear time and rejects hostile lookalikes', () => {
        expect(isTrustedObjectStorageHostname('bucket.s3.us-east-1.amazonaws.com')).toBe(true);
        expect(isTrustedObjectStorageHostname('s3-us-west-2.amazonaws.com')).toBe(true);

        const hostile = `s3-${'-'.repeat(8_000)}.amazonaws.com.attacker.invalid`;
        const startedAt = performance.now();
        expect(isTrustedObjectStorageHostname(hostile)).toBe(false);
        expect(performance.now() - startedAt).toBeLessThan(250);
    });

    it('accepts supported providers only at valid DNS label boundaries', () => {
        for (const hostname of [
            'bucket.storage.googleapis.com',
            'account.r2.cloudflarestorage.com',
            'container.blob.core.windows.net',
            'bucket.nyc3.digitaloceanspaces.com',
            's3.us-west-004.backblazeb2.com',
            'bucket.s3.eu-central-1.wasabisys.com',
        ]) {
            expect(isTrustedObjectStorageHostname(hostname)).toBe(true);
        }

        expect(isTrustedObjectStorageHostname('bucket..storage.googleapis.com')).toBe(false);
        expect(isTrustedObjectStorageHostname('bucket..s3.eu-central-1.wasabisys.com')).toBe(false);
        expect(isTrustedObjectStorageHostname('-account.r2.cloudflarestorage.com')).toBe(false);
    });
});

describe('requestAttachmentUpload', () => {
    it.each([
        'http://169.254.169.254/latest/meta-data',
        'https://127.0.0.1/internal',
        'https://[::1]/internal',
        'https://internal.invalid/upload',
        'https://bucket.s3.us-east-1.amazonaws.com.attacker.invalid/upload',
    ])('rejects an untrusted relay-selected upload destination without transferring to %s', async (uploadUrl) => {
        fetchMock.mockResolvedValueOnce(response({
            ok: true,
            json: {
                ref: 'sessions/session-1/attachments/ref.enc',
                uploadUrl,
                method: 'POST',
                formFields: { key: 'sessions/session-1/attachments/ref.enc' },
            },
        }));

        await expect(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        )).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('accepts a recognized HTTPS object-storage POST and disables redirects on control requests', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: true,
            json: {
                ref: 'sessions/session-1/attachments/ref.enc',
                uploadUrl: storageUrl,
                method: 'POST',
                formFields: { key: 'sessions/session-1/attachments/ref.enc' },
            },
        }));

        await expect(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        )).resolves.toMatchObject({ uploadUrl: storageUrl, method: 'POST' });
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    });

    it('rejects an oversized successful response before JSON parsing', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: true,
            json: {
                ref: 'ref',
                uploadUrl: storageUrl,
                method: 'PUT',
            },
            headers: { 'content-length': String(64 * 1024 + 1) },
        }));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        ));

        expect(error.message).toContain('request-upload response parse error');
        expect(error.message).toContain('response limit');
    });

    it('rejects unknown response fields instead of accepting relay-controlled data', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: true,
            json: {
                ref: 'ref',
                uploadUrl: storageUrl,
                method: 'PUT',
                internalNote: 'must not cross the API boundary',
            },
        }));

        await expect(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        )).rejects.toThrow('request-upload response parse error');
    });

    it('classifies request-upload HTTP failures against the Idle API host', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        }));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        ));

        expect(error.message).toBe('request-upload failed: 500');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'relay.example.test',
            target: 'idle-api',
            status: 500,
            statusText: 'Internal Server Error',
        });
    });

    it('keeps the request-upload 413 message while adding a diagnostic', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 413,
            statusText: 'Payload Too Large',
        }));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            11 * 1024 * 1024,
        ));

        expect(error.message).toBe('Attachment too large (max 10MB)');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'relay.example.test',
            target: 'idle-api',
            status: 413,
            statusText: 'Payload Too Large',
        });
    });

    it('classifies request-upload network failures against the Idle API host', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        ));

        expect(error.message).toBe('request-upload network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'relay.example.test',
            target: 'idle-api',
            message: 'Failed to fetch',
        });
    });

    it('classifies request-upload response parse failures without leaking credentials or refs', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: true,
            jsonError: new Error(`Unexpected token at ${apiBlobUrl} Bearer ${credentials.token} ref happy/session-1/ref`),
        }));

        const error = await rejectedError(requestAttachmentUpload(
            credentials,
            'session-1',
            'photo.jpg',
            123,
        ));

        expect(error.message).toContain('request-upload response parse error');
        expect(error.message).toContain('Unexpected token');
        expect(error.message).toContain('[url:relay.example.test]');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-upload',
            method: 'POST',
            host: 'relay.example.test',
            target: 'idle-api',
            message: expect.stringContaining('Unexpected token'),
        });
        expectNoAttachmentLeaks(error);
    });
});

describe('uploadEncryptedBlob', () => {
    it('rejects a hostname-prefix lookalike without issuing an outbound transfer', async () => {
        await expect(uploadEncryptedBlob({
            uploadUrl: 'https://relay.example.test.attacker.invalid/upload',
            method: 'PUT',
        }, new Uint8Array([1, 2, 3]), credentials)).rejects.toThrow();

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        'http://169.254.169.254/upload',
        'https://127.0.0.1/upload',
        'https://[::1]/upload',
        'https://internal.invalid/upload',
    ])('rejects an untrusted multipart destination before building or sending a form to %s', async (uploadUrl) => {
        await expect(uploadEncryptedBlob({
            uploadUrl,
            method: 'POST',
            formFields: { policy: 'opaque-policy' },
        }, new Uint8Array([1, 2, 3]), credentials)).rejects.toThrow();

        expect(appendFormFile).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects external PUT even when its host is an approved object-storage provider', async () => {
        await expect(uploadEncryptedBlob({
            uploadUrl: storageUrl,
            method: 'PUT',
        }, new Uint8Array([1, 2, 3]), credentials)).rejects.toThrow();

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        'https://bucket.s3.us-east-1.amazonaws.com/upload',
        'https://bucket.storage.googleapis.com/upload',
        'https://account.r2.cloudflarestorage.com/bucket/upload',
        'https://account.blob.core.windows.net/container/upload',
        'https://bucket.nyc3.digitaloceanspaces.com/upload',
        'https://s3.us-west-004.backblazeb2.com/bucket/upload',
        'https://bucket.s3.us-east-1.wasabisys.com/upload',
    ])('permits a no-redirect multipart upload only to a recognized storage endpoint: %s', async (uploadUrl) => {
        fetchMock.mockResolvedValueOnce(response({ ok: true }));

        await uploadEncryptedBlob({
            uploadUrl,
            method: 'POST',
            formFields: { key: 'sessions/session-1/attachments/ref.enc' },
        }, new Uint8Array([1, 2, 3]), credentials);

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
        expect(init.headers).toBeUndefined();
    });

    it('sends the bearer credential only to the exact configured server origin', async () => {
        fetchMock.mockResolvedValueOnce(response({ ok: true }));

        await uploadEncryptedBlob({
            uploadUrl: 'https://relay.example.test/v1/attachments/blob',
            method: 'PUT',
        }, new Uint8Array([1, 2, 3]), credentials);

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(init.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
        expect(init.redirect).toBe('error');
    });

    it('classifies POST blob upload network failures without leaking presigned data', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(uploadEncryptedBlob({
            uploadUrl: storageUrl,
            method: 'POST',
            formFields: {
                key: 'happy/session-1/ref',
                policy: 'secret-policy',
                'X-Amz-Signature': 's3-secret',
            },
        }, new Uint8Array([1, 2, 3]), credentials));

        expect(error.message).toBe('Blob upload (POST) network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'POST',
            host: storageHost,
            target: 'external-storage',
            message: 'Failed to fetch',
        });
        expect(cleanupFormFile).toHaveBeenCalledTimes(1);
        expectNoAttachmentLeaks(error);
    });

    it('classifies POST blob upload HTTP failures without leaking presigned query data', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
        }));

        const error = await rejectedError(uploadEncryptedBlob({
            uploadUrl: storageUrl,
            method: 'POST',
            formFields: {
                key: 'happy/session-1/ref',
                policy: 'secret-policy',
                'X-Amz-Signature': 's3-secret',
            },
        }, new Uint8Array([1, 2, 3]), credentials));

        expect(error.message).toBe('Blob upload (POST) failed: 403 Forbidden');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'POST',
            host: storageHost,
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden',
        });
        expect(cleanupFormFile).toHaveBeenCalledTimes(1);
        expectNoAttachmentLeaks(error);
    });

    it('classifies PUT blob upload network failures on the Idle API host without leaking query data', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(uploadEncryptedBlob({
            uploadUrl: apiBlobUrl,
            method: 'PUT',
        }, new Uint8Array([1, 2, 3]), credentials));

        expect(error.message).toBe('Blob upload (PUT) network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-upload',
            method: 'PUT',
            host: 'relay.example.test',
            target: 'idle-api',
            message: 'Failed to fetch',
        });
        expectNoAttachmentLeaks(error);
    });
});

describe('downloadEncryptedAttachment', () => {
    it('rejects a hostname-prefix lookalike without issuing the relay-selected download', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: 'https://relay.example.test.attacker.invalid/blob' },
            }));

        await expect(downloadEncryptedAttachment(credentials, 'session-1', 'ref')).rejects.toThrow();

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        'http://169.254.169.254/latest/meta-data',
        'https://[::1]/internal',
        'https://internal.invalid/download',
    ])('rejects an untrusted relay-selected download destination without fetching %s', async (downloadUrl) => {
        fetchMock.mockResolvedValueOnce(response({ ok: true, json: { downloadUrl } }));

        await expect(downloadEncryptedAttachment(credentials, 'session-1', 'ref')).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rewrites a literal loopback download to the exact configured relay origin', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: 'https://127.0.0.1/internal' },
            }))
            .mockResolvedValueOnce(response({
                ok: true,
                arrayBuffer: new Uint8Array([1, 2]).buffer,
            }));

        await expect(downloadEncryptedAttachment(credentials, 'session-1', 'ref'))
            .resolves.toEqual(new Uint8Array([1, 2]));
        const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect(url).toBe('https://relay.example.test/internal');
        expect(init).toMatchObject({
            redirect: 'error',
            headers: { Authorization: `Bearer ${credentials.token}` },
        });
    });

    it('rejects an attachment whose declared body exceeds the encrypted file ceiling', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: storageUrl },
            }))
            .mockResolvedValueOnce(response({
                ok: true,
                arrayBuffer: new Uint8Array().buffer,
                headers: { 'content-length': String(11 * 1024 * 1024) },
            }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'ref',
        ));

        expect(error.message).toContain('Attachment download body read error');
        expect(error.message).toContain('response limit');
    });

    it('classifies request-download network failures without leaking attachment refs', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('request-download network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-download',
            method: 'POST',
            host: 'relay.example.test',
            target: 'idle-api',
            message: 'Failed to fetch',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies request-download HTTP failures without leaking attachment refs', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: false,
            status: 404,
            statusText: 'Not Found',
        }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('request-download failed: 404');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-download',
            method: 'POST',
            host: 'relay.example.test',
            target: 'idle-api',
            status: 404,
            statusText: 'Not Found',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies request-download response parse failures without leaking attachment refs', async () => {
        fetchMock.mockResolvedValueOnce(response({
            ok: true,
            jsonError: new Error(`Invalid JSON for ref happy/session-1/ref at ${apiBlobUrl}`),
        }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toContain('request-download response parse error');
        expect(error.message).toContain('Invalid JSON');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'request-download',
            method: 'POST',
            host: 'relay.example.test',
            target: 'idle-api',
            message: expect.stringContaining('Invalid JSON'),
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies blob-download network failures without leaking presigned URL data', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: storageUrl },
            }))
            .mockRejectedValueOnce(new Error('Failed to fetch'));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('Attachment download network error: Failed to fetch');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: storageHost,
            target: 'external-storage',
            message: 'Failed to fetch',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies blob-download HTTP failures without leaking presigned query data', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: storageUrl },
            }))
            .mockResolvedValueOnce(response({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
            }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toBe('Attachment download failed: 403 Forbidden');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: storageHost,
            target: 'external-storage',
            status: 403,
            statusText: 'Forbidden',
        });
        expectNoAttachmentLeaks(error);
    });

    it('classifies blob-download body read failures against storage without leaking presigned URL data', async () => {
        fetchMock
            .mockResolvedValueOnce(response({
                ok: true,
                json: { downloadUrl: storageUrl },
            }))
            .mockResolvedValueOnce(response({
                ok: true,
                arrayBufferError: new Error(`stream reset for ${storageUrl} ref happy/session-1/ref`),
            }));

        const error = await rejectedError(downloadEncryptedAttachment(
            credentials,
            'session-1',
            'happy/session-1/ref',
        ));

        expect(error.message).toContain('Attachment download body read error');
        expect(error.message).toContain('stream reset');
        expect(getAttachmentDiagnostic(error)).toEqual({
            leg: 'blob-download',
            method: 'GET',
            host: storageHost,
            target: 'external-storage',
            message: expect.stringContaining('stream reset'),
        });
        expectNoAttachmentLeaks(error);
    });
});

function response(init: {
    ok: boolean;
    status?: number;
    statusText?: string;
    json?: unknown;
    jsonError?: unknown;
    arrayBuffer?: ArrayBuffer;
    arrayBufferError?: unknown;
    headers?: HeadersInit;
}): Response {
    const bodyError = init.jsonError ?? init.arrayBufferError;
    const body = bodyError !== undefined
        ? new ReadableStream<Uint8Array>({
            start(controller) {
                controller.error(bodyError);
            },
        })
        : init.json !== undefined
            ? JSON.stringify(init.json)
            : init.arrayBuffer ?? new Uint8Array();
    return new Response(body, {
        status: init.status ?? (init.ok ? 200 : 500),
        statusText: init.statusText ?? '',
        headers: init.headers,
    });
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (err) {
        expect(err).toBeInstanceOf(Error);
        return err as Error;
    }
    throw new Error('Expected promise to reject');
}

function expectNoAttachmentLeaks(error: Error): void {
    const serialized = JSON.stringify({
        message: error.message,
        diagnostic: getAttachmentDiagnostic(error),
    });

    expect(serialized).not.toContain(credentials.token);
    expect(serialized).not.toContain(`Bearer ${credentials.token}`);
    expect(serialized).not.toContain(storageUrl);
    expect(serialized).not.toContain(apiBlobUrl);
    expect(serialized).not.toContain('X-Amz-Signature');
    expect(serialized).not.toContain('s3-secret');
    expect(serialized).not.toContain('secret-policy');
    expect(serialized).not.toContain('happy/session-1/ref');
    expect(serialized).not.toContain('/idle/session-1/ref');
}
