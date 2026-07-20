import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NORTHGLASS_PRODUCTION_URL = new RegExp(['https://', '[a-z0-9.-]*', 'northglass\\.io'].join(''), 'i');

function walk(directory: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'build', '.git'].includes(entry.name)) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...walk(target));
        else files.push(target);
    }
    return files;
}

function isTestNetworkSource(filePath: string): boolean {
    const relative = path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
    return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)
        || /^packages\/idle-e2e\/.*\.[cm]?[jt]s$/.test(relative)
        || /^packages\/idle-server\/vitest(?:\.[^.]+)?\.config\.ts$/.test(relative)
        || relative === 'packages/idle-cli/src/test-setup.ts';
}

describe('test network hygiene', () => {
    const sources = walk(REPO_ROOT).filter(isTestNetworkSource);

    it('does not hard-code Northglass production URLs in test source', () => {
        const offenders = sources
            .filter(filePath => NORTHGLASS_PRODUCTION_URL.test(fs.readFileSync(filePath, 'utf8')))
            .map(filePath => path.relative(REPO_ROOT, filePath));
        expect(offenders).toEqual([]);
    });

    it('does not fall back from a test URL environment variable to a network URL', () => {
        const fallbackPattern = /process\.env\.[A-Z0-9_]+\s*(?:\|\||\?\?)\s*['"]https?:\/\//;
        const offenders = sources
            .filter(filePath => fallbackPattern.test(fs.readFileSync(filePath, 'utf8')))
            .map(filePath => path.relative(REPO_ROOT, filePath));
        expect(offenders).toEqual([]);
    });

    it('requires every deployed-server spec to use the explicit live-target gate', () => {
        const liveSpecs = sources.filter(filePath => filePath.endsWith('.live.security.spec.ts'));
        const offenders = liveSpecs
            .filter(filePath => !fs.readFileSync(filePath, 'utf8').includes('getExplicitLiveTestTarget'))
            .map(filePath => path.relative(REPO_ROOT, filePath));
        expect(offenders).toEqual([]);
    });

    it('installs the same two-control gate at the Playwright entry point', () => {
        const playwrightConfig = fs.readFileSync(path.join(REPO_ROOT, 'packages/idle-e2e/playwright.config.ts'), 'utf8');
        const e2eTarget = fs.readFileSync(path.join(REPO_ROOT, 'packages/idle-e2e/helpers/liveTarget.ts'), 'utf8');
        expect(playwrightConfig).toContain('./helpers/liveTarget');
        expect(e2eTarget).toContain("'TEST_SERVER_URL'");
        expect(e2eTarget).toContain("'IDLE_ALLOW_LIVE_TESTS'");
        const legacyUrlVariable = ['IDLE', 'E2E', 'SERVER', 'URL'].join('_');
        expect(sources.filter(filePath => fs.readFileSync(filePath, 'utf8').includes(legacyUrlVariable)))
            .toEqual([]);
    });
});

describe('runtime secret hygiene', () => {
    it('confines boot secret environment access to the boot loader', () => {
        const serverSources = walk(path.join(REPO_ROOT, 'packages/idle-server/sources'))
            .filter(filePath => /\.[cm]?[jt]s$/.test(filePath))
            .filter(filePath => !/\.(?:test|spec)\.[cm]?[jt]s$/.test(filePath))
            .filter(filePath => !filePath.endsWith(path.join('utils', 'validateBootSecret.ts')));
        const bootEnvironmentAccess = /process\.env\.IDLE_MASTER_SECRET(?:_FILE)?\b/;
        const offenders = serverSources
            .filter(filePath => bootEnvironmentAccess.test(fs.readFileSync(filePath, 'utf8')))
            .map(filePath => path.relative(REPO_ROOT, filePath).split(path.sep).join('/'));

        expect(offenders).toEqual([]);
    });
});
