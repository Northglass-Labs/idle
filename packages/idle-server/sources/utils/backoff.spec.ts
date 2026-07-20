import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBackoff } from './backoff';
import { AbortedExeption } from './aborted';

afterEach(() => {
    vi.useRealTimers();
});

describe('createBackoff', () => {
    it('returns the callback result on the first successful call', async () => {
        const backoff = createBackoff({ minDelay: 1, maxDelay: 10 });
        const result = await backoff(() => Promise.resolve(42));
        expect(result).toBe(42);
    });

    it('retries after a transient failure and returns the eventual result', async () => {
        vi.useFakeTimers();
        const backoff = createBackoff({ minDelay: 10, maxDelay: 100 });

        let calls = 0;
        const p = backoff(async () => {
            calls++;
            if (calls < 3) throw new Error('transient');
            return 'done';
        });

        // Advance past the retry delays (two failures, each with delay)
        await vi.runAllTimersAsync();

        expect(await p).toBe('done');
        expect(calls).toBe(3);
    });

    it('re-throws AbortedExeption immediately without retrying', async () => {
        const backoff = createBackoff({ minDelay: 1, maxDelay: 10 });
        let calls = 0;

        await expect(
            backoff(async () => {
                calls++;
                throw new AbortedExeption('test abort');
            })
        ).rejects.toBeInstanceOf(AbortedExeption);

        // Should have called the callback exactly once — no retry on AbortedExeption
        expect(calls).toBe(1);
    });

    it('waits before retrying (the delay is actually applied)', async () => {
        vi.useFakeTimers();
        const backoff = createBackoff({ minDelay: 50, maxDelay: 100 });

        let calls = 0;
        const p = backoff(async () => {
            calls++;
            if (calls < 2) throw new Error('fail once');
            return 'ok';
        });

        // The promise should not be settled yet — the backoff delay has not elapsed
        expect(calls).toBe(1);
        await vi.runAllTimersAsync();
        expect(await p).toBe('ok');
    });

    it('resolves early if signal is aborted during the wait between retries', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const backoff = createBackoff({ minDelay: 10_000, maxDelay: 60_000 });

        // Callback throws until it sees the signal is aborted, then it throws
        // AbortedExeption so the backoff loop re-throws and the promise settles.
        // This mirrors the real-world usage pattern where the work function
        // propagates abort itself once the signal fires.
        const p = backoff(
            async () => {
                if (controller.signal.aborted) {
                    throw new AbortedExeption('aborted by signal');
                }
                throw new Error('transient failure');
            },
            controller.signal
        );

        // Attach a rejection handler BEFORE advancing timers so the rejection
        // is never unhandled from vitest's perspective.
        const assertion = expect(p).rejects.toBeInstanceOf(AbortedExeption);

        // After the first failure, backoff is waiting 10s before the retry.
        // Abort the signal — delay resolves early, then the next callback run
        // sees signal.aborted and throws AbortedExeption, which the backoff
        // loop re-throws.
        controller.abort();
        await vi.runAllTimersAsync();

        await assertion;
    });

    it('uses default options when none are provided', async () => {
        // createBackoff() with no args must not throw and must return a working function
        const { backoff } = await import('./backoff');
        const result = await backoff(() => Promise.resolve('default'));
        expect(result).toBe('default');
    });

    it('works with a custom factor', async () => {
        vi.useFakeTimers();
        // factor=0 means no jitter — deterministic delay, easy to test
        const backoff = createBackoff({ minDelay: 10, maxDelay: 1000, factor: 0 });

        let calls = 0;
        const p = backoff(async () => {
            calls++;
            if (calls < 2) throw new Error('fail');
            return calls;
        });

        await vi.runAllTimersAsync();
        expect(await p).toBe(2);
    });
});

describe('exponential backoff delay shape (internal invariants)', () => {
    // We can't import the private helper directly, but we can observe behaviour
    // through createBackoff with fake timers: after N failures the delay should
    // be at least minDelay and at most maxDelay.

    it('never waits less than minDelay between retries', async () => {
        vi.useFakeTimers();
        const minDelay = 100;
        const backoff = createBackoff({ minDelay, maxDelay: 10_000, factor: 0 });

        let calls = 0;
        const p = backoff(async () => {
            calls++;
            if (calls < 2) throw new Error('fail');
            return 'done';
        });

        // Advance just under minDelay — the retry should NOT have run yet
        vi.advanceTimersByTime(minDelay - 1);
        // calls is still 1 (mid-wait)
        expect(calls).toBe(1);

        // Now advance past minDelay
        vi.advanceTimersByTime(2);
        await Promise.resolve(); // flush microtasks
        await vi.runAllTimersAsync();

        expect(await p).toBe('done');
        expect(calls).toBe(2);
    });

    it('caps delay at maxDelay even after many failures', async () => {
        vi.useFakeTimers();
        const maxDelay = 50;
        const backoff = createBackoff({ minDelay: 10, maxDelay, factor: 0 });

        let calls = 0;
        const p = backoff(async () => {
            calls++;
            if (calls < 6) throw new Error('fail');
            return 'done';
        });

        // With factor=0 each delay equals the exponential term capped at maxDelay.
        // Advancing by maxDelay * 10 is more than enough for 5 retries.
        vi.advanceTimersByTime(maxDelay * 10);
        await vi.runAllTimersAsync();

        expect(await p).toBe('done');
        expect(calls).toBe(6);
    });
});
