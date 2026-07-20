import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('CLI development defaults do not depend on tracked dot-env files', () => {
  for (const relativePath of [
    'packages/idle-cli/.env.dev',
    'packages/idle-cli/.env.dev-local-server',
    'packages/idle-cli/.envrc.example',
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, relativePath)), false, relativePath);
  }

  const packageJson = JSON.parse(read('packages/idle-cli/package.json'));
  const wrapper = read('packages/idle-cli/scripts/env-wrapper.cjs');
  const setup = read('packages/idle-cli/scripts/setup-dev.cjs');

  assert.doesNotMatch(packageJson.scripts['dev:local-server'], /--env-file|\.env/);
  assert.match(packageJson.scripts['dev:local-server'], /env-wrapper\.cjs local/);
  assert.match(wrapper, /IDLE_HOME_DIR/);
  assert.match(wrapper, /IDLE_SERVER_URL/);
  assert.match(wrapper, /IDLE_WEBAPP_URL/);
  assert.match(wrapper, /http:\/\/127\.0\.0\.1:3005/);
  assert.match(wrapper, /http:\/\/127\.0\.0\.1:8081/);
  assert.doesNotMatch(wrapper, /\bHAPPY_[A-Z0-9_]+\b|\.happy(?:-|\/)/);
  assert.match(setup, /\.envrc/);
  assert.doesNotMatch(setup, /\.envrc\.example/);
});

test('the obsolete integration environment file stays outside the public tree', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'packages/idle-cli/.env.integration-test')), false);
});

test('development wrapper output never prints the resolved local data path', () => {
  const wrapper = read('packages/idle-cli/scripts/env-wrapper.cjs');

  assert.doesNotMatch(wrapper, /console\.log\([^\n]*config\.homeDir/);
  assert.match(wrapper, /Idle CLI \(data directory configured\)/);
});

test('private session handoff variables and multipart internals use Idle names', () => {
  const daemon = read('packages/idle-cli/src/daemon/run.ts');
  const claude = read('packages/idle-cli/src/claude/runClaude.ts');
  const codex = read('packages/idle-cli/src/codex/runCodex.ts');
  const sessionApi = read('packages/idle-cli/src/api/apiSession.ts');
  const encryption = read('packages/idle-cli/src/api/encryption.ts');
  const sources = `${daemon}\n${claude}\n${codex}`;

  assert.doesNotMatch(sources, /\bHAPPY_(?:FORK(?:ED)?|RECONNECT)_[A-Z0-9_]+\b/);
  assert.match(daemon, /IDLE_FORKED_FROM_SESSION_ID/);
  assert.match(claude, /IDLE_RECONNECT_SESSION_ID/);
  assert.match(codex, /IDLE_RECONNECT_SESSION_ID/);
  assert.doesNotMatch(sessionApi, /happy-cli-/);
  assert.match(sessionApi, /idle-cli-/);
  assert.doesNotMatch(encryption, /packages\/happy-app/);
  assert.match(encryption, /packages\/idle-app/);
});
