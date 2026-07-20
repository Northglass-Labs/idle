import { describe, expect, it, vi } from 'vitest';

import { PendingSocketAdmissions } from './pendingSocketAdmissions';

describe('PendingSocketAdmissions', () => {
    it('cancels a pending socket before it can be promoted', () => {
        const admissions = new PendingSocketAdmissions();
        const admission = admissions.track('account-1', 'socket-1');

        expect(admission).not.toBeNull();
        expect(admissions.cancelUser('account-1')).toBe(1);
        expect(admission!.canceled).toBe(true);
        expect(admission!.promote()).toBe(false);
        expect(admissions.stats()).toEqual({ accounts: 0, admissions: 0 });
    });

    it('hands an enabled socket off without leaving pending state behind', () => {
        const admissions = new PendingSocketAdmissions();
        const admission = admissions.track('account-1', 'socket-1');

        expect(admission!.promote()).toBe(true);
        expect(admission!.canceled).toBe(false);
        expect(admissions.stats()).toEqual({ accounts: 0, admissions: 0 });
    });

    it('bounds both per-account and process-wide pending state', () => {
        const admissions = new PendingSocketAdmissions({
            maxPerAccount: 2,
            maxTotal: 3,
        });

        expect(admissions.track('account-1', 'socket-1')).not.toBeNull();
        expect(admissions.track('account-1', 'socket-2')).not.toBeNull();
        expect(admissions.track('account-1', 'socket-3')).toBeNull();
        expect(admissions.track('account-2', 'socket-4')).not.toBeNull();
        expect(admissions.track('account-3', 'socket-5')).toBeNull();
        expect(admissions.stats()).toEqual({ accounts: 2, admissions: 3 });
    });

    it('expires abandoned middleware admissions', () => {
        vi.useFakeTimers();
        try {
            const admissions = new PendingSocketAdmissions({ timeoutMs: 20_000 });
            const admission = admissions.track('account-1', 'socket-1');

            vi.advanceTimersByTime(20_001);

            expect(admission!.canceled).toBe(true);
            expect(admission!.promote()).toBe(false);
            expect(admissions.stats()).toEqual({ accounts: 0, admissions: 0 });
        } finally {
            vi.useRealTimers();
        }
    });
});
