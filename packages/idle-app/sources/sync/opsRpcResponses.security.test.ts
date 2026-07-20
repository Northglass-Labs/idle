import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
    ClaudeForkSessionResultSchema,
    ClaudeListRewindPointsResultSchema,
    CodexForkThreadResultSchema,
    CodexListRewindPointsResultSchema,
    CommandResponseSchema,
    KillSessionResponseSchema,
    MachineMetadataUpdateResponseSchema,
    ReadFileResponseSchema,
    SpawnSessionResultSchema,
    StopDaemonResponseSchema,
    SwitchResponseSchema,
    WriteFileResponseSchema,
    parseRpcResult,
} from './opsRpcSchemas';

describe('decrypted RPC response boundary', () => {
    it('strictly bounds spawn and fork identities', () => {
        expect(SpawnSessionResultSchema.safeParse({ type: 'success', sessionId: 'session-1' }).success).toBe(true);
        expect(SpawnSessionResultSchema.safeParse({ type: 'success', sessionId: 'session-1', extra: true }).success).toBe(false);
        expect(SpawnSessionResultSchema.safeParse({ type: 'success', sessionId: 'x'.repeat(257) }).success).toBe(false);
        expect(SpawnSessionResultSchema.safeParse({ type: 'requestToApproveCodexNativeSandbox' }).success).toBe(true);
        expect(ClaudeForkSessionResultSchema.safeParse({
            type: 'success',
            newClaudeSessionId: '00000000-0000-4000-8000-000000000000',
        }).success).toBe(true);
        expect(CodexForkThreadResultSchema.safeParse({ type: 'success', newCodexThreadId: 'thread-1' }).success).toBe(true);
    });

    it('bounds rewind collections and rejects duplicate remote identities', () => {
        const claudePoint = { uuid: 'point-1', text: 'prompt', timestamp: 1 };
        expect(ClaudeListRewindPointsResultSchema.safeParse({ type: 'success', points: [claudePoint] }).success).toBe(true);
        expect(ClaudeListRewindPointsResultSchema.safeParse({ type: 'success', points: [claudePoint, claudePoint] }).success).toBe(false);
        expect(ClaudeListRewindPointsResultSchema.safeParse({
            type: 'success',
            points: Array.from({ length: 501 }, (_, index) => ({ ...claudePoint, uuid: `point-${index}` })),
        }).success).toBe(false);

        const codexPoint = { itemId: 'item-1', text: 'prompt', timestamp: 1 };
        expect(CodexListRewindPointsResultSchema.safeParse({ type: 'success', points: [codexPoint] }).success).toBe(true);
        expect(CodexListRewindPointsResultSchema.safeParse({ type: 'success', points: [{ ...codexPoint, text: 'x'.repeat(65_537) }] }).success).toBe(false);
    });

    it('strictly validates command, file, lifecycle, and metadata acknowledgements', () => {
        expect(CommandResponseSchema.safeParse({ success: true, stdout: '', stderr: '', exitCode: 0 }).success).toBe(true);
        expect(CommandResponseSchema.safeParse({ success: true, stdout: '', stderr: '', exitCode: 0, extra: true }).success).toBe(false);
        expect(ReadFileResponseSchema.safeParse({ success: true, content: 'AQID' }).success).toBe(true);
        expect(ReadFileResponseSchema.safeParse({ success: true, content: 'not-base64' }).success).toBe(false);
        expect(ReadFileResponseSchema.safeParse({ success: true, content: 'AB==' }).success).toBe(false);
        expect(WriteFileResponseSchema.safeParse({ success: true, hash: 'a'.repeat(64) }).success).toBe(true);
        expect(WriteFileResponseSchema.safeParse({ success: true, hash: '../not-a-hash' }).success).toBe(false);
        expect(KillSessionResponseSchema.safeParse({ success: true, message: 'stopping' }).success).toBe(true);
        expect(StopDaemonResponseSchema.safeParse({ message: 'stopping' }).success).toBe(true);
        expect(SwitchResponseSchema.safeParse(true).success).toBe(true);
        expect(SwitchResponseSchema.safeParse('true').success).toBe(false);
        expect(MachineMetadataUpdateResponseSchema.safeParse({
            result: 'success',
            version: 2,
            metadata: 'ciphertext',
        }).success).toBe(true);
        expect(MachineMetadataUpdateResponseSchema.safeParse({
            result: 'success',
            version: 2,
            metadata: 'ciphertext',
            extra: true,
        }).success).toBe(false);
    });

    it('maps schema failures to a fixed message without reflecting remote values', () => {
        const sensitiveMarker = 'PRIVATE_REMOTE_RESPONSE_MARKER';

        expect(() => parseRpcResult(z.object({ ok: z.literal(true) }).strict(), {
            ok: false,
            error: sensitiveMarker,
        })).toThrow('Invalid remote control response');
        try {
            parseRpcResult(z.object({ ok: z.literal(true) }).strict(), { error: sensitiveMarker });
        } catch (error) {
            expect((error as Error).message).not.toContain(sensitiveMarker);
        }
    });

    it('wires every consumed RPC result through a named schema', () => {
        const source = readFileSync(new URL('./ops.ts', import.meta.url), 'utf8');
        const requiredSchemas = [
            'SpawnSessionResultSchema',
            'ClaudeForkSessionResultSchema',
            'ClaudeListRewindPointsResultSchema',
            'CodexForkThreadResultSchema',
            'CodexListRewindPointsResultSchema',
            'StopDaemonResponseSchema',
            'CommandResponseSchema',
            'MachineMetadataUpdateResponseSchema',
            'SwitchResponseSchema',
            'ReadFileResponseSchema',
            'WriteFileResponseSchema',
            'KillSessionResponseSchema',
        ];

        for (const schema of requiredSchemas) {
            expect(source, schema).toContain(`parseRpcResult(${schema}`);
        }
    });
});
