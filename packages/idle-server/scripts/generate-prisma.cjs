'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const prismaCli = require.resolve('prisma/build/index.js', { paths: [packageRoot] });
const schema = path.join(packageRoot, 'prisma', 'schema.prisma');

const result = spawnSync(
  process.execPath,
  [prismaCli, 'generate', '--generator=client', `--schema=${schema}`],
  {
    cwd: packageRoot,
    env: process.env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  },
);

if (result.error) {
  console.error('Unable to launch Prisma client generation.');
  process.exitCode = 1;
} else if (result.status !== 0) {
  process.exitCode = typeof result.status === 'number' ? result.status : 1;
}
