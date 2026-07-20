export type HackableMode = {
    key: string;
    name: string;
    description?: string | null;
};

export function hackMode<T extends HackableMode>(mode: T): T {
    const normalizedName = mode.name.trim().toLowerCase();
    const normalizedKey = mode.key.trim().toLowerCase();

    // Capitalize plan/build when key and name are both lowercase
    if ((normalizedKey === 'build' || normalizedKey === 'plan')) {
        // Normalize duplicated labels like "build, build" or "plan/plan"
        const stripped = normalizedName
            .replace(/,\s*/g, '/')
            .split('/')
            .map(s => s.trim());
        const allSame = stripped.every(s => s === normalizedKey);
        if (allSame) {
            return { ...mode, name: normalizedKey.charAt(0).toUpperCase() + normalizedKey.slice(1) };
        }
    }
    return mode;
}

export function hackModes<T extends HackableMode>(modes: T[]): T[] {
    return modes.map(hackMode);
}
