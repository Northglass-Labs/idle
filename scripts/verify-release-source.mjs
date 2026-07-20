#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const immutableCommit = /^[a-f0-9]{40}$/;
const redirectedGitEnvironment = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
];

function cleanGitEnvironment() {
  const env = { ...process.env };
  for (const name of redirectedGitEnvironment) delete env[name];
  return env;
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: cleanGitEnvironment(),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error('release source verification requires an intact Git worktree');
  }
  return result.stdout.trim();
}

export function verifyReleaseSource(root, expectedCommit) {
  if (!immutableCommit.test(expectedCommit)) {
    throw new Error('release source verification requires an exact lowercase 40-character commit SHA');
  }

  const repositoryRoot = git(root, ['rev-parse', '--show-toplevel']);
  const head = git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head !== expectedCommit) {
    throw new Error('release checkout does not match the authorized commit');
  }

  const status = git(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (status.length > 0) {
    throw new Error('release checkout contains tracked or untracked source drift');
  }

  return { head, repositoryRoot };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const expectedCommit = process.argv[2] ?? '';
    verifyReleaseSource(process.cwd(), expectedCommit);
    console.log('release source matches the authorized commit and clean worktree');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'release source verification failed');
    process.exitCode = 1;
  }
}
