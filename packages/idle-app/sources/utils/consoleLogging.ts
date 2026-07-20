/**
 * Keep development output local to the attached developer tools and suppress
 * every console channel in release builds. Production diagnostics must use a
 * deliberately designed, redacted telemetry boundary rather than arbitrary
 * console arguments.
 */
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
type RuntimeConsole = Record<ConsoleMethod, (...args: unknown[]) => unknown>;
let isConsolePatched = false;

export function initConsoleLogging() {
    if (isConsolePatched) {
        return;
    }
    isConsolePatched = true;

    if (__DEV__) {
        return;
    }

    const runtimeConsole = console as unknown as RuntimeConsole;
    for (const method of consoleMethods) {
        runtimeConsole[method] = method === 'context' ? () => console : () => {};
    }
}
