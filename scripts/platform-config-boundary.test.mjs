import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const volatileOperatorNarrative =
  /openssl|rand\s+-|brew install|auth login|wait\s+~?\d|subsequent deploy|cheapest|paid tier|save money|cold-start|years of|single-user usage|Claude Code|chatty side|your phone|verified by|smoke\s+20\d\d|pricing/i;

test('Render blueprint is generic, durable, and gates automatic deployments', () => {
  const render = read('render.yaml');

  assert.match(render, /^\s*dockerfilePath:\s*\.\/Dockerfile\s*$/m);
  assert.match(render, /^\s*healthCheckPath:\s*\/health\s*$/m);
  assert.match(render, /^\s*autoDeployTrigger:\s*checksPass\s*$/m);
  assert.doesNotMatch(render, /^\s*autoDeploy\s*:/m);
  assert.doesNotMatch(render, /^\s*(?:plan|region)\s*:/m);
  assert.match(render, /^\s*- key:\s*IDLE_MASTER_SECRET\s*\n\s*sync:\s*false\s*$/m);
  assert.match(render, /^\s*mountPath:\s*\/data\s*$/m);
  assert.match(render, /^\s*sizeGB:\s*1\s*$/m);
  assert.doesNotMatch(render, volatileOperatorNarrative);
});

test('Fly template leaves identity and region to each self-hoster', () => {
  const fly = read('fly.toml');

  assert.doesNotMatch(fly, /^\s*(?:app|primary_region)\s*=/m);
  assert.match(fly, /^\s*dockerfile\s*=\s*"Dockerfile"\s*$/m);
  assert.match(fly, /^\s*internal_port\s*=\s*3005\s*$/m);
  assert.match(fly, /^\s*force_https\s*=\s*true\s*$/m);
  assert.match(fly, /^\s*path\s*=\s*"\/health"\s*$/m);
  assert.match(fly, /^\s*destination\s*=\s*"\/data"\s*$/m);
  assert.doesNotMatch(fly, volatileOperatorNarrative);
});

test('platform templates contain no secret values or inline generation recipes', () => {
  for (const configPath of ['render.yaml', 'fly.toml']) {
    const config = read(configPath);
    assert.doesNotMatch(config, /IDLE_MASTER_SECRET\s*[:=]\s*\S+/);
    assert.doesNotMatch(config, /\$\([^\n]*(?:openssl|rand)[^\n]*\)/i);
  }
});
