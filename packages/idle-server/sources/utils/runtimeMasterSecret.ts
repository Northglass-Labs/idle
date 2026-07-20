import { validateBootSecret } from './validateBootSecret';

let runtimeMasterSecret: string | undefined;

/**
 * Install the validated master secret in process-private module state.
 *
 * The value deliberately never enters process.env: child processes inherit
 * that environment, and environment-backed values are routinely captured by
 * diagnostics. Boot entry points must consume their environment source before
 * calling this function.
 */
export function setRuntimeMasterSecret(value: string): void {
    const validation = validateBootSecret(value);
    if (!validation.ok) {
        throw new Error(validation.error);
    }
    runtimeMasterSecret = value;
}

/** Read the initialized secret without widening it to a global environment. */
export function getRuntimeMasterSecret(): string {
    if (runtimeMasterSecret === undefined) {
        throw new Error('Idle master secret has not been initialized.');
    }
    return runtimeMasterSecret;
}
