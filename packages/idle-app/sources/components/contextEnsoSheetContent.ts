/**
 * Pure content formatter for the ContextEnsoSheet bottom-sheet.
 *
 * Lives in its own file so the formatting logic (percent calculations, model
 * label, row contents, empty-state branch) is unit-testable in plain vitest
 * without pulling in React Native. The sheet component (ContextEnsoSheet.tsx)
 * is a thin presentation wrapper around this output.
 *
 * Encodes the ensō visualization and accessibility-label contract.
 */

export type ContextEnsoSheetRow = {
    label: string;   // "Used" / "Remaining" / "Window" / "Model"
    value: string;   // pre-formatted with commas + units
    mono: boolean;   // values are tabular-num mono; labels are sans-serif
};

export type ContextEnsoSheetContent =
    | {
        kind: 'no-data';
        modelLine: string | null;
        rows: ContextEnsoSheetRow[];
        showTip: false;
    }
    | {
        kind: 'data';
        percentText: string;      // e.g. "42% used"
        percentTier: 'normal' | 'warning' | 'critical';
        modelLine: string;        // e.g. "claude-opus-4-7 · 1M"
        rows: ContextEnsoSheetRow[];
        showTip: true;
    };

const WARNING_THRESHOLD = 0.90;
const CRITICAL_THRESHOLD = 0.95;

function formatWindowSize(total: number): string {
    if (total >= 1_000_000) {
        const m = total / 1_000_000;
        return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
    }
    if (total >= 1_000) {
        const k = total / 1_000;
        return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
    }
    return String(total);
}

function formatModel(model: string | null | undefined): string {
    if (!model || model === 'unknown') return 'unknown model';
    return model;
}

export function buildContextEnsoSheetContent(args: {
    usedTokens: number | null;
    totalTokens: number;
    model: string | null | undefined;
}): ContextEnsoSheetContent {
    const { usedTokens, totalTokens, model } = args;
    const modelLabel = formatModel(model);
    const windowLabel = formatWindowSize(totalTokens);

    if (usedTokens === null || usedTokens === 0) {
        return {
            kind: 'no-data',
            modelLine: null,
            rows: [
                { label: 'Window', value: `${totalTokens.toLocaleString()} tokens`, mono: true },
                { label: 'Model', value: modelLabel, mono: true },
            ],
            showTip: false,
        };
    }

    // Clamp ratio so 110%-used (cache-cookie edge) doesn't render as -10% remaining.
    const ratio = Math.min(1, Math.max(0, usedTokens / totalTokens));
    const remaining = Math.max(0, totalTokens - usedTokens);
    // Match ContextEnso.tsx threshold logic: compare ratio directly to avoid
    // 1 - 0.95 = 0.0500...004 float misclassification.
    let tier: 'normal' | 'warning' | 'critical' = 'normal';
    if (ratio >= CRITICAL_THRESHOLD) tier = 'critical';
    else if (ratio >= WARNING_THRESHOLD) tier = 'warning';

    // Whole-percent display — fractional precision would just add noise on a peek-at-numbers sheet.
    const percentNum = Math.round(ratio * 100);

    return {
        kind: 'data',
        percentText: `${percentNum}% used`,
        percentTier: tier,
        modelLine: `${modelLabel} · ${windowLabel}`,
        rows: [
            { label: 'Used', value: `${usedTokens.toLocaleString()} tokens`, mono: true },
            { label: 'Remaining', value: `${remaining.toLocaleString()} tokens`, mono: true },
            { label: 'Window', value: `${totalTokens.toLocaleString()} tokens`, mono: true },
        ],
        showTip: true,
    };
}
