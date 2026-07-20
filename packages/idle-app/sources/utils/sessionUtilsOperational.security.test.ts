import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({ t: (key: string) => key }));

import { markMetadataAuthenticatedForEffects } from '@/sync/sessionOperationalState';
import { getResumeCommand, getResumeCommandBlock } from './sessionUtils';

function resumableSession() {
    return {
        id: 'session-a',
        metadata: {
            path: '/workspace/project',
            host: 'host',
            os: 'darwin',
            flavor: 'claude',
            claudeSessionId: '11111111-1111-4111-8111-111111111111',
        },
    } as any;
}

describe('copyable resume command provenance', () => {
    it('does not construct executable commands from display-only legacy metadata', () => {
        const session = resumableSession();

        expect(getResumeCommand(session)).toBeNull();
        expect(getResumeCommandBlock(session)).toBeNull();
    });

    it('preserves resume commands for authenticated metadata', () => {
        const session = resumableSession();
        markMetadataAuthenticatedForEffects(session.metadata);

        expect(getResumeCommand(session)).toContain('idle claude --resume');
        expect(getResumeCommandBlock(session)?.copyText).toContain('/workspace/project');
    });
});
