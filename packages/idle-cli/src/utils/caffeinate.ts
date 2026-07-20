import { spawn, type ChildProcess } from 'node:child_process'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'

let caffeinateProcess: ChildProcess | null = null

export function buildCaffeinateArguments(ownerPid: number = process.pid): string[] {
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
        throw new Error('A positive daemon PID is required')
    }
    return ['-im', '-w', String(ownerPid)]
}

export function startCaffeinate(): boolean {
    if (configuration.disableCaffeinate) {
        logger.debug('[caffeinate] Caffeinate disabled via IDLE_DISABLE_CAFFEINATE environment variable')
        return false
    }

    if (process.platform !== 'darwin') {
        logger.debug('[caffeinate] Not on macOS, skipping caffeinate')
        return false
    }

    if (caffeinateProcess && !caffeinateProcess.killed && caffeinateProcess.exitCode === null) {
        logger.debug('[caffeinate] Caffeinate already running')
        return true
    }

    try {
        const child = spawn('caffeinate', ['-im', '-w', String(process.pid)], {
            stdio: 'ignore',
            detached: false,
        })
        caffeinateProcess = child

        child.on('error', () => {
            logger.debug('[caffeinate] Failed to start sleep prevention')
            if (caffeinateProcess === child) caffeinateProcess = null
        })

        child.on('exit', () => {
            logger.debug('[caffeinate] Sleep prevention stopped')
            if (caffeinateProcess === child) caffeinateProcess = null
        })

        logger.debug('[caffeinate] Sleep prevention started')
        return true
    } catch {
        logger.debug('[caffeinate] Failed to start sleep prevention')
        caffeinateProcess = null
        return false
    }
}

let isStopping = false

export async function stopCaffeinate(): Promise<void> {
    if (isStopping) {
        logger.debug('[caffeinate] Already stopping, skipping')
        return
    }
    const child = caffeinateProcess
    if (!child || child.killed || child.exitCode !== null) return

    isStopping = true
    caffeinateProcess = null
    try {
        child.kill('SIGTERM')
    } catch {
        logger.debug('[caffeinate] Failed to stop sleep prevention')
    } finally {
        isStopping = false
    }
}

export function isCaffeinateRunning(): boolean {
    return caffeinateProcess !== null
        && !caffeinateProcess.killed
        && caffeinateProcess.exitCode === null
}
