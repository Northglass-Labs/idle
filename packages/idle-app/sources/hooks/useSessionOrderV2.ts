import * as React from 'react';
import {
    getCachedSessionOrderV2,
    subscribeSessionOrderV2,
} from '@/sync/sessionOrderPersistence';
import { SessionOrderV2 } from '@/sync/sessionOrder';

/**
 * Subscribe to the V2 session order (groups + ungrouped ordering).
 *
 * The cache lives in sessionOrderPersistence.ts and is mutated by:
 *  - loadSessionOrderV2 on app start (fetches from encrypted KV)
 *  - sync.createSessionGroup / moveSessionToGroup / etc. on user action
 *
 * Both pathways call notifyV2Subscribers, so this hook re-renders on every
 * mutation without us needing to bounce through Zustand. Returning the cached
 * value directly keeps render-cycle cost at one ref equality + the snapshot
 * read — no object allocation when the order hasn't changed.
 */
export function useSessionOrderV2(): SessionOrderV2 {
    const subscribe = React.useCallback((cb: () => void) => {
        return subscribeSessionOrderV2(cb);
    }, []);
    return React.useSyncExternalStore(subscribe, getCachedSessionOrderV2, getCachedSessionOrderV2);
}
