import { createHash, createHmac } from 'node:crypto';
import {
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { z } from 'zod';

import { decodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';

const AgentCredentialsSchema = z.object({
    token: z.string().min(1).max(16 * 1024),
    secret: z.string().min(1).max(256).base64(),
});
const MAX_AGENT_CREDENTIAL_FILE_BYTES = 32 * 1024;

export type LocalIdleAgentCredentials = {
    token: string;
    secret: Uint8Array;
    contentKeyPair: {
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    };
};

export type ResumeSupport = {
    rpcAvailable: boolean;
    requiresSameMachine: true;
    requiresIdleAgentAuth: true;
    idleAgentAuthenticated: boolean;
    detectedAt: number;
};

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
    const hmac = createHmac('sha512', key);
    hmac.update(data);
    return new Uint8Array(hmac.digest());
}

function deriveKey(master: Uint8Array, usage: string, path: string[]): Uint8Array {
    const root = hmacSha512(new TextEncoder().encode(`${usage} Master Seed`), master);
    let state = {
        key: root.slice(0, 32),
        chainCode: root.slice(32),
    };

    for (const index of path) {
        const data = new Uint8Array([0x00, ...new TextEncoder().encode(index)]);
        const derived = hmacSha512(state.chainCode, data);
        state = {
            key: derived.slice(0, 32),
            chainCode: derived.slice(32),
        };
    }

    return state.key;
}

function deriveContentKeyPair(secret: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
    const seed = deriveKey(secret, 'Idle EnCoder', ['content']);
    const hashedSeed = new Uint8Array(createHash('sha512').update(seed).digest());
    const secretKey = hashedSeed.slice(0, 32);
    const keyPair = tweetnacl.box.keyPair.fromSecretKey(secretKey);
    return {
        publicKey: keyPair.publicKey,
        secretKey: keyPair.secretKey,
    };
}

export function getLocalIdleAgentCredentialPath(idleHomeDir: string = configuration.idleHomeDir): string {
    return join(idleHomeDir, 'agent.key');
}

export function readLocalIdleAgentCredentials(
    idleHomeDir: string = configuration.idleHomeDir,
): LocalIdleAgentCredentials | null {
    const credentialPath = getLocalIdleAgentCredentialPath(idleHomeDir);
    let descriptor: number | undefined;

    try {
        const pathStat = lstatSync(credentialPath);
        if (!pathStat.isFile() || pathStat.isSymbolicLink()) return null;
        descriptor = openSync(credentialPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const fileStat = fstatSync(descriptor);
        if (
            !fileStat.isFile()
            || fileStat.size > MAX_AGENT_CREDENTIAL_FILE_BYTES
            || pathStat.dev !== fileStat.dev
            || pathStat.ino !== fileStat.ino
        ) {
            return null;
        }
        if (process.platform !== 'win32' && (fileStat.mode & 0o777) !== 0o600) {
            fchmodSync(descriptor, 0o600);
        }

        const parsed = AgentCredentialsSchema.parse(JSON.parse(readFileSync(descriptor, 'utf8')));
        const secret = decodeBase64(parsed.secret);
        if (secret.length !== 32) return null;
        return {
            token: parsed.token,
            secret,
            contentKeyPair: deriveContentKeyPair(secret),
        };
    } catch {
        return null;
    } finally {
        if (descriptor !== undefined) {
            try { closeSync(descriptor); } catch { /* best effort */ }
        }
    }
}

export function hasLocalIdleAgentAuth(idleHomeDir: string = configuration.idleHomeDir): boolean {
    return readLocalIdleAgentCredentials(idleHomeDir) !== null;
}

export function detectResumeSupport(idleHomeDir: string = configuration.idleHomeDir): ResumeSupport {
    const idleAgentAuthenticated = hasLocalIdleAgentAuth(idleHomeDir);
    return {
        rpcAvailable: idleAgentAuthenticated,
        requiresSameMachine: true,
        requiresIdleAgentAuth: true,
        idleAgentAuthenticated,
        detectedAt: Date.now(),
    };
}
