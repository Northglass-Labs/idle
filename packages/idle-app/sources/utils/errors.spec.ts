import { describe, it, expect } from 'vitest';
import { IdleError } from './errors';

describe('IdleError', () => {
    it('extends Error so it behaves correctly with instanceof + standard error chaining', () => {
        const e = new IdleError('test', false);
        expect(e).toBeInstanceOf(Error);
        expect(e).toBeInstanceOf(IdleError);
    });

    it('preserves the message string passed to the constructor', () => {
        const e = new IdleError('something went wrong', true);
        expect(e.message).toBe('something went wrong');
    });

    it('stores the canTryAgain flag — distinguishes transient vs terminal errors', () => {
        // useIdleAction.ts reads this to decide whether to retry or surface to user.
        // Both branches must round-trip cleanly through the constructor.
        const retryable = new IdleError('temporary', true);
        const terminal = new IdleError('hard fail', false);
        expect(retryable.canTryAgain).toBe(true);
        expect(terminal.canTryAgain).toBe(false);
    });

    it('canTryAgain is readonly — TypeScript prevents reassignment at compile time', () => {
        // Runtime guard: the type is `readonly` but JS itself doesn't enforce that. This test
        // documents the property descriptor — it's a regular instance property, mutable at
        // runtime. If we ever want true immutability we'd need Object.defineProperty.
        const e = new IdleError('test', true);
        // @ts-expect-error — readonly at the type level; this verifies it compiles to an error
        e.canTryAgain = false;
        // Behavior is left as default — we acknowledge JS mutability, the type-level readonly is
        // the actual enforcement.
        expect(typeof e.canTryAgain).toBe('boolean');
    });

    it('sets name to "RetryableError" (legacy name; intentional for log filtering compatibility)', () => {
        const e = new IdleError('x', true);
        expect(e.name).toBe('RetryableError');
    });

    it('produces a stack trace', () => {
        const e = new IdleError('with stack', false);
        expect(e.stack).toBeDefined();
        expect(typeof e.stack).toBe('string');
    });
});
