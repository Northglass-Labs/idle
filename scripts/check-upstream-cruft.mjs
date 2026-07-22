#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadPublicationPolicy } from './publication-policy.mjs';

const POLICY_FILE = '.upstream-cruft-allow.txt';
const REVIEW_FILE = '.upstream-import-review.txt';
const DISABLED_PUSH_URL = 'disabled://fetch-only';
const APPROVED_UPSTREAM_URL = `https://github.com/${['slo', 'pus'].join('')}/${['hap', 'py'].join('')}.git`;
const APPROVED_UPSTREAM_FETCH = '+refs/heads/main:refs/remotes/upstream/main';
const UPSTREAM_STORE_APP_ID_PATTERN = /6748(?:[^a-z0-9]{0,16})571505/i;
const UPSTREAM_STORE_SLUG_PATTERN = /idle(?:[^a-z0-9]{0,16})coder(?:[^a-z0-9]{0,16})app/i;
const MAX_CHANGED_FILES = 4096;
const MAX_CI_COMMITS = 4096;
const MAX_CHANGED_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_CHANGED_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_POLICY_TREE_BYTES = 256 * 1024 * 1024;
const MAX_POLICY_TREE_ENTRIES = 50_000;
const MAX_POLICY_APPROVAL_DEPTH = 32;

const POLICY_FILES = new Set([
  POLICY_FILE,
  REVIEW_FILE,
]);
const PROTECTED_IMPORT_FILES = new Set([
  'package.json',
  '.gitleaks.toml',
  '.gitleaksignore',
  '.github/CODEOWNERS',
  'docs/UPSTREAM-SYNC.md',
  'scripts/check-docs-hygiene.sh',
  'scripts/check-public-git-metadata.mjs',
  'scripts/check-public-git-metadata.test.mjs',
  'scripts/check-upstream-cruft.sh',
  'scripts/check-upstream-cruft.mjs',
  'scripts/check-upstream-cruft.test.mjs',
  'scripts/opsec-boundary.mjs',
  'scripts/opsec-boundary.test.mjs',
  'scripts/publication-policy.mjs',
  'scripts/publication-policy.encrypted.json',
  'scripts/publication-policy-keychain.swift',
  'scripts/publication-policy-boundary.test.mjs',
  'scripts/verify-upstream-import.mjs',
  'scripts/verify-upstream-import.test.mjs',
]);

const EXACT_SCAN_EXCLUSIONS = new Set([
  POLICY_FILE,
  REVIEW_FILE,
  'scripts/check-upstream-cruft.sh',
  'scripts/check-upstream-cruft.mjs',
  'scripts/check-upstream-cruft.test.mjs',
]);
const EXCLUDED_BASENAMES = new Set([
  'yarn.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'Cargo.lock',
]);
const ASSET_EXTENSIONS = new Set([
  '.aac',
  '.avif',
  '.gif',
  '.ico',
  '.icns',
  '.jpeg',
  '.jpg',
  '.lottie',
  '.m4a',
  '.mov',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.svg',
  '.ttf',
  '.wav',
  '.webp',
  '.webm',
  '.woff',
  '.woff2',
]);
const ASSET_DIRECTORY_PATTERN = /(?:^|\/)(?:animations?|artwork|assets?|branding|icons?|images?)(?:\/|$)/i;

const GENERIC_FORBIDDEN_FINGERPRINTS = new Set();
let forbiddenFingerprintPolicy;
let privateForbiddenFingerprintsAvailable = false;

function forbiddenFingerprints(required = false) {
  if (forbiddenFingerprintPolicy === undefined || (required && !privateForbiddenFingerprintsAvailable)) {
    const policy = loadPublicationPolicy({ required });
    forbiddenFingerprintPolicy = policy?.upstream.forbidden ?? GENERIC_FORBIDDEN_FINGERPRINTS;
    privateForbiddenFingerprintsAvailable = policy !== null;
  }
  return forbiddenFingerprintPolicy;
}

const BRAND_PATTERN = /happy|slopus|handy-server/gi;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi;
const SCANNER_SUPPRESSION_PATTERN = /\bgitleaks\s*:\s*allow\b/i;
const CONFIG_PATTERN = new RegExp([
  '(?:development_?team|teamidentifier|applicationidentifierprefix|',
  'product_bundle_identifier|bundleidentifier|applicationid|eas[._]?project_?id|',
  'project_?id|docker_?registry|container_?registry|server_?url|webapp_?url)',
].join(''), 'i');
const ALLOWED_EMAIL_DOMAINS = new Set([
  'northglass.io',
  'users.noreply.github.com',
]);
const REVIEWABLE_KINDS = new Set([
  'binary-asset',
  'config-addition',
  'filename-compatibility',
  'source-transformation',
  'text-compatibility',
]);
const diagnostics = { categoryCountsOnly: false };

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function git(root, args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding,
    maxBuffer: MAX_CHANGED_TOTAL_BYTES + (8 * 1024 * 1024),
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Git operation failed (${args[0] ?? 'unknown'})`);
  }
  return result;
}

function repositoryRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('upstream boundary check requires a Git worktree');
  }
  return result.stdout.trim();
}

function normalizeRepoPath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isUnsafeRepositoryPath(relativePath) {
  return (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    Buffer.byteLength(relativePath, 'utf8') > 1024 ||
    /[\u0000-\u001f\u007f]/.test(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split('/').includes('..')
  );
}

function isExcluded(relativePath) {
  return EXACT_SCAN_EXCLUSIONS.has(relativePath) || EXCLUDED_BASENAMES.has(path.posix.basename(relativePath));
}

function isProtectedImportPath(relativePath) {
  const scriptName = relativePath.startsWith('scripts/') ? path.posix.basename(relativePath) : '';
  return (
    POLICY_FILES.has(relativePath) ||
    PROTECTED_IMPORT_FILES.has(relativePath) ||
    (scriptName && (
      scriptName.startsWith('check-') ||
      scriptName.startsWith('verify-') ||
      scriptName.endsWith('-boundary.test.mjs')
    )) ||
    relativePath.startsWith('.github/workflows/') ||
    relativePath === 'AUTHORS' ||
    relativePath === 'LICENSE' ||
    relativePath.endsWith('/LICENSE')
  );
}

function countBranding(value) {
  BRAND_PATTERN.lastIndex = 0;
  let count = 0;
  while (BRAND_PATTERN.exec(value) !== null) {
    count += 1;
  }
  BRAND_PATTERN.lastIndex = 0;
  return count;
}

function decodeStaticStringLiteral(literal) {
  if (literal.length < 2 || !['"', "'"].includes(literal[0]) || literal.at(-1) !== literal[0]) {
    return null;
  }
  let decoded = '';
  for (let index = 1; index < literal.length - 1; index += 1) {
    const current = literal[index];
    if (current !== '\\') {
      decoded += current;
      continue;
    }

    index += 1;
    if (index >= literal.length - 1) return null;
    const escaped = literal[index];
    const simpleEscapes = {
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      0: '\0',
      '\\': '\\',
      "'": "'",
      '"': '"',
    };
    if (Object.hasOwn(simpleEscapes, escaped)) {
      decoded += simpleEscapes[escaped];
      continue;
    }
    if (escaped === '\n') continue;
    if (escaped === '\r') {
      if (literal[index + 1] === '\n') index += 1;
      continue;
    }
    if (escaped === 'x') {
      const hex = literal.slice(index + 1, index + 3);
      if (!/^[a-f0-9]{2}$/i.test(hex)) return null;
      decoded += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (escaped === 'u') {
      if (literal[index + 1] === '{') {
        const closing = literal.indexOf('}', index + 2);
        if (closing === -1) return null;
        const hex = literal.slice(index + 2, closing);
        if (!/^[a-f0-9]{1,6}$/i.test(hex)) return null;
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff) return null;
        decoded += String.fromCodePoint(codePoint);
        index = closing;
        continue;
      }
      const hex = literal.slice(index + 1, index + 5);
      if (!/^[a-f0-9]{4}$/i.test(hex)) return null;
      decoded += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    decoded += escaped;
  }
  return decoded;
}

function isSourceWhitespace(character) {
  return character === ' '
    || character === '\t'
    || character === '\n'
    || character === '\r'
    || character === '\f'
    || character === '\v';
}

function skipSourceWhitespace(value, cursor, limit) {
  while (cursor < limit && isSourceWhitespace(value[cursor])) cursor += 1;
  return cursor;
}

function staticStringLiteralAt(value, cursor, limit) {
  const quote = value[cursor];
  if (quote !== '"' && quote !== "'") return null;
  const start = cursor;
  cursor += 1;
  while (cursor < limit) {
    if (value[cursor] === quote) {
      return { end: cursor + 1, raw: value.slice(start, cursor + 1) };
    }
    if (value[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    cursor += 1;
  }
  return null;
}

function consumeSourceCall(value, cursor, limit, name) {
  if (!value.startsWith(name, cursor)) return null;
  cursor = skipSourceWhitespace(value, cursor + name.length, limit);
  if (value[cursor] !== '(') return null;
  cursor = skipSourceWhitespace(value, cursor + 1, limit);
  if (value[cursor] !== ')') return null;
  return cursor + 1;
}

function staticLiteralReconstructionAt(value, start) {
  const itemByteLimit = 16 * 1024;
  const limit = Math.min(value.length, start + itemByteLimit + 1024);
  const items = [];
  let cursor = start + 1;
  const itemsStart = cursor;

  while (cursor < limit) {
    cursor = skipSourceWhitespace(value, cursor, limit);
    if (value[cursor] === ']') break;
    const literal = staticStringLiteralAt(value, cursor, limit);
    if (!literal) return null;
    const decoded = decodeStaticStringLiteral(literal.raw);
    if (decoded === null) return null;
    items.push(decoded);
    if (items.length > 128) return null;
    cursor = skipSourceWhitespace(value, literal.end, limit);
    if (value[cursor] === ',') cursor += 1;
  }

  if (items.length === 0 || value[cursor] !== ']' || cursor - itemsStart > itemByteLimit) return null;
  cursor = skipSourceWhitespace(value, cursor + 1, limit);
  if (value[cursor] !== '.') return null;
  cursor = skipSourceWhitespace(value, cursor + 1, limit);

  let reverse = false;
  for (const method of ['toReversed', 'reverse']) {
    const afterCall = consumeSourceCall(value, cursor, limit, method);
    if (afterCall === null) continue;
    reverse = true;
    cursor = skipSourceWhitespace(value, afterCall, limit);
    if (value[cursor] !== '.') return null;
    cursor = skipSourceWhitespace(value, cursor + 1, limit);
    break;
  }

  if (!value.startsWith('join', cursor)) return null;
  cursor = skipSourceWhitespace(value, cursor + 4, limit);
  if (value[cursor] !== '(') return null;
  cursor = skipSourceWhitespace(value, cursor + 1, limit);
  const separatorLiteral = staticStringLiteralAt(value, cursor, limit);
  if (!separatorLiteral) return null;
  const separator = decodeStaticStringLiteral(separatorLiteral.raw);
  if (separator === null) return null;
  cursor = skipSourceWhitespace(value, separatorLiteral.end, limit);
  if (value[cursor] !== ')') return null;

  if (reverse) items.reverse();
  const reconstruction = items.join(separator);
  if (reconstruction.length > itemByteLimit) return null;
  return { end: cursor + 1, reconstruction };
}

function staticLiteralReconstructions(value) {
  const reconstructions = [];
  let cursor = 0;
  while (reconstructions.length < 256) {
    const start = value.indexOf('[', cursor);
    if (start === -1) break;
    const parsed = staticLiteralReconstructionAt(value, start);
    if (parsed) {
      reconstructions.push(parsed.reconstruction);
      cursor = parsed.end;
    } else {
      cursor = start + 1;
    }
  }
  return reconstructions;
}

function containsKnownUpstreamProduct(value) {
  for (const candidate of [value, ...staticLiteralReconstructions(value)]) {
    if (
      UPSTREAM_STORE_APP_ID_PATTERN.test(candidate) ||
      UPSTREAM_STORE_SLUG_PATTERN.test(candidate)
    ) {
      return true;
    }
  }
  return false;
}

function containsForbiddenFingerprint(value) {
  const words = value.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
  for (let index = 0; index < words.length; index += 1) {
    if (forbiddenFingerprints().has(digest(words[index]))) {
      return true;
    }
    if (index + 1 < words.length && forbiddenFingerprints().has(digest(`${words[index]} ${words[index + 1]}`))) {
      return true;
    }
  }
  return false;
}

function containsUnsafePolicyProse(value) {
  return (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    /https?:\/\//i.test(value) ||
    countBranding(value) > 0 ||
    containsKnownUpstreamProduct(value) ||
    containsForbiddenFingerprint(value) ||
    hasExternalIdentity(value)
  );
}

function readWorktreeFile(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  const metadata = lstatSync(absolutePath);
  if (metadata.isSymbolicLink()) {
    return Buffer.from(readlinkSync(absolutePath));
  }
  return readFileSync(absolutePath);
}

function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8192);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function listWorktreeFiles(root) {
  const result = git(root, ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: null });
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(normalizeRepoPath)
    .filter((relativePath) => !isExcluded(relativePath))
    .sort();
}

function observeCurrentBranding(root) {
  const observed = new Map();
  const hardBlocked = new Set();
  const productBlocked = new Set();
  for (const relativePath of listWorktreeFiles(root)) {
    let count = countBranding(relativePath);
    if (containsForbiddenFingerprint(relativePath)) hardBlocked.add(relativePath);
    if (containsKnownUpstreamProduct(relativePath)) productBlocked.add(relativePath);

    let contents;
    try {
      contents = readWorktreeFile(root, relativePath);
    } catch {
      continue;
    }
    if (!looksBinary(contents)) {
      const text = contents.toString('utf8');
      count += countBranding(text);
      if (containsForbiddenFingerprint(text)) hardBlocked.add(relativePath);
      if (containsKnownUpstreamProduct(text)) productBlocked.add(relativePath);
    }
    if (count > 0) observed.set(relativePath, count);
  }
  return { hardBlocked, observed, productBlocked };
}

function readPolicyFile(root, relativePath, ref = null) {
  if (ref) {
    const result = git(root, ['show', `${ref}:${relativePath}`], { allowFailure: true });
    return result.status === 0 ? result.stdout : null;
  }
  try {
    return readFileSync(path.join(root, relativePath), 'utf8');
  } catch {
    return null;
  }
}

function parseBaseline(root, { ref = null } = {}) {
  let text;
  text = readPolicyFile(root, POLICY_FILE, ref);
  if (typeof text !== 'string') {
    return { errors: [POLICY_FILE], rules: new Map() };
  }

  const errors = [];
  const rules = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (containsUnsafePolicyProse(line)) errors.push(POLICY_FILE);
      continue;
    }
    const fields = rawLine.split('\t');
    if (fields.length !== 2) {
      errors.push(POLICY_FILE);
      continue;
    }
    const relativePath = normalizeRepoPath(fields[0].trim());
    const count = Number(fields[1].trim());
    if (
      !relativePath ||
      isUnsafeRepositoryPath(relativePath) ||
      /[*?[\]]/.test(relativePath) ||
      containsForbiddenFingerprint(relativePath) ||
      hasExternalIdentity(relativePath) ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      rules.has(relativePath)
    ) {
      errors.push(POLICY_FILE);
      continue;
    }
    rules.set(relativePath, count);
  }
  return { errors, rules };
}

function printIssues(title, issues) {
  const unique = new Map();
  for (const issue of issues) {
    const key = `${issue.kind}\0${issue.path}\0${issue.fingerprint ?? ''}`;
    unique.set(key, issue);
  }
  if (unique.size === 0) return;
  console.error(title);
  if (diagnostics.categoryCountsOnly) {
    const counts = new Map();
    for (const issue of unique.values()) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
    for (const [kind, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
      console.error(`  [${kind}] ${count} affected file(s)`);
    }
    return;
  }
  const ordered = [...unique.values()].sort((left, right) => {
    return `${left.path}\0${left.kind}`.localeCompare(`${right.path}\0${right.kind}`);
  });
  const privateIdentityCount = ordered.filter(issue => issue.kind === 'known-upstream-identity').length;
  if (privateIdentityCount > 0) {
    console.error(`  [known-upstream-identity] ${privateIdentityCount} affected file(s)`);
  }
  for (const issue of ordered.filter(issue => issue.kind !== 'known-upstream-identity')) {
    const suffix = issue.fingerprint ? ` fingerprint ${issue.fingerprint}` : '';
    const unsafePath = (
      isUnsafeRepositoryPath(issue.path) ||
      hasExternalIdentity(issue.path) ||
      containsForbiddenFingerprint(issue.path)
    );
    const displayPath = unsafePath
      ? JSON.stringify('<redacted-path>')
      : JSON.stringify(issue.path);
    console.error(`  [${issue.kind}] ${displayPath}${suffix}`);
  }
}

function parseTreeEntries(root, ref) {
  const result = git(root, ['ls-tree', '-r', '-z', '-l', '--full-tree', ref], { encoding: null });
  const entries = [];
  for (const record of result.stdout.toString('utf8').split('\0').filter(Boolean)) {
    if (entries.length >= MAX_POLICY_TREE_ENTRIES) {
      throw new Error('upstream policy tree exceeds the entry-count limit');
    }
    const match = record.match(/^(\d{6}) ([a-z]+) ([a-f0-9]{40,64})\s+([0-9-]+)\t([\s\S]+)$/);
    if (!match) throw new Error('upstream policy tree contains an unsupported Git entry');
    const size = match[4] === '-' ? null : Number(match[4]);
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) {
      throw new Error('upstream policy tree contains an invalid Git object size');
    }
    entries.push({
      mode: match[1],
      type: match[2],
      oid: match[3],
      size,
      path: normalizeRepoPath(match[5]),
    });
  }
  return entries;
}

function observeTreeBranding(root, ref) {
  const observed = new Map();
  const hardBlocked = new Set();
  const productBlocked = new Set();
  const errors = [];
  let inspectedBytes = 0;
  for (const entry of parseTreeEntries(root, ref)) {
    if (isExcluded(entry.path)) continue;
    if (isUnsafeRepositoryPath(entry.path)) {
      errors.push(entry.path);
      continue;
    }
    let count = countBranding(entry.path);
    if (containsForbiddenFingerprint(entry.path)) hardBlocked.add(entry.path);
    if (containsKnownUpstreamProduct(entry.path)) productBlocked.add(entry.path);
    if (entry.type !== 'blob' || entry.size === null) {
      errors.push(entry.path);
      continue;
    }
    if (entry.size > MAX_CHANGED_BLOB_BYTES) {
      errors.push(entry.path);
      continue;
    }
    inspectedBytes += entry.size;
    if (inspectedBytes > MAX_POLICY_TREE_BYTES) {
      throw new Error('upstream policy tree exceeds the bounded inspection budget');
    }
    const contents = git(root, ['cat-file', 'blob', entry.oid], { encoding: null }).stdout;
    if (!looksBinary(contents)) {
      const text = contents.toString('utf8');
      count += countBranding(text);
      if (containsForbiddenFingerprint(text)) hardBlocked.add(entry.path);
      if (containsKnownUpstreamProduct(text)) productBlocked.add(entry.path);
    }
    if (count > 0) observed.set(entry.path, count);
  }
  return { errors, hardBlocked, observed, productBlocked };
}

function scanCurrent(root, { listOnly = false, ref = null } = {}) {
  const { errors: treeErrors = [], hardBlocked, observed, productBlocked } = ref
    ? observeTreeBranding(root, ref)
    : { errors: [], ...observeCurrentBranding(root) };
  if (listOnly) {
    for (const [relativePath, count] of observed) {
      console.log(`${relativePath}\t${count}`);
    }
    if (hardBlocked.size > 0) {
      console.log(`known-upstream-identity\t${hardBlocked.size} affected file(s)`);
    }
    if (productBlocked.size > 0) {
      console.log(`known-upstream-product\t${productBlocked.size} affected file(s)`);
    }
    return 0;
  }

  const baseline = parseBaseline(root, { ref });
  const issues = baseline.errors.map((relativePath) => ({ kind: 'invalid-policy', path: relativePath }));
  const reviews = parseReviews(root, ref ? { mode: 'commit', ref } : undefined);
  for (const relativePath of treeErrors) {
    issues.push({ kind: 'unsupported-policy-tree-entry', path: relativePath });
  }
  for (const relativePath of reviews.errors) {
    issues.push({ kind: 'invalid-review-policy', path: relativePath });
  }
  for (const relativePath of hardBlocked) {
    issues.push({ kind: 'known-upstream-identity', path: relativePath });
  }
  for (const relativePath of productBlocked) {
    issues.push({ kind: 'known-upstream-product', path: relativePath });
  }
  for (const [relativePath, count] of observed) {
    const expected = baseline.rules.get(relativePath);
    if (expected !== count) {
      issues.push({ kind: 'branding-baseline-drift', path: relativePath });
    }
  }
  for (const [relativePath, expected] of baseline.rules) {
    if (observed.get(relativePath) !== expected) {
      issues.push({ kind: 'branding-baseline-drift', path: relativePath });
    }
  }

  if (issues.length > 0) {
    printIssues('Upstream boundary check failed (paths only; source text suppressed):', issues);
    return 1;
  }
  console.log('upstream compatibility references match the exact reviewed baseline');
  return 0;
}

function parseReviews(root, { mode = 'worktree', ref = null } = {}) {
  let text;
  if (mode === 'worktree') {
    try {
      text = readFileSync(path.join(root, REVIEW_FILE), 'utf8');
    } catch {
      return { errors: [REVIEW_FILE], records: [] };
    }
  } else {
    const object = `${ref}:${REVIEW_FILE}`;
    const result = git(root, ['show', object], { allowFailure: true });
    if (result.status !== 0) {
      return { errors: [REVIEW_FILE], records: [] };
    }
    text = result.stdout;
  }
  if (typeof text !== 'string') {
    return { errors: [REVIEW_FILE], records: [] };
  }

  const errors = [];
  const records = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (containsUnsafePolicyProse(line)) errors.push(REVIEW_FILE);
      continue;
    }
    const fields = rawLine.split('\t');
    if (fields.length !== 7) {
      errors.push(REVIEW_FILE);
      continue;
    }
    const [kind, rawPath, fingerprint, baseSha, sourceSha, importSha, reason] = fields;
    const relativePath = normalizeRepoPath(rawPath.trim());
    if (
      !REVIEWABLE_KINDS.has(kind) ||
      !relativePath ||
      isUnsafeRepositoryPath(relativePath) ||
      /[*?[\]]/.test(relativePath) ||
      containsForbiddenFingerprint(relativePath) ||
      hasExternalIdentity(relativePath) ||
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !/^[a-f0-9]{40,64}$/.test(baseSha) ||
      !/^[a-f0-9]{40,64}$/.test(sourceSha) ||
      !/^[a-f0-9]{64}$/.test(importSha) ||
      reason.trim().length < 8 ||
      reason.trim().length > 160 ||
      containsUnsafePolicyProse(reason)
    ) {
      errors.push(REVIEW_FILE);
      continue;
    }
    records.push({ baseSha, fingerprint, importSha, kind, path: relativePath, sourceSha });
  }
  return { errors, records };
}

function reviewFingerprint(kind, relativePath, targetContext, value, context) {
  const hash = createHash('sha256');
  hash.update(context.baseSha);
  hash.update('\0');
  hash.update(context.sourceSha);
  hash.update('\0');
  hash.update(context.importSha);
  hash.update('\0');
  hash.update(kind);
  hash.update('\0');
  hash.update(relativePath);
  hash.update('\0');
  hash.update(digest(targetContext));
  hash.update('\0');
  hash.update(value);
  return hash.digest('hex');
}

function resolveCommit(root, value) {
  const result = git(root, ['rev-parse', '--verify', `${value}^{commit}`], { allowFailure: true });
  if (result.status !== 0 || !/^[a-f0-9]{40,64}\n?$/.test(result.stdout)) {
    throw new Error('upstream import review requires a locally available source commit');
  }
  return result.stdout.trim();
}

function approvalAnchor(root, baseCommit) {
  let anchor = baseCommit;
  for (let depth = 0; depth < MAX_POLICY_APPROVAL_DEPTH; depth += 1) {
    const parent = git(root, ['rev-parse', '--verify', `${anchor}^1`], { allowFailure: true });
    if (parent.status !== 0) return anchor;
    const parentSha = parent.stdout.trim();
    const delta = git(root, ['diff', '--name-status', '-z', '--find-renames', parentSha, anchor], { encoding: null });
    const changes = parseNameStatus(delta.stdout);
    if (
      changes.length !== 1 ||
      changes[0].path !== REVIEW_FILE ||
      (changes[0].oldPath && changes[0].oldPath !== REVIEW_FILE)
    ) {
      return anchor;
    }
    anchor = parentSha;
  }
  throw new Error('upstream review policy chain exceeds the supported approval depth');
}

function importDeltaSha(root, mode, base, head) {
  return digest(importDeltaBytes(root, mode, base, head));
}

function importDeltaBytes(root, mode, base, head) {
  const args = diffArguments(mode, base, head, [
    '--binary',
    '--full-index',
    '--no-color',
    '--no-ext-diff',
    '--',
    '.',
    `:(exclude)${POLICY_FILE}`,
    `:(exclude)${REVIEW_FILE}`,
  ]);
  const result = git(root, args, { encoding: null });
  return result.stdout;
}

function sourceDeltaBytes(root, source) {
  const sourceCommit = resolveCommit(root, source);
  const lineage = git(root, ['rev-list', '--parents', '--max-count=1', sourceCommit])
    .stdout
    .trim()
    .split(/\s+/);
  if (lineage.length !== 2) {
    throw new Error('upstream provenance requires a single-parent source commit');
  }
  const result = git(root, [
    'diff',
    lineage[1],
    sourceCommit,
    '--binary',
    '--full-index',
    '--no-color',
    '--no-ext-diff',
    '--',
    '.',
    `:(exclude)${POLICY_FILE}`,
    `:(exclude)${REVIEW_FILE}`,
  ], { encoding: null });
  return result.stdout;
}

function scanSourceProvenance(root, { base, head, mode, source }) {
  const importBaseCommit = resolveCommit(root, mode === 'staged' ? 'HEAD' : base);
  const sourceSha = resolveCommit(root, source);
  const context = {
    baseSha: approvalAnchor(root, importBaseCommit),
    importSha: importDeltaSha(root, mode, base, head),
    sourceSha,
  };
  const sourcePatch = sourceDeltaBytes(root, sourceSha);
  const importPatch = importDeltaBytes(root, mode, base, head);
  if (sourcePatch.equals(importPatch)) {
    console.log('upstream import delta exactly matches the claimed source patch');
    return 0;
  }

  const reviews = parseReviews(root, { mode: 'commit', ref: importBaseCommit });
  const issues = reviews.errors.map((relativePath) => ({
    kind: 'invalid-review-policy',
    path: relativePath,
  }));
  const decision = reviewDecision(reviews, {
    kind: 'source-transformation',
    path: '.',
    targetContext: importPatch,
    value: sourcePatch,
  }, context);
  if (!decision.approved) {
    issues.push({
      kind: 'source-transformation',
      path: '.',
      fingerprint: decision.fingerprint,
    });
  }

  if (issues.length > 0) {
    printIssues(
      'Upstream source and imported delta require an exact independent transformation review:',
      issues,
    );
    console.error(`review context base ${context.baseSha} source ${context.sourceSha} import ${context.importSha}`);
    return 1;
  }

  console.log('upstream source transformation matches an exact independent review');
  return 0;
}

function reviewDecision(reviews, issue, context) {
  const candidates = context.sourceSha
    ? [context.sourceSha]
    : reviews.records
      .filter((record) =>
        record.kind === issue.kind &&
        record.path === issue.path &&
        record.baseSha === context.baseSha &&
        record.importSha === context.importSha)
      .map((record) => record.sourceSha);

  for (const sourceSha of new Set(candidates)) {
    const boundContext = { ...context, sourceSha };
    const fingerprint = reviewFingerprint(
      issue.kind,
      issue.path,
      issue.targetContext,
      issue.value,
      boundContext,
    );
    const approved = reviews.records.some((record) =>
      record.kind === issue.kind &&
      record.path === issue.path &&
      record.fingerprint === fingerprint &&
      record.baseSha === context.baseSha &&
      record.sourceSha === sourceSha &&
      record.importSha === context.importSha);
    if (approved) return { approved: true, fingerprint };
  }

  const fingerprint = context.sourceSha
    ? reviewFingerprint(issue.kind, issue.path, issue.targetContext, issue.value, context)
    : undefined;
  return { approved: false, fingerprint };
}

function parseNameStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0').filter(Boolean);
  const changes = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (/^[RC]/.test(status)) {
      changes.push({
        oldPath: normalizeRepoPath(fields[index + 1]),
        path: normalizeRepoPath(fields[index + 2]),
        status,
      });
      index += 2;
    } else {
      changes.push({ path: normalizeRepoPath(fields[index + 1]), status });
      index += 1;
    }
  }
  return changes;
}

function diffArguments(mode, base, head, suffix) {
  if (mode === 'staged') return ['diff', '--cached', ...suffix];
  return ['diff', base, head, ...suffix];
}

function targetBytes(root, mode, head, relativePath) {
  let oid;
  if (mode === 'staged') {
    const index = git(root, ['ls-files', '--stage', '-z', '--', `:(literal)${relativePath}`], { encoding: null });
    const records = index.stdout.toString('utf8').split('\0').filter(Boolean);
    const match = records.length === 1
      ? records[0].match(/^(\d{6}) ([a-f0-9]{40,64}) 0\t[\s\S]+$/)
      : null;
    if (!match || match[1] === '160000') {
      throw new Error('upstream import contains an unreadable or unsupported staged object');
    }
    oid = match[2];
  } else {
    const records = parseTreeEntriesForPath(root, head, relativePath);
    if (records.length !== 1 || records[0].type !== 'blob' || records[0].mode === '160000') {
      throw new Error('upstream import contains an unreadable or unsupported committed object');
    }
    oid = records[0].oid;
  }
  const sizeResult = git(root, ['cat-file', '-s', oid], { allowFailure: true });
  const size = Number(sizeResult.stdout.trim());
  if (sizeResult.status !== 0 || !Number.isSafeInteger(size) || size < 0) {
    throw new Error('upstream import contains an unreadable or unsupported Git object');
  }
  if (size > MAX_CHANGED_BLOB_BYTES) {
    throw new Error('upstream import contains a changed file larger than the review limit');
  }
  return git(root, ['cat-file', 'blob', oid], { encoding: null }).stdout;
}

function parseTreeEntriesForPath(root, ref, relativePath) {
  const result = git(
    root,
    ['ls-tree', '-z', '-l', '--full-tree', ref, '--', `:(literal)${relativePath}`],
    { encoding: null },
  );
  const entries = [];
  for (const record of result.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^(\d{6}) ([a-z]+) ([a-f0-9]{40,64})\s+([0-9-]+)\t([\s\S]+)$/);
    if (!match) continue;
    entries.push({ mode: match[1], type: match[2], oid: match[3], path: normalizeRepoPath(match[5]) });
  }
  return entries;
}

function requiresAssetReview(relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return ASSET_EXTENSIONS.has(extension) || (extension === '.json' && ASSET_DIRECTORY_PATTERN.test(relativePath));
}

function gitReportsBinaryChange(root, mode, base, head, relativePath) {
  const result = git(root, diffArguments(mode, base, head, ['--numstat', '--', `:(literal)${relativePath}`]));
  return result.stdout.split(/\r?\n/).some((line) => line.startsWith('-\t-\t'));
}

function addedLines(root, mode, base, head, relativePath) {
  const result = git(root, diffArguments(mode, base, head, [
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--',
    `:(literal)${relativePath}`,
  ]));
  const lines = [];
  let inHunk = false;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (inHunk && line.startsWith('+')) lines.push(line.slice(1));
  }
  return lines;
}

function hasExternalIdentity(line) {
  EMAIL_PATTERN.lastIndex = 0;
  let match;
  while ((match = EMAIL_PATTERN.exec(line)) !== null) {
    if (!ALLOWED_EMAIL_DOMAINS.has(match[1].toLowerCase())) {
      EMAIL_PATTERN.lastIndex = 0;
      return true;
    }
  }
  EMAIL_PATTERN.lastIndex = 0;
  return false;
}

function classifyAddedLine(line) {
  const classifications = [];
  if (SCANNER_SUPPRESSION_PATTERN.test(line)) {
    classifications.push({ kind: 'scanner-suppression-directive', reviewable: false });
  }
  if (containsForbiddenFingerprint(line)) {
    classifications.push({ kind: 'known-upstream-identity', reviewable: false });
  }
  if (containsKnownUpstreamProduct(line)) {
    classifications.push({ kind: 'known-upstream-product', reviewable: false });
  }
  if (hasExternalIdentity(line)) {
    classifications.push({ kind: 'external-identity', reviewable: false });
  }
  if (countBranding(line) > 0) {
    classifications.push({ kind: 'text-compatibility', reviewable: true });
  }
  if (CONFIG_PATTERN.test(line)) {
    classifications.push({ kind: 'config-addition', reviewable: true });
  }
  return classifications;
}

function scanDelta(root, { base, head, mode, source = null, allowFinalBaseline = false }) {
  if (mode === 'staged') git(root, ['rev-parse', 'HEAD']);
  else git(root, ['rev-parse', base]);
  if (mode !== 'staged') git(root, ['rev-parse', head]);

  const importBaseCommit = resolveCommit(root, mode === 'staged' ? 'HEAD' : base);
  const context = {
    baseSha: approvalAnchor(root, importBaseCommit),
    importSha: importDeltaSha(root, mode, base, head),
    sourceSha: source ? resolveCommit(root, source) : null,
  };

  const reviews = parseReviews(root, { mode: 'commit', ref: importBaseCommit });
  const issues = reviews.errors.map((relativePath) => ({ kind: 'invalid-review-policy', path: relativePath }));
  const nameStatus = git(
    root,
    diffArguments(mode, base, head, ['--name-status', '-z', '--find-renames']),
    { encoding: null },
  );
  const changes = parseNameStatus(nameStatus.stdout);
  const finalBaselineUpdate = allowFinalBaseline && mode !== 'staged'
    ? isIsolatedFinalBaselineUpdate(root, importBaseCommit, resolveCommit(root, head), changes)
    : false;
  if (changes.length > MAX_CHANGED_FILES) {
    printIssues('Upstream import exceeds the bounded review surface:', [{ kind: 'too-many-changed-files', path: '.' }]);
    return 1;
  }

  let reviewedBytes = 0;

  for (const change of changes) {
    if (changedPaths(change).some(isUnsafeRepositoryPath)) {
      issues.push({ kind: 'unsafe-repository-path', path: change.path });
      continue;
    }
    if (
      finalBaselineUpdate &&
      change.path === POLICY_FILE &&
      (!change.oldPath || change.oldPath === POLICY_FILE)
    ) {
      continue;
    }
    if (
      isProtectedImportPath(change.path) ||
      (change.oldPath && isProtectedImportPath(change.oldPath))
    ) {
      issues.push({ kind: 'protected-import-control', path: change.path });
      continue;
    }
    if (change.status.startsWith('D') || isExcluded(change.path)) continue;
    const contents = targetBytes(root, mode, head, change.path);
    reviewedBytes += contents.length;
    if (reviewedBytes > MAX_CHANGED_TOTAL_BYTES) {
      issues.push({ kind: 'changed-content-budget', path: change.path });
      break;
    }

    if (/^[ACR]/.test(change.status)) {
      let filenameKind = null;
      if (containsForbiddenFingerprint(change.path)) {
        filenameKind = { kind: 'known-upstream-identity', reviewable: false };
      } else if (containsKnownUpstreamProduct(change.path)) {
        filenameKind = { kind: 'known-upstream-product', reviewable: false };
      } else if (hasExternalIdentity(change.path)) {
        filenameKind = { kind: 'external-identity', reviewable: false };
      } else if (countBranding(change.path) > 0) {
        filenameKind = { kind: 'filename-compatibility', reviewable: true };
      }
      if (filenameKind) {
        if (!filenameKind.reviewable) {
          issues.push({ kind: filenameKind.kind, path: change.path });
        } else {
          const decision = reviewDecision(reviews, {
            kind: filenameKind.kind,
            path: change.path,
            targetContext: contents,
            value: Buffer.from(change.path),
          }, context);
          if (!decision.approved) {
            issues.push({ kind: filenameKind.kind, path: change.path, fingerprint: decision.fingerprint });
          }
        }
      }
    }

    const gitBinary = gitReportsBinaryChange(root, mode, base, head, change.path);
    if (requiresAssetReview(change.path) || gitBinary) {
      const decision = reviewDecision(reviews, {
        kind: 'binary-asset',
        path: change.path,
        targetContext: contents,
        value: contents,
      }, context);
      if (!decision.approved) {
        issues.push({ kind: 'binary-asset', path: change.path, fingerprint: decision.fingerprint });
      }
    }
    if (gitBinary) continue;

    for (const line of addedLines(root, mode, base, head, change.path)) {
      for (const classification of classifyAddedLine(line)) {
        if (!classification.reviewable) {
          issues.push({ kind: classification.kind, path: change.path });
        } else {
          const decision = reviewDecision(reviews, {
            kind: classification.kind,
            path: change.path,
            targetContext: contents,
            value: Buffer.from(line),
          }, context);
          if (!decision.approved) {
            issues.push({ kind: classification.kind, path: change.path, fingerprint: decision.fingerprint });
          }
        }
      }
    }
  }

  if (issues.length > 0) {
    printIssues('Upstream import requires cleanup or exact review (paths only; source text suppressed):', issues);
    if (context.sourceSha) {
      console.error(`review context base ${context.baseSha} source ${context.sourceSha} import ${context.importSha}`);
    } else if (issues.some((issue) => REVIEWABLE_KINDS.has(issue.kind))) {
      console.error('rerun with an exact source commit to generate bound review fingerprints');
    }
    return 1;
  }
  if (finalBaselineUpdate && scanCurrent(root, { ref: resolveCommit(root, head) }) !== 0) {
    return 1;
  }
  console.log('upstream import delta contains no unreviewed identity, branding, config, or binary changes');
  return 0;
}

function changedPaths(change) {
  return change.oldPath ? [change.oldPath, change.path] : [change.path];
}

function reviewRecordKey(record) {
  return [
    record.kind,
    record.path,
    record.fingerprint,
    record.baseSha,
    record.sourceSha,
    record.importSha,
  ].join('\0');
}

function rangeChanges(root, base, head) {
  const result = git(root, ['diff', '--name-status', '-z', '--find-renames', base, head], { encoding: null });
  return parseNameStatus(result.stdout);
}

function isIsolatedFinalBaselineUpdate(root, base, head, changes) {
  const hasBaselineChange = changes.some((change) => changedPaths(change).includes(POLICY_FILE));
  if (!hasBaselineChange) return false;
  for (const change of changes) {
    for (const relativePath of changedPaths(change)) {
      if (isProtectedImportPath(relativePath) && relativePath !== POLICY_FILE) return false;
    }
  }

  const parentResult = git(root, ['rev-parse', '--verify', `${head}^1`], { allowFailure: true });
  if (parentResult.status !== 0) return false;
  const parent = parentResult.stdout.trim();
  const finalChanges = rangeChanges(root, parent, head);
  if (
    finalChanges.length !== 1 ||
    finalChanges[0].path !== POLICY_FILE ||
    (finalChanges[0].oldPath && finalChanges[0].oldPath !== POLICY_FILE)
  ) {
    return false;
  }
  const earlierChanges = rangeChanges(root, base, parent);
  if (earlierChanges.some((change) => changedPaths(change).some(isProtectedImportPath))) return false;

  const reviewDelta = git(root, ['diff', '--quiet', base, head, '--', REVIEW_FILE], { allowFailure: true });
  return reviewDelta.status === 0;
}

function scanPolicyDelta(root, base, head) {
  const baseCommit = resolveCommit(root, base);
  const headCommit = resolveCommit(root, head);
  const changes = rangeChanges(root, baseCommit, headCommit);
  const issues = [];

  if (changes.length === 0) {
    issues.push({ kind: 'empty-policy-update', path: '.' });
  }
  for (const change of changes) {
    for (const relativePath of changedPaths(change)) {
      if (!POLICY_FILES.has(relativePath)) {
        issues.push({ kind: 'mixed-policy-update', path: relativePath });
      }
    }
  }

  const baseReviews = parseReviews(root, { mode: 'commit', ref: baseCommit });
  const targetReviews = parseReviews(root, { mode: 'commit', ref: headCommit });
  for (const relativePath of targetReviews.errors) {
    issues.push({ kind: 'invalid-review-policy', path: relativePath });
  }
  if (baseReviews.errors.length === 0 && targetReviews.errors.length === 0) {
    const existing = new Set(baseReviews.records.map(reviewRecordKey));
    const expectedBase = approvalAnchor(root, baseCommit);
    for (const record of targetReviews.records) {
      if (!existing.has(reviewRecordKey(record)) && record.baseSha !== expectedBase) {
        issues.push({ kind: 'unbound-policy-approval', path: REVIEW_FILE });
      }
    }
  }

  const baseline = parseBaseline(root, { ref: headCommit });
  for (const relativePath of baseline.errors) {
    issues.push({ kind: 'invalid-policy', path: relativePath });
  }

  if (issues.length > 0) {
    printIssues('Upstream policy updates must be isolated and base-bound:', issues);
    return 1;
  }
  if (scanCurrent(root, { ref: headCommit }) !== 0) return 1;
  console.log('dedicated upstream policy update is isolated, exact, and base-bound');
  return 0;
}

function scanCiDelta(root, base, head) {
  const baseCommit = resolveCommit(root, base);
  const headCommit = resolveCommit(root, head);
  const ancestry = git(root, ['merge-base', '--is-ancestor', baseCommit, headCommit], { allowFailure: true });
  if (ancestry.status !== 0) {
    printIssues('Trusted CI cannot prove complete pull-request history:', [
      { kind: 'incomplete-commit-range', path: '.git' },
    ]);
    return 1;
  }
  const countResult = git(
    root,
    ['rev-list', '--count', `--max-count=${MAX_CI_COMMITS + 1}`, `${baseCommit}..${headCommit}`],
    { allowFailure: true },
  );
  const commitCount = Number(countResult.stdout.trim());
  if (
    countResult.status !== 0 ||
    !Number.isSafeInteger(commitCount) ||
    commitCount < 1 ||
    commitCount > MAX_CI_COMMITS
  ) {
    printIssues('Trusted CI pull-request history exceeds the review boundary:', [
      { kind: 'commit-count-limit', path: '.git' },
    ]);
    return 1;
  }
  const changes = rangeChanges(root, baseCommit, headCommit);
  if (
    changes.length > 0 &&
    changes.every((change) => changedPaths(change).every((relativePath) => POLICY_FILES.has(relativePath)))
  ) {
    return scanPolicyDelta(root, baseCommit, headCommit);
  }
  return scanDelta(root, {
    base: baseCommit,
    head: headCommit,
    mode: 'commits',
    allowFinalBaseline: true,
  });
}

function checkRemote(root) {
  const fetchResult = git(root, ['config', '--get-all', 'remote.upstream.url'], { allowFailure: true });
  const pushResult = git(root, ['config', '--get-all', 'remote.upstream.pushurl'], { allowFailure: true });
  const refspecResult = git(root, ['config', '--get-all', 'remote.upstream.fetch'], { allowFailure: true });
  const tagResult = git(root, ['config', '--get-all', 'remote.upstream.tagOpt'], { allowFailure: true });
  const mirrorResult = git(root, ['config', '--get-all', 'remote.upstream.mirror'], { allowFailure: true });
  const resolvedFetchResult = git(root, ['remote', 'get-url', '--all', 'upstream'], { allowFailure: true });
  const resolvedPushResult = git(root, ['remote', 'get-url', '--push', '--all', 'upstream'], { allowFailure: true });
  const values = (result) => result.status === 0 ? result.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  const fetchUrls = fetchResult.status === 0 ? fetchResult.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  const pushUrls = pushResult.status === 0 ? pushResult.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  if (
    fetchUrls.length !== 1 ||
    fetchUrls[0] !== APPROVED_UPSTREAM_URL ||
    pushUrls.length !== 1 ||
    pushUrls[0] !== DISABLED_PUSH_URL ||
    values(refspecResult).length !== 1 ||
    values(refspecResult)[0] !== APPROVED_UPSTREAM_FETCH ||
    values(tagResult).length !== 1 ||
    values(tagResult)[0] !== '--no-tags' ||
    values(mirrorResult).length !== 0 ||
    values(resolvedFetchResult).length !== 1 ||
    values(resolvedFetchResult)[0] !== APPROVED_UPSTREAM_URL ||
    values(resolvedPushResult).length !== 1 ||
    values(resolvedPushResult)[0] !== DISABLED_PUSH_URL
  ) {
    printIssues('Upstream remote is not fetch-only:', [{ kind: 'unsafe-remote', path: '.git/config' }]);
    return 1;
  }
  console.log('upstream remote is pinned to the reviewed main-only fetch URL with tags and pushing disabled');
  return 0;
}

function usage() {
  console.error('usage: check-upstream-cruft.mjs [--require-private-policy] [--list | --tree <commit> | --staged [source] | --provenance-staged <source> | --diff <base> <head> [--source <source>] | --provenance-diff <base> <source> <head> | --policy-diff <base> <head> | --ci-diff <base> <head> | --check-remote]');
  return 2;
}

function main() {
  const root = repositoryRoot();
  const args = process.argv.slice(2);
  const requiresPrivatePolicy = args[0] === '--require-private-policy';
  if (requiresPrivatePolicy) args.shift();
  diagnostics.categoryCountsOnly = requiresPrivatePolicy;
  if (
    requiresPrivatePolicy &&
    !(args.length === 0 || (args.length === 2 && args[0] === '--tree'))
  ) {
    return usage();
  }
  forbiddenFingerprints(requiresPrivatePolicy);
  if (args.length === 0) return scanCurrent(root);
  if (args.length === 1 && args[0] === '--list') return scanCurrent(root, { listOnly: true });
  if (args.length === 2 && args[0] === '--tree') {
    return scanCurrent(root, { ref: resolveCommit(root, args[1]) });
  }
  if (args.length === 1 && args[0] === '--staged') return scanDelta(root, { base: 'HEAD', head: null, mode: 'staged' });
  if (args.length === 2 && args[0] === '--staged') {
    return scanDelta(root, { base: 'HEAD', head: null, mode: 'staged', source: args[1] });
  }
  if (args.length === 2 && args[0] === '--provenance-staged') {
    return scanSourceProvenance(root, {
      base: 'HEAD',
      head: null,
      mode: 'staged',
      source: args[1],
    });
  }
  if (args.length === 1 && args[0] === '--check-remote') return checkRemote(root);
  if (args.length === 3 && args[0] === '--diff') {
    return scanDelta(root, { base: args[1], head: args[2], mode: 'commits' });
  }
  if (args.length === 3 && args[0] === '--policy-diff') {
    return scanPolicyDelta(root, args[1], args[2]);
  }
  if (args.length === 3 && args[0] === '--ci-diff') {
    return scanCiDelta(root, args[1], args[2]);
  }
  if (args.length === 5 && args[0] === '--diff' && args[3] === '--source') {
    return scanDelta(root, {
      base: args[1],
      head: args[2],
      mode: 'commits',
      source: args[4],
      allowFinalBaseline: true,
    });
  }
  if (args.length === 4 && args[0] === '--provenance-diff') {
    return scanSourceProvenance(root, {
      base: args[1],
      source: args[2],
      head: args[3],
      mode: 'commits',
    });
  }
  return usage();
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'upstream boundary check failed unexpectedly');
  process.exitCode = 2;
}
