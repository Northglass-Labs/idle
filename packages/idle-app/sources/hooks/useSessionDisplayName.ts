import { Session } from '@/sync/storageTypes';
import { useLocalSetting } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';

/**
 * Resolves the display name for a session, preferring a user-set local
 * override over the canonical name from session metadata.
 *
 * Why this exists separately from `getSessionName`:
 * - `getSessionName(session)` is a pure function called from many places
 *   (including non-React contexts) and shouldn't pull MMKV state.
 * - The local override is keyed by `sessionId` and lives in
 *   `localSettings.customSessionNames`, which is per-device + not synced.
 * - Components that want the user-visible name on a session row should
 *   use this hook so renames immediately re-render.
 *
 * The CLI owns canonical session metadata (`metadata.summary.text`, etc.);
 * this hook applies an intentionally device-local display override.
 */
export function useSessionDisplayName(session: Session): string {
    const customNames = useLocalSetting('customSessionNames');
    const override = customNames?.[session.id];
    if (override && override.trim()) {
        return override;
    }
    return getSessionName(session);
}
