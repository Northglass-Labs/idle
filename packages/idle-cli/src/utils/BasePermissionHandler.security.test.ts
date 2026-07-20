import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  debug: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: mocks.debug },
}));

import {
  BasePermissionHandler,
  type PendingRequest,
  type PermissionResponse,
} from './BasePermissionHandler';

class TestPermissionHandler extends BasePermissionHandler {
  protected getLogPrefix(): string {
    return '[Test]';
  }

  seedPending(id: string, pending: PendingRequest): void {
    this.pendingRequests.set(id, pending);
  }
}

function createHarness() {
  let state: Record<string, any> = {};
  let permissionRpc: ((response: PermissionResponse) => Promise<void>) | undefined;
  const session = {
    rpcHandlerManager: {
      registerHandler: vi.fn((_name: string, handler: (response: PermissionResponse) => Promise<void>) => {
        permissionRpc = handler;
      }),
    },
    updateAgentState: vi.fn((updater: (currentState: Record<string, any>) => Record<string, any>) => {
      state = updater(state);
      return state;
    }),
  };

  const handler = new TestPermissionHandler(session as any);
  return {
    handler,
    invokePermission: async (response: PermissionResponse) => {
      if (!permissionRpc) throw new Error('permission RPC was not registered');
      await permissionRpc(response);
    },
    getState: () => state,
  };
}

describe('BasePermissionHandler diagnostic privacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not persist request IDs or provider tool names when resolving a permission', async () => {
    const requestId = 'request-private-correlation-sentinel';
    const toolName = 'tool-private-provider-sentinel';
    const { handler, invokePermission } = createHarness();
    handler.seedPending(requestId, {
      resolve: vi.fn(),
      reject: vi.fn(),
      toolName,
      input: { privateArgument: 'not-logged' },
    });

    await invokePermission({ id: requestId, approved: true });

    const diagnostics = JSON.stringify(mocks.debug.mock.calls);
    expect(diagnostics).not.toContain(requestId);
    expect(diagnostics).not.toContain(toolName);
  });

  it('does not persist request IDs or thrown callback text while aborting or resetting', () => {
    const abortId = 'abort-private-correlation-sentinel';
    const resetId = 'reset-private-correlation-sentinel';
    const thrownText = 'opaque-callback-failure-sentinel';
    const { handler } = createHarness();

    handler.seedPending(abortId, {
      resolve: () => { throw new Error(thrownText); },
      reject: vi.fn(),
      toolName: 'abort-tool',
      input: {},
    });
    handler.abortAll();

    handler.seedPending(resetId, {
      resolve: vi.fn(),
      reject: () => { throw new Error(thrownText); },
      toolName: 'reset-tool',
      input: {},
    });
    handler.reset();

    const diagnostics = JSON.stringify(mocks.debug.mock.calls);
    expect(diagnostics).not.toContain(abortId);
    expect(diagnostics).not.toContain(resetId);
    expect(diagnostics).not.toContain(thrownText);
  });
});
