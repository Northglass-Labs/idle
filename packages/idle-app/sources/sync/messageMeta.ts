import type { Session } from './storageTypes';
import type { Settings } from './settings';
import { getAgentDefaultOverride } from './agentDefaults';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import { getOperationalSessionMetadata } from './sessionOperationalState';

export type MessageModeMeta = {
    permissionMode?: PermissionModeKey;
    model?: string | null;
    effort?: string | null;
};

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel'>,
    settings?: Pick<Settings, 'agentDefaultOverrides'>,
): MessageModeMeta {
    const operationalMetadata = getOperationalSessionMetadata(session.metadata);
    const agentOverrides = operationalMetadata
        ? getAgentDefaultOverride(
            settings?.agentDefaultOverrides,
            operationalMetadata.flavor,
        )
        : {};
    const meta: MessageModeMeta = {};

    if (session.permissionMode !== null && session.permissionMode !== undefined) {
        meta.permissionMode = session.permissionMode;
    } else if (agentOverrides.permissionMode !== undefined) {
        meta.permissionMode = agentOverrides.permissionMode;
    }

    const modelMode = session.modelMode ?? agentOverrides.modelMode;
    if (modelMode !== undefined) {
        meta.model = modelMode === 'default' ? null : modelMode;
    }

    const effort = session.effortLevel ?? agentOverrides.effortLevel;
    if (effort !== undefined) {
        // Idle: legacy sessions may persist the sentinel 'default' effort level.
        // Treat it as an explicit reset (mirrors the model handling above) so the
        // literal string 'default' is never sent to the CLI.
        meta.effort = effort === 'default' ? null : effort;
    }

    return meta;
}
