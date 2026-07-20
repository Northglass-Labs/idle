#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { scanText } from './opsec-boundary.mjs';

const CORPORATE_EMAIL = 'hello@northglass.io';
const CORPORATE_NAMES = new Set(['Northglass', 'Northglass Labs']);
const GITHUB_SERVICE_EMAIL = 'noreply@github.com';
const GITHUB_SERVICE_NAME = 'GitHub';
const NOREPLY_DOMAIN = 'users.noreply.github.com';
const UPSTREAM_BRAND_PATTERN = new RegExp([
  ['hap', 'py'].join(''),
  ['slo', 'pus'].join(''),
  ['han', 'dy-server'].join(''),
].join('|'), 'i');
const EMAIL_PATTERN = /[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

function git(args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, {
    encoding,
    maxBuffer: MAX_METADATA_BYTES,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Git metadata operation failed (${args[0] ?? 'unknown'})`);
  }
  return result;
}

function resolveCommit(value) {
  const result = git(['rev-parse', '--verify', `${value}^{commit}`], { allowFailure: true });
  if (result.status !== 0 || !/^[a-f0-9]{40,64}\n?$/.test(result.stdout)) {
    throw new Error('Public metadata scan requires locally available commit objects');
  }
  return result.stdout.trim();
}

function approvedEmail(email) {
  const normalized = email.trim().toLowerCase();
  if (normalized === CORPORATE_EMAIL || normalized === GITHUB_SERVICE_EMAIL) return true;
  const separator = normalized.lastIndexOf('@');
  return separator > 0 && normalized.slice(separator + 1) === NOREPLY_DOMAIN;
}

function hasUnapprovedEmail(value) {
  EMAIL_PATTERN.lastIndex = 0;
  let match;
  while ((match = EMAIL_PATTERN.exec(value)) !== null) {
    if (!approvedEmail(match[0])) {
      EMAIL_PATTERN.lastIndex = 0;
      return true;
    }
  }
  EMAIL_PATTERN.lastIndex = 0;
  return false;
}

function unsafeTextKinds(value) {
  const kinds = new Set(scanText(value, '<git-metadata>').map((finding) => finding.kind));
  if (hasUnapprovedEmail(value)) kinds.add('unapproved-email');
  if (UPSTREAM_BRAND_PATTERN.test(value)) kinds.add('upstream-identity');
  if (CONTROL_PATTERN.test(value)) kinds.add('control-character');
  return kinds;
}

function parseIdentity(value) {
  const match = /^(.*) <([^<>]*)> [0-9]+ [+-][0-9]{4}$/.exec(value);
  if (!match) return null;
  return { name: match[1], email: match[2] };
}

function identityIssueKinds(identity) {
  const kinds = new Set();
  if (!identity || !identity.name.trim() || identity.name.length > 160) {
    kinds.add('invalid-identity');
    return kinds;
  }
  if (!approvedEmail(identity.email)) kinds.add('unapproved-email');
  for (const kind of unsafeTextKinds(identity.name)) kinds.add(kind);
  for (const kind of unsafeTextKinds(identity.email)) kinds.add(kind);
  if (identity.email.toLowerCase() === CORPORATE_EMAIL && !CORPORATE_NAMES.has(identity.name)) {
    kinds.add('invalid-corporate-identity');
  }
  if (identity.email.toLowerCase() === GITHUB_SERVICE_EMAIL && identity.name !== GITHUB_SERVICE_NAME) {
    kinds.add('invalid-service-identity');
  }
  return kinds;
}

function parseObject(buffer) {
  const separator = buffer.indexOf(Buffer.from('\n\n'));
  if (separator < 0) return { headers: [], message: '' };
  const headerText = buffer.subarray(0, separator).toString('utf8');
  const headers = [];
  for (const line of headerText.split('\n')) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1].value += `\n${line}`;
      continue;
    }
    const space = line.indexOf(' ');
    if (space > 0) headers.push({ key: line.slice(0, space), value: line.slice(space + 1) });
  }
  return { headers, message: buffer.subarray(separator + 2).toString('utf8') };
}

function objectBytes(type, objectId) {
  return git(['cat-file', type, objectId], { encoding: null }).stdout;
}

function addKinds(issues, scope, objectId, kinds) {
  for (const kind of kinds) issues.push({ kind, objectId, scope });
}

function scanCommit(commitId, issues) {
  const object = parseObject(objectBytes('commit', commitId));
  for (const header of object.headers) {
    if (header.key === 'author' || header.key === 'committer') {
      addKinds(issues, 'commit-metadata', commitId, identityIssueKinds(parseIdentity(header.value)));
    } else if (header.key !== 'tree' && header.key !== 'parent') {
      // Git permits auxiliary and continuation headers (for example mergetag,
      // encoding, or signatures). Treat them as public metadata rather than an
      // identity-bearing side channel outside the ordinary commit message.
      addKinds(issues, 'commit-metadata', commitId, unsafeTextKinds(header.value));
    }
  }
  addKinds(issues, 'commit-metadata', commitId, unsafeTextKinds(object.message));
}

function visibleRefs() {
  const result = git([
    'for-each-ref',
    '--format=%(refname)%00%(objecttype)%00%(objectname)%00',
    'refs/heads',
    'refs/remotes/origin',
    'refs/tags',
    'refs/pull',
  ]);
  const fields = result.stdout.split('\0');
  const refs = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const refname = fields[index].replace(/^\n+/, '');
    if (refname) refs.push({ refname, objectType: fields[index + 1], objectId: fields[index + 2] });
  }
  return refs;
}

function scanTagObject(objectId, issues, seen = new Set()) {
  if (seen.has(objectId)) return;
  seen.add(objectId);
  const object = parseObject(objectBytes('tag', objectId));
  const target = object.headers.find((header) => header.key === 'object')?.value;
  const targetType = object.headers.find((header) => header.key === 'type')?.value;
  for (const header of object.headers) {
    if (header.key === 'tagger') {
      addKinds(issues, 'tag-metadata', objectId, identityIssueKinds(parseIdentity(header.value)));
    } else if (header.key === 'tag') {
      addKinds(issues, 'tag-metadata', objectId, unsafeTextKinds(header.value));
    } else if (header.key !== 'object' && header.key !== 'type') {
      addKinds(issues, 'tag-metadata', objectId, unsafeTextKinds(header.value));
    }
  }
  addKinds(issues, 'tag-metadata', objectId, unsafeTextKinds(object.message));
  if (target && targetType === 'tag') scanTagObject(target, issues, seen);
}

function scanRefs(rangeCommits, issues) {
  for (const ref of visibleRefs()) {
    const peeled = git(['rev-parse', '--verify', `${ref.refname}^{commit}`], { allowFailure: true });
    if (peeled.status !== 0 || !rangeCommits.has(peeled.stdout.trim())) continue;
    const refId = createHash('sha256').update(ref.refname).digest('hex');
    addKinds(issues, 'ref-metadata', refId, unsafeTextKinds(ref.refname));
    if (ref.objectType === 'tag') scanTagObject(ref.objectId, issues);
  }
}

function uniqueIssues(issues) {
  const unique = new Map();
  for (const issue of issues) unique.set(`${issue.scope}\0${issue.objectId}\0${issue.kind}`, issue);
  return [...unique.values()].sort((left, right) =>
    `${left.scope}\0${left.objectId}\0${left.kind}`.localeCompare(`${right.scope}\0${right.objectId}\0${right.kind}`));
}

function printIssues(issues) {
  console.error('Public Git metadata check failed (metadata values suppressed):');
  for (const issue of uniqueIssues(issues)) {
    console.error(`  [${issue.scope}:${issue.kind}] ${issue.objectId.slice(0, 12)}`);
  }
}

function scan(commitIds) {
  const issues = [];
  for (const commitId of commitIds) scanCommit(commitId, issues);
  const rangeCommits = new Set(commitIds);
  scanRefs(rangeCommits, issues);
  if (issues.length > 0) {
    printIssues(issues);
    return 1;
  }
  console.log(`public Git metadata policy passed for ${commitIds.length} commit(s)`);
  return 0;
}

function usage() {
  console.error('usage: check-public-git-metadata.mjs --range <base> <head> | --root <head>');
  return 2;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 3 && args[0] === '--range') {
    const base = resolveCommit(args[1]);
    const head = resolveCommit(args[2]);
    const result = git(['rev-list', '--reverse', `${base}..${head}`]);
    const commits = result.stdout.split(/\r?\n/).filter(Boolean);
    return scan(commits);
  }
  if (args.length === 2 && args[0] === '--root') {
    return scan([resolveCommit(args[1])]);
  }
  return usage();
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Public Git metadata check failed unexpectedly');
  process.exitCode = 2;
}
