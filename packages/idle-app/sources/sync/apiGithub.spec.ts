import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { disconnectGitHub, getAccountProfile } from './apiGithub';
import { AuthCredentials } from '@/auth/tokenStorage';

// Mock the serverConfig
vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.test.com'
}));

// Mock apiSocket to avoid pulling React Native modules into this unit test.
vi.mock('./apiSocket', () => ({
    getIdleClientId: () => 'test-client'
}));

// Mock backoff utility
vi.mock('@/utils/time', () => ({
    backoff: vi.fn((fn) => fn())
}));

describe('apiGithub', () => {
    const mockCredentials: AuthCredentials = {
        token: 'test-token',
        secret: 'test-secret'
    };

    beforeEach(() => {
        // Reset all mocks before each test
        vi.clearAllMocks();
        // Mock global fetch
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('disconnectGitHub', () => {
        it('should successfully disconnect GitHub account', async () => {
            // Mock successful response
            const mockResponse = jsonResponse({ success: true });
            global.fetch = vi.fn().mockResolvedValue(mockResponse);

            await expect(disconnectGitHub(mockCredentials)).resolves.toBeUndefined();

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.test.com/v1/connect/github',
                {
                    method: 'DELETE',
                    headers: {
                        'Authorization': 'Bearer test-token',
                        'X-Happy-Client': 'test-client'
                    }
                }
            );
        });

        it('should throw error when GitHub account is not connected', async () => {
            // Mock 404 response
            const mockResponse = jsonResponse(
                { error: 'GitHub account not connected' },
                404,
            );
            global.fetch = vi.fn().mockResolvedValue(mockResponse);

            await expect(disconnectGitHub(mockCredentials))
                .rejects.toThrow('GitHub account not connected');
        });

        it('does not reflect a relay error body into the disconnect failure', async () => {
            const sensitiveMarker = 'private-github-account-marker';
            global.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: sensitiveMarker }, 404));

            const failure = await disconnectGitHub(mockCredentials).catch((error) => error);

            expect(failure.message).toBe('GitHub account not connected');
            expect(failure.message).not.toContain(sensitiveMarker);
        });

        it('should throw error when server returns non-success response', async () => {
            // Mock successful HTTP response but unsuccessful operation
            const mockResponse = jsonResponse({ success: false });
            global.fetch = vi.fn().mockResolvedValue(mockResponse);

            await expect(disconnectGitHub(mockCredentials))
                .rejects.toThrow('Failed to disconnect GitHub account');
        });

        it('should throw generic error for other HTTP errors', async () => {
            // Mock 500 response
            const mockResponse = jsonResponse({ error: 'Internal server error' }, 500);
            global.fetch = vi.fn().mockResolvedValue(mockResponse);

            await expect(disconnectGitHub(mockCredentials))
                .rejects.toThrow('Failed to disconnect GitHub: 500');
        });
    });

    describe('getAccountProfile', () => {
        const response = {
            id: 'account-1',
            timestamp: 1,
            firstName: null,
            lastName: null,
            username: null,
            avatar: null,
            github: null,
        };

        it('accepts the profile contract without provider-token state', async () => {
            global.fetch = vi.fn().mockResolvedValue(jsonResponse(response));

            await expect(getAccountProfile(mockCredentials)).resolves.toEqual({
                id: 'account-1',
                timestamp: 1,
                github: null,
            });
        });

        it('rejects reintroduced generic connected-service state', async () => {
            global.fetch = vi.fn().mockResolvedValue(jsonResponse({
                ...response,
                connectedServices: ['anthropic'],
            }));

            await expect(getAccountProfile(mockCredentials)).rejects.toThrow();
        });
    });
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}
