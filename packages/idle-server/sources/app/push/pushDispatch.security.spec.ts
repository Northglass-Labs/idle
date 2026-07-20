import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, isUserActiveMock, logMock, sendPushNotificationsMock } = vi.hoisted(() => ({
    dbMock: {
        accountPushToken: {
            findMany: vi.fn(),
            deleteMany: vi.fn(),
        },
    },
    isUserActiveMock: vi.fn(),
    logMock: vi.fn(),
    sendPushNotificationsMock: vi.fn(),
}));

vi.mock('../../storage/db', () => ({ db: dbMock }));
vi.mock('./focusTracker', () => ({ isUserActive: isUserActiveMock }));
vi.mock('./pushSend', () => ({ sendPushNotifications: sendPushNotificationsMock }));
vi.mock('../../utils/log', () => ({ log: logMock }));

import { dispatchSessionEventPush } from './pushDispatch';

describe('push notification fanout quota', () => {
    const pushTokenLimit = 20;

    beforeEach(() => {
        vi.clearAllMocks();
        isUserActiveMock.mockResolvedValue(false);
        sendPushNotificationsMock.mockImplementation(async (messages: unknown[]) => (
            messages.map(() => ({ status: 'ok' }))
        ));
    });

    it('sends to at most the newest account tokens when legacy rows exceed the cap', async () => {
        dbMock.accountPushToken.findMany.mockResolvedValue(
            Array.from({ length: pushTokenLimit + 5 }, (_, index) => ({
                id: `row-${index}`,
                token: `device-token-${index}`,
            })),
        );

        await dispatchSessionEventPush({
            userId: 'account-1',
            sessionId: 'session-1',
            title: 'Permission request',
            body: 'Open Idle to review this session.',
            data: { kind: 'permission' },
        });

        expect(dbMock.accountPushToken.findMany).toHaveBeenCalledWith({
            where: { accountId: 'account-1' },
            orderBy: { updatedAt: 'desc' },
            take: pushTokenLimit,
        });
        const messages = sendPushNotificationsMock.mock.calls[0][0];
        expect(messages).toHaveLength(pushTokenLimit);
        expect(messages.map((message: { to: string }) => message.to)).toEqual(
            Array.from({ length: pushTokenLimit }, (_, index) => `device-token-${index}`),
        );
    });

    it('keeps account, session, token, and upstream error prose out of diagnostics', async () => {
        dbMock.accountPushToken.findMany.mockResolvedValue([{
            id: 'private-token-row',
            token: 'private-device-token',
        }]);
        sendPushNotificationsMock.mockResolvedValue([{
            status: 'error',
            message: 'provider response with private endpoint detail',
            details: { error: 'MessageTooBig' },
        }]);

        await dispatchSessionEventPush({
            userId: 'private-account-id',
            sessionId: 'private-session-id',
            title: 'Permission request',
            body: 'Open Idle to review this session.',
        });

        const diagnostics = JSON.stringify(logMock.mock.calls);
        expect(diagnostics).not.toContain('private-account-id');
        expect(diagnostics).not.toContain('private-session-id');
        expect(diagnostics).not.toContain('private-device-token');
        expect(diagnostics).not.toContain('provider response with private endpoint detail');
        expect(diagnostics).not.toContain('MessageTooBig');
    });
});
