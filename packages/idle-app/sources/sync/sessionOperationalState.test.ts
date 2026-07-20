import { describe, expect, it } from 'vitest';

import {
    getOperationalRecentPaths,
} from './newSessionOperationalInputs';
import {
    getOperationalSessionIndicators,
    markAgentStateAuthenticatedForEffects,
    markMetadataAuthenticatedForEffects,
} from './sessionOperationalState';

describe('authenticated operational session selectors', () => {
    it('keeps legacy permission and control fields display-only', () => {
        const legacyAgentState = {
            controlledByUser: true,
            requests: {
                approval: {
                    tool: 'Bash',
                    arguments: { command: 'pwd' },
                    createdAt: 1,
                },
            },
        };

        expect(getOperationalSessionIndicators({ agentState: legacyAgentState }))
            .toEqual({
                controlledByUser: false,
                hasPendingPermissions: false,
                agentState: null,
            });

        markAgentStateAuthenticatedForEffects(legacyAgentState);
        expect(getOperationalSessionIndicators({ agentState: legacyAgentState }))
            .toMatchObject({
                controlledByUser: true,
                hasPendingPermissions: true,
                agentState: legacyAgentState,
            });

        expect(getOperationalSessionIndicators({
            agentState: structuredClone(legacyAgentState),
        })).toMatchObject({
            controlledByUser: false,
            hasPendingPermissions: false,
            agentState: null,
        });
    });

    it('uses only exact authenticated metadata objects as New Session path inputs', () => {
        const legacyMetadata = {
            machineId: 'machine-a',
            path: '/legacy/path',
            host: 'host',
        };
        const authenticatedMetadata = {
            machineId: 'machine-a',
            path: '/authenticated/path',
            host: 'host',
        };
        markMetadataAuthenticatedForEffects(authenticatedMetadata);

        expect(getOperationalRecentPaths([
            { metadata: legacyMetadata },
            { metadata: authenticatedMetadata },
        ] as any, 'machine-a')).toEqual(['/authenticated/path']);
    });
});
