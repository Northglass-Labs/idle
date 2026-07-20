import { describe, it, expect } from 'vitest';
import { buildConnectionStatusSheetContent } from './connectionStatusSheetContent';

describe('buildConnectionStatusSheetContent', () => {
    describe('connected', () => {
        it('shows calm status with no primary action — nothing for the user to do', () => {
            const c = buildConnectionStatusSheetContent({ state: 'connected' });
            expect(c.title).toBe('Connected');
            expect(c.primaryActionLabel).toBeNull();
            expect(c.dotColor).toBe('#34C759');
        });
    });

    describe('connecting', () => {
        it('hides the primary action — auto-retry is in flight; manual retry could cause reconnect storms', () => {
            // This is the most important guard: if `primaryActionLabel` reappears here someone has
            // reintroduced the risk of users tapping "Try now" during an in-flight reconnect and
            // creating socket churn.
            const c = buildConnectionStatusSheetContent({ state: 'connecting' });
            expect(c.primaryActionLabel).toBeNull();
        });

        it('includes the retry countdown in the blurb when provided', () => {
            const c = buildConnectionStatusSheetContent({ state: 'connecting', nextRetryInSeconds: 5 });
            expect(c.blurb).toContain('5s');
        });

        it('falls back to a generic "retrying automatically" blurb when no countdown is available', () => {
            const c = buildConnectionStatusSheetContent({ state: 'connecting' });
            expect(c.blurb).toContain('retrying automatically');
            expect(c.blurb).not.toContain('undefineds');
        });
    });

    describe('disconnected', () => {
        it('shows "Try now" so users can skip the backoff timer if their network just recovered', () => {
            const c = buildConnectionStatusSheetContent({ state: 'disconnected' });
            expect(c.primaryActionLabel).toBe('Try now');
            expect(c.title).toBe('Offline');
            expect(c.dotColor).toBe('#8E8E93');
        });

        it('reassures users their messages stay in the composer', () => {
            const c = buildConnectionStatusSheetContent({ state: 'disconnected' });
            expect(c.blurb).toContain('composer');
        });
    });

    describe('error', () => {
        it('shows "Try now" and points users to Show details for diagnostic info', () => {
            const c = buildConnectionStatusSheetContent({ state: 'error' });
            expect(c.primaryActionLabel).toBe('Try now');
            expect(c.title).toBe('Connection failed');
            expect(c.blurb).toContain('Show details');
            expect(c.dotColor).toBe('#FF453A');
        });
    });

    it('every state returns a non-empty title + blurb + dotColor', () => {
        for (const state of ['connected', 'connecting', 'disconnected', 'error'] as const) {
            const c = buildConnectionStatusSheetContent({ state });
            expect(c.title.length).toBeGreaterThan(0);
            expect(c.blurb.length).toBeGreaterThan(0);
            expect(c.dotColor).toMatch(/^#[0-9A-F]{6}$/i);
        }
    });
});
