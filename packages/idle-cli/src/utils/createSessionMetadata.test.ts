import { describe, expect, it } from 'vitest';
import { SandboxConfigSchema, type SandboxConfig } from '@/persistence';
import { createSessionMetadata } from './createSessionMetadata';

function createSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return SandboxConfigSchema.parse({
        policyVersion: 2,
        enabled: true,
        workspaceRoot: '~/Developer',
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg'],
        extraWritePaths: ['/tmp'],
        denyWritePaths: ['.env'],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    });
}

describe('createSessionMetadata — sandboxEnforced contract', () => {
    // The contract: metadata.sandbox represents VERIFIED ENFORCEMENT, not user intent.
    // Callers MUST only pass `sandboxEnforced` non-null when sandbox wrapping is
    // actually applied to the spawned process (e.g. claudeLocal after a successful
    // SandboxManager.initialize). Configuration-only ("user wants sandbox") is not
    // enough; only runtime enforcement evidence can support the security badge.

    it('sets metadata.sandbox to the config when enforcement is verified', () => {
        const sandbox = createSandboxConfig();
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            sandboxEnforced: sandbox,
        });

        expect(metadata.sandbox).toEqual(sandbox);
    });

    it('sets metadata.sandbox to null when sandboxEnforced is omitted', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-3',
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.sandbox to null when sandboxEnforced is explicitly undefined (e.g. Gemini path)', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'gemini',
            machineId: 'machine-2',
            startedBy: 'daemon',
            sandboxEnforced: undefined,
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.sandbox to null when sandboxEnforced is passed but disabled', () => {
        // Defense-in-depth: even if a caller passes a config object with enabled=false,
        // the metadata must not claim enforcement.
        const sandbox = createSandboxConfig({ enabled: false });
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-x',
            sandboxEnforced: sandbox,
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions to null when not provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-4',
        });

        expect(metadata.dangerouslySkipPermissions).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-5',
            dangerouslySkipPermissions: true,
        });

        expect(metadata.dangerouslySkipPermissions).toBe(true);
    });

    it('sets fork lineage metadata when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-6',
            parentSessionId: 'idle-source',
            forkedFromMessageId: 'message-2',
        });

        expect(metadata.parentSessionId).toBe('idle-source');
        expect(metadata.forkedFromMessageId).toBe('message-2');
    });

    it('records an explicitly approved provider-native Codex sandbox mode', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-native-sandbox',
            codexSandboxMode: 'provider-native',
        });

        expect(metadata.codexSandboxMode).toBe('provider-native');
    });
});
