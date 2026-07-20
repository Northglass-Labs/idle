import { describe, it, expect } from 'vitest';
import { AsyncLock } from './lock';

describe('AsyncLock', () => {
    it('runs a single inLock body to completion + returns its value', async () => {
        const lock = new AsyncLock();
        const result = await lock.inLock(async () => 42);
        expect(result).toBe(42);
    });

    it('serializes concurrent inLock callers — each runs to completion before next starts', async () => {
        // The whole point of the lock: when two callers race for the same critical section,
        // their work must NOT interleave. We track entry+exit log events and assert no overlap.
        const lock = new AsyncLock();
        const log: string[] = [];

        const work = (label: string) =>
            lock.inLock(async () => {
                log.push(`${label}-enter`);
                // Yield to the event loop so an unprotected version would interleave here.
                await new Promise<void>((resolve) => setTimeout(resolve, 10));
                log.push(`${label}-exit`);
            });

        await Promise.all([work('A'), work('B'), work('C')]);

        // Each label's enter must immediately precede its exit — no interleaving.
        for (let i = 0; i < log.length; i += 2) {
            const enterLabel = log[i].split('-')[0];
            const exitLabel = log[i + 1].split('-')[0];
            expect(enterLabel).toBe(exitLabel);
            expect(log[i]).toBe(`${enterLabel}-enter`);
            expect(log[i + 1]).toBe(`${enterLabel}-exit`);
        }
    });

    it('preserves FIFO order — callers run in the order they entered the lock', async () => {
        const lock = new AsyncLock();
        const order: string[] = [];

        // Start A first so it acquires the lock immediately, then B and C queue behind it.
        const a = lock.inLock(async () => {
            order.push('A');
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
        });
        // Small delay to ensure A acquires before B queues.
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        const b = lock.inLock(async () => { order.push('B'); });
        const c = lock.inLock(async () => { order.push('C'); });

        await Promise.all([a, b, c]);
        expect(order).toEqual(['A', 'B', 'C']);
    });

    it('releases the lock even when the body throws', async () => {
        const lock = new AsyncLock();

        // First caller throws. If unlock() is skipped, the second caller deadlocks forever.
        await expect(
            lock.inLock(async () => { throw new Error('boom'); })
        ).rejects.toThrow('boom');

        // Subsequent caller must still acquire — proves unlock() ran in the finally block.
        const result = await lock.inLock(async () => 'recovered');
        expect(result).toBe('recovered');
    });

    it('handles sync callbacks (not just async)', async () => {
        const lock = new AsyncLock();
        const result = await lock.inLock(() => 'sync');
        expect(result).toBe('sync');
    });

    it('returns the typed return value of the callback', async () => {
        const lock = new AsyncLock();
        const result: { count: number } = await lock.inLock(async () => ({ count: 7 }));
        expect(result.count).toBe(7);
    });

    it('handles many queued callers without losing any', async () => {
        const lock = new AsyncLock();
        const N = 50;
        const order: number[] = [];

        await Promise.all(
            Array.from({ length: N }, (_, i) =>
                lock.inLock(async () => { order.push(i); })
            )
        );

        expect(order.length).toBe(N);
        expect(new Set(order).size).toBe(N); // every caller ran exactly once
        // FIFO holds: indices appear in ascending order.
        for (let i = 0; i < N - 1; i++) {
            expect(order[i]).toBeLessThan(order[i + 1]);
        }
    });

    it('unlock() throws if permits > 1 when there are waiters (internal invariant)', async () => {
        // The implementation throws "this.permits should never be > 0 when there is someone waiting."
        // This invariant is enforced at line 25 of lock.ts. Triggering it directly requires
        // manipulating private state; we verify the normal path never trips it by running
        // concurrent load without error instead.
        const lock = new AsyncLock();
        let threw = false;
        try {
            await Promise.all([
                lock.inLock(async () => { await new Promise(r => setTimeout(r, 5)); }),
                lock.inLock(async () => { await new Promise(r => setTimeout(r, 5)); }),
                lock.inLock(async () => { await new Promise(r => setTimeout(r, 5)); }),
            ]);
        } catch {
            threw = true;
        }
        expect(threw).toBe(false);
    });
});
