import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativeUrl: string): string {
    return readFileSync(new URL(relativeUrl, import.meta.url), 'utf8');
}

describe('release simulator testability contract', () => {
    it('keeps stable selectors for the live new-session path', () => {
        const newSession = source('../app/(app)/new/index.tsx');
        const homeHeader = source('../components/HomeHeader.tsx');
        const mainView = source('../components/MainView.tsx');

        expect(homeHeader).toContain('testID="start-new-session"');
        expect(mainView).toContain('testID="start-new-session"');
        expect(newSession).toContain('testID={`picker-option-${item.key}`}');
        expect(newSession).toContain('testID="new-session-agent-picker"');
        expect(newSession).toContain('testID="new-session-prompt"');
        expect(newSession).toContain('testID="new-session-submit"');
    });

    it('distinguishes live session rows from archived history after relaunch', () => {
        const activeSessions = source('../components/ActiveSessionsGroup.tsx');
        const compactActiveSessions = source('../components/ActiveSessionsGroupCompact.tsx');
        const relaunchFlow = source('../../../idle-e2e-mobile/flows/16-live-session-relaunch.yaml');

        expect(activeSessions).toContain('testID="active-session-row"');
        expect(compactActiveSessions).toContain('testID="active-session-row"');
        expect(relaunchFlow).toContain('id: "active-session-row"');
        expect(relaunchFlow).not.toContain('id: "session-row"');
    });

    it('keeps release runs private and recovers only simulator infrastructure failures', () => {
        const runner = source('../../../idle-e2e-mobile/scripts/run-authed.sh');

        expect(runner).toContain('umask 077');
        expect(runner).toContain('IDLE_MAESTRO_ARTIFACT_ROOT');
        expect(runner).toContain('IDLE_MAESTRO_INFRA_RETRIES');
        expect(runner).toContain('launchctl print user/foreground/com.apple.SpringBoard');
        expect(runner).toContain('is_infrastructure_only_failure');
        expect(runner).toContain('--debug-output "$flow_debug_dir"');
        expect(runner).toContain('--test-output-dir "$flow_test_dir"');
        expect(runner).toMatch(/if run_maestro_attempt[\s\S]+then[\s\S]+break[\s\S]+else\s+status=\$\?/);
    });
});
