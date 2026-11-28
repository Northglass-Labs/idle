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

// Built from parts so the public delta scanner does not read these fixture
// addresses as new external identities.
const GITHUB_SERVICE_EMAIL = ['noreply', 'github.com'].join('@');
const DEPENDABOT_NAME = 'dependabot[bot]';
const DEPENDABOT_EMAIL = ['49699333+dependabot[bot]', 'users.noreply.github.com'].join('@');
const SIGN_OFF_ADDRESS = ['support', 'github.com'].join('@');
const DEPENDABOT_SIGN_OFF = `Signed-off-by: ${DEPENDABOT_NAME} <${SIGN_OFF_ADDRESS}>`;
const DEPENDABOT_IDENTITY = {
  authorName: DEPENDABOT_NAME,
  authorEmail: DEPENDABOT_EMAIL,
  committerName: 'GitHub',
  committerEmail: GITHUB_SERVICE_EMAIL,
};

function dependabotMessage(...trailers) {
  return [
    'chore(deps): bump fixture-package from 1.0.0 to 1.0.1',
    '',
    'Bumps fixture-package from 1.0.0 to 1.0.1.',
    '',
    '---',
    'updated-dependencies:',
    '- dependency-name: fixture-package',
    '  dependency-version: 1.0.1',
    '  dependency-type: indirect',
    '...',
    '',
    ...trailers,
  ].join('\n');
}

function scanSingleCommit(message, identity) {
  return withRepo((root) => {
    const base = git(root, ['rev-parse', 'HEAD']);
    put(root, 'dependency.txt', `${message.length}\n`);
    git(root, ['add', '.']);
    commit(root, message, identity);
    const head = git(root, ['rev-parse', 'HEAD']);
    const result = run(root, ['--range', base, head]);
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  });
}

test('range scan accepts the exact Dependabot sign-off trailer on Dependabot-authored commits', () => {
  const pullRequestCommit = scanSingleCommit(dependabotMessage(DEPENDABOT_SIGN_OFF), DEPENDABOT_IDENTITY);
  assert.equal(pullRequestCommit.status, 0, pullRequestCommit.output);

  // A squash merge keeps Dependabot as author and can repeat the trailer.
  const squashMerge = scanSingleCommit(dependabotMessage(
    DEPENDABOT_SIGN_OFF,
    '',
    DEPENDABOT_SIGN_OFF,
    `Co-authored-by: ${DEPENDABOT_NAME} <${DEPENDABOT_EMAIL}>`,
  ), DEPENDABOT_IDENTITY);
  assert.equal(squashMerge.status, 0, squashMerge.output);
});

test('range scan rejects the Dependabot sign-off address outside its exact trailer and author', () => {
  const contributor = {
    authorName: 'Public Contributor',
    authorEmail: '12345+contributor@users.noreply.github.com',
    committerName: 'GitHub',
    committerEmail: GITHUB_SERVICE_EMAIL,
  };
  const cases = [
    ['non-Dependabot author', dependabotMessage(DEPENDABOT_SIGN_OFF), contributor],
    ['Dependabot name with another address', dependabotMessage(DEPENDABOT_SIGN_OFF), {
      ...DEPENDABOT_IDENTITY,
      authorEmail: '12345+impostor@users.noreply.github.com',
    }],
    ['address in body prose', dependabotMessage(`Contact ${SIGN_OFF_ADDRESS} for help.`), DEPENDABOT_IDENTITY],
    ['address under another signer', dependabotMessage(`Signed-off-by: Someone Else <${SIGN_OFF_ADDRESS}>`), DEPENDABOT_IDENTITY],
    ['trailer with trailing text', dependabotMessage(`${DEPENDABOT_SIGN_OFF} PRIVATE_SUFFIX_MARKER`), DEPENDABOT_IDENTITY],
    ['indented trailer', dependabotMessage(`  ${DEPENDABOT_SIGN_OFF}`), DEPENDABOT_IDENTITY],
    ['exact trailer beside another unapproved address', dependabotMessage(
      DEPENDABOT_SIGN_OFF,
      `Reported-by: PRIVATE_REPORTER_MARKER <${['owner', '@', 'personal.invalid'].join('')}>`,
    ), DEPENDABOT_IDENTITY],
  ];

  for (const [label, message, identity] of cases) {
    const result = scanSingleCommit(message, identity);
    assert.notEqual(result.status, 0, label);
    assert.match(result.output, /commit-metadata:unapproved-email/, label);
    assert.doesNotMatch(result.output, /PRIVATE_(?:SUFFIX|REPORTER)_MARKER|personal\.invalid|support@/i, label);
  }
});

test('the Dependabot sign-off address is never an approved identity or tag message', () => {
  for (const identity of [
    { ...DEPENDABOT_IDENTITY, authorEmail: SIGN_OFF_ADDRESS },
    { ...DEPENDABOT_IDENTITY, committerEmail: SIGN_OFF_ADDRESS },
  ]) {
    const result = scanSingleCommit(dependabotMessage(DEPENDABOT_SIGN_OFF), identity);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /commit-metadata:unapproved-email/);
  }

  withRepo((root) => {
    const base = git(root, ['rev-parse', 'HEAD']);
    put(root, 'tagged.txt', 'tagged\n');
    git(root, ['add', '.']);
    commit(root, dependabotMessage(DEPENDABOT_SIGN_OFF), DEPENDABOT_IDENTITY);
    const head = git(root, ['rev-parse', 'HEAD']);
    git(root, ['tag', '-a', 'release/dependency-fixture', '-m', dependabotMessage(DEPENDABOT_SIGN_OFF)], {
      GIT_COMMITTER_NAME: DEPENDABOT_NAME,
      GIT_COMMITTER_EMAIL: DEPENDABOT_EMAIL,
    });

    const result = run(root, ['--range', base, head]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /tag-metadata:unapproved-email/);
    assert.doesNotMatch(output, /commit-metadata/);
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
