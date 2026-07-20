import { describe, expect, it } from 'vitest';

import {
    RpcCallDataSchema,
    RpcRegisterDataSchema,
    RpcUnregisterDataSchema,
} from './rpcSchemas';

describe('RPC wire envelope bounds', () => {
    it('accepts current scoped methods and encrypted string parameters', () => {
        expect(RpcRegisterDataSchema.safeParse({ method: 'session-1:goal-action' }).success).toBe(true);
        expect(RpcUnregisterDataSchema.safeParse({ method: 'session-1:goal-action' }).success).toBe(true);
        expect(RpcCallDataSchema.safeParse({ method: 'machine-1:spawn-idle-session', params: 'ciphertext' }).success).toBe(true);
    });

    it('rejects missing, empty, overlong, and non-string registration methods', () => {
        expect(RpcRegisterDataSchema.safeParse({}).success).toBe(false);
        expect(RpcRegisterDataSchema.safeParse({ method: '' }).success).toBe(false);
        expect(RpcRegisterDataSchema.safeParse({ method: `scope:${'x'.repeat(65)}` }).success).toBe(false);
        expect(RpcRegisterDataSchema.safeParse({ method: 42 }).success).toBe(false);
        expect(RpcRegisterDataSchema.safeParse({ method: null }).success).toBe(false);
    });

    it('rejects malformed unregister envelopes', () => {
        expect(RpcUnregisterDataSchema.safeParse(null).success).toBe(false);
        expect(RpcUnregisterDataSchema.safeParse('session-1:bash').success).toBe(false);
        expect(RpcUnregisterDataSchema.safeParse({ method: 'session-1:bash', extra: true }).success).toBe(false);
    });

    it('rejects unscoped, multiply-scoped, and malformed method names', () => {
        for (const method of ['bash', 'session-1:bash:other', ':bash', 'session-1:', 'session 1:bash']) {
            expect(RpcRegisterDataSchema.safeParse({ method }).success).toBe(false);
            expect(RpcCallDataSchema.safeParse({ method, params: 'ciphertext' }).success).toBe(false);
        }
    });

    it('requires bounded encrypted string params and strict envelopes', () => {
        expect(RpcCallDataSchema.safeParse({ method: 'session-1:bash' }).success).toBe(false);
        expect(RpcCallDataSchema.safeParse({ method: 'session-1:bash', params: {} }).success).toBe(false);
        expect(RpcCallDataSchema.safeParse({ method: 'session-1:bash', params: 'x'.repeat(16 * 1024 * 1024 + 1) }).success).toBe(false);
        expect(RpcCallDataSchema.safeParse({ method: 'session-1:bash', params: 'ciphertext', extra: true }).success).toBe(false);
    });

    it('rejects missing and non-string call methods', () => {
        expect(RpcCallDataSchema.safeParse({ params: 'ciphertext' }).success).toBe(false);
        expect(RpcCallDataSchema.safeParse({ method: 42, params: 'ciphertext' }).success).toBe(false);
    });

    it('rejects entirely non-object call envelopes', () => {
        expect(RpcCallDataSchema.safeParse('session-1:bash').success).toBe(false);
        expect(RpcCallDataSchema.safeParse(null).success).toBe(false);
        expect(RpcCallDataSchema.safeParse([]).success).toBe(false);
    });
});
