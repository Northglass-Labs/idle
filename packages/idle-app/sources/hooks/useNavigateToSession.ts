import type { Router } from "expo-router"
import { useRouter } from "expo-router"
import { trackSessionSwitched } from '@/track';

export function navigateToSession(router: Router, sessionId: string) {
    trackSessionSwitched();

    router.push(`/session/${encodeURIComponent(sessionId)}`);
}

export function useNavigateToSession() {
    const router = useRouter();
    return (sessionId: string) => {
        navigateToSession(router, sessionId);
    }
}
