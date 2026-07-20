import * as React from 'react';
import { MMKV } from 'react-native-mmkv';

// Local-only UI state. The collapsed-groups map is per-device, not synced —
// collapsing a group on one device does not change another device.
// A versioned MMKV key keeps this device-only preference outside synchronized
// account settings.

const STORAGE_KEY = 'session-group-collapsed-v1';
const mmkv = new MMKV();

type CollapsedMap = Record<string, boolean>;

function readFromStorage(): CollapsedMap {
    try {
        const raw = mmkv.getString(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as CollapsedMap;
        }
        return {};
    } catch {
        return {};
    }
}

function writeToStorage(map: CollapsedMap): void {
    try {
        mmkv.set(STORAGE_KEY, JSON.stringify(map));
    } catch {
        // No-op — MMKV write failure is non-fatal for UI state. Worst case
        // the user re-collapses the group on next launch.
    }
}

export function useSessionGroupCollapse(): {
    collapsed: CollapsedMap;
    toggleGroup: (groupId: string) => void;
    setCollapsed: (groupId: string, isCollapsed: boolean) => void;
} {
    const [collapsed, setState] = React.useState<CollapsedMap>(() => readFromStorage());

    const toggleGroup = React.useCallback((groupId: string) => {
        setState(prev => {
            const next = { ...prev, [groupId]: !prev[groupId] };
            writeToStorage(next);
            return next;
        });
    }, []);

    const setCollapsed = React.useCallback((groupId: string, isCollapsed: boolean) => {
        setState(prev => {
            if (prev[groupId] === isCollapsed) return prev;
            const next = { ...prev, [groupId]: isCollapsed };
            writeToStorage(next);
            return next;
        });
    }, []);

    return { collapsed, toggleGroup, setCollapsed };
}
