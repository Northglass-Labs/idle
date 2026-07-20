import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const source = (relativePath: string) => readFile(new URL(relativePath, import.meta.url), 'utf8')

describe('CLI diagnostic privacy inventory', () => {
    it('keeps workspace paths, URLs, identifiers, and raw errors out of shared control logs', async () => {
        const handlers = await source('./modules/common/registerCommonHandlers.ts')
        const watcher = await source('./modules/watcher/startFileWatcher.ts')
        const api = await source('./api/api.ts')
        const control = await source('./daemon/controlClient.ts')

        for (const forbidden of [
            '{ cwd: options.cwd',
            "Failed to read file:', error",
            "Failed to write file:', error",
            "Failed to run ripgrep:', error",
        ]) expect(handlers).not.toContain(forbidden)

        for (const forbidden of ['${file}', '${e.message}']) {
            expect(watcher).not.toContain(forbidden)
        }
        for (const forbidden of [
            'Machine ${opts.machineId}',
            'Raw vendor token response',
            "using as string:', parseError",
            "vendor token:', error",
            'tokenDataKeys',
            "deactivateSession failed:', error",
        ]) expect(api).not.toContain(forbidden)
        for (const forbidden of [
            'Current CLI version: ${currentCliVersion}',
            'Stopping daemon with PID ${state.pid}',
            "daemon metadata', error",
            "stale PID', error",
            "will force kill', error",
            "Error stopping daemon', error",
            'PID ${state.pid}',
            'port ${state.httpPort}',
        ]) expect(control).not.toContain(forbidden)
    })

    it('keeps CLI and auth debug mode from printing raw exceptions or credentials', async () => {
        const index = await source('./index.ts')
        const auth = await source('./ui/auth.ts')
        const session = await source('./claude/session.ts')

        expect(index).not.toContain('console.error(error)')
        expect(auth).not.toContain('[AUTH DEBUG] Public key:')
        expect(auth).not.toContain("Failed to send auth request:', error")
        for (const forbidden of [
            'initial mapping: idle=${idleSessionId} claude=${sessionId}',
            'mapping changed: idle=${idleSessionId}',
            'session ID: ${nextArg}',
            "remaining args:', this.claudeArgs",
        ]) expect(session).not.toContain(forbidden)
    })

    it('keeps offline guidance categorical and removes dead compatibility wrappers', async () => {
        const offline = await source('./utils/serverConnectionErrors.ts')
        expect(offline).not.toContain('printOfflineWarning')
        expect(offline).not.toContain('f.url ?')
        expect(offline).not.toContain('flatMap(f => f.details')
    })

    it('keeps provider content, paths, identifiers, timestamps, and raw failures out of CLI diagnostics', async () => {
        const time = await source('./utils/time.ts')
        const push = await source('./api/pushNotifications.ts')
        const machine = await source('./api/apiMachine.ts')
        const rpcManager = await source('./api/rpc/RpcHandlerManager.ts')
        const daemon = await source('./daemon/run.ts')
        const controlServer = await source('./daemon/controlServer.ts')
        const codexClient = await source('./codex/codexAppServerClient.ts')
        const codexRunner = await source('./codex/runCodex.ts')
        const queue = await source('./utils/MessageQueue2.ts')
        const reasoning = await source('./utils/BaseReasoningProcessor.ts')
        const checkSession = await source('./claude/utils/claudeCheckSession.ts')
        const findSession = await source('./claude/utils/claudeFindLastSession.ts')
        const sessionFork = await source('./claude/utils/claudeSessionFork.ts')
        const remoteLauncher = await source('./claude/claudeRemoteLauncher.ts')
        const terminalCleanup = await source('./utils/terminalStdinCleanup.ts')
        const inkFormatter = await source('./ui/messageFormatterInk.ts')

        expect(time).not.toContain('(e as Error)?.message || e')
        for (const forbidden of [
            'errorDetails = errors.map',
            "Failed to fetch push tokens (attempt ${attempt}/${maxAttempts}):', error",
            "Error sending to all devices:', error",
            "sendSessionNotification failed:', error",
        ]) expect(push).not.toContain(forbidden)

        for (const forbidden of [
            'logger: (msg, data) => logger.debug(msg, data)',
            'Spawned session ${result.sessionId}',
            'approval for: ${result.directory}',
            'Stopped session ${sessionId}',
            'Connecting to ${serverUrl}',
            'reason: ${reason}',
            "machine capabilities:', err",
        ]) expect(machine).not.toContain(forbidden)
        for (const forbidden of [
            'defaultLogger.debug(msg, data)',
            '{ method: request.method }',
            '{ error }',
        ]) expect(rpcManager).not.toContain(forbidden)

        for (const forbidden of [
            'Process exiting with code: ${code}',
            'Process about to exit with code: ${code}',
            'Health check started at ${new Date()',
            'Health check completed at ${updatedState.lastHeartbeat}',
            'Somehow a different daemon was started',
        ]) expect(daemon).not.toContain(forbidden)
        expect(controlServer).not.toContain("Failed to start:', err")

        for (const forbidden of [
            'Spawning: ${command} ${args.join',
            'Process exited: code=${code} signal=${signal}',
            "Disconnecting; pid=${pid ?? 'none'}",
            '${method} (id=${id})',
            '${method} (notification)',
            'response (id=${id})',
            'stale epoch for id=${msg.id}',
        ]) expect(codexClient).not.toContain(forbidden)
        expect(codexRunner).not.toContain('kinds=${JSON.stringify(kinds)}')

        expect(queue).not.toContain('mode hash: ${modeHash}')
        for (const forbidden of [
            'Title captured: "${title}"',
            'tool call start for: "${title}"',
            'Complete reasoning - Title: "${title}"',
        ]) expect(reasoning).not.toContain(forbidden)

        for (const forbidden of ['${sessionFile}', "Malformed JSON at line ${index + 1}:', e", 'Session ${sessionId}:']) {
            expect(checkSession).not.toContain(forbidden)
        }
        expect(findSession).not.toContain("Error finding sessions:', e")
        for (const forbidden of ['Forked ${sourceClaudeSessionId}', '-> ${newId}', 'cut after ${cutAfterUuid}']) {
            expect(sessionFork).not.toContain(forbidden)
        }
        for (const forbidden of ['Date.now() - t0', 'event.bytes', 'event.chunks', 'rawMode=${']) {
            expect(remoteLauncher).not.toContain(forbidden)
        }
        expect(terminalCleanup).not.toContain('onDebug')
        expect(inkFormatter).not.toContain('Message from remote mode:')
        expect(inkFormatter).not.toContain("onAssistantResult callback:', err")
        expect(inkFormatter).not.toContain("debugLargeJson('[RESULT] Error during execution'")
    })
})
