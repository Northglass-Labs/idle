import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const pathExistsOrIsSymlink = relativePath => {
  try {
    fs.lstatSync(path.join(repoRoot, relativePath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

test('the root EAS boundary excludes private and maintainer-only upload paths', () => {
  const ignoreRules = new Set(
    read('.easignore')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')),
  );

  for (const requiredRule of [
    '.git',
    '.env*',
    'packages/idle-app/native-tests/',
    'packages/idle-app/.eas/workflows/',
    'packages/idle-cli/tools',
    'packages/idle-cli/tools/',
  ]) {
    assert.ok(ignoreRules.has(requiredRule), `.easignore must contain ${requiredRule}`);
  }
  assert.ok(
    [...ignoreRules].every(rule => !rule.startsWith('!packages/idle-cli/tools/')),
    '.easignore must not re-include a native tool archive',
  );

  const workflow = read('.github/workflows/deploy-testflight.yml');
  assert.match(workflow, /sha:\s*\n\s+description: Exact 40-character commit SHA from public main/);
  assert.match(workflow, /required:\s*true/);
  assert.match(workflow, /PUBLIC_SHA:\s*\$\{\{\s*inputs\.sha\s*\}\}/);
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /\[\[\s*"\$PUBLIC_SHA"\s*=~\s*\^\[0-9a-f\]\{40\}\$\s*\]\]/);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$PUBLIC_SHA"/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$PUBLIC_SHA"/);
  assert.match(workflow, /test "\$\(git rev-parse origin\/main\)" = "\$PUBLIC_SHA"/);
  assert.match(workflow, /git merge-base --is-ancestor "\$PUBLIC_SHA" origin\/main/);
  const releaseAuthorization = workflow.slice(
    workflow.indexOf('- name: Verify immutable release authorization'),
    workflow.indexOf('- uses: actions/setup-node@'),
  );
  assert.doesNotMatch(
    releaseAuthorization,
    /EXPO_TOKEN|secrets\.EXPO_TOKEN/,
    'immutable Git authorization must not receive the Expo release credential',
  );
  const expoSetup = workflow.slice(
    workflow.indexOf('uses: expo/expo-github-action@'),
    workflow.indexOf('- name: Build idle-wire'),
  );
  assert.doesNotMatch(expoSetup, /\btoken:/, 'Expo setup must not export credentials job-wide');
  assert.match(
    workflow,
    /name: Verify exact production upload archive[\s\S]*?env:\s*\n\s+EXPO_TOKEN: \$\{\{ secrets\.EXPO_TOKEN \}\}[\s\S]*?: "\$\{EXPO_TOKEN:\?EXPO_TOKEN is required for EAS archive inspection\}"/,
  );
  assert.match(
    workflow,
    /name: Build and submit to TestFlight[\s\S]*?env:[\s\S]*?EXPO_TOKEN: \$\{\{ secrets\.EXPO_TOKEN \}\}[\s\S]*?: "\$\{EXPO_TOKEN:\?EXPO_TOKEN is required for TestFlight release\}"/,
  );
  assert.match(workflow, /--freeze-credentials/);
  const inspection = workflow.indexOf('eas build:inspect');
  const verification = workflow.indexOf('scripts/verify-eas-archive.mjs');
  const release = workflow.indexOf('eas build \\');
  assert.ok(inspection >= 0, 'TestFlight must inspect the exact EAS archive');
  assert.ok(verification > inspection, 'the inspected archive must be verified');
  assert.ok(release > verification, 'verification must finish before a build can upload');
  assert.equal(
    workflow.match(/scripts\/verify-release-source\.mjs "\$PUBLIC_SHA"/g)?.length,
    2,
    'both EAS snapshot operations must immediately recheck the authorized source',
  );
  assert.match(workflow, /unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR/);
  assert.match(workflow, /unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES/);
  assert.ok(fs.existsSync(path.join(repoRoot, 'scripts', 'verify-release-source.mjs')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'scripts', 'verify-eas-archive.mjs')));
  assert.equal(pathExistsOrIsSymlink('packages/idle-app/.easignore'), false, 'the root ignore file must be authoritative');
});

test('the public server workflow verifies releases without deploying private infrastructure', () => {
  const workflow = read('.github/workflows/deploy-server.yml');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /@northglass\/idle-server build:runtime/);
  assert.match(workflow, /@northglass\/idle-server test/);
  assert.match(workflow, /scripts\/container-boundary\.test\.mjs/);
  assert.match(workflow, /export IDLE_MASTER_SECRET="\$\(openssl rand -hex 32\)"/);
  assert.match(workflow, /export IDLE_AUTH_AUDIENCE=http:\/\/localhost:3005/);
  assert.match(workflow, /--env IDLE_MASTER_SECRET(?:\s|\\)/);
  assert.match(workflow, /--env IDLE_AUTH_AUDIENCE(?:\s|\\)/);
  assert.doesNotMatch(workflow, /--env IDLE_MASTER_SECRET="\$master_secret"/);
  assert.match(workflow, /docker save[\s\S]*idle-server-ci/);
  assert.match(workflow, /anchore\/grype@sha256:[0-9a-f]{64}/);
  assert.match(workflow, /docker-archive:\/scan\/idle-server-ci\.tar/);
  assert.match(workflow, /--only-fixed/);
  assert.match(workflow, /--fail-on high/);
  assert.doesNotMatch(workflow, /\/var\/run\/docker\.sock/);

  for (const privateDeploymentDetail of [
    /secrets\./,
    /ssh-action/i,
    /VPS_(?:HOST|USER|SSH_KEY)/,
    /\/var\/www/,
    /systemctl/,
    /sudoers/i,
    /post-deploy/i,
    /idle-api\.northglass\.io/i,
    /prisma\s+migrate/i,
  ]) {
    assert.doesNotMatch(workflow, privateDeploymentDetail);
  }
});

test('legacy cloud coding-agent workflow stays outside the public repository', () => {
  assert.equal(
    pathExistsOrIsSymlink('.github/workflows/claude.yml'),
    false,
    'the public repository must not expose a write-capable cloud coding-agent workflow',
  );
});

test('the web workflow verifies the canonical image without private deployment access', () => {
  const workflow = read('.github/workflows/deploy-webapp.yml');
  const beforeJobs = workflow.slice(0, workflow.indexOf('jobs:'));

  assert.match(workflow, /pull_request:/);
  assert.match(beforeJobs, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /docker build[\s\S]*--file Dockerfile\.webapp/);
  assert.match(workflow, /EXPO_PUBLIC_IDLE_SERVER_URL=https:\/\/relay\.example\.test/);
  assert.match(workflow, /docker run[\s\S]*127\.0\.0\.1::8080/);
  assert.match(workflow, /docker port[\s\S]*8080\/tcp/);
  assert.match(workflow, /docker exec[\s\S]*id -u/);
  assert.match(workflow, /curl[\s\S]*http:\/\/127\.0\.0\.1:\$\{host_port\}\//);
  assert.match(workflow, /docker save[\s\S]*idle-webapp:\$\{GITHUB_SHA\}/);
  assert.match(workflow, /anchore\/grype@sha256:[0-9a-f]{64}/);
  assert.match(workflow, /docker-archive:\/scan\/idle-webapp\.tar/);
  assert.match(workflow, /--only-fixed/);
  assert.match(workflow, /--fail-on high/);
  assert.doesNotMatch(workflow, /\/var\/run\/docker\.sock/);

  for (const privateDeploymentDetail of [
    /secrets\./,
    /\bssh(?:-keyscan)?\b/i,
    /\bscp\b|\brsync\b/i,
    /VPS_(?:HOST|USER|SSH_KEY)/,
    /\/var\/www/,
    /systemctl|sudoers|\bsudo\b/i,
    /environment:\s*production/i,
  ]) {
    assert.doesNotMatch(workflow, privateDeploymentDetail);
  }
});

test('manual distribution workflows are least-privilege and protected', () => {
  const testflight = read('.github/workflows/deploy-testflight.yml');
  assert.match(testflight, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(testflight, /\n\s{2}(?:push|pull_request):/);
  assert.match(testflight, /environment:\s*production/);
  assert.match(testflight, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(testflight, /persist-credentials:\s*false/);

  const npmPublish = read('.github/workflows/npm-publish.yml');
  assert.match(npmPublish, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(npmPublish, /\n\s{2}(?:push|pull_request):/);
  assert.match(npmPublish, /environment:\s*npm-release/);
  assert.match(npmPublish, /id-token:\s*write/);
  assert.match(npmPublish, /contents:\s*read/);
  assert.match(npmPublish, /persist-credentials:\s*false/);
  assert.match(npmPublish, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.doesNotMatch(npmPublish, /ref:\s*main\b/);
  assert.doesNotMatch(npmPublish, /secrets\./);
  assert.doesNotMatch(npmPublish, /^\s*(?:NODE_AUTH_TOKEN|NPM_TOKEN):/m);
  assert.doesNotMatch(
    npmPublish,
    /inert-but-ready|first package creation|self-upgrade footgun|this replaces|one-time per package, done on npmjs\.com by a maintainer/i,
  );
});

test('ordinary CI workflows run with read-only repository permissions', () => {
  for (const workflowPath of [
    '.github/workflows/cli-smoke-test.yml',
    '.github/workflows/public-hygiene.yml',
    '.github/workflows/test-all.yml',
    '.github/workflows/typecheck.yml',
    '.github/workflows/upstream-policy.yml',
  ]) {
    const workflow = read(workflowPath);
    const beforeJobs = workflow.slice(0, workflow.indexOf('jobs:'));
    assert.match(beforeJobs, /permissions:\s*\n\s+contents:\s*read/);
    assert.match(workflow, /persist-credentials:\s*false/);
  }

  assert.match(
    read('.github/workflows/typecheck.yml'),
    /cache-dependency-path:\s*yarn\.lock/,
  );
  assert.match(
    read('.github/workflows/public-hygiene.yml'),
    /scripts\/media-metadata-boundary\.test\.mjs/,
  );
  assert.match(
    read('.github/workflows/public-hygiene.yml'),
    /scripts\/gitleaks-config-boundary\.test\.mjs/,
  );
  assert.match(
    read('.github/workflows/public-hygiene.yml'),
    /scripts\/dependency-patch-boundary\.test\.mjs/,
  );

  const testAll = read('.github/workflows/test-all.yml');
  const publicHygiene = read('.github/workflows/public-hygiene.yml');
  const rootPackage = JSON.parse(read('package.json'));
  const appPackage = JSON.parse(read('packages/idle-app/package.json'));
  assert.equal(
    appPackage.scripts['test:export-boundary'],
    'node --test scripts/script-tag-boundary.test.mjs',
  );
  assert.match(rootPackage.scripts.test, /workspace idle-app test:export-boundary/);
  assert.match(testAll, /yarn workspace idle-app test:export-boundary/);
  const hygieneInstallIndex = publicHygiene.indexOf('yarn install --frozen-lockfile');
  const hygieneBoundaryIndex = publicHygiene.indexOf('name: Verify release boundaries');
  assert.ok(
    hygieneInstallIndex !== -1 && hygieneInstallIndex < hygieneBoundaryIndex,
    'dependency-aware hygiene tests must install the pinned dependency graph first',
  );
});

test('public deploy guides use portable examples, not Northglass operations history', () => {
  const deployDocsDir = path.join(repoRoot, 'docs', 'deploy-targets');
  const docs = fs
    .readdirSync(deployDocsDir)
    .filter(file => file.endsWith('.md'))
    .map(file => fs.readFileSync(path.join(deployDocsDir, file), 'utf8'))
    .join('\n');

  for (const internalDetail of [
    /idle-api\.northglass\.io/i,
    /\/var\/www\/idle-server/i,
    /CLAUDE\.md/i,
    /verified by smoke\s+20\d\d/i,
    /202\d-\d{2}-\d{2}/,
  ]) {
    assert.doesNotMatch(docs, internalDetail);
  }

  assert.doesNotMatch(docs, /IDLE_MASTER_SECRET\s*=\s*["']?\$\(openssl/i);
  assert.match(docs, /password manager/i);
});

test('public hygiene rejects editor-agent rules and no broken rules links remain', () => {
  const hygiene = read('scripts/check-docs-hygiene.sh');
  assert.match(hygiene, /\.cursorrules/);
  assert.equal(pathExistsOrIsSymlink('packages/idle-cli/.cursorrules'), false);
  assert.equal(pathExistsOrIsSymlink('packages/idle-server/.cursorrules'), false);
});

test('the canonical server image advertises the runtime port and the duplicate is gone', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^EXPOSE 3005$/m);
  assert.doesNotMatch(dockerfile, /^EXPOSE 3000$/m);
  assert.equal(pathExistsOrIsSymlink('Dockerfile.server'), false);
});

test('the npm workflow gates the agent with the shared tarball contract', () => {
  const workflow = read('.github/workflows/npm-publish.yml');
  const contractStep = workflow.slice(
    workflow.indexOf('Verify public tarball contracts'),
    workflow.indexOf('Publish via OIDC Trusted Publishing'),
  );
  assert.match(contractStep, /@northglass\/agent/);

  const wireStep = workflow.slice(
    workflow.indexOf('Verify the matching Idle wire release'),
    workflow.indexOf('Resolve package directory'),
  );
  assert.match(wireStep, /@northglass\/agent/);
});

test('dead maintainer utilities stay outside the public workspace', () => {
  const rootPackage = JSON.parse(read('package.json'));
  const hygiene = read('scripts/check-docs-hygiene.sh');
  const cliIndex = read('packages/idle-cli/src/index.ts');

  assert.equal(rootPackage.scripts['app-logs'], undefined);
  assert.ok(!rootPackage.workspaces.packages.includes('packages/idle-app-logs'));
  assert.equal(pathExistsOrIsSymlink('packages/idle-app-logs'), false);
  assert.equal(pathExistsOrIsSymlink('scripts/clean-slate.sh'), false);
  assert.equal(pathExistsOrIsSymlink('scripts/_generate-social-card.ts'), false);
  assert.equal(pathExistsOrIsSymlink('packages/idle-cli/experiments'), false);
  assert.equal(pathExistsOrIsSymlink('packages/idle-cli/demo-project'), false);
  assert.equal(pathExistsOrIsSymlink('packages/idle-cli/scripts/test-continue-fix.sh'), false);

  assert.equal(rootPackage.scripts['brand:generate'], undefined);
  assert.equal(pathExistsOrIsSymlink('scripts/generate-brand-pngs.ts'), false);
  assert.equal(pathExistsOrIsSymlink('.github/brand/github-social-card.png'), false);
  assert.match(cliIndex, /args\[1\] === 'clean'/);
  assert.match(cliIndex, /killRunawayIdleProcesses\(\)/);
  assert.match(cliIndex, /clearMachineId\(\)/);

  assert.match(hygiene, /packages\/idle-app-logs/);
  assert.match(hygiene, /scripts\/clean-slate\.sh/);
  assert.match(hygiene, /scripts\/_generate-social-card\.ts/);
  assert.match(hygiene, /scripts\/generate-brand-pngs\.ts/);
  assert.match(hygiene, /packages\/idle-cli\/experiments/);
  assert.match(hygiene, /packages\/idle-cli\/demo-project/);
  assert.match(hygiene, /packages\/idle-cli\/scripts\/test-continue-fix\.sh/);
});

test('the public CLI excludes dormant privileged daemon installation surfaces', () => {
  const cliIndex = read('packages/idle-cli/src/index.ts');
  const caffeinate = read('packages/idle-cli/src/utils/caffeinate.ts');

  for (const deadPath of [
    'packages/idle-cli/src/daemon/install.ts',
    'packages/idle-cli/src/daemon/uninstall.ts',
    'packages/idle-cli/src/daemon/mac/install.ts',
    'packages/idle-cli/src/daemon/mac/uninstall.ts',
  ]) {
    assert.equal(pathExistsOrIsSymlink(deadPath), false, `${deadPath} must stay deleted`);
  }

  assert.doesNotMatch(cliIndex, /daemon\/install|daemon\/uninstall/);
  assert.doesNotMatch(cliIndex, /daemonSubcommand\s*===\s*['"](?:install|uninstall)['"]/);
  assert.doesNotMatch(caffeinate, /\bpkill\b|\bexecSync\b/);
  assert.match(caffeinate, /['"]-w['"]\s*,\s*String\(process\.pid\)/);
});

test('retired CLI compatibility helpers stay outside the shipped API', () => {
  const retiredAuthPath = 'packages/idle-cli/src/api/auth.ts';
  const authCommand = read('packages/idle-cli/src/commands/auth.ts');
  const authUi = read('packages/idle-cli/src/ui/auth.ts');

  assert.equal(pathExistsOrIsSymlink(retiredAuthPath), false, `${retiredAuthPath} must stay deleted`);
  for (const source of [authCommand, authUi]) {
    assert.doesNotMatch(source, /getOrCreateSecretKey|generateAppUrl|handy:\/\//);
    assert.doesNotMatch(source, /(?:from|require\()\s*['"](?:@\/|\.\.\/|\.\/)api\/auth/);
  }
});

test('the CLI contains no server-side AI provider credential vault', () => {
  const connect = read('packages/idle-cli/src/commands/connect.ts');
  const api = read('packages/idle-cli/src/api/api.ts');
  const machine = read('packages/idle-cli/src/api/apiMachine.ts');
  const daemon = read('packages/idle-cli/src/daemon/run.ts');
  const commonHandlers = read('packages/idle-cli/src/modules/common/registerCommonHandlers.ts');
  const cliReadme = read('packages/idle-cli/README.md');

  for (const retiredPath of [
    'packages/idle-cli/src/commands/connect/authenticateClaude.ts',
    'packages/idle-cli/src/commands/connect/authenticateCodex.ts',
    'packages/idle-cli/src/commands/connect/oauthCallback.security.test.ts',
    'packages/idle-cli/src/commands/connect/oauthResponse.ts',
    'packages/idle-cli/src/commands/connect/types.ts',
    'packages/idle-cli/src/commands/connect/utils.ts',
  ]) {
    assert.equal(pathExistsOrIsSymlink(retiredPath), false, `${retiredPath} must stay deleted`);
  }

  assert.doesNotMatch(connect, /registerVendorToken|getVendorToken|authenticate(?:Claude|Codex)|decodeJwtPayload/);
  assert.doesNotMatch(connect, /idle connect (?:codex|claude|status)/);
  assert.doesNotMatch(api, /registerVendorToken|getVendorToken|\/v1\/connect\/\$\{vendor\}/);
  assert.doesNotMatch(commonHandlers, /\btoken\?:\s*string/);
  assert.doesNotMatch(machine, /\benvironmentVariables,\s*token\b|\btoken,\s*commitAttribution\b/);
  assert.doesNotMatch(daemon, /options\.token|hasProviderToken|CLAUDE_CODE_OAUTH_TOKEN|auth\.json/);
  assert.match(connect, /provider credentials stay local/i);
  assert.match(cliReadme, /provider credentials remain local/i);
  assert.doesNotMatch(cliReadme, /idle connect (?:codex|claude|status)|upload provider service credentials/i);
});

test('the public CLI excludes the unused plaintext Claude session-tag cache', () => {
  assert.equal(
    pathExistsOrIsSymlink('packages/idle-cli/src/claude/utils/sessionTagMap.ts'),
    false,
  );
  assert.equal(
    pathExistsOrIsSymlink('packages/idle-cli/src/claude/utils/sessionTagMap.test.ts'),
    false,
  );
});

test('live provider integration tests require an explicit opt-in and clean Codex task history', () => {
  const cliPackage = JSON.parse(read('packages/idle-cli/package.json'));
  const liveOptIn = 'IDLE_RUN_LIVE_AGENT_INTEGRATION';

  assert.match(cliPackage.scripts.test, new RegExp(`${liveOptIn}=0`));
  assert.match(cliPackage.scripts['test:integration'], new RegExp(`${liveOptIn}=0`));
  assert.match(cliPackage.scripts['test:integration:live'], new RegExp(`${liveOptIn}=1`));
  assert.doesNotMatch(cliPackage.scripts.test, /integration-live-/);
  assert.doesNotMatch(cliPackage.scripts['test:integration'], /integration-live-/);
  for (const project of [
    'integration-live-empty',
    'integration-live-plan-mode',
    'integration-live-authenticated',
  ]) {
    assert.match(cliPackage.scripts['test:integration:live'], new RegExp(`--project=${project}`));
  }

  const vitestConfig = read('packages/idle-cli/vitest.config.ts');
  assert.match(vitestConfig, /shouldRunLiveAgentIntegration/);
  assert.match(vitestConfig, /\.\.\.\(shouldRunLiveAgentIntegration\(\) \? liveAgentProjects : \[\]\)/);

  for (const path of [
    'packages/idle-cli/src/claude/claude.integration.test.ts',
    'packages/idle-cli/src/claude/planMode.integration.test.ts',
    'packages/idle-cli/src/codex/codex.integration.test.ts',
    'packages/idle-cli/src/openclaw/openclaw.integration.test.ts',
  ]) {
    assert.match(read(path), /shouldRunLiveAgentIntegration/);
  }

  const codexIntegration = read('packages/idle-cli/src/codex/codex.integration.test.ts');
  assert.match(codexIntegration, /const ephemeral = opts\?\.ephemeral \?\? true/);
  assert.match(codexIntegration, /deleteThread/);
});

test('native tool archives and retired installers stay outside every public package boundary', () => {
  const cliPackage = JSON.parse(read('packages/idle-cli/package.json'));
  const hygiene = read('scripts/check-docs-hygiene.sh');
  const retiredPaths = [
    'packages/idle-cli/scripts/download-tools.sh',
    'packages/idle-cli/scripts/unpack-tools.cjs',
    'packages/idle-cli/src/modules/difftastic',
    'packages/idle-cli/tools',
  ];

  for (const retiredPath of retiredPaths) {
    assert.equal(pathExistsOrIsSymlink(retiredPath), false, `${retiredPath} must remain absent`);
    assert.ok(hygiene.includes(retiredPath), `${retiredPath} must be rejected by public hygiene`);
  }

  assert.equal(cliPackage.scripts?.postinstall, undefined);
  assert.ok(!cliPackage.files.some(file => file === 'tools' || file.startsWith('tools/')));
  assert.ok(!cliPackage.files.includes('scripts/unpack-tools.cjs'));
  assert.ok(cliPackage.files.includes('scripts/ripgrep_launcher.cjs'));
  assert.ok(cliPackage.files.includes('scripts/claude_local_launcher.cjs'));
  assert.ok(cliPackage.files.includes('scripts/claude_version_utils.cjs'));
});

test('retired internal notes stay outside the public tree', () => {
  const hygiene = read('scripts/check-docs-hygiene.sh');
  const retiredPaths = [
    'packages/idle-app/sources/docs/autocomplete-text-manipulation.md',
    'packages/idle-cli/experiments/NOTES.md',
    'packages/idle-cli/agents.md',
    'environments/lab-rat-todo-project/exercise-flow.md',
  ];

  for (const retiredPath of retiredPaths) {
    assert.equal(pathExistsOrIsSymlink(retiredPath), false, `${retiredPath} must remain private`);
    assert.ok(hygiene.includes(retiredPath), `${retiredPath} must be rejected by public hygiene`);
  }
});

test('maintainer editor settings stay private and the sample guide has a portable name', () => {
  for (const editorPath of [
    'packages/idle-app/.vscode/launch.json',
    'packages/idle-cli/.vscode/launch.json',
    'packages/idle-server/.vscode/launch.json',
  ]) {
    assert.equal(pathExistsOrIsSymlink(editorPath), false, `${editorPath} must remain private`);
  }

  assert.equal(pathExistsOrIsSymlink('environments/lab-rat-todo-project/agents.md'), false);
  assert.equal(pathExistsOrIsSymlink('environments/lab-rat-todo-project/CONTRIBUTING.md'), true);
  assert.match(
    read('environments/lab-rat-todo-project/README.md'),
    /`CONTRIBUTING\.md` — contribution guidance/,
  );
});

test('publishing is CI-gated and local release bots stay outside the public packages', () => {
  for (const packagePath of [
    'packages/idle-agent/package.json',
    'packages/idle-cli/package.json',
    'packages/idle-wire/package.json',
  ]) {
    const manifest = JSON.parse(read(packagePath));
    assert.equal(manifest.scripts?.release, undefined, packagePath);
    assert.equal(manifest.devDependencies?.['release-it'], undefined, packagePath);
  }

  for (const relativePath of [
    'packages/idle-agent/.release-it.json',
    'packages/idle-agent/.release-it.notes.js',
    'packages/idle-cli/.release-it.json',
    'packages/idle-cli/.release-it.notes.js',
  ]) {
    assert.equal(pathExistsOrIsSymlink(relativePath), false, relativePath);
  }
});
