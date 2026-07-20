import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const readJson = relativePath => JSON.parse(read(relativePath));
const exists = relativePath => fs.existsSync(path.join(repoRoot, relativePath));
const listCodeFiles = relativeDirectory => {
  const absoluteDirectory = path.join(repoRoot, relativeDirectory);
  const paths = [];

  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...listCodeFiles(relativePath));
    } else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name) && !/\.(?:spec|test)\./.test(entry.name)) {
      paths.push(relativePath);
    }
  }

  return paths;
};

test('the app requests only native capabilities used by shipped code', () => {
  const appPackage = readJson('packages/idle-app/package.json');
  const appConfig = read('packages/idle-app/app.config.js');
  const yarnLock = read('yarn.lock');

  for (const unusedCapability of ['expo-calendar', 'expo-location']) {
    assert.equal(
      appPackage.dependencies[unusedCapability],
      undefined,
      `${unusedCapability} must not ship when the app has no implementation for it`,
    );
    assert.equal(
      appConfig.includes(unusedCapability),
      false,
      `${unusedCapability} must not inject an unused native permission`,
    );
    assert.equal(
      new RegExp(`^${unusedCapability}@`, 'm').test(yarnLock),
      false,
      `${unusedCapability} must not remain in the resolved release graph`,
    );
  }
});

test('the app imports only the icon fonts it ships instead of the all-font barrel', () => {
  const codeFiles = listCodeFiles('packages/idle-app/sources');
  const barrelImports = codeFiles.filter(relativePath =>
    /from\s+['"]@expo\/vector-icons['"]/.test(read(relativePath)));

  assert.deepEqual(
    barrelImports,
    [],
    'the vector-icons barrel exports every font asset, including fonts the app never uses',
  );
  assert.equal(
    codeFiles.some(relativePath => /@expo\/vector-icons\/Fontisto\b/.test(read(relativePath))),
    false,
    'the unused Fontisto font must stay outside release artifacts',
  );
});

test('package metadata is the single source for the public app version', () => {
  const appPackage = readJson('packages/idle-app/package.json');
  const appConfig = read('packages/idle-app/app.config.js');
  const changelog = read('packages/idle-app/CHANGELOG.md');
  const generatedChangelog = readJson('packages/idle-app/sources/changelog/changelog.json');

  assert.match(appPackage.version, /^\d+\.\d+\.\d+$/);
  assert.match(appConfig, /const appPackage = require\(['"]\.\/package\.json['"]\);/);
  assert.match(appConfig, /version:\s*appPackage\.version/);
  assert.doesNotMatch(appConfig, /version:\s*['"]\d+\.\d+\.\d+['"]/);
  assert.match(
    appConfig,
    new RegExp(`runtimeVersion:\\s*["']${appPackage.version.split('.').at(-1)}["']`),
    'native releases must advance the runtime version with the app patch version',
  );
  assert.ok(
    changelog.startsWith(`# Idle ${appPackage.version} — `),
    'the latest public changelog entry must match the package app version',
  );
  assert.ok(
    generatedChangelog.latestTitle.startsWith(`Idle ${appPackage.version} — `),
    'the generated in-app changelog must match the package app version',
  );
});

test('native update policy fails closed until Northglass has a live public store listing', () => {
  const versionRoute = read('packages/idle-server/sources/app/api/routes/versionRoutes.ts');
  const appApiTypes = read('packages/idle-app/sources/sync/apiTypes.ts');
  const appSync = read('packages/idle-app/sources/sync/sync.ts');

  assert.equal(
    exists('packages/idle-server/sources/versions.ts'),
    false,
    'unpublished native apps must not carry a forced-update threshold',
  );
  assert.doesNotMatch(versionRoute, /\bsemver\b|IOS_UP_TO_DATE|ANDROID_UP_TO_DATE/);
  assert.match(versionRoute, /reply\.send\(\{\s*updateUrl:\s*null\s*\}\)/);
  assert.match(appApiTypes, /ApiNativeVersionResponseSchema\s*=\s*z\.object\(\{\s*updateUrl:\s*z\.null\(\)/s);
  assert.doesNotMatch(appSync, /expectedUpdateUrl|available:\s*true/);
});

test('only the canonical EAS configuration remains', () => {
  const eas = readJson('packages/idle-app/eas.json');

  assert.equal(eas.cli.version, '20.5.1');
  assert.equal(eas.cli.requireCommit, true);
  assert.equal(eas.cli.appVersionSource, 'remote');
  assert.equal(exists('packages/idle-app/eas.json.example'), false);
  assert.equal(exists('app.json'), false);
});

test('production TestFlight submission uses the Northglass app and EAS-managed credentials', () => {
  const eas = readJson('packages/idle-app/eas.json');
  const appConfig = read('packages/idle-app/app.config.js');
  const workflow = read('.github/workflows/deploy-testflight.yml');

  assert.match(appConfig, /production:\s*["']com\.northglass\.idle["']/);
  assert.deepEqual(eas.submit, {
    production: {
      ios: {
        ascAppId: '6760240746',
      },
    },
  });
  assert.match(
    workflow,
    /eas build\s+\\\s*--platform ios\s+\\\s*--profile production\s+\\\s*--freeze-credentials\s+\\\s*--auto-submit/s,
  );
  assert.equal(
    workflow.match(/node \.\.\/\.\.\/scripts\/verify-release-source\.mjs "\$PUBLIC_SHA"/g)?.length,
    2,
    'the authorized source must be rechecked immediately before both EAS snapshot operations',
  );
  assert.match(
    workflow,
    /node \.\.\/\.\.\/scripts\/verify-release-source\.mjs "\$PUBLIC_SHA"\s+eas build:inspect/s,
  );
  assert.match(
    workflow,
    /node \.\.\/\.\.\/scripts\/verify-release-source\.mjs "\$PUBLIC_SHA"\s+eas build\s+\\/s,
  );

  const publicConfig = JSON.stringify(eas);
  for (const privateSubmitField of [
    'appleId',
    'appleTeamId',
    'companyName',
    'appName',
    'sku',
    'ascApiKeyPath',
    'ascApiKeyId',
    'ascApiKeyIssuerId',
  ]) {
    assert.doesNotMatch(
      publicConfig,
      new RegExp(`"${privateSubmitField}"`),
      `${privateSubmitField} must stay in the release environment, not public configuration`,
    );
  }
});

test('Git and EAS archives exclude local package-manager and release credentials', () => {
  for (const ignorePath of ['.gitignore', '.easignore']) {
    const ignoreRules = new Set(
      read(ignorePath)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')),
    );

    for (const credentialRule of [
      '.env*',
      '*.p8',
      'credentials.json',
      '.npmrc',
      '**/.npmrc',
      '.yarnrc',
      '**/.yarnrc',
      '.yarnrc.yml',
      '**/.yarnrc.yml',
      '.netrc',
      '**/.netrc',
      '.pypirc',
      '**/.pypirc',
    ]) {
      assert.ok(
        ignoreRules.has(credentialRule),
        `${ignorePath} must exclude ${credentialRule}`,
      );
    }
  }

  assert.equal(
    exists('packages/idle-app/.easignore'),
    false,
    'the Git-root EAS policy must remain the single upload-boundary authority',
  );
  const rootEasIgnore = read('.easignore');
  for (const buildOnlyExclusion of [
    '.github/',
    'docs/',
    'packages/idle-app/native-tests/',
  ]) {
    assert.match(
      rootEasIgnore,
      new RegExp(`^${buildOnlyExclusion.replaceAll('/', '\\/')}$$`, 'm'),
      `the Git-root EAS policy must exclude ${buildOnlyExclusion}`,
    );
  }
});

test('release source verification rejects tracked and untracked checkout drift', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-release-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const verifier = path.join(repoRoot, 'scripts', 'verify-release-source.mjs');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const verify = sha => spawnSync(process.execPath, [verifier, sha], {
    cwd: root,
    encoding: 'utf8',
  });
  const configuredEmail = spawnSync('git', ['config', '--get', 'user.email'], {
    encoding: 'utf8',
  });
  const authorEmail = configuredEmail.status === 0 && configuredEmail.stdout.trim()
    ? configuredEmail.stdout.trim()
    : 'idle-release-test@users.noreply.github.com';

  git('init', '-q');
  git('config', 'user.name', 'Northglass');
  git('config', 'user.email', authorEmail);
  fs.writeFileSync(path.join(root, 'app.ts'), 'export const release = 1;\n');
  git('add', 'app.ts');
  git('commit', '-qm', 'fixture release source');
  const sha = git('rev-parse', 'HEAD');

  const clean = verify(sha);
  assert.equal(clean.status, 0, clean.stderr);

  fs.writeFileSync(path.join(root, 'app.ts'), 'export const release = 2;\n');
  const trackedDrift = verify(sha);
  assert.notEqual(trackedDrift.status, 0);

  git('reset', '--hard', '-q', sha);
  fs.writeFileSync(path.join(root, 'untracked.ts'), 'export const drift = true;\n');
  const untrackedDrift = verify(sha);
  assert.notEqual(untrackedDrift.status, 0);
});

test('Android service configuration is injected at build time, never published', () => {
  const appConfig = read('packages/idle-app/app.config.js');
  const gitIgnore = read('.gitignore');
  const easIgnore = read('.easignore');

  assert.equal(
    exists('packages/idle-app/google-services.json'),
    false,
    'the Firebase/GCP project identifiers must not enter the public snapshot',
  );
  assert.match(appConfig, /process\.env\.IDLE_GOOGLE_SERVICES_FILE/);
  assert.match(appConfig, /\.\.\.\(googleServicesFile\s*\?\s*\{\s*googleServicesFile\s*\}\s*:\s*\{\}\)/s);
  assert.doesNotMatch(appConfig, /googleServicesFile:\s*["']\.\/google-services\.json["']/);
  assert.match(gitIgnore, /^packages\/idle-app\/google-services\.json$/m);
  assert.match(easIgnore, /^packages\/idle-app\/google-services\.json$/m);
});

test('public app code contains invariants, not incident diary notes', () => {
  const appConfig = read('packages/idle-app/app.config.js');
  const shippedCodePaths = [
    'packages/idle-app/app.config.js',
    ...listCodeFiles('packages/idle-app/plugins'),
    ...listCodeFiles('packages/idle-app/sources'),
  ];

  for (const codePath of shippedCodePaths) {
    assert.equal(
      /App Review rejection/i.test(read(codePath)),
      false,
      `${codePath} must describe current behavior without an incident diary`,
    );
  }
  assert.doesNotMatch(appConfig, /\b20\d{2}-\d{2}(?:-\d{2})?\b/);
  assert.doesNotMatch(appConfig, /HAPPY_/);
  assert.doesNotMatch(appConfig, /Security fix:|Rotation runbook:/i);
});

test('app internals use Idle names while retaining protocol compatibility literals', () => {
  const socketSource = read('packages/idle-app/sources/sync/apiSocket.ts');
  const uploadSource = read('packages/idle-app/sources/sync/uploadFormFile.ts');

  assert.match(socketSource, /export function getIdleClientId\(\): string/);
  assert.doesNotMatch(socketSource, /getHappyClientId/);
  assert.match(socketSource, /happyClient:\s*getIdleClientId\(\)/);
  assert.match(socketSource, /['"]X-Happy-Client['"]:\s*getIdleClientId\(\)/);
  assert.doesNotMatch(uploadSource, /happy-upload-/);
  assert.match(uploadSource, /idle-upload-/);
});

test('every bundled app font has a public attribution and the canonical OFL 1.1 text', () => {
  const fontDirectory = 'packages/idle-app/sources/assets/fonts';
  const fontFiles = fs.readdirSync(path.join(repoRoot, fontDirectory))
    .filter(file => file.endsWith('.ttf'))
    .sort();
  const expectedFonts = [
    'BricolageGrotesque-Bold.ttf',
    'IBMPlexMono-Italic.ttf',
    'IBMPlexMono-Regular.ttf',
    'IBMPlexMono-SemiBold.ttf',
    'IBMPlexSans-Italic.ttf',
    'IBMPlexSans-Regular.ttf',
    'IBMPlexSans-SemiBold.ttf',
    'SpaceMono-Regular.ttf',
  ];
  assert.deepEqual(fontFiles, expectedFonts);

  const notices = read(`${fontDirectory}/README.md`);
  for (const font of expectedFonts) assert.match(notices, new RegExp(`\\b${font.replaceAll('.', '\\.') }\\b`));
  for (const family of ['Bricolage Grotesque', 'IBM Plex Mono', 'IBM Plex Sans', 'Space Mono']) {
    assert.match(notices, new RegExp(family));
  }
  assert.match(notices, /SIL Open Font License, Version 1\.1/);

  const license = fs.readFileSync(path.join(repoRoot, fontDirectory, 'OFL-1.1.txt'));
  assert.equal(
    createHash('sha256').update(license).digest('hex'),
    'ebc109078c06f79af74cf2b27454c262830d12a65749f0e2bf25d1ac1db7a02a',
    'the bundled OFL text must remain byte-for-byte canonical',
  );
});
