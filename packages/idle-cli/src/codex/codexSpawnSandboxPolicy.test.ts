import { describe, expect, it } from 'vitest';

import { resolveCodexSpawnSandboxPolicy } from './codexSpawnSandboxPolicy';

describe('resolveCodexSpawnSandboxPolicy', () => {
    it('requires explicit approval before falling back from Idle isolation to Codex native sandboxing', () => {
        expect(resolveCodexSpawnSandboxPolicy({
            agent: 'codex',
            idleSandboxEnabled: true,
            providerNativeSandboxApproved: false,
            hasExplicitSandboxCredential: false,
            hasKeyringChatGptLogin: true,
        })).toBe('provider-native-approval-required');
    });

    it('uses provider-native sandboxing only after approval', () => {
        expect(resolveCodexSpawnSandboxPolicy({
            agent: 'codex',
            idleSandboxEnabled: true,
            providerNativeSandboxApproved: true,
            hasExplicitSandboxCredential: false,
            hasKeyringChatGptLogin: true,
        })).toBe('provider-native');
    });

    it('keeps Idle isolation when a scoped credential is available', () => {
        expect(resolveCodexSpawnSandboxPolicy({
            agent: 'codex',
            idleSandboxEnabled: true,
            providerNativeSandboxApproved: false,
            hasExplicitSandboxCredential: true,
            hasKeyringChatGptLogin: true,
        })).toBe('idle-managed');
    });

    it('does not alter non-Codex launches', () => {
        expect(resolveCodexSpawnSandboxPolicy({
            agent: 'claude',
            idleSandboxEnabled: true,
            providerNativeSandboxApproved: true,
            hasExplicitSandboxCredential: false,
            hasKeyringChatGptLogin: true,
        })).toBe('idle-managed');
    });
});
