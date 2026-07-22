'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const MAX_WINDOWS_PRISMA_ATTEMPTS = 3;
const WINDOWS_PRISMA_RETRY_DELAY_MS = 500;
const WINDOWS_PRISMA_LOCK_PATTERN =
  /\b(?:EPERM|EBUSY)\b[\s\S]{0,8192}\bschema-engine-windows\.exe\b/i;

function resolveOptional(request) {
  try {
    return require.resolve(request, { paths: [packageRoot] });
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

function createJsonGeneratorShim(entry) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-prisma-generator-'));
  const base = path.join(directory, 'prisma-json-types-generator');

  if (process.platform === 'win32') {
    const node = process.execPath.replaceAll('%', '%%');
    const generator = entry.replaceAll('%', '%%');
    fs.writeFileSync(`${base}.cmd`, `@echo off\r\n"${node}" "${generator}" %*\r\n`, {
      mode: 0o700,
    });
  } else {
    fs.writeFileSync(base, `#!/usr/bin/env node\nrequire(${JSON.stringify(entry)});\n`, {
      mode: 0o700,
    });
  }

  return directory;
}

function isRetryableWindowsPrismaLock(result, platform = process.platform) {
  if (platform !== 'win32') return false;
  if (result?.error && ['EPERM', 'EBUSY'].includes(result.error.code)) return true;

  const stderr = Buffer.isBuffer(result?.stderr)
    ? result.stderr.toString('utf8')
    : String(result?.stderr ?? '');
  return WINDOWS_PRISMA_LOCK_PATTERN.test(stderr);
}

function sleepSync(milliseconds) {
  const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(cell, 0, 0, milliseconds);
}

function writeChildStderr(writer, value) {
  if (!value || value.length === 0) return;
  writer.write(value);
}

function runPrismaGeneratorWithRetry({
  prismaCli,
  generatorArgs,
  environment,
  platform = process.platform,
  spawn = spawnSync,
  sleep = sleepSync,
  stderr = process.stderr,
}) {
  const maxAttempts = platform === 'win32' ? MAX_WINDOWS_PRISMA_ATTEMPTS : 1;
  let result;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = spawn(process.execPath, [prismaCli, ...generatorArgs], {
      cwd: packageRoot,
      env: environment,
      shell: false,
      stdio: ['inherit', 'inherit', 'pipe'],
      windowsHide: true,
    });

    const succeeded = !result.error && result.status === 0;
    const retryable = isRetryableWindowsPrismaLock(result, platform);
    if (succeeded || !retryable || attempt === maxAttempts) {
      writeChildStderr(stderr, result.stderr);
      return result;
    }

    stderr.write(
      `Prisma engine was temporarily locked; retrying client generation (${attempt}/${maxAttempts}).\n`,
    );
    sleep(WINDOWS_PRISMA_RETRY_DELAY_MS * attempt);
  }

  return result;
}

function main() {
  const prismaCli = require.resolve('prisma/build/index.js', { paths: [packageRoot] });
  const schema = path.join(packageRoot, 'prisma', 'schema.prisma');
  const jsonGeneratorEntry = resolveOptional('prisma-json-types-generator/index.js');
  const generatorArgs = ['generate'];
  let shimDirectory = null;
  let environment = process.env;

  if (jsonGeneratorEntry) {
    shimDirectory = createJsonGeneratorShim(jsonGeneratorEntry);
    environment = {
      ...process.env,
      PATH: [shimDirectory, path.dirname(process.execPath), process.env.PATH]
        .filter(Boolean)
        .join(path.delimiter),
    };
  } else {
    generatorArgs.push('--generator=client');
  }

  generatorArgs.push(`--schema=${schema}`);

  let result;
  try {
    result = runPrismaGeneratorWithRetry({ prismaCli, generatorArgs, environment });
  } finally {
    if (shimDirectory) {
      fs.rmSync(shimDirectory, { force: true, recursive: true });
    }
  }

  if (result.error) {
    console.error('Unable to launch Prisma client generation.');
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = typeof result.status === 'number' ? result.status : 1;
  }
}

module.exports = {
  MAX_WINDOWS_PRISMA_ATTEMPTS,
  isRetryableWindowsPrismaLock,
  runPrismaGeneratorWithRetry,
};

if (require.main === module) main();
