export function resolveDirectVoiceAgentId(
    bypassEnabled: boolean,
    customAgentId: string | null | undefined,
): string | null {
    if (!bypassEnabled) {
        return null;
    }

    const normalized = customAgentId?.trim();
    return normalized && /^[A-Za-z0-9_-]{1,128}$/.test(normalized) ? normalized : null;
}
