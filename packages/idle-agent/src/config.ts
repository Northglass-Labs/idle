import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { normalizeServerUrl } from '@northglass/idle-wire';

export type Config = {
    serverUrl: string;
    homeDir: string;
    credentialPath: string;
};

export const DEFAULT_SERVER_URL = 'https://idle-api.northglass.io';
const MAX_HOME_DIR_BYTES = 4096;

export function normalizeHomeDir(raw: string): string {
    if (
        typeof raw !== 'string'
        || raw.length === 0
        || raw !== raw.trim()
        || Buffer.byteLength(raw, 'utf8') > MAX_HOME_DIR_BYTES
        || !isAbsolute(raw)
    ) {
        throw new Error('IDLE_HOME_DIR must be a bounded absolute directory path');
    }

    const normalized = resolve(raw);
    if (normalized === parse(normalized).root) {
        throw new Error('IDLE_HOME_DIR may not be a filesystem root');
    }
    return normalized;
}

export function loadConfig(): Config {
    const serverUrl = normalizeServerUrl(process.env.IDLE_SERVER_URL ?? DEFAULT_SERVER_URL);
    const homeDir = normalizeHomeDir(process.env.IDLE_HOME_DIR ?? join(homedir(), '.idle'));
    const credentialPath = join(homeDir, 'agent.key');
    return { serverUrl, homeDir, credentialPath };
}
