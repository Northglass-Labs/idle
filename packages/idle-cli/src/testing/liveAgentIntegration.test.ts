import { describe, expect, it } from 'vitest';
import {
    LIVE_AGENT_INTEGRATION_ENV,
    shouldRunLiveAgentIntegration,
} from './liveAgentIntegration';

describe('live agent integration opt-in', () => {
    it('accepts only the exact documented opt-in value', () => {
        expect(shouldRunLiveAgentIntegration({ [LIVE_AGENT_INTEGRATION_ENV]: '1' })).toBe(true);

        for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) {
            expect(shouldRunLiveAgentIntegration({
                ...(value === undefined ? {} : { [LIVE_AGENT_INTEGRATION_ENV]: value }),
            })).toBe(false);
        }
    });
});
