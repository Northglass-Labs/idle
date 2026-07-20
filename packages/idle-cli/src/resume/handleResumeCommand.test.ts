import { describe, expect, it } from 'vitest';

import { buildResumeLaunch, formatResumeHelp, parseResumeCommandArgs } from './handleResumeCommand';

describe('parseResumeCommandArgs', () => {
    it('parses the idle session id', () => {
        expect(parseResumeCommandArgs(['cmmij8olq00dp5jcxr3wtbpau'])).toEqual({
            showHelp: false,
            sessionId: 'cmmij8olq00dp5jcxr3wtbpau',
        });
    });

    it('recognizes help flags', () => {
        expect(parseResumeCommandArgs(['--help'])).toEqual({
            showHelp: true,
            sessionId: '',
        });
    });

    it('rejects missing session ids', () => {
        expect(() => parseResumeCommandArgs([])).toThrow(
            'Idle session ID is required: idle resume <session-id>',
        );
    });
});

describe('buildResumeLaunch', () => {
    it('builds a Codex resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-1',
            active: false,
            metadata: {
                path: '/tmp/p1-control-flow',
                flavor: 'codex',
                codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
                host: 'localhost',
                homeDir: '/tmp',
                idleHomeDir: '/tmp/.idle',
                idleLibDir: '/tmp/idle',
                idleToolsDir: '/tmp/idle/tools',
            },
        })).toEqual({
            cwd: '/tmp/p1-control-flow',
            args: ['codex', '--resume', '019ccca5-726b-7c61-b914-16de27dfab6e'],
        });
    });

    it('preserves an explicitly approved Codex native-sandbox launch on resume', () => {
        expect(buildResumeLaunch({
            id: 'session-native-sandbox',
            active: false,
            metadata: {
                path: '/tmp/p1-control-flow',
                flavor: 'codex',
                codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
                codexSandboxMode: 'provider-native',
                host: 'localhost',
                homeDir: '/tmp',
                idleHomeDir: '/tmp/.idle',
                idleLibDir: '/tmp/idle',
                idleToolsDir: '/tmp/idle/tools',
            },
        })).toEqual({
            cwd: '/tmp/p1-control-flow',
            args: ['codex', '--no-sandbox', '--resume', '019ccca5-726b-7c61-b914-16de27dfab6e'],
        });
    });

    it('builds a Claude resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-2',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'claude',
                claudeSessionId: '11111111-1111-4111-8111-111111111111',
                host: 'localhost',
                homeDir: '/tmp',
                idleHomeDir: '/tmp/.idle',
                idleLibDir: '/tmp/idle',
                idleToolsDir: '/tmp/idle/tools',
            },
        })).toEqual({
            cwd: '/tmp/repo',
            args: ['claude', '--resume', '11111111-1111-4111-8111-111111111111'],
        });
    });

    it('rejects unsupported flavors', () => {
        expect(() => buildResumeLaunch({
            id: 'session-3',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'gemini',
                host: 'localhost',
                homeDir: '/tmp',
                idleHomeDir: '/tmp/.idle',
                idleLibDir: '/tmp/idle',
                idleToolsDir: '/tmp/idle/tools',
            },
        })).toThrow('Idle session session-3 uses unsupported flavor "gemini".');
    });
});

describe('formatResumeHelp', () => {
    it('mentions the session id command shape', () => {
        expect(formatResumeHelp()).toContain('idle resume <idle-session-id>');
    });
});
