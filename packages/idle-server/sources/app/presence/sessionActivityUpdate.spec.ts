import { describe, it, expect } from 'vitest';
import {
    buildHeartbeatUpdateArgs,
    buildActivityResumeUpdateArgs,
} from './sessionActivityUpdate';

describe('buildHeartbeatUpdateArgs — defends against phantom-heartbeat phantom-heartbeat resurrection', () => {
    it('scopes the update with where: { active: true } so timed-out sessions are skipped', () => {
        const args = buildHeartbeatUpdateArgs({ sessionId: 'abc', timestamp: 1000 });
        expect(args.where).toEqual({ id: 'abc', active: true });
    });

    it('does NOT include active in data — heartbeats must never write the active column', () => {
        // Writing active=true would let a heartbeat from a dead agent process
        // resurrect a timed-out session on every poll.
        const args = buildHeartbeatUpdateArgs({ sessionId: 'abc', timestamp: 1000 });
        expect('active' in args.data).toBe(false);
    });

    it('passes the supplied timestamp through to lastActiveAt as a Date', () => {
        const t = Date.UTC(2026, 4, 18, 12, 34, 56);
        const args = buildHeartbeatUpdateArgs({ sessionId: 'abc', timestamp: t });
        expect(args.data.lastActiveAt).toEqual(new Date(t));
    });

    it('returns exactly { lastActiveAt } in data — no other fields leak through', () => {
        const args = buildHeartbeatUpdateArgs({ sessionId: 'abc', timestamp: 1000 });
        expect(Object.keys(args.data)).toEqual(['lastActiveAt']);
    });
});

describe('buildActivityResumeUpdateArgs — the only legitimate resurrection path', () => {
    it('does NOT scope on active (unconditional update) so it can resurrect timed-out sessions', () => {
        const args = buildActivityResumeUpdateArgs({ sessionId: 'abc', timestamp: 1000 });
        expect(args.where).toEqual({ id: 'abc' });
        expect('active' in args.where).toBe(false);
    });

    it('sets active: true alongside lastActiveAt — the resurrection signal', () => {
        const args = buildActivityResumeUpdateArgs({ sessionId: 'abc', timestamp: 1000 });
        expect(args.data).toEqual({ lastActiveAt: new Date(1000), active: true });
    });

    it('returns exactly { lastActiveAt, active } in data — no other fields leak through', () => {
        const args = buildActivityResumeUpdateArgs({ sessionId: 'abc', timestamp: 1000 });
        expect(new Set(Object.keys(args.data))).toEqual(new Set(['lastActiveAt', 'active']));
    });

    it('preserves the supplied timestamp on lastActiveAt', () => {
        const t = Date.UTC(2026, 4, 18, 23, 0, 0);
        const args = buildActivityResumeUpdateArgs({ sessionId: 'abc', timestamp: t });
        expect(args.data.lastActiveAt).toEqual(new Date(t));
    });
});
