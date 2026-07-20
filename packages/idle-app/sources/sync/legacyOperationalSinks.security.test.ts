import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('legacy metadata operational sink source boundary', () => {
    it('routes launcher and file RPC paths through authenticated metadata selectors', () => {
        const machine = source('../app/(app)/machine/[id].tsx');
        const file = source('../app/(app)/session/[id]/file.tsx');
        const prefetch = source('../hooks/usePrefetchFileContents.ts');
        const allDiffs = source('../components/AllFilesDiffView.tsx');

        expect(machine).toContain('getOperationalRecentPaths(');
        expect(machine).toContain('getOperationalSessionMetadata(');
        expect(machine).not.toContain('return session.metadata?.machineId === machineId');
        expect(machine).not.toContain('if (session.metadata?.path)');
        for (const rpcSource of [file, prefetch, allDiffs]) {
            expect(rpcSource).toContain('getOperationalSessionMetadata(');
            expect(rpcSource).not.toMatch(/sessionPath(?:Maybe)?\s*=\s*session\?\.metadata\?\.path/);
        }
    });

    it('keeps provider, sandbox, permission, fork, and command behavior off raw metadata', () => {
        const sessionView = source('../-session/SessionView.tsx');
        const agentInput = source('../components/AgentInput.tsx');
        const messageView = source('../components/MessageView.tsx');
        const permissionFooter = source('../components/tools/PermissionFooter.tsx');
        const sessionInfo = source('../app/(app)/session/[id]/info.tsx');
        const suggestions = source('./suggestionCommands.ts');
        const messageMeta = source('./messageMeta.ts');
        const sessionUtils = source('../utils/sessionUtils.ts');

        expect(sessionView).toContain('metadata={operationalMetadata}');
        expect(sessionView).not.toContain('getAvailableModels(flavor, session.metadata');
        expect(sessionView).not.toContain('getAvailablePermissionModes(flavor, session.metadata');
        expect(sessionView).not.toContain('session.metadata?.currentOperatingModeCode');
        expect(sessionView).not.toContain('session.metadata?.currentModelCode');

        expect(agentInput).toContain('getOperationalSessionMetadata(props.metadata)');
        expect(agentInput).not.toMatch(/props\.metadata\?\.(?:flavor|sandbox|currentModelCode)/);
        expect(agentInput).not.toContain('getEnsoContextSize(props.metadata)');

        expect(messageView).toContain('getOperationalSessionMetadata(props.metadata)');
        expect(messageView).not.toContain('props.metadata?.flavor');
        expect(permissionFooter).toContain('getOperationalSessionMetadata(metadata)');
        expect(permissionFooter).not.toContain('metadata?.flavor');

        expect(sessionInfo).toContain('getOperationalSessionMetadata(session.metadata)');
        expect(sessionInfo).not.toMatch(/router\.push\(`\/(?:machine|session)\/\$\{session\.metadata/);
        expect(sessionInfo).not.toContain('Clipboard.setStringAsync(session.metadata!');

        expect(suggestions).not.toContain('session.metadata.slashCommands');
        expect(messageMeta).not.toContain('session.metadata?.flavor');
        expect(sessionUtils).not.toContain('buildResumeCommand(session.metadata');
        expect(sessionUtils).not.toContain('buildResumeCommandBlock(session.metadata');
    });

    it('revalidates Git path provenance immediately before every RPC batch', () => {
        const gitStatusSync = source('./gitStatusSync.ts');

        expect(gitStatusSync).toContain('getOperationalSessionMetadata(session?.metadata)');
        expect(gitStatusSync).not.toContain('cwd: session.metadata.path');
    });
});
