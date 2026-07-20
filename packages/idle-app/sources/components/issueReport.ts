export type IssueReportEnvironment = {
    appVersion: string;
    platform: string;
    osVersion: string | number;
    isCustomServer: boolean;
};

export function buildIssueReportBody(environment: IssueReportEnvironment): string {
    return [
        '## What happened',
        '',
        '<!-- Describe the bug -->',
        '',
        '## Steps to reproduce',
        '',
        '1. ',
        '2. ',
        '3. ',
        '',
        '## Environment',
        '',
        `- **Idle app version:** ${environment.appVersion}`,
        `- **Platform:** ${environment.platform}`,
        `- **OS version:** ${environment.osVersion}`,
        `- **Relay server:** ${environment.isCustomServer ? 'self-hosted' : 'hosted'}`,
        '- **Agent:** <!-- Claude / Codex / Gemini -->',
        '',
        '## Logs / screenshots',
        '',
        '<!-- Drop them here if you have them -->',
    ].join('\n');
}
