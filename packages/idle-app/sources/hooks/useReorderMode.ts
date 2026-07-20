import { create } from 'zustand';

// Tiny standalone store for the "rearrange sessions" mode. Volatile —
// reorder mode resets on app launch, exit-on-blur, etc. Not persisted.
//
// This small store is intentionally separate from durable session state.

interface ReorderModeState {
    enabled: boolean;
    enter: () => void;
    exit: () => void;
    toggle: () => void;
}

export const useReorderMode = create<ReorderModeState>((set) => ({
    enabled: false,
    enter: () => set({ enabled: true }),
    exit: () => set({ enabled: false }),
    toggle: () => set((state) => ({ enabled: !state.enabled })),
}));
