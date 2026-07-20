import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { SandboxConfig } from '@/persistence';

vi.mock('@/gemini/utils/config', () => ({
  readGeminiLocalConfig: vi.fn(() => ({})),
  determineGeminiModel: vi.fn(() => 'gemini-test-model'),
  getGeminiModelSource: vi.fn(() => 'default'),
}));

import { createGeminiBackend } from './gemini';

describe('createGeminiBackend sandbox propagation', () => {
  it('carries the verified launch policy into the shared ACP backend', () => {
    const sandboxConfig: SandboxConfig = {
      policyVersion: 2,
      enabled: true,
      sessionIsolation: 'workspace',
      customWritePaths: [],
      denyReadPaths: ['~/.ssh'],
      extraWritePaths: ['/tmp'],
      denyWritePaths: ['.env'],
      networkMode: 'allowed',
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: true,
    };

    const { backend } = createGeminiBackend({
      cwd: '/tmp/idle-gemini-workspace',
      sandboxConfig,
    } as any);

    expect((backend as any).options.sandboxConfig).toBe(sandboxConfig);
  });

  it('never persists configured project or account identity', async () => {
    const source = await readFile(new URL('./gemini.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('Using Google Cloud Project: ${googleCloudProject}');
    expect(source).not.toContain('Google Cloud Project for ${storedEmail}');
  });
});
