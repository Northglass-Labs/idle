import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = path.join(repoRoot, 'scripts', 'check-upstream-cruft.sh');
const brand = ['Hap', 'py'].join('');
const upstreamUrl = `https://github.com/${['slo', 'pus'].join('')}/${brand.toLowerCase()}.git`;
const upstreamFetch = '+refs/heads/main:refs/remotes/upstream/main';
const upstreamStoreId = ['571505', '6748'].reverse().join('');
const upstreamStoreSlug = ['app', 'coder', 'idle'].reverse().join('-');

function run(cwd, args = []) {
  return spawnSync('bash', [guard, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitOptional(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function put(root, relativePath, contents) {
  const destination = path.join(root, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function reviewLine(output, kind, relativePath, reason) {
  const fingerprint = output.match(new RegExp(`${kind}[^\\n]+([a-f0-9]{64})`, 'i'))?.[1];
  const context = output.match(/review context base ([a-f0-9]{40,64}) source ([a-f0-9]{40,64}) import ([a-f0-9]{64})/i);
  assert.ok(fingerprint, output);
  assert.ok(context, output);
  return [kind, relativePath, fingerprint, context[1], context[2], context[3], reason].join('\t');
}

function commitReviewBeforeStagedImport(root, reviewContents) {
  const patch = spawnSync(
    'git',
    ['diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--', '.', ':(exclude).upstream-import-review.txt'],
    { cwd: root, encoding: null },
  );
  assert.equal(patch.status, 0, patch.stderr?.toString('utf8'));
  assert.ok(patch.stdout.length > 0, 'fixture must contain a staged candidate import');

  git(root, 'reset', '--hard', '-q', 'HEAD');
  put(root, '.upstream-import-review.txt', reviewContents);
  git(root, 'add', '.upstream-import-review.txt');
  git(root, 'commit', '-qm', 'record exact import review');
  const approvalCommit = git(root, 'rev-parse', 'HEAD');

  const apply = spawnSync('git', ['apply', '--index', '--binary', '-'], {
    cwd: root,
    encoding: null,
    input: patch.stdout,
  });
  assert.equal(apply.status, 0, apply.stderr?.toString('utf8'));
  return approvalCommit;
}

function createCommitCountBoundary(root, base) {
  const commands = [];
  for (let index = 1; index <= 4097; index += 1) {
    const ref = index <= 4096 ? 'refs/heads/within-limit' : 'refs/heads/over-limit';
    const message = `fixture commit ${index}\n`;
    commands.push(
      `commit ${ref}`,
      `mark :${index}`,
      `committer Idle Guard Test <idle-guard@users.noreply.github.com> ${1700000000 + index} +0000`,
      `data ${Buffer.byteLength(message, 'utf8')}`,
      message,
      `from ${index === 1 ? base : `:${index - 1}`}`,
      '',
    );
  }
  commands.push('done', '');
  const imported = spawnSync('git', ['fast-import', '--quiet'], {
    cwd: root,
    encoding: 'utf8',
    input: commands.join('\n'),
  });
  assert.equal(imported.status, 0, imported.stderr);
  return {
    within: git(root, 'rev-parse', 'refs/heads/within-limit'),
    over: git(root, 'rev-parse', 'refs/heads/over-limit'),
  };
}

function withRepo(files, callback) {
  const root = mkdtempSync(path.join(tmpdir(), 'idle-upstream-guard-'));
  try {
    git(root, 'init', '-q');
    const authorName = gitOptional(repoRoot, 'config', 'user.name') || 'Idle Guard Test';
    const authorEmail = gitOptional(repoRoot, 'config', 'user.email') || 'idle-guard@users.noreply.github.com';
    git(root, 'config', 'user.name', authorName);
    git(root, 'config', 'user.email', authorEmail);
    put(root, '.upstream-cruft-allow.txt', '');
    put(root, '.upstream-import-review.txt', '');
    for (const [relativePath, contents] of Object.entries(files)) {
      put(root, relativePath, contents);
    }
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture base');
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('diagnostics report paths without reproducing matched source text', () => {
  withRepo({ 'src/leak.ts': `export const label = '${brand} PRIVATE_MARKER';\n` }, (root) => {
    const result = run(root);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /src\/leak\.ts/);
    assert.doesNotMatch(output, /PRIVATE_MARKER/);
  });
});

test('tree mode scans the exact commit without checkout and rejects non-blob entries', () => {
  withRepo({ 'src/client.ts': 'export const client = true;\n' }, (root) => {
    const safe = git(root, 'rev-parse', 'HEAD');
    put(root, 'src/client.ts', `export const label = '${brand}';\n`);
    const exactTree = run(root, ['--tree', safe]);
    assert.equal(exactTree.status, 0, `${exactTree.stdout}\n${exactTree.stderr}`);

    git(root, 'reset', '--hard', '-q', 'HEAD');
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${safe},vendor/dependency`);
    git(root, 'commit', '-qm', 'unsupported tree entry');
    const unsupported = git(root, 'rev-parse', 'HEAD');
    const blocked = run(root, ['--tree', unsupported]);
    assert.notEqual(blocked.status, 0);
    assert.match(`${blocked.stdout}\n${blocked.stderr}`, /unsupported-policy-tree-entry/);
  });
});

test('tree mode rejects a full tree beyond the explicit entry-count ceiling', () => {
  withRepo({ 'src/client.ts': 'export const client = true;\n' }, (root) => {
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root,
      encoding: 'utf8',
      input: 'fixture\n',
    });
    assert.equal(blob.status, 0, blob.stderr);
    const leafTree = spawnSync('git', ['mktree'], {
      cwd: root,
      encoding: 'utf8',
      input: `100644 blob ${blob.stdout.trim()}\tyarn.lock\n`,
    });
    assert.equal(leafTree.status, 0, leafTree.stderr);

    const rootEntries = Array.from({ length: 50_001 }, (_, index) => (
      `040000 tree ${leafTree.stdout.trim()}\tentry-${String(index).padStart(5, '0')}`
    )).join('\n');
    const oversizedTree = spawnSync('git', ['mktree'], {
      cwd: root,
      encoding: 'utf8',
      input: `${rootEntries}\n`,
    });
    assert.equal(oversizedTree.status, 0, oversizedTree.stderr);
    const commit = spawnSync('git', ['commit-tree', oversizedTree.stdout.trim()], {
      cwd: root,
      encoding: 'utf8',
      input: 'oversized policy tree\n',
    });
    assert.equal(commit.status, 0, commit.stderr);

    const blocked = run(root, ['--tree', commit.stdout.trim()]);
    assert.equal(blocked.status, 2);
    assert.match(`${blocked.stdout}\n${blocked.stderr}`, /entry-count limit/);
  });
});

test('baseline policy rejects wildcard and directory-wide mute rules', () => {
  withRepo(
    {
      '.upstream-cruft-allow.txt': 'packages/**\n',
      'packages/client.ts': `export const label = '${brand}';\n`,
    },
    (root) => {
      const result = run(root);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /\.upstream-cruft-allow\.txt/);
    },
  );
});

test('excluded policy files cannot carry identity data in comments or reasons', () => {
  withRepo(
    {
      '.upstream-import-review.txt': `# PRIVATE_POLICY_MARKER owner@personal.invalid\n`,
    },
    (root) => {
      const result = run(root);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.status, 0);
      assert.match(output, /\.upstream-import-review\.txt/);
      assert.doesNotMatch(output, /PRIVATE_POLICY_MARKER|personal\.invalid/);
    },
  );
});

test('an exact path and occurrence count preserve a reviewed compatibility symbol', () => {
  withRepo(
    {
      '.upstream-cruft-allow.txt': 'src/protocol.ts\t1\n',
      'src/protocol.ts': `export const X_${brand}_Client = 'wire-v1';\n`,
    },
    (root) => {
      const result = run(root);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );
});

test('an exact baseline fails closed when branding occurrence count drifts', () => {
  withRepo(
    {
      '.upstream-cruft-allow.txt': 'src/protocol.ts\t1\n',
      'src/protocol.ts': `export const X_${brand}_Client = '${brand}';\n`,
    },
    (root) => {
      const result = run(root);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /src\/protocol\.ts/);
    },
  );
});

test('diff mode blocks newly added branding even inside a baseline-approved file', () => {
  withRepo(
    {
      '.upstream-cruft-allow.txt': 'src/protocol.ts\t1\n',
      'src/protocol.ts': `export const X_${brand}_Client = 'wire-v1';\n`,
    },
    (root) => {
      const base = git(root, 'rev-parse', 'HEAD');
      put(
        root,
        'src/protocol.ts',
        `export const X_${brand}_Client = 'wire-v1';\nexport const display = '${brand} PRIVATE_DIFF_MARKER';\n`,
      );
      git(root, 'add', 'src/protocol.ts');
      const result = run(root, ['--staged', base]);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.status, 0);
      assert.match(output, /src\/protocol\.ts/);
      assert.doesNotMatch(output, /PRIVATE_DIFF_MARKER/);

      const approvalCommit = commitReviewBeforeStagedImport(
        root,
        `${reviewLine(output, 'text-compatibility', 'src/protocol.ts', 'Required wire compatibility')}\n`,
      );
      const stagedReviewed = run(root, ['--staged', base]);
      assert.equal(stagedReviewed.status, 0, `${stagedReviewed.stdout}\n${stagedReviewed.stderr}`);
      git(root, 'commit', '-qm', 'upstream import');
      const importCommit = git(root, 'rev-parse', 'HEAD');
      const reviewed = run(root, ['--diff', approvalCommit, importCommit, '--source', base]);
      assert.equal(reviewed.status, 0, `${reviewed.stdout}\n${reviewed.stderr}`);

      put(root, '.upstream-cruft-allow.txt', 'src/protocol.ts\t2\n');
      git(root, 'add', '.upstream-cruft-allow.txt');
      git(root, 'commit', '-qm', 'align exact compatibility baseline');
      const baselineCommit = git(root, 'rev-parse', 'HEAD');
      const complete = run(root, ['--diff', approvalCommit, baselineCommit, '--source', base]);
      assert.equal(complete.status, 0, `${complete.stdout}\n${complete.stderr}`);
    },
  );
});

test('diff mode blocks newly added branded filenames', () => {
  withRepo({ 'src/client.ts': 'export const client = true;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    put(root, `src/${brand.toLowerCase()}-client.ts`, 'export const client = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'upstream import');
    const head = git(root, 'rev-parse', 'HEAD');
    const result = run(root, ['--diff', base, head]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`src/${brand.toLowerCase()}-client\\.ts`, 'i'));
  });
});

test('diff mode blocks newly added external-identity filenames', () => {
  withRepo({ 'src/client.ts': 'export const client = true;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    put(root, 'src/person@private-mail.example.dev/note.ts', 'export const note = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'upstream import');
    const head = git(root, 'rev-parse', 'HEAD');
    const result = run(root, ['--diff', base, head]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /external-identity/);
    assert.doesNotMatch(output, /private-mail\.example\.dev/);
  });
});

test('control characters in changed paths fail without reaching terminal diagnostics', () => {
  withRepo({ 'src/client.ts': 'export const client = true;\n' }, (root) => {
    const source = git(root, 'rev-parse', 'HEAD');
    put(root, 'src/unsafe\nPRIVATE_PATH.ts', 'export const note = true;\n');
    git(root, 'add', '.');
    const result = run(root, ['--staged', source]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /unsafe-repository-path/);
    assert.doesNotMatch(output, /PRIVATE_PATH/);
  });
});

test('staged mode blocks external identities without printing them', () => {
  withRepo({ 'src/client.ts': 'export const client = true;\n' }, (root) => {
    const identity = ['person', '@', 'personal.invalid'].join('');
    put(root, 'src/client.ts', `export const owner = '${identity}'; // PRIVATE_IDENTITY_MARKER\n`);
    git(root, 'add', 'src/client.ts');
    const result = run(root, ['--staged']);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /src\/client\.ts/);
    assert.doesNotMatch(output, /PRIVATE_IDENTITY_MARKER|personal\.invalid/);
  });
});

test('staged and trusted CI deltas reject inline secret-scanner suppression directives', () => {
  for (const directive of ['gitleaks:allow', 'GITLEAKS : ALLOW']) {
    withRepo({ 'src/client.ts': 'export const client = true;\n' }, (root) => {
      const base = git(root, 'rev-parse', 'HEAD');
      put(root, 'src/client.ts', `export const client = true; // ${directive}\n`);
      git(root, 'add', 'src/client.ts');
      const staged = run(root, ['--staged', base]);
      assert.notEqual(staged.status, 0);
      assert.match(`${staged.stdout}\n${staged.stderr}`, /scanner-suppression-directive/);

      git(root, 'commit', '-qm', 'fixture scanner bypass');
      const head = git(root, 'rev-parse', 'HEAD');
      const trusted = run(root, ['--ci-diff', base, head]);
      assert.notEqual(trusted.status, 0);
      assert.match(`${trusted.stdout}\n${trusted.stderr}`, /scanner-suppression-directive/);
    });
  }
});

test('staged imports reject the upstream App Store identity without a review bypass', () => {
  withRepo({ 'src/client.ts': 'export const updateUrl = null;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    put(
      root,
      'src/client.ts',
      `export const updateUrl = 'https://apps.apple.com/us/app/${upstreamStoreSlug}/id${upstreamStoreId}';\n`,
    );
    git(root, 'add', 'src/client.ts');

    const staged = run(root, ['--staged', base]);
    const output = `${staged.stdout}\n${staged.stderr}`;
    assert.notEqual(staged.status, 0);
    assert.match(output, /known-upstream-product/);
    assert.doesNotMatch(output, new RegExp(upstreamStoreId));
  });
});

test('staged imports reject fragmented upstream App Store identity reconstruction', () => {
  withRepo({ 'src/client.ts': 'export const updateUrl = null;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    const idParts = [upstreamStoreId.slice(0, 4), upstreamStoreId.slice(4)];
    const slugParts = upstreamStoreSlug.split('-');
    put(
      root,
      'src/client.ts',
      [
        `const storeId = ${JSON.stringify(idParts)}.join('');`,
        `const storeSlug = ${JSON.stringify(slugParts)}.join('-');`,
        "export const updateUrl = `https://apps.apple.com/us/app/${storeSlug}/id${storeId}`;",
        '',
      ].join('\n'),
    );
    git(root, 'add', 'src/client.ts');

    const staged = run(root, ['--staged', base]);
    const output = `${staged.stdout}\n${staged.stderr}`;
    assert.notEqual(staged.status, 0);
    assert.match(output, /known-upstream-product/);
    assert.doesNotMatch(output, new RegExp(upstreamStoreId));
  });
});

test('staged imports reject reverse-ordered upstream App Store identity reconstruction', () => {
  withRepo({ 'src/client.ts': 'export const updateUrl = null;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    const idParts = [
      upstreamStoreId.slice(4),
      upstreamStoreId.slice(0, 4),
    ];
    const slugParts = upstreamStoreSlug.split('-').reverse();
    put(
      root,
      'src/client.ts',
      [
        `const storeId = ${JSON.stringify(idParts)}.reverse().join('');`,
        `const storeSlug = ${JSON.stringify(slugParts)}.toReversed().join('-');`,
        "export const updateUrl = `https://apps.apple.com/us/app/${storeSlug}/id${storeId}`;",
        '',
      ].join('\n'),
    );
    git(root, 'add', 'src/client.ts');

    const staged = run(root, ['--staged', base]);
    const output = `${staged.stdout}\n${staged.stderr}`;
    assert.notEqual(staged.status, 0);
    assert.match(output, /known-upstream-product/);
    assert.doesNotMatch(output, new RegExp(upstreamStoreId));
  });
});

test('a reachable upstream source cannot attest an unrelated clean staged delta', () => {
  withRepo({ 'src/client.ts': 'export const version = 1;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    put(root, 'src/client.ts', 'export const version = 2;\n');
    git(root, 'add', 'src/client.ts');
    git(root, 'commit', '-qm', 'fixture upstream source');
    const source = git(root, 'rev-parse', 'HEAD');

    git(root, 'reset', '--hard', '-q', base);
    put(root, 'src/client.ts', 'export const version = 3;\n');
    git(root, 'add', 'src/client.ts');

    const result = run(root, ['--provenance-staged', source]);
    assert.notEqual(result.status, 0, 'an unrelated delta must not inherit source provenance');
    assert.match(`${result.stdout}\n${result.stderr}`, /source-transformation/);
  });
});

test('an exact cherry-pick satisfies source-to-delta provenance without an exception', () => {
  withRepo({ 'src/client.ts': 'export const version = 1;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    put(root, 'src/client.ts', 'export const version = 2;\n');
    git(root, 'add', 'src/client.ts');
    git(root, 'commit', '-qm', 'fixture upstream source');
    const source = git(root, 'rev-parse', 'HEAD');

    git(root, 'reset', '--hard', '-q', base);
    git(root, 'cherry-pick', '--no-commit', source);

    const result = run(root, ['--provenance-staged', source]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test('a transformed upstream import needs a separate exact review that becomes stale', () => {
  withRepo(
    {
      'src/client.ts': 'export const version = 1;\n',
      'src/other.ts': 'export const other = 1;\n',
    },
    (root) => {
      const base = git(root, 'rev-parse', 'HEAD');
      put(root, 'src/client.ts', 'export const version = 2;\n');
      git(root, 'add', 'src/client.ts');
      git(root, 'commit', '-qm', 'fixture upstream source');
      const source = git(root, 'rev-parse', 'HEAD');

      git(root, 'reset', '--hard', '-q', base);
      put(root, 'src/client.ts', 'export const version = 2; // adapted for Idle\n');
      git(root, 'add', 'src/client.ts');
      const blocked = run(root, ['--provenance-staged', source]);
      const output = `${blocked.stdout}\n${blocked.stderr}`;
      assert.notEqual(blocked.status, 0);
      const approval = reviewLine(
        output,
        'source-transformation',
        '.',
        'Reviewed exact transformed import',
      );

      commitReviewBeforeStagedImport(root, `${approval}\n`);
      const reviewed = run(root, ['--provenance-staged', source]);
      assert.equal(reviewed.status, 0, `${reviewed.stdout}\n${reviewed.stderr}`);

      put(root, 'src/other.ts', 'export const other = 2;\n');
      git(root, 'add', 'src/other.ts');
      const stale = run(root, ['--provenance-staged', source]);
      assert.notEqual(stale.status, 0, 'changing the imported delta must invalidate approval');
      assert.match(`${stale.stdout}\n${stale.stderr}`, /source-transformation/);
    },
  );
});

test('a staged import cannot author the review that approves its own branding', () => {
  withRepo({ 'src/protocol.ts': 'export const protocol = true;\n' }, (root) => {
    const source = git(root, 'rev-parse', 'HEAD');
    put(root, 'src/protocol.ts', `export const X_${brand}_Client = 'wire-v1';\n`);
    git(root, 'add', 'src/protocol.ts');

    const blocked = run(root, ['--staged', source]);
    const output = `${blocked.stdout}\n${blocked.stderr}`;
    assert.notEqual(blocked.status, 0);
    put(
      root,
      '.upstream-import-review.txt',
      `${reviewLine(output, 'text-compatibility', 'src/protocol.ts', 'Required wire compatibility')}\n`,
    );
    git(root, 'add', '.upstream-import-review.txt');

    const selfApproved = run(root, ['--staged', source]);
    assert.notEqual(
      selfApproved.status,
      0,
      'an import must not approve itself by changing the review policy in the same staged delta',
    );
  });
});

test('a staged import cannot modify its guard, package entrypoint, or CI enforcement', () => {
  for (const protectedPath of [
    'scripts/check-upstream-cruft.mjs',
    'scripts/opsec-boundary.mjs',
    'scripts/publication-policy.encrypted.json',
    'package.json',
    '.github/workflows/public-hygiene.yml',
  ]) {
    withRepo({ [protectedPath]: 'trusted boundary\n', 'src/client.ts': 'export const version = 1;\n' }, (root) => {
      const source = git(root, 'rev-parse', 'HEAD');
      put(root, protectedPath, 'disabled boundary\n');
      git(root, 'add', protectedPath);
      const result = run(root, ['--staged', source]);
      assert.notEqual(result.status, 0, `${protectedPath} must be immutable during an upstream import`);
    });
  }
});

test('staged mode requires exact review for imported signing or bundle configuration', () => {
  withRepo({ 'app.config.js': 'export default {};\n' }, (root) => {
    const source = git(root, 'rev-parse', 'HEAD');
    put(
      root,
      'app.config.js',
      "export default { bundleIdentifier: 'com.external.product' }; // PRIVATE_CONFIG_MARKER\n",
    );
    git(root, 'add', 'app.config.js');
    const result = run(root, ['--staged', source]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /app\.config\.js/);
    assert.doesNotMatch(output, /com\.external\.product|PRIVATE_CONFIG_MARKER/);
  });
});

test('a compatibility config line requires both exact review categories', () => {
  withRepo({ 'src/config.ts': 'export const config = {};\n' }, (root) => {
    const source = git(root, 'rev-parse', 'HEAD');
    put(root, 'src/config.ts', `export const ${brand.toUpperCase()}_SERVER_URL = 'idle';\n`);
    git(root, 'add', 'src/config.ts');
    const blocked = run(root, ['--staged', source]);
    const output = `${blocked.stdout}\n${blocked.stderr}`;
    assert.notEqual(blocked.status, 0);
    const textReview = reviewLine(output, 'text-compatibility', 'src/config.ts', 'Required environment compatibility');
    const configReview = reviewLine(output, 'config-addition', 'src/config.ts', 'Verified Idle-owned configuration');

    commitReviewBeforeStagedImport(
      root,
      `${textReview}\n`,
    );
    const partiallyReviewed = run(root, ['--staged', source]);
    assert.notEqual(partiallyReviewed.status, 0);
    assert.match(`${partiallyReviewed.stdout}\n${partiallyReviewed.stderr}`, /config-addition/);

    commitReviewBeforeStagedImport(
      root,
      [
        textReview,
        configReview,
        '',
      ].join('\n'),
    );
    const reviewed = run(root, ['--staged', source]);
    assert.equal(reviewed.status, 0, `${reviewed.stdout}\n${reviewed.stderr}`);
  });
});

test('review approvals are bound to the exact base, source, and imported delta', () => {
  withRepo(
    {
      'src/protocol.ts': 'export const protocol = true;\n',
      'src/other.ts': 'export const version = 1;\n',
    },
    (root) => {
      put(root, 'src/base-note.ts', 'export const baseNote = true;\n');
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'fixture second base');
      const source = git(root, 'rev-parse', 'HEAD^');
      const alternateSource = git(root, 'rev-parse', 'HEAD');

      put(root, 'src/protocol.ts', `export const X_${brand}_Client = 'wire-v1';\n`);
      git(root, 'add', 'src/protocol.ts');
      const blocked = run(root, ['--staged', source]);
      const output = `${blocked.stdout}\n${blocked.stderr}`;
      assert.notEqual(blocked.status, 0);
      const approval = reviewLine(output, 'text-compatibility', 'src/protocol.ts', 'Required wire compatibility');
      commitReviewBeforeStagedImport(root, `${approval}\n`);

      const reviewed = run(root, ['--staged', source]);
      assert.equal(reviewed.status, 0, `${reviewed.stdout}\n${reviewed.stderr}`);

      const staleSource = run(root, ['--staged', alternateSource]);
      assert.notEqual(staleSource.status, 0, 'an approval for another source commit must not pass');

      put(root, 'src/other.ts', 'export const version = 2;\n');
      git(root, 'add', 'src/other.ts');
      const staleImport = run(root, ['--staged', source]);
      assert.notEqual(staleImport.status, 0, 'an approval for another import delta must not pass');
      put(root, 'src/other.ts', 'export const version = 1;\n');
      git(root, 'add', 'src/other.ts');

      const restored = run(root, ['--staged', source]);
      assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
      git(root, 'commit', '-qm', 'record reviewed import');

      put(root, 'src/protocol.ts', 'export const protocol = true;\n');
      git(root, 'add', 'src/protocol.ts');
      git(root, 'commit', '-qm', 'restore clean fixture baseline');

      put(root, 'src/protocol.ts', `export const X_${brand}_Client = 'wire-v1';\n`);
      git(root, 'add', 'src/protocol.ts');
      const staleBase = run(root, ['--staged', source]);
      assert.notEqual(staleBase.status, 0, 'an approval for another base commit must not pass');
    },
  );
});

test('a base-bound review can be committed only as a dedicated policy update', () => {
  withRepo({ 'src/protocol.ts': 'export const protocol = true;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    put(root, 'src/protocol.ts', `export const X_${brand}_Client = 'wire-v1';\n`);
    git(root, 'add', 'src/protocol.ts');
    const blocked = run(root, ['--staged', base]);
    const output = `${blocked.stdout}\n${blocked.stderr}`;
    assert.notEqual(blocked.status, 0);
    const approval = reviewLine(output, 'text-compatibility', 'src/protocol.ts', 'Required wire compatibility');

    git(root, 'reset', '--hard', '-q', 'HEAD');
    put(root, '.upstream-import-review.txt', `${approval}\n`);
    git(root, 'add', '.upstream-import-review.txt');
    git(root, 'commit', '-qm', 'approve exact import separately');
    const reviewCommit = git(root, 'rev-parse', 'HEAD');
    const policyOnly = run(root, ['--policy-diff', base, reviewCommit]);
    assert.equal(policyOnly.status, 0, `${policyOnly.stdout}\n${policyOnly.stderr}`);
  });
});

test('policy mode rejects mixed code changes and approvals bound to another base', () => {
  withRepo({ 'src/client.ts': 'export const version = 1;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    const invalidApproval = [
      'config-addition',
      'src/client.ts',
      '0'.repeat(64),
      '1'.repeat(40),
      base,
      '2'.repeat(64),
      'Verified Idle configuration',
    ].join('\t');
    put(root, '.upstream-import-review.txt', `${invalidApproval}\n`);
    git(root, 'add', '.upstream-import-review.txt');
    git(root, 'commit', '-qm', 'fixture wrong-base review');
    const wrongBaseHead = git(root, 'rev-parse', 'HEAD');
    const wrongBase = run(root, ['--policy-diff', base, wrongBaseHead]);
    assert.notEqual(wrongBase.status, 0);
    assert.match(`${wrongBase.stdout}\n${wrongBase.stderr}`, /unbound-policy-approval/);

    put(root, 'src/client.ts', 'export const version = 2;\n');
    put(root, '.upstream-import-review.txt', '# Dedicated policy records only.\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture mixed policy and code');
    const mixedHead = git(root, 'rev-parse', 'HEAD');
    const mixed = run(root, ['--policy-diff', wrongBaseHead, mixedHead]);
    assert.notEqual(mixed.status, 0);
    assert.match(`${mixed.stdout}\n${mixed.stderr}`, /mixed-policy-update/);
  });
});

test('policy mode rejects a baseline that does not exactly match the target tree', () => {
  withRepo({ 'src/client.ts': 'export const version = 1;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    put(root, '.upstream-cruft-allow.txt', 'src/missing.ts\t1\n');
    git(root, 'add', '.upstream-cruft-allow.txt');
    git(root, 'commit', '-qm', 'fixture invalid baseline');
    const head = git(root, 'rev-parse', 'HEAD');
    const result = run(root, ['--policy-diff', base, head]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /branding-baseline-drift/);
  });
});

test('a compatibility baseline cannot be folded into the import commit', () => {
  withRepo(
    {
      '.upstream-cruft-allow.txt': 'src/protocol.ts\t1\n',
      'src/protocol.ts': `export const X_${brand}_Client = 'wire-v1';\n`,
    },
    (root) => {
      const source = git(root, 'rev-parse', 'HEAD');
      put(root, 'src/protocol.ts', `export const X_${brand}_Client = '${brand}';\n`);
      git(root, 'add', 'src/protocol.ts');
      const blocked = run(root, ['--staged', source]);
      const output = `${blocked.stdout}\n${blocked.stderr}`;
      assert.notEqual(blocked.status, 0);
      const approval = reviewLine(output, 'text-compatibility', 'src/protocol.ts', 'Required wire compatibility');
      const approvalCommit = commitReviewBeforeStagedImport(root, `${approval}\n`);

      put(root, '.upstream-cruft-allow.txt', 'src/protocol.ts\t2\n');
      git(root, 'add', '.upstream-cruft-allow.txt');
      git(root, 'commit', '-qm', 'unsafe combined import and baseline');
      const head = git(root, 'rev-parse', 'HEAD');
      const result = run(root, ['--diff', approvalCommit, head, '--source', source]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /protected-import-control/);
    },
  );
});

test('legacy unbound review entries fail closed', () => {
  withRepo({
    '.upstream-cruft-allow.txt': 'src/protocol.ts\t1\n',
    'src/protocol.ts': `export const X_${brand}_Client = 'wire-v1';\n`,
  }, (root) => {
    put(
      root,
      '.upstream-import-review.txt',
      `text-compatibility\tsrc/protocol.ts\t${'0'.repeat(64)}\tLegacy unbound approval\n`,
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /invalid-review-policy/);
  });
});

test('safe text-only upstream deltas pass', () => {
  withRepo({ 'src/client.ts': 'export const version = 1;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    put(root, 'src/client.ts', 'export const version = 2;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'safe upstream import');
    const head = git(root, 'rev-parse', 'HEAD');
    const result = run(root, ['--diff', base, head]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test('trusted CI requires complete base ancestry and at most 4096 reviewed commits', () => {
  withRepo({ 'src/client.ts': 'export const version = 1;\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    const { within, over } = createCommitCountBoundary(root, base);

    const allowed = run(root, ['--ci-diff', base, within]);
    assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`);

    const rejected = run(root, ['--ci-diff', base, over]);
    assert.notEqual(rejected.status, 0, 'the 4097th commit must be a rejected sentinel');
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /commit-count-limit/);

    const tree = git(root, 'rev-parse', `${base}^{tree}`);
    const unrelated = spawnSync('git', ['commit-tree', tree], {
      cwd: root,
      encoding: 'utf8',
      input: 'unrelated fixture\n',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Idle Guard Test',
        GIT_AUTHOR_EMAIL: 'idle-guard@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'Idle Guard Test',
        GIT_COMMITTER_EMAIL: 'idle-guard@users.noreply.github.com',
      },
    });
    assert.equal(unrelated.status, 0, unrelated.stderr);
    const incomplete = run(root, ['--ci-diff', base, unrelated.stdout.trim()]);
    assert.notEqual(incomplete.status, 0);
    assert.match(`${incomplete.stdout}\n${incomplete.stderr}`, /incomplete-commit-range/);
  });
});

test('binary asset changes require an exact content review fingerprint', () => {
  withRepo({ 'assets/icon.png': Buffer.from([0, 1, 2, 3]) }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    const reviewedBytes = Buffer.from([0, 9, 8, 7, 6]);
    put(root, 'assets/icon.png', reviewedBytes);
    git(root, 'add', 'assets/icon.png');

    const blocked = run(root, ['--staged', base]);
    assert.notEqual(blocked.status, 0);
    assert.match(`${blocked.stdout}\n${blocked.stderr}`, /assets\/icon\.png/);

    const output = `${blocked.stdout}\n${blocked.stderr}`;
    const approvalCommit = commitReviewBeforeStagedImport(
      root,
      `${reviewLine(output, 'binary-asset', 'assets/icon.png', 'Reviewed Idle artwork')}\n`,
    );
    const stagedReviewed = run(root, ['--staged', base]);
    assert.equal(stagedReviewed.status, 0, `${stagedReviewed.stdout}\n${stagedReviewed.stderr}`);
    git(root, 'commit', '-qm', 'replace artwork');
    const importCommit = git(root, 'rev-parse', 'HEAD');
    const reviewed = run(root, ['--diff', approvalCommit, importCommit, '--source', base]);
    assert.equal(reviewed.status, 0, `${reviewed.stdout}\n${reviewed.stderr}`);
  });
});

test('text-based artwork requires asset review and still receives text scanning', () => {
  withRepo({ 'assets/logo.svg': '<svg></svg>\n' }, (root) => {
    const base = git(root, 'rev-parse', 'HEAD');
    put(root, 'assets/logo.svg', `<svg><text>${brand}</text></svg>\n`);
    git(root, 'add', 'assets/logo.svg');
    git(root, 'commit', '-qm', 'replace artwork');
    const head = git(root, 'rev-parse', 'HEAD');
    const blocked = run(root, ['--diff', base, head]);
    const output = `${blocked.stdout}\n${blocked.stderr}`;
    assert.notEqual(blocked.status, 0);
    assert.match(output, /binary-asset/);
    assert.match(output, /text-compatibility/);
  });
});

function configureSafeRemote(root) {
  git(root, 'remote', 'add', 'upstream', upstreamUrl);
  git(root, 'remote', 'set-url', '--push', 'upstream', 'disabled://fetch-only');
  git(root, 'config', '--replace-all', 'remote.upstream.fetch', upstreamFetch);
  git(root, 'config', 'remote.upstream.tagOpt', '--no-tags');
}

test('remote check requires the exact fetch-only main-branch configuration', () => {
  withRepo({}, (root) => {
    git(root, 'remote', 'add', 'upstream', upstreamUrl);
    const unsafe = run(root, ['--check-remote']);
    assert.notEqual(unsafe.status, 0);

    git(root, 'remote', 'set-url', '--push', 'upstream', 'disabled://fetch-only');
    git(root, 'config', '--replace-all', 'remote.upstream.fetch', upstreamFetch);
    git(root, 'config', 'remote.upstream.tagOpt', '--no-tags');
    const safe = run(root, ['--check-remote']);
    assert.equal(safe.status, 0, `${safe.stdout}\n${safe.stderr}`);
  });
});

test('remote check rejects wildcard fetches, tag downloads, mirrors, and extra URLs', () => {
  for (const mutate of [
    (root) => git(root, 'config', '--replace-all', 'remote.upstream.fetch', '+refs/heads/*:refs/remotes/upstream/*'),
    (root) => git(root, 'config', '--unset-all', 'remote.upstream.tagOpt'),
    (root) => git(root, 'config', 'remote.upstream.tagOpt', '--tags'),
    (root) => git(root, 'config', 'remote.upstream.mirror', 'true'),
    (root) => git(root, 'config', '--add', 'remote.upstream.url', 'https://example.invalid/extra.git'),
    (root) => git(root, 'config', '--add', 'remote.upstream.pushurl', 'https://example.invalid/push.git'),
  ]) {
    withRepo({}, (root) => {
      configureSafeRemote(root);
      mutate(root);
      const result = run(root, ['--check-remote']);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });
  }
});

test('public sync guide is operational and contains no incident narrative', () => {
  const guide = readFileSync(path.join(repoRoot, 'docs', 'UPSTREAM-SYNC.md'), 'utf8');
  assert.match(guide, /disabled:\/\/fetch-only/);
  assert.match(guide, /cherry-pick --no-commit/);
  assert.match(guide, /--staged/);
  assert.match(guide, /--check-remote/);
  assert.match(guide, /verify:upstream-import --staged/);
  assert.match(guide, /verify:upstream-import --range/);
  assert.match(guide, /verify:upstream-import --policy-range/);
  assert.match(guide, /base commit, upstream source commit, and imported-delta SHA-256/);
  assert.match(guide, /reads review records from the import base/);
  assert.match(guide, /Do not squash the import and final baseline commits/);
  assert.match(guide, /cannot delete or rewrite\s+GitHub-hosted pull-request refs/);
  assert.match(guide, /LICENSE/);
  assert.doesNotMatch(guide, /bitten us|previous sync|incident/i);

  const hygiene = readFileSync(path.join(repoRoot, 'scripts', 'check-docs-hygiene.sh'), 'utf8');
  assert.match(hygiene, /--defer-upstream-baseline/);
  assert.match(hygiene, /defer_upstream_baseline.*-eq 0/);
});

test('public hygiene CI evaluates the complete PR or push delta', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'public-hygiene.yml'), 'utf8');
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(workflow, /HEAD_SHA:.*github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /verify-upstream-import\.mjs --ci-range/);
  assert.match(workflow, /check-public-git-metadata\.mjs --root/);
  assert.match(workflow, /Initial root commit has no delta base; enforcing the exact full-tree baseline/);
});

test('trusted PR policy CI runs base code and treats pull request objects only as bounded data', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'upstream-policy.yml'), 'utf8');
  const privateJobMarker = '\n  private-publication:';
  const privateJobOffset = workflow.indexOf(privateJobMarker);
  assert.notEqual(privateJobOffset, -1, 'protected private-publication job must exist');
  const staticJob = workflow.slice(0, privateJobOffset);
  const privateJob = workflow.slice(privateJobOffset);
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /pull_request_target:\s*\n\s+branches:\s*\[main\]\s*\n\s+types:\s*\[opened, reopened, synchronize, edited, ready_for_review\]/);
  assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /--filter=blob:limit=16777217/);
  assert.match(workflow, /--depth=4098/);
  assert.match(workflow, /GIT_NO_LAZY_FETCH:\s*['"]?1['"]?/);
  assert.match(workflow, /merge-base --is-ancestor "\$BASE_SHA" "\$HEAD_SHA"/);
  assert.match(workflow, /rev-list --count --max-count=4097/);
  assert.match(workflow, /commit_count >= 1 && commit_count <= 4096/);
  assert.match(workflow, /refs\/pull\/\$\{PR_NUMBER\}\/head:refs\/remotes\/policy\/pr-head/);
  assert.match(workflow, /verify-upstream-import\.mjs --ci-range "\$BASE_SHA" "\$HEAD_SHA"/);
  assert.doesNotMatch(workflow, /(?:npm|yarn|pnpm)\s+(?:install|run|test)|actions\/cache|upload-artifact|download-artifact/);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.(?:head|merge_commit_sha)/);
  assert.doesNotMatch(staticJob, /secrets\.|GITHUB_TOKEN|github\.token/);
  assert.doesNotMatch(workflow, /GITHUB_TOKEN|github\.token|pull-requests:\s*write|contents:\s*write/);
  assert.match(privateJob, /environment:\s*private-publication-review/);
  assert.equal((privateJob.match(/secrets\.IDLE_PUBLICATION_POLICY_KEY/g) ?? []).length, 1);
  assert.doesNotMatch(privateJob, /secrets\.(?!IDLE_PUBLICATION_POLICY_KEY\b)/);
  const actions = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(actions.length > 0);
  for (const action of actions) assert.match(action, /@[a-f0-9]{40}$/);
});
