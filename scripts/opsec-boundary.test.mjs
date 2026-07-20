import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as opsecBoundary from './opsec-boundary.mjs';
import { scanGitTree, scanRepository, scanText } from './opsec-boundary.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function put(root, relativePath, contents) {
  const destination = path.join(root, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

test('opaque identity fingerprints detect words and phrases without echoing source text', () => {
  const findings = scanText(
    'This references Private Identity and privateidentity in a fixture.',
    'fixture.txt',
    {
      normalized: new Set([digest('private identity'), digest('privateidentity')]),
      caseSensitive: new Set(),
    },
  );

  assert.deepEqual(findings.map(finding => finding.kind), ['prohibited-identity']);
  assert.deepEqual(findings.map(finding => finding.path), ['fixture.txt']);
  assert.equal(JSON.stringify(findings).includes('Private Identity'), false);
});

test('generic high-confidence personal data patterns are rejected by path only', () => {
  const content = [
    `Contact ${['sample.user', 'gmail.com'].join('@')}.`,
    `Mail: ${['123', 'Example', 'Street'].join(' ')}, Exampleville.`,
    `Phone: ${['(212)', '555', '0199'].join(' ')}.`,
    `Identifier: ${['123', '45', '6789'].join('-')}.`,
  ].join('\n');
  const findings = scanText(content, 'profile.md', {
    normalized: new Set(),
    caseSensitive: new Set(),
  });

  assert.deepEqual(
    findings.map(finding => finding.kind).sort(),
    ['gmail-address', 'postal-address', 'social-security-number', 'us-phone-number'],
  );
  assert.ok(findings.every(finding => Object.keys(finding).join(',') === 'kind,path'));
});

test('printable strings inside binary files receive the same OPSEC inspection', () => {
  assert.equal(typeof opsecBoundary.scanFileContents, 'function');

  const privateIdentity = 'Private Binary Identity';
  const contents = Buffer.concat([
    Buffer.from([0x00, 0xff, 0x01]),
    Buffer.from(`/Users/${privateIdentity.replaceAll(' ', '')}/artifact`, 'ascii'),
    Buffer.from([0x00, 0xfe]),
    Buffer.from(`contact=${['binary.fixture', 'gmail.com'].join('@')}`, 'ascii'),
    Buffer.from([0x00]),
  ]);
  const findings = opsecBoundary.scanFileContents(contents, 'fixture.bin', {
    normalized: new Set([digest(privateIdentity), digest(privateIdentity.replaceAll(' ', '').toLowerCase())]),
    caseSensitive: new Set(),
  });

  assert.deepEqual(
    findings.map(finding => finding.kind).sort(),
    ['gmail-address', 'prohibited-identity'],
  );
  assert.ok(findings.every(finding => Object.keys(finding).join(',') === 'kind,path'));
  assert.equal(JSON.stringify(findings).includes(privateIdentity), false);
});

test('opaque archives fail closed without unpacking member data', () => {
  assert.equal(typeof opsecBoundary.scanFileContents, 'function');

  const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  const magicFinding = opsecBoundary.scanFileContents(zipHeader, 'fixture.bin', {
    normalized: new Set(),
    caseSensitive: new Set(),
  });
  const extensionFinding = opsecBoundary.scanFileContents(Buffer.from('not an archive'), 'fixture.tgz', {
    normalized: new Set(),
    caseSensitive: new Set(),
  });

  assert.deepEqual(magicFinding, [{ kind: 'opaque-container', path: 'fixture.bin' }]);
  assert.deepEqual(extensionFinding, [{ kind: 'opaque-container', path: 'fixture.tgz' }]);
});

test('renamed disk-image containers fail closed by trailer magic', () => {
  const diskImage = Buffer.alloc(1024);
  diskImage.write('koly', diskImage.length - 512, 'ascii');

  assert.deepEqual(
    opsecBoundary.scanFileContents(diskImage, 'renamed-container.bin', {
      normalized: new Set(),
      caseSensitive: new Set(),
    }),
    [{ kind: 'opaque-container', path: 'renamed-container.bin' }],
  );
});

test('required native and media binary formats remain eligible for printable-string inspection', () => {
  assert.equal(typeof opsecBoundary.scanFileContents, 'function');

  const eligibleHeaders = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]),
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x01]),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
  ];

  for (const [index, header] of eligibleHeaders.entries()) {
    assert.deepEqual(
      opsecBoundary.scanFileContents(header, `eligible-${index}.bin`, {
        normalized: new Set(),
        caseSensitive: new Set(),
      }),
      [],
    );
  }
});

test('pathological printable runs fail closed within a bounded scan', () => {
  const contents = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.alloc(1024 * 1024, 0x41),
    Buffer.from([0x00]),
  ]);

  assert.deepEqual(
    opsecBoundary.scanFileContents(contents, 'oversized-run.bin', {
      normalized: new Set(),
      caseSensitive: new Set(),
    }),
    [{ kind: 'oversized-printable-string', path: 'oversized-run.bin' }],
  );
});

test('failure summaries never echo a sensitive path or matched content', () => {
  assert.equal(typeof opsecBoundary.summarizeFindings, 'function');

  const sensitivePath = ['Users', 'PrivateBinaryIdentity', 'artifact.bin'].join('/');
  const summary = opsecBoundary.summarizeFindings([
    { kind: 'prohibited-identity', path: sensitivePath },
    { kind: 'gmail-address', path: sensitivePath },
  ]);

  assert.deepEqual(summary, [
    { count: 1, kind: 'gmail-address' },
    { count: 1, kind: 'prohibited-identity' },
  ]);
  assert.equal(JSON.stringify(summary).includes(sensitivePath), false);
  assert.equal(JSON.stringify(summary).includes('PrivateBinaryIdentity'), false);
});

test('publishable files that cannot be read fail closed', () => {
  const source = readFileSync(new URL('./opsec-boundary.mjs', import.meta.url), 'utf8');
  assert.match(source, /unreadable-publishable-file/);
  assert.doesNotMatch(source, /catch\s*\{\s*continue;\s*\}/);
});

test('Git-object tree scanning inspects blobs without checkout and rejects non-blob entries', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'idle-opsec-tree-'));
  const fingerprints = { normalized: new Set(), caseSensitive: new Set() };
  try {
    git(root, ['init', '-q']);
    const configuredEmail = spawnSync('git', ['config', '--get', 'user.email'], { encoding: 'utf8' });
    const authorEmail = configuredEmail.status === 0 && configuredEmail.stdout.trim()
      ? configuredEmail.stdout.trim()
      : 'idle-opsec@users.noreply.github.com';
    git(root, ['config', 'user.name', 'Idle OPSEC Test']);
    git(root, ['config', 'user.email', authorEmail]);
    put(root, 'README.md', 'safe fixture\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'safe tree']);
    const safe = git(root, ['rev-parse', 'HEAD']);
    assert.deepEqual(scanGitTree(root, safe, fingerprints), []);

    put(root, 'src/contact.txt', `contact=${['tree.fixture', 'gmail.com'].join('@')}\n`);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'pii tree']);
    const pii = git(root, ['rev-parse', 'HEAD']);
    assert.deepEqual(scanGitTree(root, pii, fingerprints), [
      { kind: 'gmail-address', path: 'src/contact.txt' },
    ]);

    git(root, ['update-index', '--add', '--cacheinfo', `160000,${pii},vendor/dependency`]);
    git(root, ['commit', '-qm', 'unsupported tree entry']);
    const unsupported = git(root, ['rev-parse', 'HEAD']);
    assert.throws(() => scanGitTree(root, unsupported, fingerprints), /could not inspect Git tree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the current publishable worktree has no prohibited OPSEC identity or PII finding', () => {
  assert.equal(scanRepository().length, 0);
});
