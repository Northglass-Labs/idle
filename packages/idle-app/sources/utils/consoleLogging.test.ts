import { afterEach, describe, expect, it, vi } from 'vitest';

import { initConsoleLogging } from './consoleLogging';

const consoleMethods = [
    'assert',
    'clear',
    'context',
    'count',
    'countReset',
    'debug',
    'dir',
    'dirxml',
    'error',
    'group',
    'groupCollapsed',
    'groupEnd',
    'info',
    'log',
    'profile',
    'profileEnd',
    'table',
    'time',
    'timeEnd',
    'timeLog',
    'timeStamp',
    'trace',
    'warn',
] as const;
type ConsoleMethod = typeof consoleMethods[number];
type ConsoleFunction = (...args: unknown[]) => unknown;
type ConsoleSubset = Record<ConsoleMethod, ConsoleFunction>;

describe('initConsoleLogging', () => {
    const runtimeConsole = console as unknown as ConsoleSubset;
    const originals = Object.fromEntries(
        consoleMethods.map((method) => [method, runtimeConsole[method]]),
    ) as ConsoleSubset;

    afterEach(() => {
        for (const method of consoleMethods) {
            runtimeConsole[method] = originals[method];
        }
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('suppresses every console method without creating network egress in production', () => {
        const originalSpies = Object.fromEntries(
            consoleMethods.map((method) => [method, vi.fn()]),
        ) as Record<ConsoleMethod, ReturnType<typeof vi.fn>>;
        for (const method of consoleMethods) {
            runtimeConsole[method] = originalSpies[method];
        }
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        initConsoleLogging();

        for (const method of consoleMethods) {
            runtimeConsole[method]('credential-shaped payload');
            expect(originalSpies[method]).not.toHaveBeenCalled();
        }
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
