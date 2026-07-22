import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({
    randomUUID: vi.fn(() => '00000001-0002-4000-8000-000000000003'),
}));

vi.mock('@/sync/ops', () => ({
    machineBash: vi.fn(),
}));

import * as worktree from './worktree';

describe('worktree name entropy', () => {
    it('derives the readable name and collision suffix from platform cryptographic randomness', () => {
        const generateWorktreeName = (worktree as {
            generateWorktreeName?: () => string;
        }).generateWorktreeName;

        expect(generateWorktreeName).toBeTypeOf('function');
        expect(generateWorktreeName!()).toBe('idle-cloud-00000003');
    });
});
