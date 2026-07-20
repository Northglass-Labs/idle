import * as React from 'react';
import { View, TouchableOpacity } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

/**
 * Context window indicator rendered as an ensō (zen brush-stroke circle with
 * a gap at top). The Northglass flagship symbol used as a functional UI
 * element — fill arc grows clockwise from the gap as the session consumes
 * its context window.
 *
 * Visual contract:
 *   - usedTokens === null  → empty ensō stroke only ("no usage data yet")
 *   - totalTokens === null → empty ensō stroke only ("model not resolved yet")
 *   - both present         → fill arc proportional to usedTokens / totalTokens
 *   - >90% used (≤10% left) → fill arc transitions to theme.colors.warning
 *   - >95% used (≤5% left)  → fill arc transitions to theme.colors.warningCritical
 *
 * The empty state fixes the old "0% left" reading: when contextSize=0 the text indicator could
 * read "0% left" red, which looks like failure. An empty ensō reads
 * unambiguously as "ring is open, nothing to show yet."
 *
 * onPress optional — caller decides what tapping does (typically opens a
 * Modal.alert with the absolute numbers + model + /compact hint).
 */

interface ContextEnsoProps {
    usedTokens: number | null;
    totalTokens: number | null;
    size?: number;
    onPress?: () => void;
    testID?: string;
}

const STROKE_WIDTH = 1.5;
// The brush-stroke opening at the top of the ensō. 30° is the visual sweet
// spot — wide enough to read as "intentional gap", narrow enough that the
// arc still dominates.
const GAP_DEGREES = 30;

export const ContextEnso = React.memo(function ContextEnso({
    usedTokens,
    totalTokens,
    size = 16,
    onPress,
    testID,
}: ContextEnsoProps) {
    const { theme } = useUnistyles();

    const radius = (size - STROKE_WIDTH) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const circumference = 2 * Math.PI * radius;
    const gapLength = (GAP_DEGREES / 360) * circumference;
    const arcLength = circumference - gapLength;

    const hasData = usedTokens !== null && totalTokens !== null && totalTokens > 0;
    const usedRatio = hasData
        ? Math.min(1, Math.max(0, usedTokens! / totalTokens!))
        : 0;
    // We compare usedRatio directly against thresholds rather than computing
    // remainingPct = 1 - usedRatio because float subtraction edge cases
    // (e.g., 1 - 0.95 = 0.05000...0004) misclassify 95%-used into "warning"
    // instead of "critical". Comparing the original value avoids the issue.

    // SVG <circle> starts at 3 o'clock and renders clockwise. We want the
    // gap centered at 12 o'clock — rotate -90° (to start at top) and back off
    // by half the gap width so the gap straddles top dead center.
    const rotation = -90 - GAP_DEGREES / 2;

    // Base stroke: draw the arc, then the gap.
    const baseDashArray = `${arcLength} ${gapLength}`;

    // Fill arc: starts at the same point as the base, grows clockwise.
    const fillArcLength = arcLength * usedRatio;
    const fillDashArray = `${fillArcLength} ${circumference - fillArcLength}`;

    // Color tier for the fill arc.
    let fillColor: string;
    if (usedRatio >= 0.95) {
        fillColor = theme.colors.warningCritical;
    } else if (usedRatio >= 0.90) {
        fillColor = theme.colors.warning;
    } else {
        fillColor = theme.colors.textSecondary;
    }

    const ring = (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            {/* Base ensō stroke — always visible (with the brush-stroke gap) */}
            <Circle
                cx={cx}
                cy={cy}
                r={radius}
                fill="none"
                stroke={theme.colors.textSecondary}
                strokeWidth={STROKE_WIDTH}
                strokeLinecap="round"
                strokeDasharray={baseDashArray}
                transform={`rotate(${rotation} ${cx} ${cy})`}
                opacity={hasData ? 0.3 : 0.4}
            />
            {/* Fill arc — only when we have actual usage data */}
            {hasData && usedRatio > 0 && (
                <Circle
                    cx={cx}
                    cy={cy}
                    r={radius}
                    fill="none"
                    stroke={fillColor}
                    strokeWidth={STROKE_WIDTH}
                    strokeLinecap="round"
                    strokeDasharray={fillDashArray}
                    transform={`rotate(${rotation} ${cx} ${cy})`}
                />
            )}
        </Svg>
    );

    if (onPress) {
        return (
            <TouchableOpacity onPress={onPress} hitSlop={8} testID={testID}>
                {ring}
            </TouchableOpacity>
        );
    }
    return <View testID={testID}>{ring}</View>;
});
