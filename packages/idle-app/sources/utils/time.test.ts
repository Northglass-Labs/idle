import { describe, expect, it, vi } from 'vitest';

import { createBackoff } from './time';

describe('createBackoff', () => {
    it('rejects the original error when the failure budget is exhausted', async () => {
        const failure = new Error('permanent failure');
        const callback = vi.fn(async () => {
            throw failure;
        });
        const onError = vi.fn();
        const retry = createBackoff({
            minDelay: 0,
            maxDelay: 0,
            maxFailureCount: 2,
            onError,
        });

        await expect(retry(callback)).rejects.toBe(failure);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledTimes(2);
    });

    it('preserves a legitimate success within the failure budget', async () => {
        const callback = vi.fn()
            .mockRejectedValueOnce(new Error('transient failure'))
            .mockResolvedValueOnce('ok');
        const retry = createBackoff({
            minDelay: 0,
            maxDelay: 0,
            maxFailureCount: 2,
        });

        await expect(retry(callback)).resolves.toBe('ok');
        expect(callback).toHaveBeenCalledTimes(2);
    });
});
