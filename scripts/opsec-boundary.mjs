#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPublicationPolicy } from './publication-policy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const MIN_PRINTABLE_STRING_LENGTH = 4;
const MAX_PRINTABLE_STRING_LENGTH = 256 * 1024;
const MAX_PUBLISHABLE_FILES = 50_000;
const MAX_PUBLISHABLE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PUBLISHABLE_TREE_BYTES = 512 * 1024 * 1024;
const MAX_REPOSITORY_PATH_BYTES = 1024;
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;
const PUBLISHABLE_BLOB_MODES = new Set(['100644', '100755', '120000']);

// Compressed archives, disk images, databases, documents, and media containers
// can conceal content from a bounded printable-string pass. Public releases
// reject them rather than expanding attacker-controlled members. Required app
// assets (PNG/JPEG/ICO/TTF) and native binaries remain eligible for inspection.
const OPAQUE_CONTAINER_SUFFIXES = Object.freeze([
  '.7z', '.aab', '.aar', '.apk', '.appx', '.appxbundle', '.ar', '.avi',
  '.avif', '.bz2', '.cab', '.cpio', '.db', '.deb', '.dmg', '.doc', '.docm',
  '.docx', '.ear', '.epub', '.flac', '.gem', '.gz', '.heic', '.heif', '.ipa',
  '.iso', '.jar', '.m4a', '.m4v', '.mkv', '.mov', '.mp3', '.mp4', '.msi',
  '.nupkg', '.numbers', '.odp', '.ods', '.odt', '.pages', '.pack', '.pdf',
  '.pkg', '.ppt', '.pptm', '.pptx', '.psd', '.rar', '.rpm', '.sketch',
  '.sqlite', '.sqlite3', '.svgz', '.tar', '.tar.bz2', '.tar.gz', '.tar.xz',
  '.tar.zst', '.tbz', '.tbz2', '.tgz', '.txz', '.vsix', '.war', '.wav',
  '.webm', '.webp', '.whl', '.xar', '.xls', '.xlsb', '.xlsm', '.xlsx', '.xz',
  '.zip', '.zipx', '.zst',
]);

const OPAQUE_CONTAINER_PREFIXES = Object.freeze([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), // ZIP member
  Buffer.from([0x50, 0x4b, 0x05, 0x06]), // empty ZIP
  Buffer.from([0x50, 0x4b, 0x07, 0x08]), // spanned ZIP
  Buffer.from([0x1f, 0x8b]), // gzip
  Buffer.from([0x42, 0x5a, 0x68]), // bzip2
  Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), // xz
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), // 7-Zip
  Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]), // RAR
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), // Zstandard
  Buffer.from('!<arch>\n', 'ascii'), // ar archive
  Buffer.from('%PDF-', 'ascii'),
  Buffer.from('SQLite format 3\0', 'ascii'),
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), // OLE
  Buffer.from('xar!', 'ascii'),
  Buffer.from('bplist00', 'ascii'),
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), // Matroska/WebM
  Buffer.from('fLaC', 'ascii'),
  Buffer.from('ID3', 'ascii'),
  Buffer.from('8BPS', 'ascii'),
  Buffer.from('MSCF', 'ascii'), // CAB
  Buffer.from([0xed, 0xab, 0xee, 0xdb]), // RPM
  Buffer.from('MSWIM\0\0\0', 'ascii'),
  Buffer.from([0x51, 0x46, 0x49, 0xfb]), // QCOW
]);

const GENERIC_FINGERPRINTS = Object.freeze({
  normalized: new Set(),
  caseSensitive: new Set(),
});
let defaultFingerprints;
let privateFingerprintsAvailable = false;

function publicationFingerprints(required = false) {
  if (defaultFingerprints === undefined || (required && !privateFingerprintsAvailable)) {
    const policy = loadPublicationPolicy({ required });
    defaultFingerprints = policy?.opsec ?? GENERIC_FINGERPRINTS;
    privateFingerprintsAvailable = policy !== null;
  }
  return defaultFingerprints;
}

const GMAIL_PATTERN = /\b[a-z0-9._%+-]+@gmail\.com\b/i;
const POSTAL_ADDRESS_PATTERN = /\b[0-9]{1,6}\s+(?:[a-z0-9.'-]+\s+){0,4}(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|boulevard|blvd|way|place|pl)\b/i;
const US_PHONE_PATTERN = /(?:\+1[ .-]?)?\(?[2-9][0-9]{2}\)?[ .-][2-9][0-9]{2}[ .-][0-9]{4}\b/;
const SSN_PATTERN = /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/;

function identityCandidates(value, normalize) {
  const words = value.match(/[a-z0-9][a-z0-9._-]*/gi) ?? [];
  const candidates = new Set();
  for (let start = 0; start < words.length; start += 1) {
    for (let size = 1; size <= 4 && start + size <= words.length; size += 1) {
      const phrase = words.slice(start, start + size).join(' ');
      const candidate = normalize ? phrase.toLowerCase() : phrase;
      candidates.add(candidate);
      candidates.add(candidate.replace(/[\s._-]+/g, ''));
    }
  }
  return candidates;
}

function hasIdentityFingerprint(value, fingerprints) {
  for (const candidate of identityCandidates(value, true)) {
    if (fingerprints.normalized.has(digest(candidate))) return true;
  }
  for (const candidate of identityCandidates(value, false)) {
    if (fingerprints.caseSensitive.has(digest(candidate))) return true;
  }
  return false;
}

export function scanText(value, relativePath, fingerprints = publicationFingerprints()) {
  const findings = [];
  const add = kind => {
    if (!findings.some(finding => finding.kind === kind)) {
      findings.push({ kind, path: relativePath });
    }
  };

  if (hasIdentityFingerprint(value, fingerprints)) add('prohibited-identity');
  if (GMAIL_PATTERN.test(value)) add('gmail-address');
  if (POSTAL_ADDRESS_PATTERN.test(value)) add('postal-address');
  if (US_PHONE_PATTERN.test(value)) add('us-phone-number');
  if (SSN_PATTERN.test(value)) add('social-security-number');

  return findings;
}

function hasPrefix(buffer, prefix) {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

function hasOpaqueContainerMagic(buffer) {
  if (OPAQUE_CONTAINER_PREFIXES.some(prefix => hasPrefix(buffer, prefix))) return true;

  // POSIX tar header, ISO-9660 descriptor, and RIFF/ISO media containers have
  // identifying bytes away from offset zero.
  if (buffer.length >= 262 && buffer.subarray(257, 262).equals(Buffer.from('ustar', 'ascii'))) return true;
  if (buffer.length >= 32_774 && buffer.subarray(32_769, 32_774).equals(Buffer.from('CD001', 'ascii'))) return true;
  if (buffer.length >= 12 && hasPrefix(buffer, Buffer.from('RIFF', 'ascii'))) return true;
  if (buffer.length >= 12 && buffer.subarray(4, 8).equals(Buffer.from('ftyp', 'ascii'))) return true;
  if (buffer.length >= 512) {
    const footer = buffer.length - 512;
    if (buffer.subarray(footer, footer + 4).equals(Buffer.from('koly', 'ascii'))) return true;
    if (buffer.subarray(footer, footer + 8).equals(Buffer.from('conectix', 'ascii'))) return true;
  }

  const cpioMagic = buffer.subarray(0, 6).toString('ascii');
  return cpioMagic === '070701' || cpioMagic === '070702' || cpioMagic === '070707';
}

function hasOpaqueContainerSuffix(relativePath) {
  const normalized = relativePath.toLowerCase();
  return OPAQUE_CONTAINER_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

function isAsciiPrintable(byte) {
  return byte >= 0x20 && byte <= 0x7e;
}

function* asciiPrintableStrings(buffer) {
  let start = -1;
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index < buffer.length && isAsciiPrintable(buffer[index])) {
      if (start < 0) start = index;
      continue;
    }
    if (start >= 0 && index - start >= MIN_PRINTABLE_STRING_LENGTH) {
      yield index - start > MAX_PRINTABLE_STRING_LENGTH
        ? null
        : buffer.toString('ascii', start, index);
    }
    start = -1;
  }
}

function* utf16PrintableStrings(buffer, littleEndian) {
  for (const alignment of [0, 1]) {
    let start = -1;
    let characterCount = 0;
    for (let index = alignment; index + 1 < buffer.length; index += 2) {
      const codePoint = littleEndian
        ? buffer[index] | (buffer[index + 1] << 8)
        : (buffer[index] << 8) | buffer[index + 1];
      if (isAsciiPrintable(codePoint)) {
        if (start < 0) start = index;
        characterCount += 1;
        continue;
      }
      if (characterCount >= MIN_PRINTABLE_STRING_LENGTH) {
        if (characterCount > MAX_PRINTABLE_STRING_LENGTH) {
          yield null;
        } else {
          const encoded = buffer.subarray(start, start + characterCount * 2);
          yield littleEndian
            ? encoded.toString('utf16le')
            : Buffer.from(encoded).swap16().toString('utf16le');
        }
      }
      start = -1;
      characterCount = 0;
    }
    if (characterCount >= MIN_PRINTABLE_STRING_LENGTH) {
      if (characterCount > MAX_PRINTABLE_STRING_LENGTH) {
        yield null;
      } else {
        const encoded = buffer.subarray(start, start + characterCount * 2);
        yield littleEndian
          ? encoded.toString('utf16le')
          : Buffer.from(encoded).swap16().toString('utf16le');
      }
    }
  }
}

function uniqueFindings(findings) {
  const unique = new Map();
  for (const finding of findings) unique.set(`${finding.kind}\0${finding.path}`, finding);
  return [...unique.values()].sort((left, right) =>
    `${left.path}\0${left.kind}`.localeCompare(`${right.path}\0${right.kind}`));
}

export function scanFileContents(buffer, relativePath, fingerprints = publicationFingerprints()) {
  const findings = [];
  if (hasOpaqueContainerSuffix(relativePath) || hasOpaqueContainerMagic(buffer)) {
    findings.push({ kind: 'opaque-container', path: relativePath });
  }

  if (!buffer.includes(0)) {
    findings.push(...scanText(buffer.toString('utf8'), relativePath, fingerprints));
    return uniqueFindings(findings);
  }

  if (buffer.length > MAX_PUBLISHABLE_FILE_BYTES) {
    findings.push({ kind: 'oversized-binary', path: relativePath });
    return uniqueFindings(findings);
  }

  for (const value of asciiPrintableStrings(buffer)) {
    if (value === null) findings.push({ kind: 'oversized-printable-string', path: relativePath });
    else findings.push(...scanText(value, relativePath, fingerprints));
  }
  for (const value of utf16PrintableStrings(buffer, true)) {
    if (value === null) findings.push({ kind: 'oversized-printable-string', path: relativePath });
    else findings.push(...scanText(value, relativePath, fingerprints));
  }
  for (const value of utf16PrintableStrings(buffer, false)) {
    if (value === null) findings.push({ kind: 'oversized-printable-string', path: relativePath });
    else findings.push(...scanText(value, relativePath, fingerprints));
  }
  return uniqueFindings(findings);
}

export function summarizeFindings(findings) {
  const counts = new Map();
  for (const { kind } of findings) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => ({ count, kind }));
}

function isUnsafeRepositoryPath(relativePath) {
  return (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    Buffer.byteLength(relativePath, 'utf8') > MAX_REPOSITORY_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/.test(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split('/').includes('..')
  );
}

function listPublishableFiles(root) {
  const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.status !== 0) throw new Error('OPSEC boundary check requires a Git worktree');
  const files = result.stdout.toString('utf8').split('\0').filter(Boolean).sort();
  if (files.length > MAX_PUBLISHABLE_FILES) throw new Error('OPSEC boundary file ceiling exceeded');
  if (files.some(isUnsafeRepositoryPath)) throw new Error('OPSEC boundary contains an unsupported repository path');
  return files;
}

export function scanRepository(root = repoRoot, fingerprints = publicationFingerprints()) {
  const findings = [];
  let inspectedBytes = 0;
  for (const relativePath of listPublishableFiles(root)) {
    const absolutePath = path.join(root, relativePath);
    let buffer;
    try {
      const metadata = fs.lstatSync(absolutePath);
      inspectedBytes += metadata.size;
      if (inspectedBytes > MAX_PUBLISHABLE_TREE_BYTES) {
        findings.push({ kind: 'publishable-tree-capacity', path: '<repository>' });
        break;
      }
      if (metadata.size > MAX_PUBLISHABLE_FILE_BYTES) {
        findings.push({ kind: 'oversized-publishable-file', path: relativePath });
        continue;
      }
      buffer = metadata.isSymbolicLink()
        ? Buffer.from(fs.readlinkSync(absolutePath), 'utf8')
        : fs.readFileSync(absolutePath);
    } catch (error) {
      // Cached paths removed by the public-curation diff are not publishable.
      if (error?.code === 'ENOENT') continue;
      findings.push({ kind: 'unreadable-publishable-file', path: relativePath });
      continue;
    }

    const pathFindings = scanText(relativePath, relativePath, fingerprints);
    findings.push(...pathFindings);
    findings.push(...scanFileContents(buffer, relativePath, fingerprints));
  }

  return uniqueFindings(findings);
}

function git(root, args, encoding = null) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.status !== 0) throw new Error('OPSEC boundary could not inspect Git tree');
  return result.stdout;
}

function resolveCommit(root, value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) {
    throw new Error('OPSEC boundary could not inspect Git tree');
  }
  const resolved = git(root, ['rev-parse', '--verify', `${value}^{commit}`], 'utf8').trim();
  if (!/^[a-f0-9]{40,64}$/.test(resolved)) throw new Error('OPSEC boundary could not inspect Git tree');
  return resolved;
}

function listGitTreeEntries(root, commit) {
  const output = git(root, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit]);
  const entries = [];
  for (const record of output.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^(\d{6}) ([a-z]+) ([a-f0-9]{40,64})\s+([0-9-]+)\t([\s\S]+)$/);
    if (!match) throw new Error('OPSEC boundary could not inspect Git tree');
    const size = match[4] === '-' ? null : Number(match[4]);
    const entry = {
      mode: match[1],
      type: match[2],
      oid: match[3],
      size,
      path: match[5],
    };
    if (
      entry.type !== 'blob' ||
      !PUBLISHABLE_BLOB_MODES.has(entry.mode) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      isUnsafeRepositoryPath(entry.path)
    ) {
      throw new Error('OPSEC boundary could not inspect Git tree');
    }
    entries.push(entry);
  }
  if (entries.length > MAX_PUBLISHABLE_FILES) throw new Error('OPSEC boundary could not inspect Git tree');
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function scanGitTree(root, value, fingerprints = publicationFingerprints()) {
  try {
    const commit = resolveCommit(root, value);
    const entries = listGitTreeEntries(root, commit);
    const findings = [];
    let inspectedBytes = 0;
    for (const entry of entries) {
      inspectedBytes += entry.size;
      if (inspectedBytes > MAX_PUBLISHABLE_TREE_BYTES) {
        findings.push({ kind: 'publishable-tree-capacity', path: '<repository>' });
        break;
      }
      if (entry.size > MAX_PUBLISHABLE_FILE_BYTES) {
        findings.push({ kind: 'oversized-publishable-file', path: entry.path });
        continue;
      }
      const buffer = git(root, ['cat-file', 'blob', entry.oid]);
      if (buffer.length !== entry.size) throw new Error('OPSEC boundary could not inspect Git tree');
      findings.push(...scanText(entry.path, entry.path, fingerprints));
      findings.push(...scanFileContents(buffer, entry.path, fingerprints));
    }
    return uniqueFindings(findings);
  } catch {
    throw new Error('OPSEC boundary could not inspect Git tree');
  }
}

function main() {
  let findings;
  try {
    const args = process.argv.slice(2);
    const requiresPrivatePolicy = args[0] === '--require-private-policy';
    if (requiresPrivatePolicy) args.shift();
    const fingerprints = publicationFingerprints(requiresPrivatePolicy);
    if (args.length === 0) findings = scanRepository(repoRoot, fingerprints);
    else if (args.length === 2 && args[0] === '--tree') findings = scanGitTree(repoRoot, args[1], fingerprints);
    else throw new Error('unsupported OPSEC boundary mode');
  } catch {
    console.error('OPSEC boundary check could not inspect the publishable tree');
    process.exitCode = 1;
    return;
  }
  if (findings.length === 0) {
    console.log('OPSEC boundary check passed');
    return;
  }

  console.error('OPSEC boundary check failed (category counts only):');
  for (const finding of summarizeFindings(findings)) {
    console.error(`  [${finding.kind}] ${finding.count} affected file(s)`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
