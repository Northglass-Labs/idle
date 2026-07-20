import { log } from "./log";

export type ShutdownPhase = 'drain' | 'storage';

export interface ShutdownHandler {
    name: string;
    phase: ShutdownPhase;
    callback: () => Promise<void>;
}

const shutdownHandlers = new Set<ShutdownHandler>();
const shutdownController = new AbortController();

export const shutdownSignal = shutdownController.signal;

export function onShutdown(
    name: string,
    callback: () => Promise<void>,
    phase: ShutdownPhase = 'drain',
): () => void {
    if (shutdownSignal.aborted) {
        // If already shutting down, execute immediately
        void callback().catch(() => {
            log({ module: 'shutdown', level: 'error' }, 'Late shutdown handler failed');
        });
        return () => {};
    }

    const handler: ShutdownHandler = { name, phase, callback };
    shutdownHandlers.add(handler);

    // Return unsubscribe function
    return () => {
        shutdownHandlers.delete(handler);
    };
}

export function isShutdown() {
    return shutdownSignal.aborted;
}

async function runShutdownPhase(
    phase: ShutdownPhase,
    handlers: readonly ShutdownHandler[],
): Promise<void> {
    const phaseHandlers = handlers.filter(handler => handler.phase === phase);
    if (phaseHandlers.length === 0) {
        return;
    }

    const grouped = new Map<string, ShutdownHandler[]>();
    for (const handler of phaseHandlers) {
        const group = grouped.get(handler.name) ?? [];
        group.push(handler);
        grouped.set(handler.name, group);
    }

    const allHandlers: Promise<void>[] = [];
    for (const group of grouped.values()) {
        log({ module: 'shutdown', phase, handlerCount: group.length }, 'Starting shutdown handlers');
        group.forEach((handler) => {
            allHandlers.push(handler.callback().then(
                () => {},
                () => log({ module: 'shutdown', level: 'error', phase }, 'Shutdown handler failed'),
            ));
        });
    }

    log({ module: 'shutdown', phase, handlerCount: phaseHandlers.length }, 'Waiting for shutdown handlers');
    const startTime = Date.now();
    await Promise.all(allHandlers);
    const duration = Date.now() - startTime;
    log({
        module: 'shutdown',
        phase,
        handlerCount: phaseHandlers.length,
        durationMs: duration,
    }, 'Shutdown handlers completed');
}

export async function runShutdownHandlers(
    handlers: readonly ShutdownHandler[],
): Promise<void> {
    await runShutdownPhase('drain', handlers);
    await runShutdownPhase('storage', handlers);
}

export async function awaitShutdown() {
    await new Promise<void>((resolve) => {
        process.on('SIGINT', async () => {
            log('Received SIGINT signal. Exiting...');
            resolve();
        });
        process.on('SIGTERM', async () => {
            log('Received SIGTERM signal. Exiting...');
            resolve();
        });
    });
    shutdownController.abort();

    // Snapshot before execution so late registrations cannot reorder storage
    // close ahead of already-running drain work.
    await runShutdownHandlers([...shutdownHandlers]);
}

export async function keepAlive<T>(name: string, callback: () => Promise<T>): Promise<T> {
    let completed = false;
    let result: T;
    let error: any;

    const promise = new Promise<void>((resolve) => {
        const unsubscribe = onShutdown(`keepAlive:${name}`, async () => {
            if (!completed) {
                log({ module: 'shutdown' }, 'Waiting for active operation to complete');
                await promise;
            }
        });

        // Run the callback
        callback().then(
            (res) => {
                result = res;
                completed = true;
                unsubscribe();
                resolve();
            },
            (err) => {
                error = err;
                completed = true;
                unsubscribe();
                resolve();
            }
        );
    });

    // Wait for completion
    await promise;

    if (error) {
        throw error;
    }

    return result!;
}
