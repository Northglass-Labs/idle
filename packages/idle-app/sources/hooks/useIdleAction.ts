import * as React from 'react';
import { Modal } from '@/modal';
import { IdleError } from '@/utils/errors';

export function useIdleAction(action: () => Promise<void>) {
    const [loading, setLoading] = React.useState(false);
    const loadingRef = React.useRef(false);
    const doAction = React.useCallback(() => {
        if (loadingRef.current) {
            return;
        }
        loadingRef.current = true;
        setLoading(true);
        (async () => {
            try {
                while (true) {
                    try {
                        await action();
                        break;
                    } catch (e) {
                        if (e instanceof IdleError) {
                            Modal.alert('Error', e.message, [{ text: 'OK', style: 'cancel' }]);
                            break;
                        } else {
                            Modal.alert('Error', 'Unknown error', [{ text: 'OK', style: 'cancel' }]);
                            break;
                        }
                    }
                }
            } finally {
                loadingRef.current = false;
                setLoading(false);
            }
        })();
    }, [action]);
    return [loading, doAction] as const;
}
