import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('ignore files describe current product outputs without legacy tool diaries', () => {
  const contents = [read('.gitignore'), read('packages/idle-cli/.gitignore')].join('\n');
  const staleTerms = [
    ['super', 'powers'].join(''),
    ['ral', 'phex'].join(''),
    ['super', 'vibe'].join(''),
    ['hap', 'py'].join(''),
    ['competition', 'opencode'].join('/'),
    'claude-docs',
    'release-notes-temp',
  ];

  for (const term of staleTerms) {
    assert.equal(contents.toLowerCase().includes(term.toLowerCase()), false, term);
  }

  for (const required of [
    'node_modules/',
    '.DS_Store',
    '**/.claude/',
    'packages/idle-app/certs/private-key.pem',
    'environments/data/',
    '.idle-dev/',
  ]) {
    assert.ok(contents.includes(required), required);
  }
  assert.match(contents, /^\.env\*$/m);
  assert.match(contents, /^data\/$/m);
  assert.equal(
    execFileSync('git', ['ls-files', '--', '**/.claude/**'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    '',
    'maintainer progress and agent context must remain outside the public tree',
  );
});

test('the private workspace root and public packages use Idle product names', () => {
  const rootPackage = JSON.parse(read('package.json'));
  assert.equal(rootPackage.private, true);
  assert.equal(rootPackage.name, 'idle');

  const rootReadme = read('README.md');
  assert.match(rootReadme, />a Northglass Product<\/a>/);
  assert.doesNotMatch(rootReadme, />A Northglass Product<\/a>/);
});

test('package scripts contain runnable commands rather than embedded maintainer notes', () => {
  for (const relativePath of [
    'packages/idle-app/package.json',
    'packages/idle-cli/package.json',
  ]) {
    const manifest = JSON.parse(read(relativePath));
    const noteKeys = Object.keys(manifest.scripts ?? {}).filter(
      key => key.startsWith('//') || key.includes('?'),
    );
    assert.deepEqual(noteKeys, [], relativePath);
  }
});

test('public build utilities have live entrypoints and no incident annotations', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/build-web.sh')), false);
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'scripts/generate-brand-pngs.ts')),
    false,
    'the stale maintainer asset generator must not overwrite approved public artwork',
  );
});

test('CLI developer utilities use only current Idle names and package-manager commands', () => {
  const utilities = [
    read('packages/idle-cli/scripts/install-local.cjs'),
    read('packages/idle-cli/scripts/bundle-server.cjs'),
  ].join('\n');
  const retiredNames = [
    ['hap', 'py'].join(''),
    ['han', 'dy'].join(''),
  ];

  for (const retiredName of retiredNames) {
    assert.equal(utilities.toLowerCase().includes(retiredName), false, retiredName);
  }
  assert.match(utilities, /idle-server/);
  assert.doesNotMatch(utilities, /run\(['"]pnpm['"]/);
});

test('public data and configuration files are not marked executable', () => {
  if (process.platform === 'win32') return;

  const files = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).split('\0').filter(Boolean);
  const dataExtensions = new Set([
    '.css', '.gif', '.ico', '.jpeg', '.jpg', '.json', '.md', '.plist',
    '.png', '.svg', '.toml', '.ttf', '.webp', '.yaml', '.yml',
  ]);
  const executableData = files.filter(relativePath => {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath) || !dataExtensions.has(path.extname(relativePath).toLowerCase())) {
      return false;
    }
    return (fs.statSync(absolutePath).mode & 0o111) !== 0;
  });

  assert.deepEqual(executableData, []);
});

test('every mobile E2E flow belongs to a runnable public suite', () => {
  const packageRoot = 'packages/idle-e2e-mobile';
  const flowNames = fs.readdirSync(path.join(repoRoot, packageRoot, 'flows'))
    .filter(name => name.endsWith('.yaml'))
    .sort();
  const runnerSurface = [
    JSON.stringify(JSON.parse(read(`${packageRoot}/package.json`)).scripts ?? {}),
    read(`${packageRoot}/scripts/dev-client-maestro.sh`),
    read(`${packageRoot}/scripts/run-authed.sh`),
    read(`${packageRoot}/scripts/run-release.sh`),
  ].join('\n');

  const unreferenced = flowNames.filter(name => !runnerSurface.includes(name));
  assert.deepEqual(unreferenced, []);

  const publicFlows = flowNames.filter(name => /^0[01]-/.test(name));
  const liveReleaseFlows = flowNames.filter(name => /^1[456]-/.test(name));
  const authenticatedFlows = flowNames.filter(name => (
    !publicFlows.includes(name) && !liveReleaseFlows.includes(name)
  ));
  const devRunner = read(`${packageRoot}/scripts/dev-client-maestro.sh`);
  const authenticatedRunner = read(`${packageRoot}/scripts/run-authed.sh`);
  const liveReleaseRunner = read(`${packageRoot}/scripts/run-release.sh`);
  for (const flow of publicFlows) assert.match(devRunner, new RegExp(flow.replace('.', '\\.')));
  for (const flow of authenticatedFlows) assert.match(authenticatedRunner, new RegExp(flow.replace('.', '\\.')));
  for (const flow of liveReleaseFlows) assert.match(liveReleaseRunner, new RegExp(flow.replace('.', '\\.')));
  assert.match(liveReleaseRunner, /IDLE_RELEASE_LIVE_TEST/);
  assert.match(authenticatedRunner, /IDLE_SIMULATOR_UDID/);
  assert.match(authenticatedRunner, /--device/);
  assert.match(authenticatedRunner, /IDLE_RELEASE_LIVE_TEST/);
});
