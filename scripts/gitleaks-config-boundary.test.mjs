import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = fs.readFileSync(path.join(repoRoot, '.gitleaks.toml'), 'utf8');

test('Gitleaks exemptions are rule-scoped and cannot hide arbitrary secrets by path', () => {
  assert.doesNotMatch(config, /^\[allowlist\]$/m);
  assert.doesNotMatch(config, /encryption\//);
  assert.doesNotMatch(config, /\\\.env/);
  assert.doesNotMatch(config, /authenticateGemini|deriveKey|expandEnvVars|eas\\\.json/);
  assert.doesNotMatch(config, /packages\/idle-app\/google-services/);
  assert.doesNotMatch(config, /targetRules\s*=\s*\["gcp-api-key"\]/);
});

test('the generated web allowlist is limited to public libsodium export symbols', () => {
  assert.match(
    config,
    /targetRules\s*=\s*\["generic-api-key"\][\s\S]*?regexTarget\s*=\s*"secret"[\s\S]*?\^crypto_\(aead\|kdf\)_/,
  );
  assert.doesNotMatch(config, /_expo|static\/js|index-\[|\.js\$|paths\s*=/);
});

test('public Gitleaks policy does not describe private operator enforcement', () => {
  assert.doesNotMatch(config, /operator-specific|private-repo|maintainer(?:'s|s')?\s+private|global git-hook|pen-test/i);
});
