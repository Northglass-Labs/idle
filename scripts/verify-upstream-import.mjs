#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const upstreamGuard = path.join(scriptDirectory, 'check-upstream-cruft.sh');
const hygieneGuard = path.join(scriptDirectory, 'check-docs-hygiene.sh');
const metadataGuard = path.join(scriptDirectory, 'check-public-git-metadata.mjs');
const immutableObjectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function usageError() {
  return new Error([
    'usage: verify-upstream-import.mjs --staged <source>',
    '   or: verify-upstream-import.mjs --range <base> <source> <head>',
    '   or: verify-upstream-import.mjs --policy-range <base> <head>',
    '   or: verify-upstream-import.mjs --ci-range <base> <head>',
  ].join('\n'));
}

function requireImmutableObjectId(value) {
  if (!immutableObjectId.test(value)) {
    throw new Error('upstream verification requires a full 40- or 64-character lowercase Git object ID');
  }
  return value;
}

function requireDirectCommitStep(value) {
  return {
    command: 'bash',
    args: [
      '-c',
      'test "$(git cat-file -t "$1")" = commit',
      'verify-upstream-commit',
      value,
    ],
  };
}

export function buildVerificationSteps(_root, args) {
  if (args.length === 2 && args[0] === '--staged') {
    const source = requireImmutableObjectId(args[1]);
    return [
      { command: 'bash', args: [upstreamGuard, '--check-remote'] },
      requireDirectCommitStep(source),
      { command: 'git', args: ['merge-base', '--is-ancestor', source, 'refs/remotes/upstream/main'] },
      { command: 'bash', args: [upstreamGuard, '--provenance-staged', source] },
      { command: 'bash', args: [hygieneGuard, '--defer-upstream-baseline'] },
      { command: 'bash', args: [upstreamGuard, '--staged', source] },
      { command: 'git', args: ['diff', '--check', '--cached'] },
      { command: 'yarn', args: ['typecheck'] },
      { command: 'yarn', args: ['test'] },
    ];
  }

  if (args.length === 4 && args[0] === '--range') {
    const [, rawBase, rawSource, rawHead] = args;
    const base = requireImmutableObjectId(rawBase);
    const source = requireImmutableObjectId(rawSource);
    const head = requireImmutableObjectId(rawHead);
    return [
      { command: 'bash', args: [upstreamGuard, '--check-remote'] },
      requireDirectCommitStep(base),
      requireDirectCommitStep(source),
      requireDirectCommitStep(head),
      { command: 'git', args: ['merge-base', '--is-ancestor', source, 'refs/remotes/upstream/main'] },
      { command: 'bash', args: [upstreamGuard, '--provenance-diff', base, source, head] },
      { command: 'bash', args: [hygieneGuard] },
      { command: 'bash', args: [upstreamGuard, '--diff', base, head, '--source', source] },
      { command: process.execPath, args: [metadataGuard, '--range', base, head] },
      { command: 'git', args: ['diff', '--check', base, head] },
      { command: 'yarn', args: ['typecheck'] },
      { command: 'yarn', args: ['test'] },
    ];
  }

  if (args.length === 3 && args[0] === '--ci-range') {
    const [, rawBase, rawHead] = args;
    const base = requireImmutableObjectId(rawBase);
    const head = requireImmutableObjectId(rawHead);
    return [
      requireDirectCommitStep(base),
      requireDirectCommitStep(head),
      { command: 'bash', args: [upstreamGuard, '--ci-diff', base, head] },
      { command: process.execPath, args: [metadataGuard, '--range', base, head] },
      { command: 'git', args: ['diff', '--check', base, head] },
    ];
  }

  if (args.length === 3 && args[0] === '--policy-range') {
    const [, rawBase, rawHead] = args;
    const base = requireImmutableObjectId(rawBase);
    const head = requireImmutableObjectId(rawHead);
    return [
      requireDirectCommitStep(base),
      requireDirectCommitStep(head),
      { command: 'bash', args: [hygieneGuard] },
      { command: 'bash', args: [upstreamGuard, '--policy-diff', base, head] },
      { command: process.execPath, args: [metadataGuard, '--range', base, head] },
      { command: 'git', args: ['diff', '--check', base, head] },
      { command: process.execPath, args: ['--test', path.join(scriptDirectory, 'check-upstream-cruft.test.mjs'), path.join(scriptDirectory, 'verify-upstream-import.test.mjs')] },
    ];
  }

  throw usageError();
}

function repositoryRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('upstream verification requires a Git worktree');
  return result.stdout.trim();
}

function runStep(root, step) {
  const result = spawnSync(step.command, step.args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const root = repositoryRoot();
  for (const step of buildVerificationSteps(root, process.argv.slice(2))) runStep(root, step);
  console.log('canonical upstream import verification passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'upstream verification failed unexpectedly');
    process.exitCode = 2;
  }
}
