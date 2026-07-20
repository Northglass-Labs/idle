/**
 * UI predicate for the "(sandboxed)" badge on the permission-mode chip.
 *
 * Contract: `metadata.sandbox` is the runtime SECURITY CLAIM the CLI
 * makes about the spawned process — it is only set non-null after sandbox
 * enforcement is verified to be active. This predicate is intentionally
 * strict: only `{ enabled: true }` (and shape-compatible config objects)
 * count. An empty object, a missing `enabled` key, or a truthy-but-not-true
 * `enabled` value all collapse to false.
 *
 * The prior inline `isSandboxEnabled` accepted
 * "any truthy non-null sandbox object that doesn't have an `enabled` key"
 * as enabled — letting empty `{}` payloads light the badge. This is a
 * defense-in-depth fix; no in-tree writer ever produced an empty payload,
 * but tightening the check closes the case.
 */
export function isSandboxActive(sandbox: unknown): boolean {
    if (!sandbox || typeof sandbox !== 'object') {
        return false;
    }
    const maybeEnabled = (sandbox as { enabled?: unknown }).enabled;
    return maybeEnabled === true;
}
