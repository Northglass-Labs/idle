import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Vitest global lifecycle', () => {
  it('never rebuilds the shared CLI dist directory from inside a test process', () => {
    const source = readFileSync(new URL('./test-setup.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/node:child_process|\b(?:exec|spawn)(?:File|Sync)?\s*\(/);
  });
});
