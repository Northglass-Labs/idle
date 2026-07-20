import { describe, it, expect } from 'vitest';
import { Future } from './future';

describe('Future', () => {
    it('exposes a .promise that resolves when resolve() is called', async () => {
        const f = new Future<number>();
        f.resolve(42);
        await expect(f.promise).resolves.toBe(42);
    });

    it('exposes a .promise that rejects when reject() is called', async () => {
        const f = new Future<never>();
        f.reject(new Error('boom'));
        await expect(f.promise).rejects.toThrow('boom');
    });

    it('resolve can be called before awaiting the promise', async () => {
        const f = new Future<string>();
        f.resolve('hello');
        // Even though we resolve before we await, the value is captured
        const val = await f.promise;
        expect(val).toBe('hello');
    });

    it('resolve can be called after awaiting starts', async () => {
        const f = new Future<string>();
        // Start awaiting before the resolve fires
        const waiting = f.promise;
        setTimeout(() => f.resolve('delayed'), 5);
        await expect(waiting).resolves.toBe('delayed');
    });

    it('reject propagates the rejection reason', async () => {
        const f = new Future<void>();
        const reason = new Error('reason');
        f.reject(reason);
        await expect(f.promise).rejects.toBe(reason);
    });

    it('supports void type: resolve() with no argument', async () => {
        const f = new Future<void>();
        f.resolve(undefined);
        await expect(f.promise).resolves.toBeUndefined();
    });

    it('resolve with a complex object type', async () => {
        const f = new Future<{ x: number; y: string }>();
        f.resolve({ x: 1, y: 'a' });
        const val = await f.promise;
        expect(val).toEqual({ x: 1, y: 'a' });
    });

    it('reject with a string reason (not an Error)', async () => {
        const f = new Future<never>();
        f.reject('string-reason');
        await expect(f.promise).rejects.toBe('string-reason');
    });

    it('multiple awaits on the same promise all receive the resolved value', async () => {
        const f = new Future<number>();
        f.resolve(99);
        const [a, b, c] = await Promise.all([f.promise, f.promise, f.promise]);
        expect(a).toBe(99);
        expect(b).toBe(99);
        expect(c).toBe(99);
    });

    it('the promise property returns the same Promise instance each time', () => {
        const f = new Future<number>();
        expect(f.promise).toBe(f.promise);
    });
});
