import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildIssueReportBody } from './issueReport';

const baseEnvironment = {
    appVersion: '1.2.3',
    platform: 'ios',
    osVersion: '18.5',
};

describe('buildIssueReportBody', () => {
    it('reports a self-hosted relay without embedding its hostname', () => {
        const body = buildIssueReportBody({
            ...baseEnvironment,
            isCustomServer: true,
        });

        expect(body.split('\n').find((line) => line.startsWith('- **Relay server:**')))
            .toBe('- **Relay server:** self-hosted');
        expect(body).not.toMatch(/self-hosted\s*\(/);
        expect(body).not.toContain('://');
    });

    it('reports the Northglass relay only as hosted', () => {
        const body = buildIssueReportBody({
            ...baseEnvironment,
            isCustomServer: false,
        });

        expect(body.split('\n').find((line) => line.startsWith('- **Relay server:**')))
            .toBe('- **Relay server:** hosted');
        expect(body).not.toMatch(/hosted\s*\(/);
        expect(body).not.toContain('idle-api.northglass.io');
    });

    it('keeps SettingsView on the hostname-free report boundary', () => {
        const settingsSource = readFileSync(
            new URL('./IdleSettingsView.tsx', import.meta.url),
            'utf8',
        );
        const reportHandler = settingsSource.slice(
            settingsSource.indexOf('const handleReportIssue'),
            settingsSource.indexOf('// Connection state for the CONNECTED group'),
        );

        expect(reportHandler).toContain('buildIssueReportBody({');
        expect(reportHandler).not.toContain('getServerInfo');
        expect(reportHandler).not.toMatch(/serverInfo\.hostname/);
    });
});
