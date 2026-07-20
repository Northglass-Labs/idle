/**
 * Human-readable elapsed-time formatter for tool-call durations.
 *
 * The `.toFixed(1)` + bare-seconds format is illegible
 * above ~2 minutes. Past 60s, switch to minute:second; past an hour, drop
 * seconds entirely.
 *
 * Examples:
 *   formatElapsedSeconds(0.4)   → '0s'
 *   formatElapsedSeconds(7.2)   → '7s'
 *   formatElapsedSeconds(59.8)  → '60s'
 *   formatElapsedSeconds(60)    → '1m 0s'
 *   formatElapsedSeconds(67.4)  → '1m 7s'
 *   formatElapsedSeconds(125)   → '2m 5s'
 *   formatElapsedSeconds(3599)  → '59m 59s'
 *   formatElapsedSeconds(3600)  → '1h 0m'
 *   formatElapsedSeconds(3725)  → '1h 2m'
 *   formatElapsedSeconds(7322)  → '2h 2m'
 */

export function formatElapsedSeconds(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0s';
    const total = Math.round(seconds);

    if (total < 60) {
        return `${total}s`;
    }

    if (total < 3600) {
        const minutes = Math.floor(total / 60);
        const remSeconds = total % 60;
        return `${minutes}m ${remSeconds}s`;
    }

    const hours = Math.floor(total / 3600);
    const remMinutes = Math.floor((total % 3600) / 60);
    return `${hours}h ${remMinutes}m`;
}
