import { describe, expect, it } from 'vitest';

import { getCodeAgentDefaults, resolveAgentDefaultConfig } from './agentDefaults';

describe('agent permission defaults', () => {
    it.each(['claude', 'codex', 'gemini', 'openclaw'] as const)(
        'uses approval-preserving defaults for %s',
        (agent) => {
            expect(getCodeAgentDefaults(agent).permissionMode).toBe('default');
        },
    );

    it('keeps explicit full-control overrides available', () => {
        expect(resolveAgentDefaultConfig({
            claude: { permissionMode: 'bypassPermissions' },
            codex: { permissionMode: 'yolo' },
        }, 'claude').permissionMode).toBe('bypassPermissions');
        expect(resolveAgentDefaultConfig({
            claude: { permissionMode: 'bypassPermissions' },
            codex: { permissionMode: 'yolo' },
        }, 'codex').permissionMode).toBe('yolo');
    });
});
