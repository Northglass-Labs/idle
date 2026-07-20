import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    debug: vi.fn(),
    spawn: vi.fn(),
    handlers: new Map<string, (...args: unknown[]) => void>(),
}))

vi.mock('node:child_process', () => ({
    spawn: mocks.spawn,
}))

vi.mock('@/configuration', () => ({
    configuration: { disableCaffeinate: false },
}))

vi.mock('@/ui/logger', () => ({
    logger: { debug: mocks.debug },
}))

import { buildCaffeinateArguments, startCaffeinate, stopCaffeinate } from './caffeinate'

describe('caffeinate lifecycle isolation', () => {
    let platform: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.handlers.clear()
        platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
        const child = {
            exitCode: null,
            killed: false,
            kill: vi.fn(function (this: { killed: boolean }) {
                this.killed = true
                return true
            }),
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                mocks.handlers.set(event, handler)
                return child
            }),
        }
        mocks.spawn.mockReturnValue(child)
    })

    afterEach(async () => {
        await stopCaffeinate()
        platform.mockRestore()
    })

    it('binds the wake assertion to the owning daemon PID', () => {
        expect(buildCaffeinateArguments(4242)).toEqual(['-im', '-w', '4242'])
        expect(startCaffeinate()).toBe(true)
        expect(mocks.spawn).toHaveBeenCalledWith('caffeinate', [
            '-im',
            '-w',
            String(process.pid),
        ], {
            stdio: 'ignore',
            detached: false,
        })
    })

    it('never persists the child PID or raw startup errors', () => {
        expect(startCaffeinate()).toBe(true)
        mocks.handlers.get('error')?.(new Error('private-startup-diagnostic'))

        const renderedLogs = JSON.stringify(mocks.debug.mock.calls)
        expect(renderedLogs).not.toContain('private-startup-diagnostic')
        expect(renderedLogs).not.toMatch(/\b\d{4,}\b/)
    })
})
