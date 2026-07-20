import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiSessionClient } from './apiSession';
import { mkdirSync, rmSync } from 'node:fs';

const {
    mockAxiosGet,
    mockAxiosPost,
    mockAxiosPut,
    mockIo,
    testConfiguration,
} = vi.hoisted(() => ({
    mockAxiosGet: vi.fn(),
    mockAxiosPost: vi.fn(),
    mockAxiosPut: vi.fn(),
    mockIo: vi.fn(),
    testConfiguration: {
        idleHomeDir: `/tmp/idle-attachment-policy-${process.pid}`,
    },
}));

vi.mock('axios', () => ({
    default: {
        get: mockAxiosGet,
        post: mockAxiosPost,
        put: mockAxiosPut,
    },
}));

vi.mock('socket.io-client', () => ({ io: mockIo }));

vi.mock('@/configuration', () => ({
    configuration: {
        currentCliVersion: 'test',
        serverUrl: 'https://server.test',
        idleHomeDir: testConfiguration.idleHomeDir,
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
    },
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
    },
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn(),
}));

vi.mock('@/utils/time', () => ({
    backoff: vi.fn(async <T>(callback: () => Promise<T>) => callback()),
    delay: vi.fn(async () => undefined),
}));

vi.mock('@/utils/lidState', () => ({ shouldReconnect: vi.fn(() => false) }));

function credentialedTestUrl(hostAndPath: string): string {
    const url = new URL(`https://${hostAndPath}`);
    url.username = 'test-user';
    url.password = 'test-password';
    return url.toString();
}

function createClient(): ApiSessionClient {
    return new ApiSessionClient('ordinary-api-token', {
        id: 'test-session-id',
        seq: 0,
        metadata: {
            path: '/workspace',
            host: 'test-host',
            homeDir: '/home/test',
            idleHomeDir: '/home/test/.idle',
            idleLibDir: '/home/test/.idle/lib',
            idleToolsDir: '/home/test/.idle/tools',
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    });
}

describe('attachment transfer URL policy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mkdirSync(testConfiguration.idleHomeDir, { recursive: true, mode: 0o700 });
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            on: vi.fn(),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            close: vi.fn(),
        });
    });

    afterAll(() => {
        rmSync(testConfiguration.idleHomeDir, { recursive: true, force: true });
    });

    it('rejects a prefix-matching upload host before transmitting bytes', async () => {
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                ref: 'opaque-ref',
                uploadUrl: 'https://server.test.evil.example/upload',
                method: 'PUT',
            },
        });
        const client = createClient();

        await expect(client.uploadLocalImageAttachmentEnvelope({
            data: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            name: 'image.png',
        })).rejects.toThrow('Attachment transfer URL is not allowed');
        expect(mockAxiosPut).not.toHaveBeenCalled();
    });

    it('rejects a prefix-matching download host before requesting bytes', async () => {
        mockAxiosPost.mockResolvedValueOnce({
            data: { downloadUrl: 'https://server.test.evil.example/download' },
        });
        const client = createClient();

        await expect(client.downloadAttachment('opaque-ref')).rejects.toThrow(
            'Attachment transfer URL is not allowed',
        );
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it.each([
        'http://external.example/upload',
        'ftp://external.example/upload',
        credentialedTestUrl('external.example/upload'),
        'https://127.0.0.1/internal',
        'https://169.254.169.254/latest/meta-data',
        'https://internal.example/upload',
        'https://bucket.s3.us-east-1.amazonaws.com.attacker.example/upload',
    ])('rejects unsafe provider-controlled upload URL %s', async (uploadUrl) => {
        mockAxiosPost.mockResolvedValueOnce({
            data: { ref: 'opaque-ref', uploadUrl, method: 'PUT' },
        });
        const client = createClient();

        await expect(client.uploadLocalImageAttachmentEnvelope({
            data: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            name: 'image.png',
        })).rejects.toThrow('Attachment transfer URL is not allowed');
        expect(mockAxiosPut).not.toHaveBeenCalled();
    });

    it('accepts a recognized object-storage POST without adding the Idle bearer', async () => {
        const storageUrl = 'https://bucket.s3.us-east-1.amazonaws.com/upload?X-Amz-Signature=test';
        mockAxiosPost
            .mockResolvedValueOnce({
                data: {
                    ref: 'opaque-ref',
                    uploadUrl: storageUrl,
                    method: 'POST',
                    formFields: { key: 'opaque-ref', policy: 'bounded-policy' },
                },
            })
            .mockResolvedValueOnce({ data: null });
        const client = createClient();

        await client.uploadLocalImageAttachmentEnvelope({
            data: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            name: 'image.png',
        });

        const [, , config] = mockAxiosPost.mock.calls[1] as [string, unknown, {
            headers: Record<string, string>;
            maxRedirects?: number;
        }];
        expect(config.headers.Authorization).toBeUndefined();
        expect(config.maxRedirects).toBe(0);
    });

    it('does not permit raw PUT uploads to an external object-storage origin', async () => {
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                ref: 'opaque-ref',
                uploadUrl: 'https://bucket.s3.us-east-1.amazonaws.com/upload',
                method: 'PUT',
            },
        });
        const client = createClient();

        await expect(client.uploadLocalImageAttachmentEnvelope({
            data: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            name: 'image.png',
        })).rejects.toThrow('Attachment transfer URL is not allowed');
        expect(mockAxiosPut).not.toHaveBeenCalled();
    });

    it.each([
        'http://external.example/download',
        'file:///private/file',
        credentialedTestUrl('external.example/download'),
    ])('rejects unsafe provider-controlled download URL %s', async (downloadUrl) => {
        mockAxiosPost.mockResolvedValueOnce({ data: { downloadUrl } });
        const client = createClient();

        await expect(client.downloadAttachment('opaque-ref')).rejects.toThrow(
            'Attachment transfer URL is not allowed',
        );
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('accepts a recognized object-storage download without adding the Idle bearer', async () => {
        const storageUrl = 'https://bucket.s3.us-east-1.amazonaws.com/download?X-Amz-Signature=test';
        mockAxiosPost.mockResolvedValueOnce({ data: { downloadUrl: storageUrl } });
        mockAxiosGet.mockResolvedValueOnce({ data: Buffer.from([1, 2, 3]) });
        const client = createClient();

        await expect(client.downloadAttachment('opaque-ref')).resolves.toEqual(new Uint8Array([1, 2, 3]));

        const config = mockAxiosGet.mock.calls[0][1] as {
            headers: Record<string, string>;
            maxRedirects?: number;
        };
        expect(config.headers.Authorization).toBeUndefined();
        expect(config.maxRedirects).toBe(0);
    });
});
