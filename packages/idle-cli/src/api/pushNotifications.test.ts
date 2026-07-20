import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from './types';
import {
    PushNotificationClient,
    getSessionNotificationBody,
    getSessionNotificationCopy,
    getSessionNotificationTitle,
} from './pushNotifications';

const axiosMocks = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
}));

vi.mock('axios', () => ({
    default: axiosMocks,
}));

vi.mock('@/configuration', () => ({
    configuration: { currentCliVersion: '1.2.3' },
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

function makeMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/Users/test/projects/idle',
        host: 'test-host',
        homeDir: '/Users/test',
        idleHomeDir: '/Users/test/.idle',
        idleLibDir: '/Users/test/.idle/lib',
        idleToolsDir: '/Users/test/.idle/tools',
        ...overrides,
    };
}

describe('getSessionNotificationTitle', () => {
    it('maps done notifications to a ready title', () => {
        expect(getSessionNotificationTitle('done')).toBe("It's ready!");
    });

    it('maps permission notifications to a permission title', () => {
        expect(getSessionNotificationTitle('permission')).toBe('Permission request');
    });

    it('maps question notifications to a clarification title', () => {
        expect(getSessionNotificationTitle('question')).toBe('Clarification needed');
    });
});

describe('getSessionNotificationBody', () => {
    it('never exposes the session summary', () => {
        const metadata = makeMetadata({
            summary: {
                text: 'Confidential customer and repository details',
                updatedAt: 1,
            }
        });

        expect(getSessionNotificationBody(metadata)).toBe('Open Idle to review this session.');
        expect(getSessionNotificationBody(metadata)).not.toContain('Confidential');
    });

    it('never exposes a private workspace path', () => {
        const metadata = makeMetadata({
            path: '/Users/test/projects/secret-client-repository',
        });

        expect(getSessionNotificationBody(metadata)).toBe('Open Idle to review this session.');
        expect(getSessionNotificationBody(metadata)).not.toContain('secret-client-repository');
    });

    it('falls back to a generic label when metadata is missing', () => {
        expect(getSessionNotificationBody(null)).toBe('Open Idle to review this session.');
    });
});

describe('getSessionNotificationCopy', () => {
    it('returns event context without session metadata', () => {
        const metadata = makeMetadata({
            summary: {
                text: 'Fix push notifications',
                updatedAt: 1,
            }
        });

        expect(getSessionNotificationCopy('done', metadata)).toEqual({
            title: "It's ready!",
            body: 'Open Idle to review this session.',
        });
    });
});

describe('PushNotificationClient bearer transport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not follow redirects while fetching device tokens', async () => {
        axiosMocks.get.mockResolvedValueOnce({ data: { tokens: [] } });
        const client = new PushNotificationClient('opaque-token', 'https://relay.example.test');

        await expect(client.fetchPushTokens()).resolves.toEqual([]);

        expect(axiosMocks.get.mock.calls[0][1]).toMatchObject({ maxRedirects: 0 });
    });

    it('does not follow redirects while dispatching a session event', async () => {
        axiosMocks.post.mockResolvedValueOnce({ status: 204 });
        const client = new PushNotificationClient('opaque-token', 'https://relay.example.test');

        client.sendSessionNotification({
            kind: 'done',
            metadata: null,
            data: { sessionId: 'session-1' },
        });

        await vi.waitFor(() => expect(axiosMocks.post).toHaveBeenCalledTimes(1));
        expect(axiosMocks.post.mock.calls[0][2]).toMatchObject({ maxRedirects: 0 });
    });
});
