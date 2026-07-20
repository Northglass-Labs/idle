import { describe, it, expect } from 'vitest';
import { AbortedExeption } from './aborted';

describe('AbortedExeption', () => {
    it('is an instance of Error', () => {
        const e = new AbortedExeption();
        expect(e).toBeInstanceOf(Error);
    });

    it('uses the default message when none is supplied', () => {
        const e = new AbortedExeption();
        expect(e.message).toBe('Operation aborted');
    });

    it('uses a custom message when one is supplied', () => {
        const e = new AbortedExeption('timed out');
        expect(e.message).toBe('timed out');
    });

    it('sets name to "AbortedExeption" (matches the typo in source)', () => {
        // The class intentionally preserves the existing "Exeption" spelling
        // so that catch-site instanceof checks keep working across the codebase.
        const e = new AbortedExeption();
        expect(e.name).toBe('AbortedExeption');
    });

    it('has a stack trace', () => {
        const e = new AbortedExeption();
        expect(e.stack).toBeTruthy();
    });

    it('isAborted returns true for an AbortedExeption instance', () => {
        const e = new AbortedExeption();
        expect(AbortedExeption.isAborted(e)).toBe(true);
    });

    it('isAborted returns false for a plain Error', () => {
        expect(AbortedExeption.isAborted(new Error('oops'))).toBe(false);
    });

    it('isAborted returns false for null', () => {
        expect(AbortedExeption.isAborted(null)).toBe(false);
    });

    it('isAborted returns false for undefined', () => {
        expect(AbortedExeption.isAborted(undefined)).toBe(false);
    });

    it('isAborted returns false for a plain object', () => {
        expect(AbortedExeption.isAborted({ message: 'Operation aborted' })).toBe(false);
    });

    it('can be caught with instanceof in a catch block', () => {
        let caught = false;
        try {
            throw new AbortedExeption('abort!');
        } catch (e) {
            if (e instanceof AbortedExeption) {
                caught = true;
            }
        }
        expect(caught).toBe(true);
    });
});
