#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;

const requiredPaths = [
  'package.json',
  'yarn.lock',
  'packages/idle-app/package.json',
  'packages/idle-app/app.config.js',
  'packages/idle-app/eas.json',
  'packages/idle-app/certs/certificate.pem',
  'packages/idle-app/certs/public-key.pem',
  'packages/idle-wire/package.json',
];

const maintainerReleasePaths = new Set([
  'scripts/check-testflight.sh',
  'scripts/fix-codesign-keychain.sh',
  'scripts/patch-eas-keychain.cjs',
  'scripts/refresh-local-idle.sh',
  'scripts/release-build-local.sh',
  'scripts/release-build.sh',
  'scripts/release.cjs',
  'scripts/setup-local-signing.sh',
  'packages/idle-app/release-dev.sh',
  'packages/idle-app/release-production.sh',
  'packages/idle-app/release.cjs',
]);
const credentialBasenames = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.yarnrc',
  '.yarnrc.yml',
]);

function normalized(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function forbiddenReason(relativePath) {
  const parts = relativePath.split('/');
  const basename = parts.at(-1) ?? '';

  if (parts.some(part => ['.git', '.github', '.claude', '.codex', '.agents'].includes(part))) {
    return 'repository or maintainer metadata';
  }
  if (['.cursorrules', '.mcp.json', 'CLAUDE.md', 'AGENTS.md'].includes(basename)) {
    return 'maintainer-local configuration';
  }
  if (credentialBasenames.has(basename)) return 'local package-manager credentials';
  if (basename === 'credentials.json') return 'local signing credentials';
  if (['.vscode', '.idea', '.expo'].some(part => parts.includes(part))) {
    return 'local development output';
  }
  if (basename.startsWith('.env')) return 'local environment file';
  if (parts[0] === 'docs' || parts[0] === 'notes') return 'documentation not used by the build';
  if (relativePath.startsWith('packages/idle-app/native-tests/')) return 'native test harness';
  if (relativePath.startsWith('packages/idle-app/.eas/workflows/')) return 'maintainer release automation';
  if (relativePath.startsWith('packages/idle-app/ios/') || relativePath.startsWith('packages/idle-app/android/')) {
    return 'locally generated native project';
  }
  if (maintainerReleasePaths.has(relativePath)) return 'maintainer release automation';
  if (relativePath === 'packages/idle-cli/package' || relativePath.startsWith('packages/idle-cli/package/')) {
    return 'local packaging output';
  }
  if (relativePath === 'packages/idle-cli/tools' || relativePath.startsWith('packages/idle-cli/tools/')) {
    return 'retired native CLI tool payload';
  }
  if (/\.(?:jks|p8|p12|key|mobileprovision)$/i.test(basename)) return 'private signing material';
  if (/\.pem$/i.test(basename) && ![
    'packages/idle-app/certs/certificate.pem',
    'packages/idle-app/certs/public-key.pem',
  ].includes(relativePath)) return 'unexpected PEM file';
  if (parts.includes('dist')) return 'local compiled output';

  return null;
}

export function verifyEasArchive(
  archiveRoot,
  {
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  } = {},
) {
  const root = path.resolve(archiveRoot);
  const violations = [];
  const files = [];
  let totalBytes = 0;

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { files, totalBytes, violations: ['archive output is not a directory'] };
  }

  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = normalized(path.join(prefix, entry.name));
      const absolutePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolutePath);

      if (stat.isSymbolicLink()) {
        violations.push(`${relativePath}: symbolic links are not allowed`);
        continue;
      }

      if (stat.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        violations.push(`${relativePath}: unsupported filesystem entry`);
        continue;
      }

      const reason = forbiddenReason(relativePath);
      if (reason) violations.push(`${relativePath}: ${reason}`);

      files.push(relativePath);
      totalBytes += stat.size;
      if (stat.size > maxFileBytes) violations.push(`${relativePath}: file exceeds size ceiling`);
    }
  }

  walk(root);

  for (const requiredPath of requiredPaths) {
    if (!files.includes(requiredPath)) violations.push(`${requiredPath}: required build input is missing`);
  }
  if (totalBytes > maxTotalBytes) violations.push('archive exceeds total size ceiling');

  return { files, totalBytes, violations: [...new Set(violations)].sort() };
}

function formatMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const archiveRoot = process.argv[2];
  if (!archiveRoot) {
    console.error('Usage: node scripts/verify-eas-archive.mjs <eas-archive-directory>');
    process.exitCode = 2;
  } else {
    const result = verifyEasArchive(archiveRoot);
    if (result.violations.length > 0) {
      console.error('EAS archive verification failed:');
      for (const violation of result.violations) console.error(`  ${violation}`);
      process.exitCode = 1;
    } else {
      console.log(`EAS archive verification passed (${result.files.length} files, ${formatMiB(result.totalBytes)} MiB)`);
    }
  }
}
