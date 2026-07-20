import type { QueryOptions } from '@/claude/sdk';
import type { PermissionMode } from '@/api/types';

/** Derived from SDK's QueryOptions - the modes Claude actually supports */
export type ClaudeSdkPermissionMode = NonNullable<QueryOptions['permissionMode']>;

/**
 * Map any PermissionMode (7 modes) to a Claude-compatible mode (4 modes)
 * This is the ONLY place where Codex modes are mapped to Claude equivalents.
 *
 * Mapping:
 * - yolo → bypassPermissions (both skip all permissions)
 * - safe-yolo → default (ask for permissions)
 * - read-only → default (Claude doesn't support read-only)
 *
 * Claude modes pass through unchanged:
 * - default, acceptEdits, bypassPermissions, plan
 */
export function mapToClaudeMode(mode: PermissionMode): ClaudeSdkPermissionMode {
    const codexToClaudeMap: Record<string, ClaudeSdkPermissionMode> = {
        'yolo': 'bypassPermissions',
        'safe-yolo': 'default',
        'read-only': 'default',
    };
    return codexToClaudeMap[mode] ?? (mode as ClaudeSdkPermissionMode);
}

const VALID_PERMISSION_MODES: readonly PermissionMode[] = [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'read-only',
    'safe-yolo',
    'yolo',
] as const;

function isPermissionMode(value: string | undefined): value is PermissionMode {
    return !!value && VALID_PERMISSION_MODES.includes(value as PermissionMode);
}

/**
 * Extract permission mode override from Claude CLI args.
 * Supports both:
 * - --permission-mode VALUE
 * - --permission-mode=VALUE
 */
export function extractPermissionModeFromClaudeArgs(claudeArgs?: string[]): PermissionMode | undefined {
    if (!claudeArgs || claudeArgs.length === 0) {
        return undefined;
    }

    let found: PermissionMode | undefined = undefined;
    for (let i = 0; i < claudeArgs.length; i++) {
        const arg = claudeArgs[i];
        if (arg === '--permission-mode') {
            const next = claudeArgs[i + 1];
            if (isPermissionMode(next)) {
                found = next;
            }
            i += 1;
            continue;
        }

        if (arg.startsWith('--permission-mode=')) {
            const value = arg.slice('--permission-mode='.length);
            if (isPermissionMode(value)) {
                found = value;
            }
        }
    }

    return found;
}

/**
 * Resolve the initial permission mode for remote Claude execution.
 * `--dangerously-skip-permissions` takes precedence over all other modes.
 */
export function resolveInitialClaudePermissionMode(
    optionMode: PermissionMode | undefined,
    claudeArgs?: string[],
): PermissionMode {
    if (claudeArgs?.includes('--dangerously-skip-permissions')) {
        return 'bypassPermissions';
    }
    return extractPermissionModeFromClaudeArgs(claudeArgs) ?? optionMode ?? 'default';
}

/**
 * Keep Claude's approval policy independent from sandbox configuration.
 *
 * The sandbox is applied only by the local launcher and can be unsupported or
 * fail during initialization. Treating a configured sandbox as an applied
 * sandbox would otherwise disable Claude's native approvals before containment
 * exists. The local launcher adds `--dangerously-skip-permissions` only after
 * its sandbox wrapper initializes successfully.
 */
export function applySandboxPermissionPolicy(
    mode: PermissionMode | undefined,
    _sandboxEnabled: boolean,
): PermissionMode {
    return mode ?? 'default';
}

function isClaudeBypassEquivalent(mode: PermissionMode | undefined): boolean {
    return mode === 'bypassPermissions' || mode === 'yolo';
}

/**
 * Resolve permission mode overrides from remote app messages.
 *
 * Older app versions can send `permissionMode: "default"` with every message.
 * Preserve bypass only when this CLI process explicitly pinned it; an
 * app-selected dangerous mode must remain downgradeable from the app.
 */
export function resolveRemoteClaudePermissionMode(
    currentMode: PermissionMode | undefined,
    incomingMode: PermissionMode | undefined,
    sandboxEnabled: boolean,
    preserveExplicitBypass = false,
): PermissionMode | undefined {
    if (!incomingMode) {
        return currentMode;
    }

    const nextMode = applySandboxPermissionPolicy(incomingMode, sandboxEnabled);
    if (preserveExplicitBypass && isClaudeBypassEquivalent(currentMode) && nextMode === 'default') {
        return currentMode;
    }

    return nextMode;
}

export function hasExplicitClaudeBypassArg(claudeArgs?: string[]): boolean {
    if (claudeArgs?.includes('--dangerously-skip-permissions')) {
        return true;
    }
    return isClaudeBypassEquivalent(extractPermissionModeFromClaudeArgs(claudeArgs));
}
