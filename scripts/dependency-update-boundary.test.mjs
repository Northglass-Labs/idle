import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Dependabot monitors every ecosystem without opening routine version PRs', () => {
  const config = fs.readFileSync(path.join(repoRoot, '.github/dependabot.yml'), 'utf8');
  assert.match(config, /^version:\s*2$/m);
  for (const ecosystem of ['npm', 'docker', 'github-actions']) {
    assert.match(config, new RegExp(`package-ecosystem:\\s*["']?${ecosystem}["']?`));
  }
  const pullRequestLimits = [...config.matchAll(/open-pull-requests-limit:\s*(\d+)/g)]
    .map((match) => Number(match[1]));
  assert.deepEqual(pullRequestLimits, [0, 0, 0]);
  assert.doesNotMatch(config, /target-branch:|assignees:|reviewers:/);
});

test('development tooling stays above known vulnerable transitive versions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  assert.equal(manifest.resolutions.flatted, '3.4.2');
  assert.equal(manifest.resolutions['**/eslint/ajv'], '6.14.0');
  assert.equal(manifest.resolutions['**/@eslint/eslintrc/ajv'], '6.14.0');
});
