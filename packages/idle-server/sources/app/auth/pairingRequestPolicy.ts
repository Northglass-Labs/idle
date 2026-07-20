export const PAIRING_REQUEST_TTL_MS = 5 * 60 * 1000;

export function pairingRequestCutoff(now = Date.now()): Date {
    return new Date(now - PAIRING_REQUEST_TTL_MS);
}

export function isPairingRequestFresh(createdAt: Date, now = Date.now()): boolean {
    const createdAtMs = createdAt.getTime();
    return Number.isFinite(createdAtMs) && createdAtMs >= now - PAIRING_REQUEST_TTL_MS;
}
