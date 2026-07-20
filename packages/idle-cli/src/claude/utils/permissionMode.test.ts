import { describe, it, expect } from 'vitest';
import {
    applySandboxPermissionPolicy,
    extractPermissionModeFromClaudeArgs,
    hasExplicitClaudeBypassArg,
    mapToClaudeMode,
    resolveInitialClaudePermissionMode,
    resolveRemoteClaudePermissionMode,
} from './permissionMode';
import type { PermissionMode } from '@/api/types';

describe('mapToClaudeMode', () => {
    describe('Codex modes are mapped to Claude equivalents', () => {
        it('maps yolo → bypassPermissions', () => {
            expect(mapToClaudeMode('yolo')).toBe('bypassPermissions');
        });

        it('maps safe-yolo → default', () => {
            expect(mapToClaudeMode('safe-yolo')).toBe('default');
        });

        it('maps read-only → default', () => {
            expect(mapToClaudeMode('read-only')).toBe('default');
        });
    });

    describe('Claude modes pass through unchanged', () => {
        it('passes through default', () => {
            expect(mapToClaudeMode('default')).toBe('default');
        });

        it('passes through acceptEdits', () => {
            expect(mapToClaudeMode('acceptEdits')).toBe('acceptEdits');
        });

        it('passes through bypassPermissions', () => {
            expect(mapToClaudeMode('bypassPermissions')).toBe('bypassPermissions');
        });

        it('passes through plan', () => {
            expect(mapToClaudeMode('plan')).toBe('plan');
        });
    });

    describe('all 7 PermissionMode values are handled', () => {
        const allModes: PermissionMode[] = [
            'default', 'acceptEdits', 'bypassPermissions', 'plan',  // Claude modes
            'read-only', 'safe-yolo', 'yolo'  // Codex modes
        ];

        it('returns a valid Claude mode for every PermissionMode', () => {
            const validClaudeModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

            allModes.forEach(mode => {
                const result = mapToClaudeMode(mode);
                expect(validClaudeModes).toContain(result);
            });
        });
    });
});

describe('extractPermissionModeFromClaudeArgs', () => {
    it('extracts mode from --permission-mode VALUE', () => {
        expect(extractPermissionModeFromClaudeArgs(['--permission-mode', 'bypassPermissions'])).toBe('bypassPermissions');
    });

    it('extracts mode from --permission-mode=VALUE', () => {
        expect(extractPermissionModeFromClaudeArgs(['--foo', '--permission-mode=plan'])).toBe('plan');
    });

    it('returns undefined for invalid mode', () => {
        expect(extractPermissionModeFromClaudeArgs(['--permission-mode', 'invalid'])).toBeUndefined();
    });
});

describe('resolveInitialClaudePermissionMode', () => {
    it('uses the interactive default when no mode is provided', () => {
        expect(resolveInitialClaudePermissionMode(undefined)).toBe('default');
    });

    it('uses --dangerously-skip-permissions as highest priority', () => {
        expect(resolveInitialClaudePermissionMode('default', ['--permission-mode', 'plan', '--dangerously-skip-permissions'])).toBe('bypassPermissions');
    });

    it('uses mode from claude args when present', () => {
        expect(resolveInitialClaudePermissionMode('default', ['--permission-mode', 'acceptEdits'])).toBe('acceptEdits');
    });

    it('falls back to option mode when claude args have no mode', () => {
        expect(resolveInitialClaudePermissionMode('bypassPermissions', ['--foo'])).toBe('bypassPermissions');
    });
});

describe('applySandboxPermissionPolicy', () => {
    it('does not weaken approvals merely because sandboxing is configured', () => {
        expect(applySandboxPermissionPolicy('default', true)).toBe('default');
        expect(applySandboxPermissionPolicy(undefined, true)).toBe('default');
    });

    it('preserves plan mode when sandboxing is configured', () => {
        expect(applySandboxPermissionPolicy('plan', true)).toBe('plan');
    });

    it('returns original mode when sandbox is disabled', () => {
        expect(applySandboxPermissionPolicy('acceptEdits', false)).toBe('acceptEdits');
    });
});

describe('resolveRemoteClaudePermissionMode', () => {
    it('preserves bypassPermissions when the CLI explicitly pinned bypass mode', () => {
        expect(resolveRemoteClaudePermissionMode('bypassPermissions', 'default', false, true)).toBe('bypassPermissions');
    });

    it('preserves yolo when the CLI explicitly pinned yolo mode', () => {
        expect(resolveRemoteClaudePermissionMode('yolo', 'default', false, true)).toBe('yolo');
    });

    it.each(['bypassPermissions', 'yolo'] as const)(
        'allows the app to downgrade an app-selected %s mode to default',
        (currentMode) => {
            expect(resolveRemoteClaudePermissionMode(currentMode, 'default', false, false)).toBe('default');
        },
    );

    it('does not pin bypass merely because sandboxing is configured', () => {
        expect(resolveRemoteClaudePermissionMode('bypassPermissions', 'default', true, false)).toBe('default');
    });

    it('still allows explicit plan mode after bypassPermissions was active', () => {
        expect(resolveRemoteClaudePermissionMode('bypassPermissions', 'plan', false)).toBe('plan');
    });

    it('preserves incoming approvals even when sandboxing is configured', () => {
        expect(resolveRemoteClaudePermissionMode('default', 'plan', true)).toBe('plan');
    });
});

describe('hasExplicitClaudeBypassArg', () => {
    it.each([
        { args: ['--dangerously-skip-permissions'] },
        { args: ['--permission-mode', 'bypassPermissions'] },
        { args: ['--permission-mode=yolo'] },
    ])('recognizes a process-level dangerous-mode opt-in: $args', ({ args }) => {
        expect(hasExplicitClaudeBypassArg(args)).toBe(true);
    });

    it.each([
        { args: undefined },
        { args: [] },
        { args: ['--permission-mode', 'default'] },
        { args: ['--permission-mode=safe-yolo'] },
    ])('does not pin safe or absent CLI modes: $args', ({ args }) => {
        expect(hasExplicitClaudeBypassArg(args)).toBe(false);
    });
});
