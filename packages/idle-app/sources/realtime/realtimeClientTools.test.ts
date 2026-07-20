import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    confirm: vi.fn(),
    sessionAllow: vi.fn(),
    sessionDeny: vi.fn(),
    sendMessage: vi.fn(),
    trackVoicePermissionResponse: vi.fn(),
    agentStateTrusted: true,
    metadataTrusted: true,
    requestTool: 'Bash',
    requestArguments: { command: 'provider-secret-command' } as unknown,
    backgroundRequestEnabled: false,
    backgroundRequestId: 'request-2',
    backgroundRequestTool: 'Bash',
    backgroundRequestArguments: { command: 'background-command' } as unknown,
    voiceStarted: false,
    sendContextualUpdate: vi.fn(),
}));

vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/ops', () => ({
    sessionAllow: mocks.sessionAllow,
    sessionDeny: mocks.sessionDeny,
}));
vi.mock('@/track', () => ({ trackVoicePermissionResponse: mocks.trackVoicePermissionResponse }));
vi.mock('@/sync/storage', () => ({
    isAgentStateAuthenticatedForEffects: () => mocks.agentStateTrusted,
    isMetadataAuthenticatedForEffects: () => mocks.metadataTrusted,
    storage: {
        getState: () => ({
            sessions: {
                'session-1': {
                    metadata: { machineId: 'machine-1', path: '/project' },
                    agentState: {
                        requests: {
                            'request-1': {
                                tool: mocks.requestTool,
                                arguments: mocks.requestArguments,
                                createdAt: 1,
                            },
                        },
                    },
                },
                ...(mocks.backgroundRequestEnabled ? {
                    'session-2': {
                        metadata: { machineId: 'machine-2', path: '/background-project' },
                        agentState: {
                            requests: {
                                [mocks.backgroundRequestId]: {
                                    tool: mocks.backgroundRequestTool,
                                    arguments: mocks.backgroundRequestArguments,
                                    createdAt: 2,
                                },
                            },
                        },
                    },
                } : {}),
            },
        }),
    },
}));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.sendMessage } }));
vi.mock('@/sync/persistence', () => ({
    getVoiceMessageCount: vi.fn(() => 0),
    incrementVoiceMessageCount: vi.fn(),
}));
vi.mock('./RealtimeSession', () => ({
    getVoiceSession: vi.fn(() => ({ sendContextualUpdate: mocks.sendContextualUpdate })),
    isVoiceSessionStarted: vi.fn(() => mocks.voiceStarted),
}));

import { realtimeClientTools } from './realtimeClientTools';

describe('voice permission tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.agentStateTrusted = true;
        mocks.metadataTrusted = true;
        mocks.requestTool = 'Bash';
        mocks.requestArguments = { command: 'provider-secret-command' };
        mocks.backgroundRequestEnabled = false;
        mocks.backgroundRequestId = 'request-2';
        mocks.backgroundRequestTool = 'Bash';
        mocks.backgroundRequestArguments = { command: 'background-command' };
        mocks.voiceStarted = false;
    });

    it('requires an explicit local confirmation before allowing', async () => {
        mocks.confirm.mockResolvedValue(false);

        await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-1',
            decision: 'allow',
        });

        expect(mocks.confirm).toHaveBeenCalledTimes(1);
        const [title, review, options] = mocks.confirm.mock.calls[0];
        expect(title).toBe('settingsVoice.permissionConfirmTitle');
        expect(review).toContain('Target session: "session-1"');
        expect(review).toContain('Request: "request-1"');
        expect(review).toContain('"tool":"Bash"');
        expect(review).toContain('"command":"provider-secret-command"');
        expect(options).toEqual({
            cancelText: 'common.cancel',
            confirmText: 'common.yes',
            destructive: true,
        });
        expect(mocks.sessionAllow).not.toHaveBeenCalled();
        expect(mocks.trackVoicePermissionResponse).not.toHaveBeenCalled();
    });

    it('allows only after the local confirmation succeeds', async () => {
        mocks.confirm.mockResolvedValue(true);

        await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-1',
            decision: 'allow',
        });

        expect(mocks.sessionAllow).toHaveBeenCalledWith('session-1', 'request-1');
        expect(mocks.trackVoicePermissionResponse).toHaveBeenCalledWith(true);
    });

    it('does not allow a permission whose locally reviewed tool changes during confirmation', async () => {
        mocks.confirm.mockImplementation(async () => {
            mocks.requestTool = 'Write';
            return true;
        });

        const result = await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-1',
            decision: 'allow',
        });

        expect(result).toBe('error (permission request changed during confirmation)');
        expect(mocks.sessionAllow).not.toHaveBeenCalled();
    });

    it('does not allow a permission whose hidden local arguments change during confirmation', async () => {
        mocks.confirm.mockImplementation(async () => {
            mocks.requestArguments = { command: 'changed-command' };
            return true;
        });

        const result = await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-1',
            decision: 'allow',
        });

        expect(result).toBe('error (permission request changed during confirmation)');
        expect(mocks.sessionAllow).not.toHaveBeenCalled();
    });

    it('continues to permit fail-safe voice denials without confirmation', async () => {
        await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-1',
            decision: 'deny',
        });

        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.sessionDeny).toHaveBeenCalledWith('session-1', 'request-1');
    });

    it('does not act on a permission request from display-only legacy agent state', async () => {
        mocks.agentStateTrusted = false;

        const result = await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-1',
            decision: 'deny',
        });

        expect(result).toBe('error (permission request not found)');
        expect(mocks.sessionAllow).not.toHaveBeenCalled();
        expect(mocks.sessionDeny).not.toHaveBeenCalled();
        expect(mocks.trackVoicePermissionResponse).not.toHaveBeenCalled();
    });

    it('rejects oversized provider-controlled identifiers before looking up permissions', async () => {
        const result = await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'r'.repeat(129),
            decision: 'allow',
        });

        expect(result).toBe('error (invalid parameters)');
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.sessionAllow).not.toHaveBeenCalled();
    });

    it('renders same-tool requests with different arguments as different reviews', async () => {
        mocks.confirm.mockResolvedValue(false);

        await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-1',
            decision: 'allow',
        });
        const firstReview = mocks.confirm.mock.calls[0][1];

        mocks.requestArguments = { command: 'different-command' };
        await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-1',
            decision: 'allow',
        });
        const secondReview = mocks.confirm.mock.calls[1][1];

        expect(firstReview).not.toBe(secondReview);
        expect(secondReview).toContain('different-command');
    });

    it('fails closed when the exact permission request cannot be shown completely', async () => {
        mocks.requestArguments = { command: 'x'.repeat(20 * 1024) };

        const oversized = await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-1',
            decision: 'allow',
        });

        expect(oversized).toBe('error (permission request is not reviewable)');
        expect(mocks.confirm).not.toHaveBeenCalled();

        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        mocks.requestArguments = cyclic;
        const unserializable = await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-1',
            decision: 'allow',
        });

        expect(unserializable).toBe('error (permission request is not reviewable)');
        expect(mocks.confirm).not.toHaveBeenCalled();
    });

    it('visibly escapes direction-changing characters in the complete local review', async () => {
        mocks.confirm.mockResolvedValue(false);
        mocks.requestArguments = { command: 'reviewed-prefix\u202Ehidden-suffix' };

        await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-1',
            decision: 'allow',
        });

        const review = mocks.confirm.mock.calls[0][1] as string;
        expect(review).toContain('reviewed-prefix\\u202ehidden-suffix');
        expect(review).not.toContain('\u202E');
    });

    it('requires an exact authenticated session and request pair', async () => {
        mocks.backgroundRequestEnabled = true;

        const result = await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-1',
            requestId: 'request-2',
            decision: 'allow',
        });

        expect(result).toBe('error (permission request not found)');
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.sessionAllow).not.toHaveBeenCalled();
    });

    it('shows and dispatches the exact background session selected by the pair', async () => {
        mocks.backgroundRequestEnabled = true;
        mocks.confirm.mockResolvedValue(true);

        const result = await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-2',
            requestId: 'request-2',
            decision: 'allow',
        });

        expect(result).toBe("done [DO NOT say anything else, simply say 'done']");
        expect(mocks.confirm.mock.calls[0][1]).toContain('Target session: "session-2"');
        expect(mocks.confirm.mock.calls[0][1]).toContain('background-command');
        expect(mocks.sessionAllow).toHaveBeenCalledWith('session-2', 'request-2');
    });

    it('does not select duplicate request IDs by session iteration order', async () => {
        mocks.backgroundRequestEnabled = true;
        mocks.backgroundRequestId = 'request-1';
        mocks.confirm.mockResolvedValue(true);

        await realtimeClientTools.processPermissionRequest({
            sessionId: 'session-2',
            requestId: 'request-1',
            decision: 'allow',
        });

        expect(mocks.sessionAllow).toHaveBeenCalledWith('session-2', 'request-1');
        expect(mocks.confirm.mock.calls[0][1]).toContain('Target session: "session-2"');
    });

    it('rejects permission callbacks that omit the target session', async () => {
        const result = await realtimeClientTools.processPermissionRequest({
            requestId: 'request-1',
            decision: 'allow',
        });

        expect(result).toBe('error (invalid parameters)');
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.sessionAllow).not.toHaveBeenCalled();
    });

    it('rejects oversized provider-controlled messages before forwarding them to a session', async () => {
        const result = await realtimeClientTools.sendMessageToSession({
            sessionId: 'session-1',
            message: 'm'.repeat(1024 + 1),
        });

        expect(result).toBe('error (invalid parameters)');
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('shows the exact complete provider-originated message before forwarding it', async () => {
        mocks.confirm.mockResolvedValue(false);
        const message = 'provider-secret-message-content';

        const result = await realtimeClientTools.sendMessageToSession({
            sessionId: 'session-1',
            message,
        });

        expect(result).toBe('cancelled (local confirmation was not granted)');
        expect(mocks.confirm).toHaveBeenCalledWith(
            'settingsVoice.messageConfirmTitle',
            message,
            {
                cancelText: 'common.cancel',
                confirmText: 'common.yes',
            },
        );
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('does not let a hidden suffix pass beyond the complete local preview limit', async () => {
        mocks.confirm.mockResolvedValue(true);
        const unreviewableMessage = 'a'.repeat(1024) + 'UNREVIEWED-SUFFIX';

        const result = await realtimeClientTools.sendMessageToSession({
            sessionId: 'session-1',
            message: unreviewableMessage,
        });

        expect(result).toBe('error (invalid parameters)');
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('rejects provider text that could render differently from the sent message', async () => {
        mocks.confirm.mockResolvedValue(true);

        const result = await realtimeClientTools.sendMessageToSession({
            sessionId: 'session-1',
            message: 'reviewed prefix\u202Ehidden-directional-suffix',
        });

        expect(result).toBe('error (invalid parameters)');
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('rechecks the target authentication after local confirmation', async () => {
        mocks.confirm.mockImplementation(async () => {
            mocks.agentStateTrusted = false;
            mocks.metadataTrusted = false;
            return true;
        });

        const result = await realtimeClientTools.sendMessageToSession({
            sessionId: 'session-1',
            message: 'hello',
        });

        expect(result).toBe('error (session is no longer authenticated)');
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('sends exactly the complete locally reviewed message after target recheck', async () => {
        mocks.confirm.mockResolvedValue(true);
        mocks.voiceStarted = true;
        const message = 'hello\nsecond reviewed line';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const result = await realtimeClientTools.sendMessageToSession({
                sessionId: 'session-1',
                message,
            });

            expect(result).toBe("sent [DO NOT say anything else, simply say 'sent']");
            expect(result).not.toContain(message);
            expect(mocks.confirm.mock.calls[0]?.[1]).toBe(message);
            expect(mocks.sendMessage).toHaveBeenCalledWith('session-1', message, { source: 'voice' });
            expect(JSON.stringify(mocks.sendContextualUpdate.mock.calls)).not.toContain(message);
            expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(message);
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('does not send to a session known only through display-only legacy data', async () => {
        mocks.agentStateTrusted = false;
        mocks.metadataTrusted = false;

        const result = await realtimeClientTools.sendMessageToSession({
            sessionId: 'session-1',
            message: 'hello',
        });

        expect(result).toBe('error (session is not authenticated)');
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });
});
