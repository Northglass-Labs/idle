'use strict';

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const packageJson = require(path.join(root, 'package.json'));
const external = Object.keys(packageJson.dependencies).flatMap(name => [name, `${name}/*`]);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

esbuild.buildSync({
  absWorkingDir: root,
  entryPoints: ['sources/standalone.ts'],
  outfile: 'dist/standalone.mjs',
  bundle: true,
  external,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
});
