import { describe, expect, it } from 'vitest';
import { describeCodexFailure } from './runCodex';

describe('describeCodexFailure', () => {
    it('surfaces the bounded provider failure code without restoring raw diagnostics', () => {
        expect(describeCodexFailure({
            type: 'turn_aborted',
            status: 'failed',
            failure: { kind: 'provider-failed', code: 'usage_limit' },
        })).toBe('Provider failure (usage_limit)');
    });

    it('uses a useful fixed fallback when the provider supplies no safe code', () => {
        expect(describeCodexFailure({
            type: 'turn_aborted',
            status: 'failed',
            failure: { kind: 'provider-failed' },
        })).toBe('Provider reported a failed turn without details');
    });

    it('does not surface an unbounded or unsafe provider code', () => {
        expect(describeCodexFailure({
            type: 'turn_aborted',
            status: 'failed',
            failure: { kind: 'provider-failed', code: 'unsafe provider detail with spaces' },
        })).toBe('Provider reported a failed turn without details');
    });

    it('maps legacy provider text to a fixed code and ignores successful completion', () => {
        expect(describeCodexFailure({ status: 'failed', error: 'Authentication required' }))
            .toBe('Provider failure (authentication_required)');
        expect(describeCodexFailure({ status: 'completed', error: null })).toBeNull();
    });

    it('does not forward arbitrary legacy provider text to the mobile session', () => {
        const privateDetail = 'provider detail containing private diagnostic context';
        const description = describeCodexFailure({ status: 'failed', error: privateDetail });

        expect(description).toBe('Provider reported a failed turn without details');
        expect(description).not.toContain(privateDetail);
    });
});
