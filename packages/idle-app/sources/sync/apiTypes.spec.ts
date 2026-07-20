import { describe, expect, it } from 'vitest';
import {
    ApiEphemeralUpdateSchema,
    ApiMachinesResponseSchema,
    ApiNativeVersionResponseSchema,
    ApiPostSessionMessagesResponseSchema,
    ApiSessionsResponseSchema,
    ApiSettingsResponseSchema,
    ApiSettingsUpdateResponseSchema,
    ApiUpdateSchema,
    ApiUpdateContainerSchema,
} from './apiTypes';

describe('HTTP snapshot response schemas', () => {
    const machine = {
        id: 'machine-1',
        metadata: 'encrypted-metadata',
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey: null,
        seq: 1,
        active: false,
        activeAt: 1,
        createdAt: 1,
        updatedAt: 1,
    };

    it('strictly bounds the machine inventory', () => {
        expect(ApiMachinesResponseSchema.safeParse([machine]).success).toBe(true);
        expect(ApiMachinesResponseSchema.safeParse([{ ...machine, attacker: true }]).success).toBe(false);
        expect(ApiMachinesResponseSchema.safeParse(
            Array.from({ length: 101 }, (_, index) => ({ ...machine, id: `machine-${index}` })),
        ).success).toBe(false);
        expect(ApiMachinesResponseSchema.safeParse([machine, { ...machine }]).success).toBe(false);
    });

    it('strictly validates both settings endpoints', () => {
        expect(ApiSettingsResponseSchema.safeParse({ settings: null, settingsVersion: 0 }).success).toBe(true);
        expect(ApiSettingsResponseSchema.safeParse({ settings: null, settingsVersion: 0, extra: true }).success).toBe(false);
        expect(ApiSettingsUpdateResponseSchema.safeParse({ success: true, version: 1 }).success).toBe(true);
        expect(ApiSettingsUpdateResponseSchema.safeParse({
            success: false,
            error: 'version-mismatch',
            currentVersion: 2,
            currentSettings: null,
        }).success).toBe(true);
        expect(ApiSettingsUpdateResponseSchema.safeParse({ success: true }).success).toBe(false);
    });

    it('accepts only the current native-version contract', () => {
        expect(ApiNativeVersionResponseSchema.safeParse({ updateUrl: null }).success).toBe(true);
        expect(ApiNativeVersionResponseSchema.safeParse({
            updateUrl: 'https://apps.apple.com/app/idle/id1234567890',
        }).success).toBe(false);
        expect(ApiNativeVersionResponseSchema.safeParse({
            updateUrl: 'https://play.google.com/store/apps/details?id=com.northglass.idle',
        }).success).toBe(false);
        expect(ApiNativeVersionResponseSchema.safeParse({ update_required: true, update_url: 'https://example.test' }).success).toBe(false);
        expect(ApiNativeVersionResponseSchema.safeParse({ updateUrl: 'javascript:alert(1)' }).success).toBe(false);
    });

    it('strictly bounds acknowledged message batches', () => {
        const message = {
            id: 'message-1',
            seq: 1,
            localId: 'local-1',
            createdAt: 1,
            updatedAt: 1,
        };
        expect(ApiPostSessionMessagesResponseSchema.safeParse({ messages: [message] }).success).toBe(true);
        expect(ApiPostSessionMessagesResponseSchema.safeParse({ messages: [{ ...message, attacker: true }] }).success).toBe(false);
        expect(ApiPostSessionMessagesResponseSchema.safeParse({
            messages: Array.from({ length: 101 }, (_, index) => ({
                ...message,
                id: `message-${index}`,
                localId: `local-${index}`,
                seq: index + 1,
            })),
        }).success).toBe(false);
        expect(ApiPostSessionMessagesResponseSchema.safeParse({ messages: [message, { ...message }] }).success).toBe(false);
    });
});

describe('ApiUpdateSchema', () => {
    it('bounds and validates session snapshots before hydration work', () => {
        const session = {
            id: 'session-1',
            seq: 0,
            metadata: 'encrypted-metadata',
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            active: false,
            activeAt: 1,
            createdAt: 1,
            updatedAt: 1,
            lastMessage: null,
        };
        expect(ApiSessionsResponseSchema.safeParse({ sessions: [session] }).success).toBe(true);
        expect(ApiSessionsResponseSchema.safeParse({ sessions: [{ ...session, attacker: true }] }).success).toBe(false);
        expect(ApiSessionsResponseSchema.safeParse({ sessions: [session], attacker: true }).success).toBe(false);
        expect(ApiSessionsResponseSchema.safeParse({
            sessions: [{ ...session, metadataVersion: Number.MAX_SAFE_INTEGER + 1 }],
        }).success).toBe(false);
        expect(ApiSessionsResponseSchema.safeParse({
            sessions: [{ ...session, activeAt: 253_402_300_799_001 }],
        }).success).toBe(false);
        expect(ApiSessionsResponseSchema.safeParse({
            sessions: [{ ...session, agentState: 'x'.repeat(65_537) }],
        }).success).toBe(false);
        expect(ApiSessionsResponseSchema.safeParse({
            sessions: Array.from({ length: 151 }, (_, index) => ({
                ...session,
                id: `session-${index}`,
            })),
        }).success).toBe(false);
        expect(ApiSessionsResponseSchema.safeParse({
            sessions: [session, { ...session }],
        }).success).toBe(false);
    });

    it('accepts shared wire update-session payload', () => {
        const parsed = ApiUpdateSchema.safeParse({
            t: 'update-session',
            id: 'session-1',
        });
        expect(parsed.success).toBe(true);
    });

    it('accepts app-local new-session payload', () => {
        const parsed = ApiUpdateSchema.safeParse({
            t: 'new-session',
            id: 'session-2',
            createdAt: 1,
            updatedAt: 1,
        });
        expect(parsed.success).toBe(true);
    });

    // Regression: cold-onboarding "machine never shows up / can't start a new
    // session until app restart". When a machine is created, the server emits a
    // `new-machine` update (the only creation signal the user's app receives —
    // the `update-machine` companion is machine-scoped-only). Sync.handleUpdate
    // validates every update with ApiUpdateContainerSchema.safeParse() and
    // returns early on failure, so an unrecognized `new-machine` body is silently
    // dropped and the machine only appears after a full fetchMachines (restart /
    // socket reconnect). The body shape mirrors server buildNewMachineUpdate().
    it('accepts the server new-machine update body', () => {
        const parsed = ApiUpdateSchema.safeParse({
            t: 'new-machine',
            machineId: 'machine-1',
            seq: 1,
            metadata: 'encrypted-metadata',
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            dataEncryptionKey: 'base64-key',
            active: false,
            activeAt: 1700000000000,
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
        });
        expect(parsed.success).toBe(true);
    });

    it('accepts a full new-machine update container (the handleUpdate validation gate)', () => {
        const parsed = ApiUpdateContainerSchema.safeParse({
            id: 'update-1',
            seq: 42,
            createdAt: 1700000000000,
            body: {
                t: 'new-machine',
                machineId: 'machine-1',
                seq: 1,
                metadata: 'encrypted-metadata',
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                dataEncryptionKey: null,
                active: true,
                activeAt: 1700000000000,
                createdAt: 1700000000000,
                updatedAt: 1700000000000,
            },
        });
        expect(parsed.success).toBe(true);
    });

    it.each([
        { t: 'delete-session', sid: 'session-1' },
        { t: 'delete-machine', machineId: 'machine-1' },
        { t: 'delete-artifact', artifactId: 'artifact-1' },
    ])('accepts current and rolling-upgrade delete payloads for $t', (body) => {
        expect(ApiUpdateSchema.safeParse({ ...body, recordCreatedAt: 1_700_000_000_000 }).success).toBe(true);
        expect(ApiUpdateSchema.safeParse(body).success).toBe(true);
        expect(ApiUpdateSchema.safeParse({
            ...body,
            recordCreatedAt: Number.MAX_SAFE_INTEGER + 1,
        }).success).toBe(false);
    });

    it('bounds session delete identities before retaining deletion fences', () => {
        expect(ApiUpdateSchema.safeParse({
            t: 'delete-session',
            sid: '',
            recordCreatedAt: 1,
        }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({
            t: 'delete-session',
            sid: 'x'.repeat(65),
            recordCreatedAt: 1,
        }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({
            t: 'delete-session',
            sid: 'x'.repeat(64),
            recordCreatedAt: 1,
        }).success).toBe(true);
    });

    it('rejects non-positive or unsafe persistent update sequence numbers', () => {
        const body = {
            t: 'delete-session',
            sid: 'session-1',
        };
        expect(ApiUpdateContainerSchema.safeParse({
            id: 'update-zero',
            seq: 0,
            createdAt: 1,
            body,
        }).success).toBe(false);
        expect(ApiUpdateContainerSchema.safeParse({
            id: 'update-unsafe',
            seq: Number.MAX_SAFE_INTEGER + 1,
            createdAt: 1,
            body,
        }).success).toBe(false);
        expect(ApiUpdateContainerSchema.safeParse({
            id: 'update-invalid-date',
            seq: 1,
            createdAt: 253_402_300_799_001,
            body,
        }).success).toBe(false);
    });

    it('bounds persistent update identities before retaining them for replay detection', () => {
        const update = {
            seq: 1,
            createdAt: 1,
            body: { t: 'delete-session', sid: 'session-1' },
        };
        expect(ApiUpdateContainerSchema.safeParse({ ...update, id: '' }).success).toBe(false);
        expect(ApiUpdateContainerSchema.safeParse({ ...update, id: 'x'.repeat(129) }).success).toBe(false);
        expect(ApiUpdateContainerSchema.safeParse({ ...update, id: 'x'.repeat(128) }).success).toBe(true);
    });

    it('bounds live machine creation and deletion fields at the relay contract', () => {
        const machine = {
            t: 'new-machine',
            machineId: 'm'.repeat(64),
            seq: 1,
            metadata: 'm'.repeat(16_384),
            metadataVersion: 1,
            daemonState: 'd'.repeat(65_536),
            daemonStateVersion: 1,
            dataEncryptionKey: 'k'.repeat(1_024),
            active: false,
            activeAt: 1,
            createdAt: 1,
            updatedAt: 1,
        };

        expect(ApiUpdateSchema.safeParse(machine).success).toBe(true);
        expect(ApiUpdateSchema.safeParse({ ...machine, machineId: 'm'.repeat(65) }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({ ...machine, metadata: 'm'.repeat(16_385) }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({ ...machine, daemonState: 'd'.repeat(65_537) }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({ ...machine, dataEncryptionKey: 'k'.repeat(1_025) }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({ t: 'delete-machine', machineId: 'm'.repeat(65) }).success).toBe(false);
    });

    it('bounds account, artifact, and KV update amplification before reducer work', () => {
        expect(ApiUpdateSchema.safeParse({
            t: 'update-account',
            id: 'a'.repeat(64),
            settings: { value: 's'.repeat(16_384), version: 1 },
            firstName: 'f'.repeat(256),
            lastName: 'l'.repeat(256),
        }).success).toBe(true);
        expect(ApiUpdateSchema.safeParse({ t: 'update-account', id: 'a'.repeat(65) }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({
            t: 'update-account',
            id: 'account-1',
            settings: { value: 's'.repeat(16_385), version: 1 },
        }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({
            t: 'update-account',
            id: 'account-1',
            firstName: 'f'.repeat(257),
        }).success).toBe(false);

        const artifact = {
            t: 'new-artifact',
            artifactId: 'a'.repeat(64),
            header: 'h'.repeat(16_384),
            headerVersion: 1,
            body: 'b'.repeat(65_536),
            bodyVersion: 1,
            dataEncryptionKey: 'k'.repeat(1_024),
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
        };
        expect(ApiUpdateSchema.safeParse(artifact).success).toBe(true);
        expect(ApiUpdateSchema.safeParse({ ...artifact, artifactId: 'a'.repeat(65) }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({ ...artifact, header: 'h'.repeat(16_385) }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({ ...artifact, body: 'b'.repeat(65_537) }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({ ...artifact, dataEncryptionKey: 'k'.repeat(1_025) }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({
            t: 'update-artifact',
            artifactId: 'artifact-1',
            header: { value: 'h'.repeat(16_385), version: 1 },
        }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({ t: 'delete-artifact', artifactId: 'a'.repeat(65) }).success).toBe(false);

        const change = { key: 'k'.repeat(128), value: 'v'.repeat(65_536), version: 1 };
        expect(ApiUpdateSchema.safeParse({
            t: 'kv-batch-update',
            changes: Array.from({ length: 100 }, () => change),
        }).success).toBe(true);
        expect(ApiUpdateSchema.safeParse({
            t: 'kv-batch-update',
            changes: Array.from({ length: 101 }, () => change),
        }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({
            t: 'kv-batch-update',
            changes: [{ ...change, key: 'k'.repeat(129) }],
        }).success).toBe(false);
        expect(ApiUpdateSchema.safeParse({
            t: 'kv-batch-update',
            changes: [{ ...change, value: 'v'.repeat(65_537) }],
        }).success).toBe(false);
    });
});

describe('ApiEphemeralUpdateSchema', () => {
    it('bounds activity identities and timestamps', () => {
        expect(ApiEphemeralUpdateSchema.safeParse({
            type: 'activity',
            id: 's'.repeat(64),
            active: true,
            activeAt: 253_402_300_799_000,
            thinking: false,
        }).success).toBe(true);
        expect(ApiEphemeralUpdateSchema.safeParse({
            type: 'activity',
            id: 's'.repeat(65),
            active: true,
            activeAt: 1,
            thinking: false,
        }).success).toBe(false);
        expect(ApiEphemeralUpdateSchema.safeParse({
            type: 'machine-activity',
            id: 'machine-1',
            active: true,
            activeAt: Number.POSITIVE_INFINITY,
        }).success).toBe(false);
        expect(ApiEphemeralUpdateSchema.safeParse({
            type: 'machine-activity',
            id: 'machine-1',
            active: true,
            activeAt: 253_402_300_799_001,
        }).success).toBe(false);
    });

    it('enforces the server usage-report numeric contract', () => {
        const usage = {
            type: 'usage',
            id: 'session-1',
            key: 'claude-session',
            timestamp: 1,
            tokens: {
                total: 4,
                input: 1,
                output: 1,
                cache_creation: 1,
                cache_read: 1,
            },
            cost: { total: 3, input: 1, output: 2 },
        };
        expect(ApiEphemeralUpdateSchema.safeParse(usage).success).toBe(true);
        expect(ApiEphemeralUpdateSchema.safeParse({ ...usage, key: 'x'.repeat(129) }).success).toBe(false);
        expect(ApiEphemeralUpdateSchema.safeParse({
            ...usage,
            tokens: { ...usage.tokens, total: 5 },
        }).success).toBe(false);
        expect(ApiEphemeralUpdateSchema.safeParse({
            ...usage,
            tokens: { ...usage.tokens, input: 1_000_000_001, total: 1_000_000_004 },
        }).success).toBe(false);
        expect(ApiEphemeralUpdateSchema.safeParse({
            ...usage,
            cost: { ...usage.cost, total: Number.NaN },
        }).success).toBe(false);
    });

    it('bounds session-event text before notification work', () => {
        const event = {
            type: 'session-event',
            sessionId: 's'.repeat(64),
            kind: 'permission',
            title: 't'.repeat(200),
            body: 'b'.repeat(500),
            timestamp: 1,
        };
        expect(ApiEphemeralUpdateSchema.safeParse(event).success).toBe(true);
        expect(ApiEphemeralUpdateSchema.safeParse({ ...event, sessionId: 's'.repeat(65) }).success).toBe(false);
        expect(ApiEphemeralUpdateSchema.safeParse({ ...event, title: 't'.repeat(201) }).success).toBe(false);
        expect(ApiEphemeralUpdateSchema.safeParse({ ...event, body: 'b'.repeat(501) }).success).toBe(false);
        expect(ApiEphemeralUpdateSchema.safeParse({ ...event, timestamp: -1 }).success).toBe(false);
    });
});
