import { describe, it, expect, vi, afterEach } from 'vitest';
import { delay } from './delay';

afterEach(() => {
    vi.useRealTimers();
});

describe('delay', () => {
    it('resolves after the specified time when no signal is provided', async () => {
        vi.useFakeTimers();
        const p = delay(500);
        vi.advanceTimersByTime(500);
        await expect(p).resolves.toBeUndefined();
    });

    it('resolves immediately when the signal is already aborted before call', async () => {
        const controller = new AbortController();
        controller.abort();
        // Should resolve synchronously / without hanging
        await expect(delay(60_000, controller.signal)).resolves.toBeUndefined();
    });

    it('resolves early when the signal is aborted mid-delay', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const p = delay(10_000, controller.signal);

        // Abort well before the timer would fire
        vi.advanceTimersByTime(100);
        controller.abort();
        vi.advanceTimersByTime(1);

        await expect(p).resolves.toBeUndefined();
    });

    it('resolves normally at expiry when a live signal is given but never aborted', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const p = delay(200, controller.signal);
        vi.advanceTimersByTime(200);
        await expect(p).resolves.toBeUndefined();
    });

    it('resolves (not rejects) when aborted — delay swallows the abort signal', async () => {
        const controller = new AbortController();
        controller.abort();
        // The contract is resolve, not throw
        let threw = false;
        try {
            await delay(1, controller.signal);
        } catch {
            threw = true;
        }
        expect(threw).toBe(false);
    });

    it('resolves with undefined (returns void)', async () => {
        vi.useFakeTimers();
        const p = delay(1);
        vi.advanceTimersByTime(1);
        const result = await p;
        expect(result).toBeUndefined();
    });
});
