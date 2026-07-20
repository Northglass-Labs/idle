import { readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function source(relativeUrl: string): string {
    return readFileSync(new URL(relativeUrl, import.meta.url), 'utf8');
}

describe('runtime logging privacy', () => {
    it('passes only fixed diagnostic codes to the shipped runtime console', () => {
        const sourcesRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
        const violations: string[] = [];

        for (const file of runtimeSourceFiles(sourcesRoot)) {
            const contents = readFileSync(file, 'utf8');
            const parsed = ts.createSourceFile(
                file,
                contents,
                ts.ScriptTarget.Latest,
                true,
                extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
            );

            const visit = (node: ts.Node): void => {
                if (ts.isCallExpression(node)
                    && ts.isPropertyAccessExpression(node.expression)
                    && ts.isIdentifier(node.expression.expression)
                    && node.expression.expression.text === 'console'
                    && ['debug', 'error', 'info', 'log', 'trace', 'warn'].includes(node.expression.name.text)) {
                    const isFixedCode = node.arguments.length === 1
                        && ts.isStringLiteralLike(node.arguments[0]);
                    if (!isFixedCode) {
                        const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
                        violations.push(`${relative(sourcesRoot, file)}:${line}`);
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(parsed);
        }

        expect(violations).toEqual([]);
    });

    it('does not log realtime voice message or callback payloads', () => {
        const voice = source('../realtime/RealtimeVoiceSession.tsx');
        const webVoice = source('../realtime/RealtimeVoiceSession.web.tsx');

        for (const implementation of [voice, webVoice]) {
            expect(implementation).not.toContain("console.log('Realtime session connected:'");
            expect(implementation).not.toContain("console.log('Realtime message:'");
            expect(implementation).not.toContain("console.log('Realtime status change:'");
            expect(implementation).not.toContain("console.log('Realtime mode change:'");
            expect(implementation).not.toContain("console.warn('Realtime voice not available:'");
            expect(implementation).not.toContain("console.debug('Realtime debug:'");
            expect(implementation).not.toContain('Setting conversationInstance:',);
        }
    });

    it('does not log malformed socket payloads or attempted external URLs', () => {
        const sync = source('../sync/sync.ts');
        const openLink = source('./openLink.ts');

        expect(sync).not.toContain("console.error('❌ Sync: Invalid update data:', update)");
        expect(sync).not.toContain("console.log('❌ Sync: Invalid update received:', validatedUpdate.error)");
        expect(openLink).not.toContain("console.warn('[openLink] failed to open', url, e)");
    });

    it('does not log authentication material, message bodies, identifiers, or raw responses', () => {
        const qrAuth = source('../auth/authQRStart.ts');
        const reducer = source('../sync/reducer/reducer.ts');
        const suggestions = source('../sync/suggestionFile.ts');
        const voiceTools = source('../realtime/realtimeClientTools.ts');
        const sync = source('../sync/sync.ts');

        expect(qrAuth).not.toContain('Sending auth request to: ${serverUrl}');
        expect(qrAuth).not.toContain('Public key: ${encodeBase64(keypair.publicKey)');
        expect(qrAuth).not.toContain("Failed to send auth request:', error");
        expect(reducer).not.toContain('console.log(JSON.stringify(messages');
        expect(reducer).not.toContain("to event:', event");
        expect(suggestions).not.toContain('console.log(response)');
        expect(voiceTools).not.toContain("Sending message to session:', sessionId");
        expect(voiceTools).not.toContain("processPermissionRequest:', decision");
        expect(sync).not.toContain("console.log('[fetchNativeUpdate] Data:', data)");
        expect(sync).not.toContain("console.error('Invalid ephemeral update received:', update)");
    });

    it('does not log decrypted account data, voice context, or tool results', () => {
        const sync = source('../sync/sync.ts');
        const voiceConfig = source('../realtime/voiceConfig.ts');
        const voiceHooks = source('../realtime/hooks/voiceHooks.ts');
        const toolView = source('../components/tools/ToolView.tsx');

        expect(sync).not.toContain("console.log('settings version-mismatch");
        expect(sync).not.toContain("console.log('settings'");
        expect(sync).not.toContain("console.log('profile'");
        expect(voiceConfig).not.toContain('ENABLE_DEBUG_LOGGING');
        expect(voiceHooks).not.toContain('ENABLE_DEBUG_LOGGING');
        expect(voiceHooks).not.toContain("console.log('🎤 Voice:");
        expect(toolView).not.toContain("console.log('isToolUseError'");
    });

    it('does not log decrypted artifacts, runtime objects, identifiers, paths, or raw errors', () => {
        const webVoice = source('../realtime/RealtimeVoiceSession.web.tsx');
        const artifacts = source('../app/(app)/artifacts/index.tsx');
        const sync = source('../sync/sync.ts');
        const gitStatusFiles = source('../sync/gitStatusFiles.ts');
        const gitStatusSync = source('../sync/gitStatusSync.ts');
        const suggestions = source('../sync/suggestionFile.ts');
        const rawTypes = source('../sync/typesRaw.ts');

        const unsafeSinks = [
            ...[
                "conversationInstance:', conversationInstance",
                "Started conversation with ID:', conversationId",
                "microphone permission:', error",
                "start realtime session:', error",
                "end realtime session:', error",
            ].filter((needle) => webVoice.includes(needle)),
            ...[
                "First artifact:', artifacts[0]",
                "Failed to fetch artifacts:', error",
            ].filter((needle) => artifacts.includes(needle)),
            ...[
                'No blob key for session ${sessionId}',
                'Session ${sessionId} not found after sync',
                'Session ${sessionId} not found in storage after sync',
                'data encryption key for session ${session.id}',
                'Session encryption not found for ${session.id}',
                'key for artifact ${artifact.id}',
                'artifact ${artifact.id}:`, err',
                'key for artifact ${artifactId}',
                'artifact ${artifactId}:`, error',
                'data encryption key for machine ${machine.id}',
                'machine ${machine.id}:`, error',
                'Session ${updateData.body.sid} not found after sync',
                'Session encryption not found for ${updateData.body.id}',
                'new machine ${machineId}',
                'not found for ${machineId}',
                'machine ${machineId}:`, error',
                'metadata for ${machineId}:`, error',
                'daemonState for ${machineId}:`, error',
                'new artifact ${artifactId}',
                'Artifact ${artifactId} not found',
                'key not found for artifact ${artifactId}',
                'artifact update ${artifactId}:`, error',
                "Failed to load sessions:', error",
                'background send timeout notification: ${error}',
                'cancel background send timeout notification: ${error}',
                'message failure notification: ${error}',
                'Error fetching artifacts: ${error}',
                "Failed to fetch artifacts:', error",
                "Failed to create artifact:', error",
                "Failed to update artifact:', error",
                "Failed to initialize machine encryptions:', error",
                "Failed to sync purchases:', error",
                "Failed to register push token: ' + JSON.stringify(error)",
                "Failed to process settings update:', error",
                'fetchMessages starting for session ${sessionId}',
                'log.log(`💬 fetchMessages: Session encryption not ready for ${sessionId}',
                'fetchMessages completed for session ${sessionId}',
                'loadOlderMessages: encryption not ready for ${sessionId}',
                'Session ${sessionId} deleted from local storage',
                'mobile for session ${updateData.body.id}',
                'Delete machine update received for ${machineId}',
                'Machine ${machineId} not in storage',
                'Added new artifact ${artifactId}',
                'Updated artifact ${artifactId}',
            ].filter((needle) => sync.includes(needle)),
            ...[
                "session', sessionId, ':', error",
                'Unexpected directory in untracked files: ${untrackedPath}',
            ].filter((needle) => gitStatusFiles.includes(needle)),
            ...[
                "git status:', statusResult.error",
                "session', sessionId, ':', error",
            ].filter((needle) => gitStatusSync.includes(needle)),
            ...[
                'file cache for session ${sessionId}',
                'directories for session ${sessionId}',
            ].filter((needle) => suggestions.includes(needle)),
            ...[
                'Unrecognized message type: ${msgType} (id: ${id})',
            ].filter((needle) => rawTypes.includes(needle)),
        ];

        expect(unsafeSinks).toEqual([]);
    });
});

function runtimeSourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'scripts') {
                files.push(...runtimeSourceFiles(path));
            }
            continue;
        }
        if (!/\.(?:ts|tsx)$/.test(entry.name)
            || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) {
            continue;
        }
        files.push(path);
    }
    return files;
}
