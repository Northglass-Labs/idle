import { test, expect } from '@playwright/test';
import { createTestApi } from '../helpers/api';
import type { AxiosInstance } from 'axios';
import type { TestAccount } from '../helpers/auth';

/**
 * E2E tests for the machines API.
 *
 * Covers machine registration, listing, and correct round-tripping
 * of the dataEncryptionKey as a base64 string (not a JSON object).
 */

let client: AxiosInstance;
let account: TestAccount;
let cleanup: () => Promise<void>;

test.describe('Machines API', () => {
    test.beforeAll(async () => {
        const api = await createTestApi();
        client = api.client;
        account = api.account;
        cleanup = api.cleanup;
    });

    test.afterAll(async () => {
        await cleanup();
    });

    test('register machine via API', async () => {
        const machineId = `e2e-machine-${Date.now()}`;
        const metadata = JSON.stringify({ hostname: 'e2e-test-host' });

        const response = await client.post('/v1/machines', {
            id: machineId,
            metadata,
        });

        expect(response.status).toBe(200);
        expect(response.data.machine).toBeDefined();
        expect(response.data.machine.id).toBe(machineId);
    });

    test('list machines returns registered machine', async () => {
        const machineId = `e2e-list-machine-${Date.now()}`;
        const metadata = JSON.stringify({ hostname: 'e2e-list-host' });

        // Register a machine
        await client.post('/v1/machines', { id: machineId, metadata });

        // List machines and verify the registered one is present
        const listResponse = await client.get('/v1/machines');

        expect(listResponse.status).toBe(200);
        expect(Array.isArray(listResponse.data)).toBe(true);

        const found = listResponse.data.find(
            (m: { id: string }) => m.id === machineId
        );
        expect(found).toBeDefined();
        expect(found.id).toBe(machineId);
    });

    test('dataEncryptionKey round-trips as binary', async () => {
        const machineId = `e2e-dek-machine-${Date.now()}`;
        const metadata = JSON.stringify({ hostname: 'e2e-dek-host' });

        // Generate a random 32-byte key, encode as base64
        const rawKey = Buffer.from(
            Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
        );
        const keyBase64 = rawKey.toString('base64');

        // Register machine with dataEncryptionKey
        const createResponse = await client.post('/v1/machines', {
            id: machineId,
            metadata,
            dataEncryptionKey: keyBase64,
        });

        expect(createResponse.status).toBe(200);

        // Retrieve from list and verify the key is a base64 string, not a JSON object
        const listResponse = await client.get('/v1/machines');
        const machine = listResponse.data.find(
            (m: { id: string }) => m.id === machineId
        );

        expect(machine).toBeDefined();
        expect(typeof machine.dataEncryptionKey).toBe('string');
        // Must be a plain base64 string, not serialized JSON like {"type":"Buffer","data":[...]}
        expect(machine.dataEncryptionKey).not.toMatch(/^\{/);
        // Decode and verify it matches the original key
        const decoded = Buffer.from(machine.dataEncryptionKey, 'base64');
        expect(decoded).toEqual(rawKey);
    });
});
