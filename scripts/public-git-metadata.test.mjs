import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanner = path.join(repoRoot, 'scripts', 'check-public-git-metadata.mjs');

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function run(cwd, args) {
  return spawnSync(process.execPath, [scanner, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      LC_ALL: 'C',
    },
  });
}

function writeObject(cwd, type, contents) {
  const result = spawnSync('git', ['hash-object', '-t', type, '-w', '--stdin'], {
    cwd,
    encoding: 'utf8',
    input: contents,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function put(root, relativePath, contents) {
  const destination = path.join(root, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function commit(root, message, {
  authorName = 'Northglass',
  authorEmail = 'hello@northglass.io',
  committerName = 'Northglass',
  committerEmail = 'hello@northglass.io',
} = {}) {
  return git(root, ['commit', '-qm', message], {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
  });
}

function withRepo(callback) {
  const root = mkdtempSync(path.join(tmpdir(), 'idle-public-metadata-'));
  try {
    git(root, ['init', '-q']);
    put(root, 'README.md', 'fixture\n');
    git(root, ['add', '.']);
    commit(root, 'chore: fixture base');
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('range scan accepts corporate and GitHub-noreply public identities', () => {
  withRepo((root) => {
    const base = git(root, ['rev-parse', 'HEAD']);
    put(root, 'safe.txt', 'safe\n');
    git(root, ['add', '.']);
    commit(root, 'feat: safe public change', {
      authorName: 'Public Contributor',
      authorEmail: '12345+contributor@users.noreply.github.com',
      committerName: 'GitHub',
      committerEmail: 'noreply@github.com',
    });
    const head = git(root, ['rev-parse', 'HEAD']);

    const result = run(root, ['--range', base, head]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test('range scan rejects unapproved author, committer, and message identities without echoing them', () => {
  withRepo((root) => {
    const base = git(root, ['rev-parse', 'HEAD']);
    const privateEmail = ['owner', '@', 'personal.invalid'].join('');
    put(root, 'unsafe.txt', 'unsafe\n');
    git(root, ['add', '.']);
    commit(root, `feat: PRIVATE_MESSAGE_MARKER ${privateEmail}`, {
      authorName: 'PRIVATE_AUTHOR_MARKER',
      authorEmail: privateEmail,
      committerName: 'PRIVATE_COMMITTER_MARKER',
      committerEmail: privateEmail,
    });
    const head = git(root, ['rev-parse', 'HEAD']);

    const result = run(root, ['--range', base, head]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /commit-metadata/);
    assert.doesNotMatch(output, /PRIVATE_(?:MESSAGE|AUTHOR)_MARKER|personal\.invalid/i);
  });
});

test('range scan rejects locally visible ref and annotated-tag metadata for range commits', () => {
  withRepo((root) => {
    const base = git(root, ['rev-parse', 'HEAD']);
    put(root, 'tagged.txt', 'tagged\n');
    git(root, ['add', '.']);
    commit(root, 'feat: tagged change');
    const head = git(root, ['rev-parse', 'HEAD']);
    const privateEmail = ['tagger', '@', 'personal.invalid'].join('');
    git(root, ['tag', '-a', 'release/PRIVATE_REF_MARKER', '-m', `PRIVATE_TAG_MARKER ${privateEmail}`], {
      GIT_COMMITTER_NAME: 'PRIVATE_TAGGER_MARKER',
      GIT_COMMITTER_EMAIL: privateEmail,
    });

    const result = run(root, ['--range', base, head]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /ref-metadata|tag-metadata/);
    assert.doesNotMatch(output, /PRIVATE_(?:REF|TAG|TAGGER)_MARKER|personal\.invalid/i);
  });
});

test('refs and tags outside the selected range do not contaminate a clean delta', () => {
  withRepo((root) => {
    const outside = git(root, ['rev-parse', 'HEAD']);
    git(root, ['tag', 'legacy/PRIVATE_OUTSIDE_MARKER', outside]);
    put(root, 'safe.txt', 'safe\n');
    git(root, ['add', '.']);
    commit(root, 'fix: clean delta');
    const head = git(root, ['rev-parse', 'HEAD']);

    const result = run(root, ['--range', outside, head]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test('root mode scans the first commit when no push base exists', () => {
  withRepo((root) => {
    const head = git(root, ['rev-parse', 'HEAD']);
    const result = run(root, ['--root', head]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test('range scan rejects identity data hidden in auxiliary commit headers', () => {
  withRepo((root) => {
    const base = git(root, ['rev-parse', 'HEAD']);
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    const privateEmail = ['header', '@', 'personal.invalid'].join('');
    const commit = writeObject(root, 'commit', [
      `tree ${tree}`,
      `parent ${base}`,
      'author Northglass <hello@northglass.io> 1700000000 +0000',
      'committer Northglass <hello@northglass.io> 1700000000 +0000',
      'mergetag object 0000000000000000000000000000000000000000',
      ' type commit',
      ' tag PRIVATE_HEADER_REF',
      ` tagger PRIVATE_HEADER_AUTHOR <${privateEmail}> 1700000000 +0000`,
      '',
      'feat: safe visible message',
      '',
    ].join('\n'));

    const result = run(root, ['--range', base, commit]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /commit-metadata/);
    assert.doesNotMatch(output, /PRIVATE_HEADER|personal\.invalid/i);
  });
});
