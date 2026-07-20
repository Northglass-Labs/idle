import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';
import { buildSandboxRuntimeConfig, type SandboxRuntimeOverrides } from './config';

export async function initializeSandbox(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
    overrides?: SandboxRuntimeOverrides,
): Promise<() => Promise<void>> {
    const runtimeConfig = overrides
        ? buildSandboxRuntimeConfig(sandboxConfig, sessionPath, overrides)
        : buildSandboxRuntimeConfig(sandboxConfig, sessionPath);
    // sandbox-runtime supports an omitted allowedDomains field as its
    // unrestricted opt-in, although the published declaration requires it.
    await SandboxManager.initialize(runtimeConfig as SandboxRuntimeConfig);

    return async () => {
        await SandboxManager.reset();
    };
}

export async function wrapCommand(command: string): Promise<string> {
    return SandboxManager.wrapWithSandbox(command);
}

export type SandboxedSpawn = (
    command: string,
    args: string[],
) => { command: 'sh'; args: string[] };

/**
 * Prepare a synchronous spawn adapter for APIs (notably the Claude Agent SDK)
 * whose process callback cannot await SandboxManager.wrapWithSandbox().
 *
 * The provider command and every argument are supplied as positional shell
 * parameters after the fixed program. They are never interpolated into shell
 * source, so custom ACP commands cannot turn an argv value into shell syntax.
 */
export async function prepareSandboxedSpawn(): Promise<SandboxedSpawn> {
    const wrappedTemplate = await wrapCommand('exec "$0" "$@"');
    const shellProgram = `${wrappedTemplate} "$0" "$@"`;

    return (command, args) => ({
        command: 'sh',
        args: ['-c', shellProgram, command, ...args],
    });
}

export async function wrapForMcpTransport(
    command: string,
    args: string[],
): Promise<{ command: 'sh'; args: string[] }> {
    const wrapSpawn = await prepareSandboxedSpawn();
    return wrapSpawn(command, args);
}
