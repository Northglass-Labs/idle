import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from './api';
import axios from 'axios';
import { connectionState } from '@/utils/serverConnectionErrors';

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const {
    mockPost,
    mockIsAxiosError,
    mockLoggerDebug,
    mockGetOrCreateSessionCreateIdentity,
} = vi.hoisted(() => ({
    mockPost: vi.fn(),
    mockIsAxiosError: vi.fn(() => true),
    mockLoggerDebug: vi.fn(),
    mockGetOrCreateSessionCreateIdentity: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        post: mockPost,
        isAxiosError: mockIsAxiosError
    },
    isAxiosError: mockIsAxiosError
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: mockLoggerDebug,
    }
}));

// Mock encryption utilities
vi.mock('./encryption', () => ({
    decodeBase64: vi.fn((data: string) => new Uint8Array(Buffer.from(data, 'base64'))),
    encodeBase64: vi.fn((data: Uint8Array) => Buffer.from(data).toString('base64')),
    decrypt: vi.fn((_key: any, _variant: any, data: Uint8Array) => (
        JSON.parse(new TextDecoder().decode(data))
    )),
    encrypt: vi.fn((_key: any, _variant: any, data: any) => (
        new TextEncoder().encode(JSON.stringify(data))
    )),
    getRandomBytes: vi.fn((size: number) => new Uint8Array(size).fill(7)),
    libsodiumEncryptForPublicKey: vi.fn(() => new Uint8Array(48).fill(8)),
}));

// Mock configuration
vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://api.example.com',
        idleHomeDir: '/private/idle-test',
        currentCliVersion: '0.0.0-test',
    }
}));

vi.mock('./sessionCreateIdentity', () => ({
    getOrCreateSessionCreateIdentity: mockGetOrCreateSessionCreateIdentity,
}));

// Global test metadata
const testMetadata = {
    path: '/tmp',
    host: 'localhost',
    homeDir: '/home/user',
    idleHomeDir: '/home/user/.idle',
    idleLibDir: '/home/user/.idle/lib',
    idleToolsDir: '/home/user/.idle/tools'
};

const testMachineMetadata = {
    host: 'localhost',
    platform: 'darwin',
    idleCliVersion: '1.0.0',
    homeDir: '/home/user',
    idleHomeDir: '/home/user/.idle',
    idleLibDir: '/home/user/.idle/lib'
};

describe('Api server error handling', () => {
    let api: ApiClient;

    beforeEach(async () => {
        vi.clearAllMocks();
        connectionState.reset(); // Reset offline state between tests
        mockGetOrCreateSessionCreateIdentity.mockResolvedValue({
            tagFingerprint: 'a'.repeat(64),
            sessionId: '11111111-1111-4111-8111-111111111111',
            encryptionKey: new Uint8Array(32).fill(9),
        });

        // Create a mock credential
        const mockCredential = {
            token: 'fake-token',
            encryption: {
                type: 'legacy' as const,
                secret: new Uint8Array(32)
            }
        };

        api = await ApiClient.create(mockCredential);
    });

    describe('getOrCreateSession', () => {
        it('negotiates the current create contract before an older relay can mutate state', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            mockPost.mockRejectedValueOnce({
                response: { status: 404 },
                isAxiosError: true,
            });

            await expect(api.getOrCreateSession({
                tag: 'requires-current-relay',
                metadata: testMetadata,
                state: null,
            })).resolves.toBeNull();
            expect(mockPost).toHaveBeenCalledTimes(1);
            expect(mockPost).toHaveBeenCalledWith(
                'https://api.example.com/v2/sessions',
                expect.any(Object),
                expect.any(Object),
            );
            consoleSpy.mockRestore();
        });

        it('retains and reuses one durable data-key identity across acknowledged retries', async () => {
            const dataKeyApi = await ApiClient.create({
                token: 'fake-token',
                encryption: {
                    type: 'dataKey' as const,
                    publicKey: new Uint8Array(32).fill(3),
                    machineKey: new Uint8Array(32).fill(4),
                },
            });
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            mockPost
                .mockRejectedValueOnce({ code: 'ECONNRESET' })
                .mockImplementation(async (_url: string, body: any) => ({
                    data: {
                        session: {
                            id: body.id,
                            seq: 0,
                            createdAt: 1,
                            updatedAt: 1,
                            active: true,
                            activeAt: 1,
                            metadata: body.metadata,
                            metadataVersion: 0,
                            agentState: null,
                            agentStateVersion: 0,
                            dataEncryptionKey: body.dataEncryptionKey,
                        },
                    },
                }));

            await expect(dataKeyApi.getOrCreateSession({
                tag: 'retry-data-key-session',
                metadata: testMetadata,
                state: null,
            })).resolves.toBeNull();
            await expect(dataKeyApi.getOrCreateSession({
                tag: 'retry-data-key-session',
                metadata: testMetadata,
                state: null,
            })).resolves.toMatchObject({
                id: '11111111-1111-4111-8111-111111111111',
                encryptionVariant: 'dataKey',
            });
            await expect(dataKeyApi.getOrCreateSession({
                tag: 'retry-data-key-session',
                metadata: testMetadata,
                state: null,
            })).resolves.toMatchObject({
                id: '11111111-1111-4111-8111-111111111111',
                encryptionVariant: 'dataKey',
            });

            expect(mockGetOrCreateSessionCreateIdentity).toHaveBeenCalledTimes(3);
            expect(mockGetOrCreateSessionCreateIdentity).toHaveBeenCalledWith(
                'retry-data-key-session',
                new Uint8Array(32).fill(4),
            );
            expect(mockPost).toHaveBeenCalledTimes(3);
            const firstBody = mockPost.mock.calls[0][1];
            const secondBody = mockPost.mock.calls[1][1];
            const thirdBody = mockPost.mock.calls[2][1];
            expect(mockPost.mock.calls.map((call) => call[0])).toEqual([
                'https://api.example.com/v2/sessions',
                'https://api.example.com/v2/sessions',
                'https://api.example.com/v2/sessions',
            ]);
            expect(secondBody.id).toBe(firstBody.id);
            expect(secondBody.metadata).toEqual(firstBody.metadata);
            expect(thirdBody.id).toBe(firstBody.id);
            expect(thirdBody.metadata).toEqual(firstBody.metadata);
            expect(mockPost.mock.calls[0][2]).toMatchObject({
                timeout: 60_000,
                maxContentLength: 256 * 1024,
                maxBodyLength: 128 * 1024,
                maxRedirects: 0,
            });
            const debugOutput = mockLoggerDebug.mock.calls.flat().map(String).join('\n');
            expect(debugOutput).not.toContain('retry-data-key-session');
            expect(debugOutput).not.toContain(firstBody.id);
            consoleSpy.mockRestore();
        });

        it.each([
            ['oversized ID', { id: 'x'.repeat(65) }],
            ['unsafe metadata version', { metadataVersion: Number.MAX_SAFE_INTEGER + 1 }],
            ['oversized encrypted metadata', { metadata: 'x'.repeat((16 * 1024) + 1) }],
        ])('rejects an invalid %s before decryption', async (_label, invalidFields) => {
            mockPost.mockImplementationOnce(async (_url: string, body: any) => ({
                data: {
                    session: {
                        id: body.id,
                        seq: 0,
                        createdAt: 1,
                        updatedAt: 1,
                        active: true,
                        activeAt: 1,
                        metadata: body.metadata,
                        metadataVersion: 0,
                        agentState: null,
                        agentStateVersion: 0,
                        dataEncryptionKey: null,
                        ...invalidFields,
                    },
                },
            }));

            await expect(api.getOrCreateSession({
                tag: 'invalid-relay-response',
                metadata: testMetadata,
                state: null,
            })).rejects.toThrow('Relay returned an invalid session response');
        });

        it('rejects an invalid tag before creating a local retry record or relay request', async () => {
            const dataKeyApi = await ApiClient.create({
                token: 'fake-token',
                encryption: {
                    type: 'dataKey' as const,
                    publicKey: new Uint8Array(32).fill(3),
                    machineKey: new Uint8Array(32).fill(4),
                },
            });

            await expect(dataKeyApi.getOrCreateSession({
                tag: 'x'.repeat(129),
                metadata: testMetadata,
                state: null,
            })).rejects.toThrow('Session tag must be between 1 and 128 characters');
            expect(mockGetOrCreateSessionCreateIdentity).not.toHaveBeenCalled();
            expect(mockPost).not.toHaveBeenCalled();
        });

        it('should return null when Idle server is unreachable (ECONNREFUSED)', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Idle server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when Idle server cannot be found (ENOTFOUND)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw DNS resolution error
            mockPost.mockRejectedValue({ code: 'ENOTFOUND' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Idle server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when Idle server times out (ETIMEDOUT)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw timeout error
            mockPost.mockRejectedValue({ code: 'ETIMEDOUT' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Idle server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('retains retry state when Axios aborts a timed-out session request (ECONNABORTED)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            const dataKeyApi = await ApiClient.create({
                token: 'fake-token',
                encryption: {
                    type: 'dataKey' as const,
                    publicKey: new Uint8Array(32).fill(3),
                    machineKey: new Uint8Array(32).fill(4),
                },
            });

            mockPost
                .mockRejectedValueOnce({ code: 'ECONNABORTED' })
                .mockImplementationOnce(async (_url: string, body: any) => ({
                    data: {
                        session: {
                            id: body.id,
                            seq: 0,
                            createdAt: 1,
                            updatedAt: 1,
                            active: true,
                            activeAt: 1,
                            metadata: body.metadata,
                            metadataVersion: 0,
                            agentState: null,
                            agentStateVersion: 0,
                            dataEncryptionKey: body.dataEncryptionKey,
                        },
                    },
                }));

            await expect(dataKeyApi.getOrCreateSession({
                tag: 'timeout-retry-tag',
                metadata: testMetadata,
                state: null,
            })).resolves.toBeNull();
            await expect(dataKeyApi.getOrCreateSession({
                tag: 'timeout-retry-tag',
                metadata: testMetadata,
                state: null,
            })).resolves.toMatchObject({
                id: '11111111-1111-4111-8111-111111111111',
                encryptionVariant: 'dataKey',
            });
            expect(mockGetOrCreateSessionCreateIdentity).toHaveBeenCalledTimes(2);
            expect(mockPost.mock.calls[1][1].id).toBe(mockPost.mock.calls[0][1].id);
            expect(mockPost.mock.calls[1][1].metadata).toEqual(mockPost.mock.calls[0][1].metadata);
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Idle server unreachable'),
            );

            consoleSpy.mockRestore();
        });

        it('should return null when session endpoint returns 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            const privateMarker = 'private-session-endpoint-detail';

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404, data: privateMarker },
                message: privateMarker,
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            // New unified format via connectionState.fail()
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Idle server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledTimes(1);
            expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('404'));
            expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining(privateMarker));
            expect(JSON.stringify(mockLoggerDebug.mock.calls)).not.toContain(privateMarker);

            consoleSpy.mockRestore();
        });

        it('should return null when server returns 500 Internal Server Error', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 500 error
            mockPost.mockRejectedValue({
                response: { status: 500 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Idle server unreachable')
            );
            consoleSpy.mockRestore();
        });

        it('should return null when server returns 503 Service Unavailable', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 503 error
            mockPost.mockRejectedValue({
                response: { status: 503 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Idle server unreachable')
            );
            consoleSpy.mockRestore();
        });

        it('should re-throw non-connection errors', async () => {
            // Mock axios to throw a different type of error (e.g., authentication error)
            const authError = new Error('Invalid API key');
            (authError as any).code = 'UNAUTHORIZED';
            mockPost.mockRejectedValue(authError);

            await expect(
                api.getOrCreateSession({ tag: 'test-tag', metadata: testMetadata, state: null })
            ).rejects.toThrow('Failed to get or create session: Invalid API key');

            // Should not show the offline mode message
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            expect(consoleSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Idle server unreachable')
            );
            consoleSpy.mockRestore();
        });
    });

    describe('getOrCreateMachine', () => {
        it('never follows a redirect while sending the account bearer', async () => {
            mockPost.mockResolvedValueOnce({
                data: {
                    machine: {
                        id: 'test-machine',
                        metadata: Buffer.from(JSON.stringify(testMachineMetadata)).toString('base64'),
                        metadataVersion: 0,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                },
            });

            await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
            });

            expect(mockPost.mock.calls[0][2]).toMatchObject({ maxRedirects: 0 });
        });

        it('should return minimal machine object when server is unreachable (ECONNREFUSED)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                daemonState: {
                    status: 'running',
                    pid: 1234
                }
            });

            expect(result).toEqual({
                id: 'test-machine',
                encryptionKey: expect.any(Uint8Array),
                encryptionVariant: 'legacy',
                metadata: testMachineMetadata,
                metadataVersion: 0,
                daemonState: {
                    status: 'running',
                    pid: 1234
                },
                daemonStateVersion: 0,
            });

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Idle server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return minimal machine object when server endpoint returns 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            const privateMarker = 'private-machine-endpoint-detail';

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404, data: privateMarker },
                message: privateMarker,
                isAxiosError: true
            });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            });

            expect(result).toEqual({
                id: 'test-machine',
                encryptionKey: expect.any(Uint8Array),
                encryptionVariant: 'legacy',
                metadata: testMachineMetadata,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            });

            // New unified format via connectionState.fail()
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Idle server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledTimes(1);
            expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('404'));
            expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining(privateMarker));
            expect(JSON.stringify(mockLoggerDebug.mock.calls)).not.toContain(privateMarker);

            consoleSpy.mockRestore();
        });
    });

    it('never follows a redirect while deactivating a session with the bearer', async () => {
        mockPost.mockResolvedValueOnce({ status: 200 });

        await expect(api.deactivateSession('session-1')).resolves.toBe(true);

        expect(mockPost.mock.calls[0][2]).toMatchObject({ maxRedirects: 0 });
    });
});
