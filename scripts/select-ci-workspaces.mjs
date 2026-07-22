#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');

export const workspaceProfiles = Object.freeze({
  'cli-smoke': Object.freeze([
    'packages/idle-cli',
    'packages/idle-server',
    'packages/idle-wire',
  ]),
});

export function selectWorkspacePackages(manifest, selectedPackages) {
  const configuredPackages = manifest?.workspaces?.packages;
  if (!Array.isArray(configuredPackages)) {
    throw new Error('Root package.json must define workspaces.packages as an array');
  }
  if (!Array.isArray(selectedPackages) || selectedPackages.length === 0) {
    throw new Error('At least one CI workspace must be selected');
  }

  const uniquePackages = [...new Set(selectedPackages)];
  if (uniquePackages.length !== selectedPackages.length) {
    throw new Error('CI workspace selection must not contain duplicates');
  }

  const configured = new Set(configuredPackages);
  for (const workspace of uniquePackages) {
    if (!configured.has(workspace)) {
      throw new Error(`CI workspace is not configured by the root manifest: ${workspace}`);
    }
  }

  return {
    ...manifest,
    workspaces: {
      ...manifest.workspaces,
      packages: uniquePackages,
    },
  };
}

export function restrictRootWorkspaces(profile, manifestPath = path.join(repoRoot, 'package.json')) {
  const selectedPackages = workspaceProfiles[profile];
  if (!selectedPackages) {
    throw new Error(`Unknown CI workspace profile: ${profile || '<missing>'}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const restricted = selectWorkspacePackages(manifest, selectedPackages);
  fs.writeFileSync(manifestPath, `${JSON.stringify(restricted, null, 4)}\n`);
  return selectedPackages;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const selected = restrictRootWorkspaces(process.argv[2]);
    console.log(`CI workspace install restricted to: ${selected.join(', ')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
