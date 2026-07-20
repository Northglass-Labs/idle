import { describe, expect, it } from 'vitest';

import { isStrictlyNewerVersion } from './versionPolicy';

describe('versioned update replay policy', () => {
    it.each([
        [4, 3, true],
        [3, 3, false],
        [2, 3, false],
        [-1, 3, false],
        [Number.NaN, 3, false],
    ])('incoming version %s over current %s is fresh: %s', (incoming, current, expected) => {
        expect(isStrictlyNewerVersion(incoming, current)).toBe(expected);
    });
});
