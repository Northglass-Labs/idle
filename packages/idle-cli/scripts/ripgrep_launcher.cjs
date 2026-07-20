#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_FALLBACK_DEPTH = 64;
const MAX_FALLBACK_DIRECTORIES = 20_000;
const MAX_FALLBACK_ENTRIES = 100_000;
const MAX_FALLBACK_FILES = 50_000;
const MAX_FALLBACK_OUTPUT_BYTES = 1024 * 1024;

const SKIPPED_DIRECTORIES = new Set([
    'bower_components',
    'build',
    'coverage',
    'deriveddata',
    'dist',
    'node_modules',
    'out',
    'pods',
    'target',
    'vendor',
]);

class FileListUnavailable extends Error {}

function parseArguments(raw) {
    let args;
    try {
        args = JSON.parse(raw);
    } catch {
        throw new FileListUnavailable();
    }

    if (
        !Array.isArray(args)
        || args.length > MAX_ARGUMENTS
        || args.some(argument =>
            typeof argument !== 'string'
            || argument.includes('\0')
            || Buffer.byteLength(argument, 'utf8') > MAX_ARGUMENT_BYTES
        )
    ) {
        throw new FileListUnavailable();
    }
    return args;
}

function compareNames(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function sameIdentity(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.nlink === right.nlink;
}

function assertStableDirectory(directory, expected) {
    const current = fs.lstatSync(directory, { bigint: true });
    if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || !sameIdentity(current, expected)
        || fs.realpathSync.native(directory) !== directory
    ) {
        throw new FileListUnavailable();
    }
}

function readDirectoryNames(directory, state) {
    const names = [];
    const handle = fs.opendirSync(directory);
    try {
        let entry;
        while ((entry = handle.readSync()) !== null) {
            state.entries += 1;
            if (state.entries > MAX_FALLBACK_ENTRIES) throw new FileListUnavailable();
            names.push(entry.name);
        }
    } finally {
        handle.closeSync();
    }
    return names.sort(compareNames);
}

function listFilesWithoutRipgrep() {
    const root = fs.realpathSync.native(process.cwd());
    const rootPrefix = `${root}${path.sep}`;
    const files = [];
    const state = { directories: 0, entries: 0, outputBytes: 0 };

    function isInsideRoot(absolutePath) {
        return absolutePath === root || absolutePath.startsWith(rootPrefix);
    }

    function walk(directory, depth) {
        if (depth > MAX_FALLBACK_DEPTH) throw new FileListUnavailable();
        state.directories += 1;
        if (state.directories > MAX_FALLBACK_DIRECTORIES) throw new FileListUnavailable();

        const before = fs.lstatSync(directory, { bigint: true });
        if (
            before.isSymbolicLink()
            || !before.isDirectory()
            || !isInsideRoot(directory)
            || fs.realpathSync.native(directory) !== directory
        ) {
            throw new FileListUnavailable();
        }

        const names = readDirectoryNames(directory, state);
        assertStableDirectory(directory, before);

        for (const name of names) {
            if (!name || name.startsWith('.')) continue;
            const absolutePath = path.join(directory, name);
            const metadata = fs.lstatSync(absolutePath, { bigint: true });
            if (metadata.isSymbolicLink()) continue;

            if (metadata.isDirectory()) {
                if (SKIPPED_DIRECTORIES.has(name.toLowerCase())) continue;
                walk(absolutePath, depth + 1);
                continue;
            }
            if (!metadata.isFile()) continue;

            const realPath = fs.realpathSync.native(absolutePath);
            const current = fs.lstatSync(absolutePath, { bigint: true });
            if (
                realPath !== absolutePath
                || !isInsideRoot(realPath)
                || !current.isFile()
                || !sameIdentity(metadata, current)
            ) {
                throw new FileListUnavailable();
            }

            const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
            if (!relativePath || relativePath.includes('\n') || relativePath.includes('\r')) continue;
            state.outputBytes += Buffer.byteLength(relativePath, 'utf8') + 1;
            if (
                files.length >= MAX_FALLBACK_FILES
                || state.outputBytes > MAX_FALLBACK_OUTPUT_BYTES
            ) {
                throw new FileListUnavailable();
            }
            files.push(relativePath);
        }

        assertStableDirectory(directory, before);
    }

    walk(root, 0);
    files.sort(compareNames);
    return files.length === 0 ? '' : `${files.join('\n')}\n`;
}

function runSystemRipgrep(args) {
    const result = spawnSync('rg', args, {
        stdio: ['ignore', 'inherit', 'ignore'],
        windowsHide: true,
    });
    if (result.error?.code === 'ENOENT') return null;
    if (result.error) return 1;
    return Number.isInteger(result.status) ? result.status : 1;
}

let args;
try {
    args = parseArguments(process.argv[2]);
} catch {
    process.stderr.write('Invalid search request\n');
    process.exit(1);
}

const systemExitCode = runSystemRipgrep(args);
if (systemExitCode !== null) process.exit(systemExitCode);

if (args.length !== 1 || args[0] !== '--files') {
    process.stderr.write('System ripgrep is required for content search\n');
    process.exit(1);
}

try {
    process.stdout.write(listFilesWithoutRipgrep());
    process.exit(0);
} catch {
    process.stderr.write('File listing unavailable\n');
    process.exit(1);
}
