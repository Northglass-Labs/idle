import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patchScript = path.join(repoRoot, 'patches', 'patch-minio-stream-json-v3.cjs');

test('the MinIO notification parser uses the fixed stream-json v3 stream adapter', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-minio-stream-json-'));
  try {
    const nodeModules = path.join(scratch, 'node_modules');
    const mainPath = path.join(nodeModules, 'minio', 'dist', 'main', 'notification.js');
    const esmPath = path.join(nodeModules, 'minio', 'dist', 'esm', 'notification.mjs');
    fs.mkdirSync(path.dirname(mainPath), { recursive: true });
    fs.mkdirSync(path.dirname(esmPath), { recursive: true });
    fs.writeFileSync(
      mainPath,
      'var _Parser = require("stream-json/jsonl/Parser.js");\nconst asm = _Parser.make();\n',
    );
    fs.writeFileSync(
      esmPath,
      "import jsonLineParser from 'stream-json/jsonl/Parser.js';\nconst asm = jsonLineParser.make();\n",
    );

    const first = spawnSync(process.execPath, [patchScript, nodeModules], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(
      fs.readFileSync(mainPath, 'utf8'),
      /require\("stream-json\/jsonl\/parser\.js"\)[\s\S]*_Parser\.parser\.asStream\(\)/,
    );
    assert.match(
      fs.readFileSync(esmPath, 'utf8'),
      /from 'stream-json\/jsonl\/parser\.js'[\s\S]*jsonLineParser\.asStream\(\)/,
    );

    const second = spawnSync(process.execPath, [patchScript, nodeModules], { encoding: 'utf8' });
    assert.notEqual(second.status, 0, 'the patch must reject already-modified or drifted files');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
