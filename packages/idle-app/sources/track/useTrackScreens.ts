import { useSegments } from "expo-router";
import { tracking } from "./tracking";
import React from "react";

export function getScreenCategory(segments: readonly string[]): string {
    const segment = segments.find(value => !value.startsWith('('));
    if (!segment) return 'root';
    return /^[A-Za-z0-9_-]{1,64}$/.test(segment) ? segment : 'unknown';
}

export function useTrackScreens() {
    const route = getScreenCategory(useSegments());
    React.useEffect(() => { tracking?.screen(route); }, [route]);
}
