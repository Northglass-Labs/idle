import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('local attachment filesystem boundary', () => {
    let root: string;
    let files: typeof import('./files');

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-attachment-files-'));
        delete process.env.S3_HOST;
        process.env.DATA_DIR = root;
        vi.resetModules();
        files = await import('./files');
        await files.loadFiles();
    });

    afterEach(() => {
        delete process.env.DATA_DIR;
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('atomically streams and reads an opaque encrypted blob under a safe key', async () => {
        const ref = `sessions/session-1/attachments/${crypto.randomUUID()}.enc`;
        const body = Buffer.from('ciphertext');

        await files.putLocalFileStream(ref, Readable.from(body), body.length);

        expect(await files.statAttachmentObject(ref)).toEqual({ size: body.length });
        const opened = await files.openBoundedLocalFile(ref, 1024);
        const chunks: Buffer[] = [];
        for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(body);
        expect(opened.size).toBe(body.length);
        const mode = fs.statSync(path.join(files.getLocalFilesDir(), ref)).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it('rejects short and overlong upload streams without publishing a partial object', async () => {
        const shortRef = `sessions/session-1/attachments/${crypto.randomUUID()}.enc`;
        const longRef = `sessions/session-1/attachments/${crypto.randomUUID()}.enc`;

        await expect(files.putLocalFileStream(shortRef, Readable.from(Buffer.from('x')), 2))
            .rejects.toThrow(/size/i);
        await expect(files.putLocalFileStream(longRef, Readable.from(Buffer.from('xx')), 1))
            .rejects.toThrow(/size/i);

        expect(await files.statAttachmentObject(shortRef)).toBeNull();
        expect(await files.statAttachmentObject(longRef)).toBeNull();
    });

    it('removes the temporary object when a streaming upload is aborted', async () => {
        const ref = `sessions/session-1/attachments/${crypto.randomUUID()}.enc`;
        const controller = new AbortController();
        controller.abort();

        await expect(files.putLocalFileStream(
            ref,
            Readable.from(Buffer.from('ciphertext')),
            Buffer.byteLength('ciphertext'),
            controller.signal,
        )).rejects.toThrow();

        expect(await files.statAttachmentObject(ref)).toBeNull();
    });

    it('streams an exact maximum-size attachment without a whole-file read', async () => {
        const ref = `sessions/session-1/attachments/${crypto.randomUUID()}.enc`;
        const size = 10 * 1024 * 1024;

        await files.putLocalFileStream(ref, Readable.from(Buffer.alloc(size, 0x61)), size);

        expect(await files.statAttachmentObject(ref)).toEqual({ size });
        const opened = await files.openBoundedLocalFile(ref, size);
        let received = 0;
        for await (const chunk of opened.stream) received += Buffer.byteLength(chunk);
        expect(received).toBe(size);
    });

    it('rejects traversal and absolute storage keys', async () => {
        await expect(files.putLocalFile('../escape.enc', Buffer.from('x'))).rejects.toThrow(/storage key/i);
        await expect(files.putLocalFile('/tmp/escape.enc', Buffer.from('x'))).rejects.toThrow(/storage key/i);
    });

    it('rejects noncanonical uppercase attachment UUIDs at the storage boundary', async () => {
        const ref = 'sessions/session-1/attachments/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.enc';

        await expect(files.putLocalFileStream(ref, Readable.from(Buffer.from('x')), 1))
            .rejects.toThrow(/attachment key/i);
        expect(fs.existsSync(path.join(files.getLocalFilesDir(), ref))).toBe(false);
    });

    it('rejects a case-variant lookup when the local filesystem aliases its path', async () => {
        const attachmentFile = '11111111-1111-4111-8111-111111111111.enc';
        const legacyRef = `sessions/LegacySession/attachments/${attachmentFile}`;
        const aliasedRef = `sessions/legacysession/attachments/${attachmentFile}`;
        const legacyPath = path.join(files.getLocalFilesDir(), legacyRef);
        fs.mkdirSync(path.dirname(legacyPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(legacyPath, 'legacy-ciphertext', { mode: 0o600 });

        // Case-sensitive CI volumes cannot reproduce the platform alias. On a
        // case-insensitive volume, the consuming storage API must notice that
        // the directory spelling differs before opening the physical object.
        if (!fs.existsSync(path.join(files.getLocalFilesDir(), aliasedRef))) return;

        await expect(files.statAttachmentObject(aliasedRef)).rejects.toThrow(/case|storage key/i);
    });

    it('refuses a symlinked directory component instead of writing outside storage', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-attachment-outside-'));
        const sessionDir = path.join(files.getLocalFilesDir(), 'sessions', 'session-1');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.symlinkSync(outside, path.join(sessionDir, 'attachments'));
        const ref = `sessions/session-1/attachments/${crypto.randomUUID()}.enc`;

        await expect(files.putLocalFile(ref, Buffer.from('x'))).rejects.toThrow(/symlink/i);
        expect(fs.readdirSync(outside)).toEqual([]);
        fs.rmSync(outside, { recursive: true, force: true });
    });

    it('refuses to follow a symlink when reading an attachment', async () => {
        const outside = path.join(root, 'outside');
        fs.writeFileSync(outside, 'private');
        const dir = path.join(files.getLocalFilesDir(), 'sessions', 'session-1', 'attachments');
        fs.mkdirSync(dir, { recursive: true });
        const ref = `sessions/session-1/attachments/${crypto.randomUUID()}.enc`;
        fs.symlinkSync(outside, path.join(files.getLocalFilesDir(), ref));

        await expect(files.openBoundedLocalFile(ref, 1024)).rejects.toThrow();
    });

    it('deletes only the exact bounded set of refs supplied by the database', async () => {
        const refs = [
            `sessions/session-1/attachments/${crypto.randomUUID()}.enc`,
            `sessions/session-1/attachments/${crypto.randomUUID()}.enc`,
        ];
        const untouched = `sessions/session-1/attachments/${crypto.randomUUID()}.enc`;
        for (const ref of [...refs, untouched]) await files.putLocalFile(ref, Buffer.from(ref));

        await files.deleteAttachmentObjects(refs);

        for (const ref of refs) expect(await files.statAttachmentObject(ref)).toBeNull();
        expect(await files.statAttachmentObject(untouched)).not.toBeNull();
    });

    it('treats an expired reservation with no uploaded object as already cleaned up', async () => {
        const missing = `sessions/missing-session/attachments/${crypto.randomUUID()}.enc`;

        await expect(files.deleteAttachmentObjects([missing])).resolves.toBeUndefined();
    });

    it('never lets attachment cleanup target the public image namespace', async () => {
        await expect(files.deleteAttachmentObjects(['public/users/account-1/avatar.jpg']))
            .rejects.toThrow(/attachment key/i);
    });

    it('classifies only the explicit public namespace as publicly readable', () => {
        expect(files.isPublicLocalFileKey('public/users/account-1/avatar.jpg')).toBe(true);
        expect(files.isPublicLocalFileKey('sessions/session-1/attachments/blob.enc')).toBe(false);
        expect(files.isPublicLocalFileKey('public/../secret')).toBe(false);
    });
});
