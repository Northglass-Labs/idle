import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildVerificationSteps } from './verify-upstream-import.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (character) => character.repeat(40);

function flattened(steps) {
  return steps.map((step) => [step.command, ...step.args].join(' ')).join('\n');
}

test('staged verification is the canonical full local import gate', () => {
  const steps = buildVerificationSteps(repoRoot, ['--staged', sha('a')]);
  const commands = flattened(steps);
  assert.match(commands, /check-upstream-cruft\.sh --check-remote/);
  assert.match(commands, /git merge-base --is-ancestor a{40} refs\/remotes\/upstream\/main/);
  assert.match(commands, /check-upstream-cruft\.sh --provenance-staged a{40}/);
  assert.match(commands, /check-upstream-cruft\.sh --staged a{40}/);
  assert.match(commands, /check-docs-hygiene\.sh --defer-upstream-baseline/);
  assert.match(commands, /git diff --check --cached/);
  assert.match(commands, /yarn typecheck/);
  assert.match(commands, /yarn test/);
});

test('committed verification binds source and scans commit metadata', () => {
  const steps = buildVerificationSteps(repoRoot, ['--range', sha('a'), sha('b'), sha('c')]);
  const commands = flattened(steps);
  assert.match(commands, /check-upstream-cruft\.sh --provenance-diff a{40} b{40} c{40}/);
  assert.match(commands, /check-upstream-cruft\.sh --diff a{40} c{40} --source b{40}/);
  assert.match(commands, /git merge-base --is-ancestor b{40} refs\/remotes\/upstream\/main/);
  assert.match(commands, /verify-upstream-commit a{40}/);
  assert.match(commands, /verify-upstream-commit b{40}/);
  assert.match(commands, /verify-upstream-commit c{40}/);
  assert.match(commands, /check-public-git-metadata\.mjs --range a{40} c{40}/);
  assert.match(commands, /check-docs-hygiene\.sh(?:\n|$)/);
  assert.doesNotMatch(commands, /check-docs-hygiene\.sh --defer-upstream-baseline/);
  assert.match(commands, /git diff --check a{40} c{40}/);
  assert.match(commands, /yarn typecheck/);
  assert.match(commands, /yarn test/);
});

test('CI mode reuses the canonical delta gates without duplicating dependency-heavy jobs', () => {
  const steps = buildVerificationSteps(repoRoot, ['--ci-range', sha('a'), sha('c')]);
  const commands = flattened(steps);
  assert.match(commands, /check-upstream-cruft\.sh --ci-diff a{40} c{40}/);
  assert.match(commands, /check-public-git-metadata\.mjs --range a{40} c{40}/);
  assert.match(commands, /git diff --check a{40} c{40}/);
  assert.match(commands, /verify-upstream-commit a{40}/);
  assert.match(commands, /verify-upstream-commit c{40}/);
  assert.doesNotMatch(commands, /--check-remote|check-docs-hygiene|yarn (?:typecheck|test)/);
});

test('policy updates use a dedicated isolated maintainer gate', () => {
  const steps = buildVerificationSteps(repoRoot, ['--policy-range', sha('a'), sha('c')]);
  const commands = flattened(steps);
  assert.match(commands, /check-docs-hygiene\.sh/);
  assert.match(commands, /check-upstream-cruft\.sh --policy-diff a{40} c{40}/);
  assert.match(commands, /check-public-git-metadata\.mjs --range a{40} c{40}/);
  assert.match(commands, /git diff --check a{40} c{40}/);
  assert.match(commands, /verify-upstream-commit a{40}/);
  assert.match(commands, /verify-upstream-commit c{40}/);
  assert.match(commands, /check-upstream-cruft\.test\.mjs/);
  assert.doesNotMatch(commands, /yarn (?:typecheck|test)/);
});

test('unknown or incomplete modes fail closed', () => {
  assert.throws(() => buildVerificationSteps(repoRoot, ['--staged']), /usage/);
  assert.throws(() => buildVerificationSteps(repoRoot, ['--range', sha('a'), sha('b')]), /usage/);
  assert.throws(() => buildVerificationSteps(repoRoot, ['--policy-range', sha('a')]), /usage/);
  assert.throws(() => buildVerificationSteps(repoRoot, ['--unknown']), /usage/);
});

test('all import revisions must be immutable full object IDs', () => {
  for (const args of [
    ['--staged', 'upstream/main'],
    ['--staged', 'abcdef0'],
    ['--range', sha('a'), 'upstream/main', sha('c')],
    ['--range', 'HEAD~1', sha('b'), sha('c')],
    ['--range', sha('a'), sha('b'), 'HEAD'],
    ['--policy-range', 'main', sha('c')],
    ['--policy-range', sha('a'), 'release-candidate'],
    ['--ci-range', 'refs/pull/1/head', sha('c')],
    ['--ci-range', sha('a'), 'FETCH_HEAD'],
  ]) {
    assert.throws(
      () => buildVerificationSteps(repoRoot, args),
      /full 40- or 64-character lowercase Git object ID/,
      args.join(' '),
    );
  }
});

test('direct revision checks accept commits and reject blob, tree, and tag object IDs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-upstream-object-kind-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'devconfig.publicIdentity', 'true');
  git('config', 'user.name', 'Northglass');
  git('config', 'user.email', 'hello@northglass.io');
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'fixture\n');
  git('add', 'fixture.txt');
  git('commit', '-qm', 'fixture');
  git('tag', '-am', 'fixture tag', 'fixture-tag');

  const objects = {
    commit: git('rev-parse', 'HEAD'),
    blob: git('rev-parse', 'HEAD:fixture.txt'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    tag: git('rev-parse', 'refs/tags/fixture-tag'),
  };
  for (const [kind, objectId] of Object.entries(objects)) {
    const step = buildVerificationSteps(repoRoot, ['--staged', objectId])
      .find(candidate => candidate.args.includes('verify-upstream-commit'));
    assert.ok(step, `missing direct commit check for ${kind}`);
    const result = spawnSync(step.command, step.args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status === 0, kind === 'commit', `${kind}: ${result.stderr}`);
  }
});
