import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
    sanitizeServerLogText,
    sanitizeServerLogValue,
    serverLogFormatForEnvironment,
} from './log';

const forbiddenDiagnosticField = /^(?:accountId|artifactId|body|error|failure|host|id|ip|key|machineId|path|payload|reason|ref|request|sessionId|socketId|token|url|userId)$/i;

function productionTypeScriptFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path));
        else if (entry.isFile() && entry.name.endsWith('.ts') && !/\.(?:spec|test)\.ts$/.test(entry.name)) files.push(path);
    }
    return files;
}

function isDiagnosticCall(node: ts.CallExpression): boolean {
    if (ts.isIdentifier(node.expression)) return node.expression.text === 'log';
    if (!ts.isPropertyAccessExpression(node.expression)) return false;
    const owner = node.expression.expression.getText();
    return (owner === 'logger' || owner === 'console')
        && ['debug', 'error', 'fatal', 'info', 'log', 'trace', 'warn'].includes(node.expression.name.text);
}

describe('server log privacy boundary', () => {
    it('uses structured logs in production and pretty logs only for local development', () => {
        expect(serverLogFormatForEnvironment('production')).toBe('json');
        expect(serverLogFormatForEnvironment('test')).toBe('pretty');
        expect(serverLogFormatForEnvironment('development')).toBe('pretty');
        expect(serverLogFormatForEnvironment(undefined)).toBe('pretty');
    });

    it('emits one topology-free JSON record for a production request event', () => {
        const moduleUrl = new URL('./log.ts', import.meta.url).href;
        const script = [
            `const { logger } = await import(${JSON.stringify(moduleUrl)});`,
            `logger.info({ durationBucket: '10-49ms', httpMethod: 'GET', module: 'http', routeTemplate: '/health', statusCode: 200 }, 'HTTP request completed');`,
        ].join('\n');
        const result = spawnSync(process.execPath, [
            '--no-deprecation',
            '--import', 'tsx',
            '--input-type=module',
            '--eval', script,
        ], {
            cwd: new URL('../..', import.meta.url),
            encoding: 'utf8',
            env: { ...process.env, NODE_ENV: 'production' },
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        const lines = result.stdout.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain('\u001b');
        expect(lines[0].match(/"localTime":/g)).toHaveLength(1);
        const record = JSON.parse(lines[0]);
        expect(Object.keys(record).sort()).toEqual([
            'durationBucket',
            'httpMethod',
            'level',
            'localTime',
            'module',
            'msg',
            'routeTemplate',
            'statusCode',
            'time',
        ]);
    });

    it('redacts credentials, request bodies, identities, URL queries, and durable IDs', () => {
        const raw = [
            'Authorization: Bearer header-secret',
            'email=person@personal.example',
            'body: arbitrary private prompt',
            'https://example.test/callback?token=query-secret',
            'sessionId=123e4567-e89b-12d3-a456-426614174000',
        ].join(' ');
        const sanitized = sanitizeServerLogText(raw);

        expect(sanitized).not.toContain('header-secret');
        expect(sanitized).not.toContain('person@personal.example');
        expect(sanitized).not.toContain('arbitrary private prompt');
        expect(sanitized).not.toContain('query-secret');
        expect(sanitized).not.toContain('123e4567-e89b-12d3-a456-426614174000');
        expect(sanitized).toContain('[REDACTED]');
    });

    it('recursively censors secret-bearing structured fields', () => {
        const sanitized = sanitizeServerLogValue({
            authorization: 'Bearer header-secret',
            nested: {
                token: 'token-secret',
                safeCount: 4,
            },
        }) as Record<string, unknown>;

        expect(sanitized.authorization).toBe('[REDACTED]');
        expect(sanitized.nested).toEqual({ token: '[REDACTED]', safeCount: 4 });
    });

    it('redacts account, session, transport, and storage identifiers in prose and fields', () => {
        const identifiers = [
            'user_123456789',
            'session_123456789',
            'socket_123456789',
            'machine_123456789',
            'usage_key_123456789',
        ];
        const text = sanitizeServerLogText([
            `Push sent for user ${identifiers[0]} session ${identifiers[1]}`,
            `Received message from socket ${identifiers[2]}`,
            `User connected: ${identifiers[0]}`,
            `Access key retrieved for session ${identifiers[1]}, machine ${identifiers[3]}`,
            `Usage report saved: key=${identifiers[4]}`,
        ].join('\n'));
        const structured = sanitizeServerLogValue({
            id: identifiers[0],
            socketId: identifiers[2],
            artifactId: 'artifact_123456789',
            ref: 'private/object/ref',
            key: identifiers[4],
            safeCount: 4,
        }) as Record<string, unknown>;

        for (const identifier of identifiers) {
            expect(text).not.toContain(identifier);
        }
        expect(text).toContain('Push sent');
        expect(sanitizeServerLogText('Configure IDLE_MASTER_SECRET before startup'))
            .toContain('IDLE_MASTER_SECRET');
        expect(structured).toEqual({
            id: '[REDACTED]',
            socketId: '[REDACTED]',
            artifactId: '[REDACTED]',
            ref: '[REDACTED]',
            key: '[REDACTED]',
            safeCount: 4,
        });
    });

    it('does not preserve arbitrary exception prose or stacks', () => {
        const privateProse = 'customer supplied prose without a token-shaped marker';
        const text = sanitizeServerLogText('Error updating record: ' + privateProse);
        const error = new Error(privateProse);
        error.stack = 'Error: ' + privateProse + '\n at privateFunction (/private/source.ts:1:1)';

        expect(text).not.toContain(privateProse);
        expect(JSON.stringify(sanitizeServerLogValue(error))).not.toContain(privateProse);
        expect(JSON.stringify(sanitizeServerLogValue(error))).not.toContain('privateFunction');
    });

    it('redacts IPv4 and IPv6 peer addresses without corrupting versions or timestamps', () => {
        const text = sanitizeServerLogText([
            'peer 203.0.113.42',
            'peer 203.0.113.42:443',
            'peer 2001:db8:85a3::8a2e:370:7334',
            'peer [2001:db8::1]:8443',
            'peer ::ffff:192.0.2.128',
            'release 1.2.3 at 12:34:56.789',
        ].join('\n'));

        expect(text).not.toContain('203.0.113.42');
        expect(text).not.toContain('2001:db8');
        expect(text).not.toContain('192.0.2.128');
        expect(text).toContain('release 1.2.3 at 12:34:56.789');
    });

    it('keeps portable-server failures behind the shared sanitizer', () => {
        const source = readFileSync(new URL('../standalone.ts', import.meta.url), 'utf8');

        expect(/console\.error\(e\)/.test(source)).toBe(false);
        expect(/Migrating database in \$\{targetPgliteDir\}/.test(source)).toBe(false);
        expect(source).toContain('Standalone command failed. Check configuration and storage access.');
    });

    it('keeps production diagnostics value-free except for bounded categorical metadata', () => {
        const sourcesRoot = fileURLToPath(new URL('..', import.meta.url));
        const violations: string[] = [];
        for (const path of productionTypeScriptFiles(sourcesRoot)) {
            if (path.endsWith('/utils/log.ts')) continue;
            const source = readFileSync(path, 'utf8');
            const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
            const visit = (node: ts.Node): void => {
                if (ts.isCallExpression(node) && isDiagnosticCall(node)) {
                    for (const argument of node.arguments) {
                        if (ts.isTemplateExpression(argument) || ts.isBinaryExpression(argument)) {
                            violations.push(`${path}:${file.getLineAndCharacterOfPosition(argument.getStart()).line + 1}:dynamic-message`);
                        }
                        if (ts.isObjectLiteralExpression(argument)) {
                            for (const property of argument.properties) {
                                if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
                                    violations.push(`${path}:${file.getLineAndCharacterOfPosition(property.getStart()).line + 1}:dynamic-fields`);
                                    continue;
                                }
                                const name = property.name?.getText().replace(/^['"]|['"]$/g, '') ?? '';
                                if (forbiddenDiagnosticField.test(name)) {
                                    violations.push(`${path}:${file.getLineAndCharacterOfPosition(property.getStart()).line + 1}:${name}`);
                                }
                            }
                        } else if (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) {
                            violations.push(`${path}:${file.getLineAndCharacterOfPosition(argument.getStart()).line + 1}:raw-argument`);
                        }
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(file);
        }

        expect(violations).toEqual([]);
    });
});
