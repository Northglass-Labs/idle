import { describe, it, expect } from 'vitest';
import { isSandboxActive } from './sandboxClassification';

describe('isSandboxActive security claim', () => {
    // metadata.sandbox is the security CLAIM the UI badges on. Only
    // accept fully-formed payloads with explicit { enabled: true }.
    // The earlier implementation allowed "any truthy non-null sandbox
    // object" to count as enabled, which let an empty {} payload light
    // the badge.

    it('returns true when sandbox is { enabled: true }', () => {
        expect(isSandboxActive({ enabled: true })).toBe(true);
    });

    it('returns true for a fully-populated SandboxConfig with enabled:true', () => {
        expect(isSandboxActive({
            enabled: true,
            workspaceRoot: '~/Developer',
            networkMode: 'allowed',
        })).toBe(true);
    });

    it('returns false when sandbox is null', () => {
        expect(isSandboxActive(null)).toBe(false);
    });

    it('returns false when sandbox is undefined', () => {
        expect(isSandboxActive(undefined)).toBe(false);
    });

    it('returns false when sandbox is { enabled: false }', () => {
        expect(isSandboxActive({ enabled: false })).toBe(false);
    });

    it('returns false for an empty object {}', () => {
        // Missing or non-true `enabled` cannot support a sandbox badge claim.
        expect(isSandboxActive({})).toBe(false);
    });

    it('returns false for arbitrary truthy non-config objects', () => {
        expect(isSandboxActive({ foo: 'bar' })).toBe(false);
        expect(isSandboxActive({ enabled: 'yes' as unknown as boolean })).toBe(false);
        expect(isSandboxActive({ enabled: 1 as unknown as boolean })).toBe(false);
    });

    it('returns false for non-object inputs', () => {
        expect(isSandboxActive('enabled' as unknown)).toBe(false);
        expect(isSandboxActive(42 as unknown)).toBe(false);
        expect(isSandboxActive(true as unknown)).toBe(false);
    });
});
