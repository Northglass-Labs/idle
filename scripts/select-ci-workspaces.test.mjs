import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  restrictRootWorkspaces,
  selectWorkspacePackages,
  workspaceProfiles,
} from './select-ci-workspaces.mjs';

const fullManifest = {
  private: true,
  workspaces: {
    packages: [
      'packages/idle-app',
      'packages/idle-agent',
      'packages/idle-cli',
      'packages/idle-e2e',
      'packages/idle-server',
      'packages/idle-wire',
    ],
    nohoist: ['**/react-native'],
  },
};

test('CLI smoke profile excludes mobile and unrelated workspaces', () => {
  assert.deepEqual(workspaceProfiles['cli-smoke'], [
    'packages/idle-cli',
    'packages/idle-server',
    'packages/idle-wire',
  ]);

  const restricted = selectWorkspacePackages(fullManifest, workspaceProfiles['cli-smoke']);
  assert.deepEqual(restricted.workspaces.packages, workspaceProfiles['cli-smoke']);
  assert.deepEqual(restricted.workspaces.nohoist, fullManifest.workspaces.nohoist);
  assert.equal(restricted.private, true);
});

test('workspace selection fails closed for missing and duplicate entries', () => {
  assert.throws(
    () => selectWorkspacePackages(fullManifest, ['packages/not-configured']),
    /not configured/,
  );
  assert.throws(
    () => selectWorkspacePackages(fullManifest, ['packages/idle-cli', 'packages/idle-cli']),
    /must not contain duplicates/,
  );
});

test('profile command rewrites only the temporary root workspace list', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-ci-workspaces-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'package.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(fullManifest, null, 2)}\n`);

  restrictRootWorkspaces('cli-smoke', manifestPath);

  const rewritten = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(rewritten.workspaces.packages, workspaceProfiles['cli-smoke']);
  assert.deepEqual(rewritten.workspaces.nohoist, fullManifest.workspaces.nohoist);
  assert.equal(rewritten.private, true);
});
