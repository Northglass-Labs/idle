import { describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { createAcpBackend } from './createAcpBackend';

describe('createAcpBackend sandbox propagation', () => {
  it('does not drop an observed process-containment policy', () => {
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
    const onSandboxApplied = vi.fn();

    const backend = createAcpBackend({
      agentName: 'custom',
      cwd: '/tmp/idle-acp-workspace',
      command: 'custom-agent',
      sandboxConfig,
      onSandboxApplied,
    });

    expect((backend as any).options.sandboxConfig).toBe(sandboxConfig);
    expect((backend as any).options.onSandboxApplied).toBe(onSandboxApplied);
  });
});
