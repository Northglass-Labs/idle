import { describe, it, expect } from 'vitest';
import { createOfflineSessionStub } from './offlineSessionStub';

describe('createOfflineSessionStub', () => {
    it('sets sessionId to "offline-<tag>"', () => {
        const stub = createOfflineSessionStub('abc123');
        expect(stub.sessionId).toBe('offline-abc123');
    });

    it('uses the exact tag string provided in the sessionId', () => {
        const stub = createOfflineSessionStub('my-session-tag');
        expect(stub.sessionId).toBe('offline-my-session-tag');
    });

    it('each call with the same tag returns an object with the same sessionId', () => {
        const a = createOfflineSessionStub('same');
        const b = createOfflineSessionStub('same');
        expect(a.sessionId).toBe(b.sessionId);
    });

    it('different tags produce different sessionIds', () => {
        const a = createOfflineSessionStub('tag-a');
        const b = createOfflineSessionStub('tag-b');
        expect(a.sessionId).not.toBe(b.sessionId);
    });

    it('synchronous no-op methods do not throw', () => {
        const stub = createOfflineSessionStub('test');
        expect(() => (stub as any).sendCodexMessage()).not.toThrow();
        expect(() => (stub as any).sendAgentMessage()).not.toThrow();
        expect(() => (stub as any).sendClaudeSessionMessage()).not.toThrow();
        expect(() => (stub as any).keepAlive()).not.toThrow();
        expect(() => (stub as any).sendSessionEvent()).not.toThrow();
        expect(() => (stub as any).sendSessionDeath()).not.toThrow();
        expect(() => (stub as any).updateLifecycleState()).not.toThrow();
        expect(() => (stub as any).updateMetadata()).not.toThrow();
        expect(() => (stub as any).updateAgentState()).not.toThrow();
        expect(() => (stub as any).onUserMessage()).not.toThrow();
    });

    it('async no-op methods resolve without error', async () => {
        const stub = createOfflineSessionStub('test');
        await expect((stub as any).requestControlTransfer()).resolves.toBeUndefined();
        await expect((stub as any).flush()).resolves.toBeUndefined();
        await expect((stub as any).close()).resolves.toBeUndefined();
    });

    it('rpcHandlerManager.registerHandler is a no-op that does not throw', () => {
        const stub = createOfflineSessionStub('test');
        expect(() => (stub as any).rpcHandlerManager.registerHandler('foo', () => {})).not.toThrow();
    });

    it('synchronous methods return undefined (not a value)', () => {
        const stub = createOfflineSessionStub('test');
        const result = (stub as any).keepAlive();
        expect(result).toBeUndefined();
    });

    it('flush returns a Promise (async no-op)', () => {
        const stub = createOfflineSessionStub('test');
        const result = (stub as any).flush();
        expect(result).toBeInstanceOf(Promise);
    });

    it('calling the same method multiple times does not accumulate side effects', () => {
        const stub = createOfflineSessionStub('test');
        // No state should change across multiple calls
        expect(() => {
            for (let i = 0; i < 10; i++) {
                (stub as any).keepAlive();
                (stub as any).sendSessionEvent();
            }
        }).not.toThrow();
        // sessionId should remain unchanged
        expect(stub.sessionId).toBe('offline-test');
    });
});
