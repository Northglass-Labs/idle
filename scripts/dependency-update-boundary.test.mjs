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

test('dependency policy stays at or above every reviewed advisory fix', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const appManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/idle-app/package.json'), 'utf8'),
  );
  const serverManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/idle-server/package.json'), 'utf8'),
  );

  assert.equal(manifest.resolutions['@hono/node-server'], '^2.0.5');
  assert.equal(manifest.resolutions['body-parser'], '^2.3.0');
  assert.equal(manifest.resolutions.dompurify, '^3.4.12');
  assert.equal(manifest.resolutions['fast-uri'], '^3.1.4');
  assert.equal(manifest.resolutions['fast-xml-parser'], '^5.10.1');
  assert.equal(appManifest.devDependencies.sharp, '^0.35.0');
  assert.equal(serverManifest.dependencies.sharp, '^0.35.0');
});
