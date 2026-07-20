#!/usr/bin/env node
/**
 * Session Hook Forwarder
 *
 * This script is executed by Claude's SessionStart hook.
 * It reads JSON data from stdin and forwards it to Idle's local hook server.
 *
 * Usage: echo '{"session_id":"..."}' | node session_hook_forwarder.cjs <port> <token-file>
 */

const fs = require('fs');
const http = require('http');

const port = parseInt(process.argv[2], 10);
const tokenPath = process.argv[3];

if (!port || isNaN(port) || !tokenPath) {
    process.exit(1);
}

let authToken;
try {
    const tokenStats = fs.lstatSync(tokenPath);
    if (!tokenStats.isFile() || tokenStats.isSymbolicLink()) {
        process.exit(1);
    }
    if (process.platform !== 'win32' && (tokenStats.mode & 0o077) !== 0) {
        process.exit(1);
    }
    authToken = fs.readFileSync(tokenPath, 'utf8');
    if (!authToken || authToken.length > 256) {
        process.exit(1);
    }
} catch {
    process.exit(1);
}

const chunks = [];
let receivedBytes = 0;
const maxBodyBytes = 64 * 1024;

process.stdin.on('data', (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes > maxBodyBytes) {
        process.stdin.destroy();
        process.exit(1);
    }
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    const body = Buffer.concat(chunks);

    const req = http.request({
        host: '127.0.0.1',
        port: port,
        method: 'POST',
        path: '/hook/session-start',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            'Authorization': `Bearer ${authToken}`,
        }
    }, (res) => {
        res.resume(); // Drain response
    });

    req.on('error', () => {
        // Silently ignore errors - don't break Claude
    });

    req.end(body);
});

process.stdin.resume();
