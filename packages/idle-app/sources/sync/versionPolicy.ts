export function isStrictlyNewerVersion(incoming: number, current: number): boolean {
    return Number.isSafeInteger(incoming)
        && incoming >= 0
        && Number.isSafeInteger(current)
        && incoming > current;
}
