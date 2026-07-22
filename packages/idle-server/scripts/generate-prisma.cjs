'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const prismaCli = require.resolve('prisma/build/index.js', { paths: [packageRoot] });
const schema = path.join(packageRoot, 'prisma', 'schema.prisma');

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
  result = spawnSync(process.execPath, [prismaCli, ...generatorArgs], {
    cwd: packageRoot,
    env: environment,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
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
