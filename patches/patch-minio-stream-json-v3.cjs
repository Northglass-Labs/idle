#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

if (process.argv.length !== 3) {
  console.error('usage: patch-minio-stream-json-v3.cjs NODE_MODULES_ROOT');
  process.exit(2);
}

const nodeModulesRoot = path.resolve(process.argv[2]);
const rootStat = fs.lstatSync(nodeModulesRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error('NODE_MODULES_ROOT must be a real directory');
}

const patches = [
  {
    relativePath: 'minio/dist/main/notification.js',
    replacements: [
      [
        'var _Parser = require("stream-json/jsonl/Parser.js");',
        'var _Parser = require("stream-json/jsonl/parser.js");',
      ],
      ['const asm = _Parser.make();', 'const asm = _Parser.parser.asStream();'],
    ],
  },
  {
    relativePath: 'minio/dist/esm/notification.mjs',
    replacements: [
      [
        "import jsonLineParser from 'stream-json/jsonl/Parser.js';",
        "import jsonLineParser from 'stream-json/jsonl/parser.js';",
      ],
      ['const asm = jsonLineParser.make();', 'const asm = jsonLineParser.asStream();'],
    ],
  },
];

function replaceExactlyOnce(content, from, to, relativePath) {
  const firstIndex = content.indexOf(from);
  if (firstIndex < 0 || content.indexOf(from, firstIndex + from.length) >= 0) {
    throw new Error(`${relativePath}: expected exactly one reviewed source pattern`);
  }
  return `${content.slice(0, firstIndex)}${to}${content.slice(firstIndex + from.length)}`;
}

for (const patch of patches) {
  const target = path.resolve(nodeModulesRoot, patch.relativePath);
  if (!target.startsWith(`${nodeModulesRoot}${path.sep}`)) {
    throw new Error('patch target escaped NODE_MODULES_ROOT');
  }
  const targetStat = fs.lstatSync(target);
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error(`${patch.relativePath}: target must be a regular file`);
  }
  let content = fs.readFileSync(target, 'utf8');
  for (const [from, to] of patch.replacements) {
    content = replaceExactlyOnce(content, from, to, patch.relativePath);
  }
  const temporary = `${target}.idle-patch.tmp`;
  fs.writeFileSync(temporary, content, { mode: targetStat.mode });
  fs.renameSync(temporary, target);
}

console.log('patched MinIO for the reviewed stream-json v3 adapter');
