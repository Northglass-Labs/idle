import { afterEach, describe, expect, it } from 'vitest';
import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { DurableIncomingMessageReplayStore } from './DurableIncomingMessageReplayStore';

describe('DurableIncomingMessageReplayStore', () => {
    const roots: string[] = [];

    function createRoot(): string {
        const root = mkdtempSync(join(tmpdir(), 'idle-message-replay-'));
        roots.push(root);
        return root;
    }

    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
            rmSync(join(dirname(root), `.${basename(root)}.initialized`), {
                force: true,
            });
        }
    });

    it('rejects a consumed identity after constructing a new store instance', () => {
        const root = createRoot();
        const first = new DurableIncomingMessageReplayStore({ directory: root });

        expect(first.consume('session-a:key-epoch-a', 'authenticated:message-1'))
            .toBe('consumed');

        const afterRestart = new DurableIncomingMessageReplayStore({ directory: root });
        expect(afterRestart.consume('session-a:key-epoch-a', 'authenticated:message-1'))
            .toBe('replay');
    });

    it('atomically lets only one process consume an identity', () => {
        const root = createRoot();
        const first = new DurableIncomingMessageReplayStore({ directory: root });
        const second = new DurableIncomingMessageReplayStore({ directory: root });

        expect([
            first.consume('session-a:key-epoch-a', 'authenticated:race'),
            second.consume('session-a:key-epoch-a', 'authenticated:race'),
        ].sort()).toEqual(['consumed', 'replay']);
    });

    it('keeps session key epochs isolated', () => {
        const store = new DurableIncomingMessageReplayStore({ directory: createRoot() });

        expect(store.consume('session-a:key-epoch-a', 'authenticated:message-1'))
            .toBe('consumed');
        expect(store.consume('session-a:key-epoch-b', 'authenticated:message-1'))
            .toBe('consumed');
        expect(store.consume('session-b:key-epoch-a', 'authenticated:message-1'))
            .toBe('consumed');
    });

    it('fails closed at capacity without evicting an older identity', () => {
        const root = createRoot();
        const store = new DurableIncomingMessageReplayStore({
            directory: root,
            maxEntriesPerScope: 2,
        });

        expect(store.consume('session-a:key-epoch-a', 'authenticated:oldest'))
            .toBe('consumed');
        expect(store.consume('session-a:key-epoch-a', 'authenticated:second'))
            .toBe('consumed');
        expect(store.consume('session-a:key-epoch-a', 'authenticated:overflow'))
            .toBe('saturated');
        expect(store.consume('session-a:key-epoch-a', 'authenticated:oldest'))
            .toBe('replay');
        expect(store.consume('session-a:key-epoch-a', 'authenticated:overflow'))
            .toBe('saturated');
    });

    it('persists only fixed-format digests and version markers', () => {
        const root = createRoot();
        const privateScope = 'private-session:private-key-epoch';
        const privateIdentity = 'authenticated:private-message-id';
        const store = new DurableIncomingMessageReplayStore({ directory: root });

        expect(store.consume(privateScope, privateIdentity)).toBe('consumed');

        const serialized = walk(root)
            .map((entry) => `${entry.relativePath}\n${entry.contents}`)
            .join('\n');
        expect(serialized).not.toContain(privateScope);
        expect(serialized).not.toContain(privateIdentity);
        for (const entry of walk(root)) {
            expect(entry.relativePath).toMatch(
                /^(?:[a-f0-9]{64}\.scope|[a-f0-9]{64}\/[a-f0-9]{64}\.seen)$/,
            );
            expect(entry.contents).toBe('v1\n');
        }
    });

    it('rejects a symlinked store root', () => {
        const parent = createRoot();
        const outside = createRoot();
        const root = join(parent, 'message-replay-v1');
        symlinkSync(outside, root);
        const store = new DurableIncomingMessageReplayStore({ directory: root });

        expect(() => store.consume('scope', 'identity'))
            .toThrow('Invalid message replay marker directory');
    });

    it('rejects corrupt entries instead of treating the scope as empty', () => {
        const root = createRoot();
        const store = new DurableIncomingMessageReplayStore({ directory: root });
        expect(store.consume('scope', 'identity-1')).toBe('consumed');
        const scopeDirectory = join(
            root,
            readdirSync(root, { withFileTypes: true })
                .find((entry) => entry.isDirectory())!.name,
        );
        writeFileSync(join(scopeDirectory, 'unexpected.txt'), 'corrupt');

        expect(() => store.consume('scope', 'identity-2'))
            .toThrow('Invalid message replay marker entry');
    });

    it('rejects a missing root after the durable initialization anchor exists', () => {
        const parent = createRoot();
        const root = join(parent, 'message-replay-v1');
        const store = new DurableIncomingMessageReplayStore({ directory: root });
        expect(store.consume('scope', 'identity-1')).toBe('consumed');
        rmSync(root, { recursive: true, force: true });

        const afterRestart = new DurableIncomingMessageReplayStore({ directory: root });
        expect(() => afterRestart.consume('scope', 'identity-2'))
            .toThrow('Message replay marker directory is missing');
    });
});

function walk(root: string, prefix = ''): Array<{ relativePath: string; contents: string }> {
    const result: Array<{ relativePath: string; contents: string }> = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const relativePath = join(prefix, entry.name);
        const absolutePath = join(root, entry.name);
        if (entry.isDirectory()) {
            result.push(...walk(absolutePath, relativePath));
        } else {
            result.push({ relativePath, contents: readFileSync(absolutePath, 'utf8') });
        }
    }
    return result;
}
