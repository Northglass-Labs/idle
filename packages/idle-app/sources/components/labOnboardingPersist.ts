/**
 * Lab onboarding / hint-once persistence helpers (pure).
 *
 * All three are tiny "shown once globally" decisions backed by mmkv flags.
 * The pure decision functions here are vitest-runnable; the mmkv read/write
 * lives in persistence.ts with sane defaults if the flag is absent.
 *
 * Flag keys (in mmkv):
 *   - lab-onboarding-seen-v1     — first Lab visit welcome card
 *   - swipe-removed-hint-seen-v1 — first swipe attempt after the removal
 *   - session-actions-hint-seen-v1 — first-launch ⋯ coachmark
 */

export function shouldShowLabOnboarding(seenFlag: string | undefined): boolean {
    return seenFlag !== 'seen';
}

export function shouldShowSwipeRemovedHint(seenFlag: string | undefined): boolean {
    return seenFlag !== 'seen';
}

export function shouldShowSessionActionsHint(
    seenFlag: string | undefined,
    hasPairedTerminal: boolean,
    sessionCount: number,
): boolean {
    if (seenFlag === 'seen') return false;
    if (!hasPairedTerminal) return false;
    if (sessionCount < 2) return false;
    return true;
}
