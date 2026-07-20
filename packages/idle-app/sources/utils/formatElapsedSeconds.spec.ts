import { describe, expect, it } from 'vitest';
import { formatElapsedSeconds } from './formatElapsedSeconds';

describe('formatElapsedSeconds', () => {
    describe('sub-minute (seconds only, no decimal)', () => {
        it('formats 0 as "0s"', () => {
            expect(formatElapsedSeconds(0)).toBe('0s');
        });
        it('rounds fractional seconds (0.4 → "0s")', () => {
            expect(formatElapsedSeconds(0.4)).toBe('0s');
        });
        it('rounds fractional seconds (7.6 → "8s")', () => {
            expect(formatElapsedSeconds(7.6)).toBe('8s');
        });
        it('formats 59 as "59s"', () => {
            expect(formatElapsedSeconds(59)).toBe('59s');
        });
        it('formats 59.4 as "59s" (rounds down)', () => {
            expect(formatElapsedSeconds(59.4)).toBe('59s');
        });
    });

    describe('minute:second range (60s ≤ x < 3600s)', () => {
        it('formats 60 as "1m 0s"', () => {
            expect(formatElapsedSeconds(60)).toBe('1m 0s');
        });
        it('formats 67.4 as "1m 7s"', () => {
            expect(formatElapsedSeconds(67.4)).toBe('1m 7s');
        });
        it('formats 125 as "2m 5s"', () => {
            expect(formatElapsedSeconds(125)).toBe('2m 5s');
        });
        it('formats 1704 as "28m 24s"', () => {
            expect(formatElapsedSeconds(1704)).toBe('28m 24s');
        });
        it('formats 3599 as "59m 59s"', () => {
            expect(formatElapsedSeconds(3599)).toBe('59m 59s');
        });
        it('formats 60.6 (rounds up) as "1m 1s"', () => {
            expect(formatElapsedSeconds(60.6)).toBe('1m 1s');
        });
    });

    describe('hours range (≥ 3600s)', () => {
        it('formats 3600 as "1h 0m"', () => {
            expect(formatElapsedSeconds(3600)).toBe('1h 0m');
        });
        it('formats 3725 as "1h 2m" (drops seconds at this scale)', () => {
            expect(formatElapsedSeconds(3725)).toBe('1h 2m');
        });
        it('formats 7322 as "2h 2m"', () => {
            expect(formatElapsedSeconds(7322)).toBe('2h 2m');
        });
        it('formats 86399 (just under 24h) as "23h 59m"', () => {
            expect(formatElapsedSeconds(86399)).toBe('23h 59m');
        });
    });

    describe('defensive', () => {
        it('treats negative input as 0s', () => {
            expect(formatElapsedSeconds(-5)).toBe('0s');
        });
        it('treats NaN as 0s', () => {
            expect(formatElapsedSeconds(NaN)).toBe('0s');
        });
        it('treats Infinity as 0s', () => {
            expect(formatElapsedSeconds(Infinity)).toBe('0s');
        });
    });
});
