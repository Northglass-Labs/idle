import { test, expect } from '@playwright/test';
import { createTestApi } from '../helpers/api';
import type { AxiosInstance } from 'axios';
import type { TestAccount } from '../helpers/auth';
import { randomUUID } from 'node:crypto';

/**
 * E2E tests for the sessions API.
 *
 * Covers CRUD operations, idempotent creation by tag, and correct
 * round-tripping of the dataEncryptionKey as a base64 string.
 */

let client: AxiosInstance;
let account: TestAccount;
let cleanup: () => Promise<void>;

test.describe('Sessions API', () => {
    test.beforeAll(async () => {
        const api = await createTestApi();
        client = api.client;
        account = api.account;
        cleanup = api.cleanup;
    });

    test.afterAll(async () => {
        await cleanup();
    });

    test('create session through the current bound API', async () => {
        const tag = `e2e-session-${Date.now()}`;
        const metadata = JSON.stringify({ title: 'E2E Test Session' });
        const id = randomUUID();

        const response = await client.post('/v2/sessions', {
            id,
            tag,
            metadata,
        });

        expect(response.status).toBe(200);
        expect(response.data.session).toBeDefined();
        expect(response.data.session.id).toBe(id);
    });

    test('legacy create remains compatible without a client id', async () => {
        const response = await client.post('/v1/sessions', {
            tag: `e2e-legacy-session-${Date.now()}`,
            metadata: JSON.stringify({ title: 'Legacy Client Session' }),
        });

        expect(response.status).toBe(200);
        expect(response.data.session.id).toEqual(expect.any(String));
    });

    test('list sessions returns created session', async () => {
        const tag = `e2e-list-${Date.now()}`;
        const metadata = JSON.stringify({ title: 'Listed Session' });

        // Create a session first
        const createResponse = await client.post('/v2/sessions', {
            id: randomUUID(),
            tag,
            metadata,
        });
        const sessionId = createResponse.data.session.id;

        // List sessions and verify it's in the response
        const listResponse = await client.get('/v1/sessions');

        expect(listResponse.status).toBe(200);
        expect(Array.isArray(listResponse.data.sessions)).toBe(true);

        const found = listResponse.data.sessions.find(
            (s: { id: string }) => s.id === sessionId
        );
        expect(found).toBeDefined();
    });

    test('session creation is idempotent', async () => {
        const tag = `e2e-idempotent-${Date.now()}`;
        const metadata = JSON.stringify({ title: 'Idempotent Session' });

        // Create the same tag twice
        const first = await client.post('/v2/sessions', { id: randomUUID(), tag, metadata });
        const second = await client.post('/v2/sessions', { id: randomUUID(), tag, metadata });

        expect(first.data.session.id).toBe(second.data.session.id);
    });

    test('delete session via API', async () => {
        const tag = `e2e-delete-${Date.now()}`;
        const metadata = JSON.stringify({ title: 'Session To Delete' });

        // Create
        const createResponse = await client.post('/v2/sessions', {
            id: randomUUID(),
            tag,
            metadata,
        });
        const sessionId = createResponse.data.session.id;

        // Delete
        const deleteResponse = await client.delete(`/v1/sessions/${sessionId}`);
        expect(deleteResponse.status).toBe(200);

        // Verify it's gone from the list
        const listResponse = await client.get('/v1/sessions');
        const found = listResponse.data.sessions.find(
            (s: { id: string }) => s.id === sessionId
        );
        expect(found).toBeUndefined();
    });

    test('dataEncryptionKey round-trips correctly', async () => {
        const tag = `e2e-dek-${Date.now()}`;
        const metadata = JSON.stringify({ title: 'DEK Test Session' });

        // Generate a random 32-byte key, encode as base64
        const rawKey = Buffer.from(
            Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
        );
        const keyBase64 = rawKey.toString('base64');

        // Create session with dataEncryptionKey
        const createResponse = await client.post('/v2/sessions', {
            id: randomUUID(),
            tag,
            metadata,
            dataEncryptionKey: keyBase64,
        });

        expect(createResponse.status).toBe(200);

        // Retrieve the session from the list and verify the key is a base64 string
        const listResponse = await client.get('/v1/sessions');
        const session = listResponse.data.sessions.find(
            (s: { id: string }) => s.id === createResponse.data.session.id
        );

        expect(session).toBeDefined();
        expect(typeof session.dataEncryptionKey).toBe('string');
        // Verify it's a valid base64 string, not a JSON object
        expect(session.dataEncryptionKey).not.toMatch(/^\{/);
        // Decode and verify it matches the original key
        const decoded = Buffer.from(session.dataEncryptionKey, 'base64');
        expect(decoded).toEqual(rawKey);
    });
});
