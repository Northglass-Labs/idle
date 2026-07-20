import { logger } from '@/ui/logger';

/**
 * Expands ${VAR} references in environment variable values.
 *
 * Session profiles may reference the daemon environment. Resolving them in
 * process gives direct and tmux launch paths identical behavior.
 *
 * @param envVars - Environment variables that may contain ${VAR} references
 * @param sourceEnv - Source environment (usually process.env) to resolve references from
 * @returns New object with resolvable references expanded
 */
export function expandEnvironmentVariables(
    envVars: Record<string, string>,
    sourceEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
    const expanded: Record<string, string> = {};
    let resolvedReferenceCount = 0;
    let defaultedReferenceCount = 0;
    let undefinedReferenceCount = 0;
    let emptyReferenceCount = 0;

    for (const [key, value] of Object.entries(envVars)) {
        // Replace all ${VAR} and ${VAR:-default} references with actual values from sourceEnv
        const expandedValue = value.replace(/\$\{([^}]+)\}/g, (match, expr) => {
            // Support bash parameter expansion: ${VAR:-default}
            // Example: ${Z_AI_BASE_URL:-https://api.z.ai/api/anthropic}
            const colonDashIndex = expr.indexOf(':-');
            let varName: string;
            let defaultValue: string | undefined;

            if (colonDashIndex !== -1) {
                // Split ${VAR:-default} into varName and defaultValue
                varName = expr.substring(0, colonDashIndex);
                defaultValue = expr.substring(colonDashIndex + 2);
            } else {
                // Simple ${VAR} reference
                varName = expr;
            }

            const resolvedValue = sourceEnv[varName];
            if (resolvedValue !== undefined) {
                resolvedReferenceCount++;
                if (resolvedValue === '') {
                    emptyReferenceCount++;
                }
                return resolvedValue;
            } else if (defaultValue !== undefined) {
                defaultedReferenceCount++;
                return defaultValue;
            } else {
                undefinedReferenceCount++;
                return match;
            }
        });

        expanded[key] = expandedValue;
    }

    if (resolvedReferenceCount > 0 || defaultedReferenceCount > 0) {
        logger.debug('[EXPAND ENV] Environment references processed', {
            resolvedReferenceCount,
            defaultedReferenceCount,
        });
    }
    if (emptyReferenceCount > 0) {
        logger.warn('[EXPAND ENV] One or more environment references resolved to an empty value', {
            emptyReferenceCount,
        });
    }
    if (undefinedReferenceCount > 0) {
        logger.warn('[EXPAND ENV] One or more environment references are undefined', {
            undefinedReferenceCount,
        });
    }

    return expanded;
}
