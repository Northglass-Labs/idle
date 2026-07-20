/**
 * Build a new child-only environment. Per-session values never mutate the
 * long-lived daemon environment and disappear with the provider process.
 */

export interface BuildSpawnEnvArgs {
    /** Base environment selected for the provider child. */
    baseEnv: NodeJS.ProcessEnv;
    /** Per-session values applied only to the returned child environment. */
    additionalEnv?: Record<string, string> | undefined;
}

/** Merge values into a new object without retaining the base environment by reference. */
export function buildSpawnEnv(args: BuildSpawnEnvArgs): NodeJS.ProcessEnv {
    if (!args.additionalEnv) {
        // Still copy so the consumer doesn't hold a reference to process.env that could be
        // mutated elsewhere.
        return { ...args.baseEnv };
    }
    return {
        ...args.baseEnv,
        ...args.additionalEnv,
    };
}
