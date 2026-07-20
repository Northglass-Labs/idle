import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthenticatedSessionFieldEnvelope } from '@northglass/idle-wire';

const mocks = vi.hoisted(() => {
    const sessionApplyContexts: unknown[] = [];
    let authenticatedAgentStates = new WeakSet<object>();
    let authenticatedMetadata = new WeakSet<object>();
    const state: any = {
        sessions: {},
        machines: {},
        artifacts: {},
        profile: {
            id: 'account-a',
            timestamp: 0,
            firstName: null,
            lastName: null,
            avatar: null,
            github: null,
        },
        settings: {},
        settingsVersion: 0,
        failedMessageDrafts: {},
        setFailedMessageDraft: vi.fn(),
        getActiveSessions: () => Object.values(state.sessions).filter((session: any) => session.active),
        applySessions: (sessions: any[], context?: unknown) => {
            sessionApplyContexts.push(context);
            const effectContext = context as {
                effectfulAgentStateSessionIds?: ReadonlySet<string>;
                effectfulMetadataSessionIds?: ReadonlySet<string>;
            } | undefined;
            for (const session of sessions) {
                if (
                    session.agentState
                    && (
                        effectContext?.effectfulAgentStateSessionIds?.has(session.id)
                        || authenticatedAgentStates.has(session.agentState)
                    )
                ) {
                    authenticatedAgentStates.add(session.agentState);
                }
                if (
                    session.metadata
                    && (
                        effectContext?.effectfulMetadataSessionIds?.has(session.id)
                        || authenticatedMetadata.has(session.metadata)
                    )
                ) {
                    authenticatedMetadata.add(session.metadata);
                }
                state.sessions[session.id] = session;
            }
        },
        applyMachines: (machines: any[]) => {
            for (const machine of machines) state.machines[machine.id] = machine;
        },
        applyProfile: (profile: any) => {
            state.profile = profile;
        },
        applySettings: (settings: any, version: number) => {
            if (state.settingsVersion === null || state.settingsVersion < version) {
                state.settings = settings;
                state.settingsVersion = version;
            }
        },
        deleteSession: (id: string) => delete state.sessions[id],
        deleteMachine: (id: string) => delete state.machines[id],
        addArtifact: (artifact: any) => {
            state.artifacts[artifact.id] = artifact;
        },
        updateArtifact: (artifact: any) => {
            state.artifacts[artifact.id] = artifact;
        },
        deleteArtifact: (id: string) => delete state.artifacts[id],
    };
    const storage: any = () => undefined;
    storage.getState = () => state;
    const replayFencePersistence = {
        ciphertext: null as string | null,
        save: vi.fn((ciphertext: string) => {
            writeOrder.push('blob');
            replayFencePersistence.ciphertext = ciphertext;
        }),
    };
    const writeOrder: string[] = [];
    const replayFenceAnchorPersistence = {
        result: {
            status: 'missing' as const,
            protection: 'device-secure' as const,
        } as any,
        load: vi.fn(async () => replayFenceAnchorPersistence.result),
        save: vi.fn(async (anchor: unknown) => {
            writeOrder.push('anchor');
            replayFenceAnchorPersistence.result = {
                status: 'available',
                protection: 'device-secure',
                anchor,
            };
        }),
    };

    return {
        state,
        storage,
        gitInvalidate: vi.fn(),
        permissionRequested: vi.fn(),
        sessionOnline: vi.fn(),
        sessionOffline: vi.fn(),
        sessionFocus: vi.fn(),
        artifactDecryptHeader: vi.fn(),
        artifactDecryptBody: vi.fn(),
        trackMessageSent: vi.fn(),
        sessionApplyContexts,
        replayFencePersistence,
        replayFenceAnchorPersistence,
        writeOrder,
        isAgentStateAuthenticatedForEffects: (value: unknown) => (
            typeof value === 'object'
            && value !== null
            && authenticatedAgentStates.has(value)
        ),
        isMetadataAuthenticatedForEffects: (value: unknown) => (
            typeof value === 'object'
            && value !== null
            && authenticatedMetadata.has(value)
        ),
        markAuthenticatedAgentState: (value: object) => authenticatedAgentStates.add(value),
        markAuthenticatedMetadata: (value: object) => authenticatedMetadata.add(value),
        resetAuthenticatedValues: () => {
            authenticatedAgentStates = new WeakSet<object>();
            authenticatedMetadata = new WeakSet<object>();
        },
    };
});

vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('expo-crypto', () => ({
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digestStringAsync: vi.fn(async (_algorithm: string, value: string) => {
        let hash = 2_166_136_261;
        for (let index = 0; index < value.length; index += 1) {
            hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
        }
        return `digest:${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }),
}));
vi.mock('expo-notifications', () => ({
    scheduleNotificationAsync: vi.fn(),
    cancelScheduledNotificationAsync: vi.fn(),
}));
vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    AppState: { currentState: 'active', addEventListener: vi.fn() },
}));
vi.mock('@/sync/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onReconnected: vi.fn(),
        sendAppState: vi.fn(),
    },
    getCurrentAppState: () => 'active',
    getIdleClientId: () => 'app/test',
}));
vi.mock('@/sync/encryption/encryption', () => ({ Encryption: { create: vi.fn() } }));
vi.mock('./encryption/artifactEncryption', () => ({
    ArtifactEncryption: class {
        static generateDataEncryptionKey() {
            return new Uint8Array(32);
        }
        async decryptHeader(value: string) {
            return mocks.artifactDecryptHeader(value);
        }
        async decryptBody(value: string) {
            return mocks.artifactDecryptBody(value);
        }
        async encryptHeader() {
            return 'encrypted-header';
        }
        async encryptBody() {
            return 'encrypted-body';
        }
    },
}));
vi.mock('./storage', () => ({
    storage: mocks.storage,
    isAgentStateAuthenticatedForEffects: mocks.isAgentStateAuthenticatedForEffects,
    isMetadataAuthenticatedForEffects: mocks.isMetadataAuthenticatedForEffects,
}));
vi.mock('./persistence', () => ({
    loadPendingSettings: () => ({}),
    savePendingSettings: vi.fn(),
    loadSessionFailedMessage: vi.fn(),
    loadSessionReplayFenceCiphertext: () => mocks.replayFencePersistence.ciphertext,
    saveSessionReplayFenceCiphertext: mocks.replayFencePersistence.save,
}));
vi.mock('./sessionReplayAnchor', () => ({
    loadSessionReplayAnchor: mocks.replayFenceAnchorPersistence.load,
    saveSessionReplayAnchor: mocks.replayFenceAnchorPersistence.save,
}));
vi.mock('./sessionOrderPersistence', () => ({
    getCachedSessionOrderV2: () => ({ groups: [], ungrouped: [] }),
    saveSessionOrderV2: vi.fn(),
}));
vi.mock('@/utils/notificationDismiss', () => ({
    dismissAllNotifications: vi.fn(),
    dismissSessionNotifications: vi.fn(),
}));
vi.mock('./pushRegistration', () => ({ syncCurrentPushToken: vi.fn() }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://relay.example' }));
vi.mock('./apiAttachments', () => ({
    requestAttachmentUpload: vi.fn(),
    uploadEncryptedBlob: vi.fn(),
}));
vi.mock('@/encryption/blob', () => ({ encryptBlob: vi.fn() }));
vi.mock('@/track', () => ({
    setTrackingConsent: vi.fn(),
    trackGitHubConnected: vi.fn(),
    trackMessageSent: mocks.trackMessageSent,
    trackPaywallCancelled: vi.fn(),
    trackPaywallError: vi.fn(),
    trackPaywallPresented: vi.fn(),
    trackPaywallPurchased: vi.fn(),
    trackPaywallRestored: vi.fn(),
}));
vi.mock('./revenueCat', () => ({ RevenueCat: {}, LogLevel: {}, PaywallResult: {} }));
vi.mock('@/config', () => ({ config: {} }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: vi.fn() }));
vi.mock('@/log', () => ({ log: { log: vi.fn() } }));
vi.mock('./gitStatusSync', () => ({
    gitStatusSync: {
        invalidate: mocks.gitInvalidate,
        clearForSession: vi.fn(),
        getSync: () => ({ invalidate: mocks.gitInvalidate }),
    },
}));
vi.mock('@/realtime/hooks/voiceHooks', () => ({
    voiceHooks: {
        onPermissionRequested: mocks.permissionRequested,
        onMessages: vi.fn(),
        onReady: vi.fn(),
        onSessionOnline: mocks.sessionOnline,
        onSessionOffline: mocks.sessionOffline,
        onSessionFocus: mocks.sessionFocus,
    },
}));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/encryption/aes', async () => await import('@/encryption/aes.web'));

import { Sync, sync } from './sync';
import { SessionEncryption } from './encryption/sessionEncryption';
import { EncryptionCache } from './encryption/encryptionCache';
import { AES256Encryption } from './encryption/encryptor';

function session(version = 0) {
    return {
        id: 'session-a',
        seq: 10,
        createdAt: 100,
        updatedAt: 100,
        active: true,
        activeAt: 100,
        metadata: { path: '/workspace', host: 'host' },
        metadataVersion: 0,
        agentState: {},
        agentStateVersion: version,
        thinking: false,
        thinkingAt: 0,
        presence: 'online' as const,
    };
}

function updateSession(id: string, seq: number, version: number, value: string) {
    return {
        id,
        seq,
        createdAt: 1_000 + seq,
        body: {
            t: 'update-session' as const,
            id: 'session-a',
            agentState: { version, value },
        },
    };
}

function machine(overrides: Record<string, unknown> = {}) {
    return {
        id: 'machine-a',
        seq: 3,
        createdAt: 200,
        updatedAt: 250,
        active: false,
        activeAt: 240,
        metadata: { host: 'current', platform: 'darwin', idleCliVersion: '1', idleHomeDir: '/idle', homeDir: '/home' },
        metadataVersion: 5,
        daemonState: { status: 'current' },
        daemonStateVersion: 7,
        ...overrides,
    };
}

function artifact(overrides: Record<string, unknown> = {}) {
    return {
        id: 'artifact-a',
        title: 'current',
        body: 'current body',
        headerVersion: 5,
        bodyVersion: 7,
        seq: 9,
        createdAt: 200,
        updatedAt: 250,
        isDecrypted: true,
        ...overrides,
    };
}

function container(id: string, seq: number, body: Record<string, unknown>, createdAt = 1_000 + seq) {
    return { id, seq, createdAt, body };
}

function snapshotSession(overrides: Record<string, unknown> = {}) {
    return {
        id: 'session-a',
        seq: 10,
        createdAt: 100,
        updatedAt: 100,
        active: true,
        activeAt: 100,
        metadata: 'encrypted-metadata',
        metadataVersion: 1,
        agentState: 'encrypted-agent-state',
        agentStateVersion: 1,
        dataEncryptionKey: null,
        lastMessage: null,
        ...overrides,
    };
}

function sessionsResponse(sessions: Record<string, unknown>[]) {
    return new Response(JSON.stringify({ sessions }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

function replayFenceTestEncryption(dataKey: Uint8Array) {
    const aead = new AES256Encryption(dataKey);
    const installed = new Map<string, SessionEncryption>();
    return {
        aead,
        encryption: {
            decryptEncryptionKey: vi.fn(async () => dataKey),
            openEncryption: vi.fn(async () => aead),
            getSessionEncryption: (sessionId: string) => installed.get(sessionId) ?? null,
            initializeSessions: vi.fn(async (keys: Map<string, Uint8Array | null>) => {
                for (const sessionId of keys.keys()) {
                    installed.set(sessionId, new SessionEncryption(
                        sessionId,
                        aead,
                        new EncryptionCache(),
                    ));
                }
            }),
            removeSessionEncryption: vi.fn((sessionId: string) => {
                installed.delete(sessionId);
            }),
            encryptRaw: vi.fn(async (value: unknown) => (
                Buffer.from(JSON.stringify(value)).toString('base64')
            )),
            decryptRaw: vi.fn(async (ciphertext: string) => {
                try {
                    return JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf8'));
                } catch {
                    return null;
                }
            }),
        },
    };
}

function createTestSync(): Sync {
    const instance = new Sync();
    (instance as any).serverID = 'account-a';
    if (mocks.state.sessions['session-a']) {
        (instance as any).sessionDataKeys = new Map([['session-a', null]]);
    }
    let encryption: any;
    Object.defineProperty(instance, 'encryption', {
        configurable: true,
        get: () => encryption,
        set: (value: any) => {
            encryption = {
                encryptRaw: vi.fn(async (payload: unknown) => (
                    Buffer.from(JSON.stringify(payload)).toString('base64')
                )),
                decryptRaw: vi.fn(async (ciphertext: string) => {
                    try {
                        return JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf8'));
                    } catch {
                        return null;
                    }
                }),
                ...value,
            };
        },
    });
    return instance;
}

describe('persistent update replay and ordering boundary', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        mocks.state.sessions = { 'session-a': session() };
        mocks.state.machines = {};
        mocks.state.artifacts = {};
        mocks.state.profile = {
            id: 'account-a',
            timestamp: 0,
            firstName: null,
            lastName: null,
            avatar: null,
            github: null,
        };
        mocks.state.settings = {};
        mocks.state.settingsVersion = 0;
        mocks.state.failedMessageDrafts = {};
        mocks.gitInvalidate.mockClear();
        mocks.permissionRequested.mockClear();
        mocks.sessionOnline.mockClear();
        mocks.sessionOffline.mockClear();
        mocks.sessionFocus.mockClear();
        mocks.artifactDecryptHeader.mockReset();
        mocks.artifactDecryptBody.mockReset();
        mocks.trackMessageSent.mockReset();
        mocks.sessionApplyContexts.length = 0;
        mocks.replayFencePersistence.ciphertext = null;
        mocks.replayFencePersistence.save.mockClear();
        mocks.replayFenceAnchorPersistence.result = {
            status: 'missing',
            protection: 'device-secure',
        };
        mocks.replayFenceAnchorPersistence.load.mockClear();
        mocks.replayFenceAnchorPersistence.save.mockClear();
        mocks.writeOrder.length = 0;
        mocks.resetAuthenticatedValues();
        (sync as any).serverID = 'account-a';
        (sync as any).sessionLastSeq = new Map();
        (sync as any).messagesSync = new Map();
        (sync as any).sessionMessageLocks = new Map();
        (sync as any).sessionMessageQueue = new Map();
        (sync as any).sessionQueueProcessing = new Set();
        (sync as any).sessionDataKeys = new Map();
        (sync as any).machineDataKeys = new Map();
        (sync as any).artifactDataKeys = new Map();
        (sync as any).recentPersistentUpdateIds?.clear();
        (sync as any).recentPersistentMessageReplayKeys?.clear();
        (sync as any).recentPermissionRequestReplayKeys?.clear();
        (sync as any).sessionDeletionTombstones?.clear();
        (sync as any).sessionDeletionTombstonesSaturated = false;
        (sync as any).sessionReplayFences = new Map();
        (sync as any).sessionReplayProtectionState = 'ready';
        (sync as any).sessionSnapshotEpoch = 0;
    });

    it('serializes concurrent persistent updates so delayed decryption cannot downgrade state', async () => {
        let releaseFirst!: () => void;
        let firstDecryptStarted!: () => void;
        const firstStarted = new Promise<void>((resolve) => {
            firstDecryptStarted = resolve;
        });
        const firstBlocked = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const decryptAgentState = async (_version: number, value: string) => {
            if (value === 'slow-v1') {
                firstDecryptStarted();
                await firstBlocked;
            }
            return { marker: value };
        };
        (sync as any).encryption = {
            getSessionEncryption: () => ({
                decryptAgentState,
                decryptAgentStateResult: async (version: number, value: string) => ({
                    success: true,
                    value: await decryptAgentState(version, value),
                }),
                decryptMetadataResult: vi.fn(),
            }),
        };

        const first = (sync as any).handleUpdate(updateSession('update-1', 1, 1, 'slow-v1'));
        await firstStarted;
        const second = (sync as any).handleUpdate(updateSession('update-2', 2, 2, 'fast-v2'));
        await Promise.resolve();
        releaseFirst();
        await Promise.all([first, second]);

        expect(mocks.state.sessions['session-a'].agentStateVersion).toBe(2);
        expect(mocks.state.sessions['session-a'].agentState).toEqual({ marker: 'fast-v2' });
    });

    it('rejects authentic v1 fields relabeled v999 in a fresh Sync and decryption cache', async () => {
        mocks.state.sessions = { 'session-a': session() };
        const aead = new AES256Encryption(new Uint8Array(32).fill(5));
        const [capturedBytes] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                1,
                {
                    controlledByUser: false,
                    requests: {
                        captured: {
                            tool: 'Bash',
                            arguments: { command: 'pwd' },
                            createdAt: 1,
                        },
                    },
                },
            ),
        ]);
        const captured = Buffer.from(capturedBytes).toString('base64');
        const [capturedMetadataBytes] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'metadata',
                1,
                { path: '/captured', host: 'relay-replay' },
            ),
        ]);
        const capturedMetadata = Buffer.from(capturedMetadataBytes).toString('base64');
        const reader = new SessionEncryption(
            'session-a',
            aead,
            new EncryptionCache(),
        );
        const freshSync = createTestSync();
        (freshSync as any).serverID = 'account-a';
        (freshSync as any).sessionsSync = { awaitQueue: vi.fn(), invalidate: vi.fn() };
        (freshSync as any).encryption = {
            getSessionEncryption: () => reader,
        };

        await (freshSync as any).handleUpdate(container(
            'relay-rewrapped-after-restart',
            999,
            {
                t: 'update-session',
                id: 'session-a',
                agentState: { version: 999, value: captured },
                metadata: { version: 999, value: capturedMetadata },
            },
        ));

        expect(mocks.state.sessions['session-a']).toMatchObject({
            agentState: {},
            agentStateVersion: 0,
            metadata: { path: '/workspace', host: 'host' },
            metadataVersion: 0,
            seq: 10,
        });
        expect(mocks.permissionRequested).not.toHaveBeenCalled();
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
    });

    it('uses prior authenticated state as the permission replay boundary after restart', async () => {
        const prior = session(1);
        prior.agentState = {
            requests: {
                'request-1': {
                    tool: 'Bash',
                    arguments: { command: 'pwd' },
                    createdAt: 1,
                },
            },
        };
        mocks.markAuthenticatedAgentState(prior.agentState);
        mocks.markAuthenticatedMetadata(prior.metadata);
        mocks.state.sessions = { 'session-a': prior };
        const aead = new AES256Encryption(new Uint8Array(32).fill(6));
        const [nextBytes] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                2,
                {
                    requests: {
                        'request-1': {
                            tool: 'Bash',
                            arguments: { command: 'pwd' },
                            createdAt: 1,
                        },
                        'request-2': {
                            tool: 'Write',
                            arguments: { file_path: '/workspace/new.txt' },
                            createdAt: 2,
                        },
                    },
                },
            ),
        ]);
        const freshSync = createTestSync();
        (freshSync as any).serverID = 'account-a';
        (freshSync as any).sessionsSync = { awaitQueue: vi.fn(), invalidate: vi.fn() };
        (freshSync as any).encryption = {
            getSessionEncryption: () => new SessionEncryption(
                'session-a',
                aead,
                new EncryptionCache(),
            ),
        };

        await (freshSync as any).handleUpdate(updateSession(
            'bound-permission-update-after-restart',
            2,
            2,
            Buffer.from(nextBytes).toString('base64'),
        ));

        expect(mocks.state.sessions['session-a'].agentStateVersion).toBe(2);
        expect(mocks.permissionRequested).toHaveBeenCalledTimes(1);
        expect(mocks.permissionRequested).toHaveBeenCalledWith(
            'session-a',
            'request-2',
            'Write',
        );
    });

    it('keeps readable legacy state side-effect-free on the live update path', async () => {
        mocks.state.sessions = { 'session-a': session(1) };
        const aead = new AES256Encryption(new Uint8Array(32).fill(8));
        const legacyValue = {
            requests: {
                legacy: {
                    tool: 'Bash',
                    arguments: { command: 'pwd' },
                    createdAt: 1,
                },
            },
        };
        const [legacyBytes] = await aead.encrypt([legacyValue]);
        const legacyCiphertext = Buffer.from(legacyBytes).toString('base64');
        const reader = new SessionEncryption(
            'session-a',
            aead,
            new EncryptionCache(),
        );
        await expect(reader.decryptAgentState(1, legacyCiphertext)).resolves.toEqual(legacyValue);

        const freshSync = createTestSync();
        (freshSync as any).serverID = 'account-a';
        (freshSync as any).sessionsSync = { awaitQueue: vi.fn(), invalidate: vi.fn() };
        (freshSync as any).encryption = { getSessionEncryption: () => reader };
        await (freshSync as any).handleUpdate(updateSession(
            'legacy-live-state',
            2,
            2,
            legacyCiphertext,
        ));

        expect(mocks.state.sessions['session-a'].agentStateVersion).toBe(1);
        expect(mocks.permissionRequested).not.toHaveBeenCalled();
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
    });

    it('does not use legacy agent state as a permission or control-transition baseline', async () => {
        const prior = session(1);
        prior.agentState = {
            controlledByUser: true,
            requests: {
                replayed: {
                    tool: 'Write',
                    arguments: { file_path: '/workspace/replayed.txt' },
                    createdAt: 1,
                },
            },
        };
        mocks.markAuthenticatedMetadata(prior.metadata);
        mocks.state.sessions = { 'session-a': prior };
        const onSessionVisible = vi.fn();
        const freshSync = createTestSync();
        (freshSync as any).serverID = 'account-a';
        (freshSync as any).sessionsSync = { awaitQueue: vi.fn(), invalidate: vi.fn() };
        (freshSync as any).onSessionVisible = onSessionVisible;
        (freshSync as any).encryption = {
            getSessionEncryption: () => ({
                decryptAgentStateResult: vi.fn(async () => ({
                    success: true as const,
                    binding: 'bound' as const,
                    value: {
                        controlledByUser: true,
                        requests: {
                            replayed: {
                                tool: 'Write',
                                arguments: { file_path: '/workspace/replayed.txt' },
                                createdAt: 1,
                            },
                        },
                    },
                })),
                decryptMetadataResult: vi.fn(),
            }),
        };

        await (freshSync as any).handleUpdate(updateSession(
            'first-bound-after-legacy',
            2,
            2,
            'bound-v2',
        ));

        expect(mocks.permissionRequested).toHaveBeenCalledWith(
            'session-a',
            'replayed',
            'Write',
        );
        expect(onSessionVisible).toHaveBeenCalledOnce();

        mocks.permissionRequested.mockClear();
        onSessionVisible.mockClear();
        await (freshSync as any).handleUpdate(updateSession(
            'second-bound-after-trust',
            3,
            3,
            'bound-v3',
        ));
        expect(mocks.permissionRequested).not.toHaveBeenCalled();
        expect(onSessionVisible).not.toHaveBeenCalled();
    });

    it('consumes an update identity before side effects so exact delivery replay is inert', async () => {
        const invalidate = vi.fn();
        (sync as any).sessionsSync = { invalidate, awaitQueue: vi.fn() };
        const update = container('same-update', 3, {
            t: 'new-session',
            id: 'session-new',
            createdAt: 300,
            updatedAt: 300,
        });

        await (sync as any).handleUpdate(update);
        await (sync as any).handleUpdate(update);

        expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it('rejects a stale message before decrypting or replaying lifecycle side effects', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'message-old',
            localId: 'local-old',
            createdAt: 100,
            content: {
                role: 'session',
                content: {
                    type: 'session',
                    data: { id: 'turn-old', time: 100, role: 'agent', ev: { t: 'turn-start' } },
                },
            },
        }));
        (sync as any).encryption = {
            getSessionEncryption: () => ({ decryptMessage }),
            encryptRaw: vi.fn(async (payload: unknown) => (
                Buffer.from(JSON.stringify(payload)).toString('base64')
            )),
        };
        (sync as any).sessionLastSeq = new Map([['session-a', 10]]);
        (sync as any).messagesSync = new Map([['session-a', { invalidate: vi.fn() }]]);

        await (sync as any).handleUpdate(container('message-replay', 4, {
            t: 'new-message',
            sid: 'session-a',
            message: {
                id: 'message-old',
                seq: 5,
                localId: 'local-old',
                content: { t: 'encrypted', c: 'AAAA' },
                createdAt: 100,
                updatedAt: 100,
            },
        }));

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(mocks.state.sessions['session-a'].thinking).toBe(false);
    });

    it('persists the accepted live message tip before applying its side effects', async () => {
        const current = session(1) as any;
        mocks.state.sessions = { 'session-a': current };
        const decryptMessage = vi.fn(async () => ({
            id: 'message-11',
            localId: 'local-11',
            createdAt: 200,
            content: {
                messageIdentity: { v: 1, sessionId: 'session-a', messageId: 'local-11' },
                role: 'user',
                content: { type: 'text', text: 'durable tip' },
            },
        }));
        (sync as any).encryption = {
            getSessionEncryption: () => ({ decryptMessage }),
            encryptRaw: vi.fn(async (payload: unknown) => (
                Buffer.from(JSON.stringify(payload)).toString('base64')
            )),
        };
        (sync as any).sessionLastSeq = new Map([['session-a', 10]]);
        (sync as any).sessionDataKeys = new Map([['session-a', null]]);
        (sync as any).sessionReplayFences = new Map([[
            'session-a',
            {
                sessionId: 'session-a',
                createdAt: 100,
                metadataVersion: 1,
                metadataCiphertextCommitment: 'metadata-v1',
                agentStateVersion: 1,
                agentStateCiphertextCommitment: 'agent-v1',
                dataKeyFingerprint: 'legacy-master-key',
            },
        ]]);
        mocks.replayFencePersistence.save.mockClear();

        await (sync as any).handleUpdate(container('message-tip-live', 26, {
            t: 'new-message',
            sid: 'session-a',
            message: {
                id: 'message-11',
                seq: 11,
                localId: 'local-11',
                content: { t: 'encrypted', c: 'AQID' },
                createdAt: 200,
                updatedAt: 200,
            },
        }));

        expect((sync as any).sessionReplayFences.get('session-a')).toMatchObject({
            messageSeq: 11,
            messageCiphertextCommitment: expect.stringMatching(/^digest:/),
        });
        expect(mocks.replayFencePersistence.save).toHaveBeenCalled();
        expect((sync as any).sessionLastSeq.get('session-a')).toBe(11);
    });

    it('rejects a different ciphertext relabeled at the durable message tip', async () => {
        const acceptedMessage = {
            id: 'message-11',
            seq: 11,
            localId: 'local-11',
            content: { t: 'encrypted' as const, c: 'AQID' },
            createdAt: 200,
            updatedAt: 200,
        };
        const commitment = await (sync as any).messageCiphertextCommitment(
            'session-a',
            acceptedMessage,
        );
        (sync as any).sessionReplayFences = new Map([[
            'session-a',
            {
                sessionId: 'session-a',
                createdAt: 100,
                metadataVersion: 1,
                metadataCiphertextCommitment: 'metadata-v1',
                agentStateVersion: 1,
                agentStateCiphertextCommitment: 'agent-v1',
                dataKeyFingerprint: 'legacy-master-key',
                messageSeq: 11,
                messageCiphertextCommitment: commitment,
            },
        ]]);
        const applyMessages = vi.spyOn(sync as any, 'applyMessages').mockImplementation(() => undefined);
        const encryption = {
            decryptMessages: vi.fn(async () => [{
                id: 'substitute-11',
                localId: 'substitute-local-11',
                createdAt: 201,
                content: {
                    messageIdentity: {
                        v: 1,
                        sessionId: 'session-a',
                        messageId: 'substitute-local-11',
                    },
                    role: 'user',
                    content: { type: 'text', text: 'captured substitute' },
                },
            }]),
        };

        try {
            await expect((sync as any).applyFetchedMessages('session-a', encryption, [{
                ...acceptedMessage,
                id: 'substitute-11',
                localId: 'substitute-local-11',
                content: { t: 'encrypted', c: 'BAUG' },
                createdAt: 201,
                updatedAt: 201,
            }])).rejects.toThrow(/message replay floor/i);
            expect(applyMessages).not.toHaveBeenCalled();
        } finally {
            applyMessages.mockRestore();
        }
    });

    it.each([
        ['empty', []],
        ['truncated', [{
            id: 'message-10',
            seq: 10,
            localId: 'local-10',
            content: { t: 'encrypted' as const, c: 'AQID' },
            createdAt: 190,
            updatedAt: 190,
        }]],
    ])('rejects an %s tip-bearing page below the durable message floor', async (_label, messages) => {
        (sync as any).sessionReplayFences = new Map([[
            'session-a',
            {
                sessionId: 'session-a',
                createdAt: 100,
                metadataVersion: 1,
                metadataCiphertextCommitment: 'metadata-v1',
                agentStateVersion: 1,
                agentStateCiphertextCommitment: 'agent-v1',
                dataKeyFingerprint: 'legacy-master-key',
                messageSeq: 11,
                messageCiphertextCommitment: 'message-v11',
            },
        ]]);
        const encryption = {
            decryptMessages: vi.fn(async () => messages.map((message) => ({
                id: message.id,
                localId: message.localId,
                createdAt: message.createdAt,
                content: {
                    messageIdentity: {
                        v: 1,
                        sessionId: 'session-a',
                        messageId: message.localId,
                    },
                    role: 'user',
                    content: { type: 'text', text: 'rolled back' },
                },
            }))),
        };

        await expect((sync as any).applyFetchedMessages(
            'session-a',
            encryption,
            messages,
            'tip',
        )).rejects.toThrow(/message replay floor/i);
        expect((sync as any).recentPersistentMessageReplayKeys.size).toBe(0);
    });

    it('allows authenticated older-history pages without moving the durable tip', async () => {
        const fence = {
            sessionId: 'session-a',
            createdAt: 100,
            metadataVersion: 1,
            metadataCiphertextCommitment: 'metadata-v1',
            agentStateVersion: 1,
            agentStateCiphertextCommitment: 'agent-v1',
            dataKeyFingerprint: 'legacy-master-key',
            messageSeq: 11,
            messageCiphertextCommitment: 'message-v11',
        };
        (sync as any).sessionReplayFences = new Map([['session-a', fence]]);
        const applyMessages = vi.spyOn(sync as any, 'applyMessages').mockImplementation(() => undefined);
        const message = {
            id: 'message-5',
            seq: 5,
            localId: 'local-5',
            content: { t: 'encrypted' as const, c: 'AQID' },
            createdAt: 150,
            updatedAt: 150,
        };
        const encryption = {
            decryptMessages: vi.fn(async () => [{
                id: message.id,
                localId: message.localId,
                createdAt: message.createdAt,
                content: {
                    messageIdentity: { v: 1, sessionId: 'session-a', messageId: message.localId },
                    role: 'user',
                    content: { type: 'text', text: 'older history' },
                },
            }]),
        };

        try {
            await (sync as any).applyFetchedMessages('session-a', encryption, [message], 'history');
            expect(applyMessages).toHaveBeenCalledOnce();
            expect((sync as any).sessionReplayFences.get('session-a')).toEqual(fence);
        } finally {
            applyMessages.mockRestore();
        }
    });

    it('cannot roll the message cursor back behind a concurrent catch-up fetch', async () => {
        let releaseFetch!: () => void;
        let releaseDecrypt!: () => void;
        const fetchGate = new Promise<void>((resolve) => {
            releaseFetch = resolve;
        });
        const decryptGate = new Promise<void>((resolve) => {
            releaseDecrypt = resolve;
        });
        const decryptMessage = vi.fn(async (message: any) => {
            await decryptGate;
            return {
                id: message.id,
                localId: message.localId,
                createdAt: message.createdAt,
                content: {
                    messageIdentity: { v: 1, sessionId: 'session-a', messageId: 'cursor-race-local' },
                    role: 'user',
                    content: { type: 'text', text: 'delayed push' },
                },
            };
        });
        (sync as any).encryption = {
            getSessionEncryption: () => ({ decryptMessage }),
        };
        (sync as any).sessionLastSeq = new Map([['session-a', 10]]);
        (sync as any).messagesSync = new Map([['session-a', { invalidate: vi.fn() }]]);

        const messageLock = (sync as any).getSessionMessageLock('session-a');
        const catchUp = messageLock.inLock(async () => {
            await fetchGate;
            (sync as any).sessionLastSeq.set('session-a', 12);
        });
        const pushed = (sync as any).handleUpdate(container('message-fetch-race', 25, {
            t: 'new-message',
            sid: 'session-a',
            message: {
                id: 'cursor-race-message',
                seq: 11,
                localId: 'cursor-race-local',
                content: { t: 'encrypted', c: 'AQID' },
                createdAt: 200,
                updatedAt: 200,
            },
        }));

        // Give an unlocked push handler time to pass its stale cursor check
        // and block in decryption while the catch-up owns the session lock.
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseFetch();
        await catchUp;
        releaseDecrypt();
        await pushed;

        expect((sync as any).sessionLastSeq.get('session-a')).toBe(12);
    });

    it('rejects a message whose authenticated identity belongs to another session', async () => {
        const invalidate = vi.fn();
        const enqueueMessages = vi.spyOn(sync as any, 'enqueueMessages').mockImplementation(() => undefined);
        const decryptMessage = vi.fn(async () => ({
            id: 'message-new',
            localId: 'local-new',
            createdAt: 200,
            content: {
                messageIdentity: {
                    v: 1,
                    sessionId: 'session-b',
                    messageId: 'local-new',
                },
                role: 'session',
                content: {
                    type: 'session',
                    data: {
                        id: 'turn-new',
                        time: 200,
                        role: 'agent',
                        turn: 'turn-new',
                        ev: { t: 'turn-start' },
                    },
                },
            },
        }));
        (sync as any).encryption = {
            getSessionEncryption: () => ({ decryptMessage }),
        };
        (sync as any).sessionLastSeq = new Map([['session-a', 10]]);
        (sync as any).messagesSync = new Map([['session-a', { invalidate }]]);

        try {
            await (sync as any).handleUpdate(container('message-cross-session', 16, {
                t: 'new-message',
                sid: 'session-a',
                message: {
                    id: 'message-new',
                    seq: 11,
                    localId: 'local-new',
                    content: { t: 'encrypted', c: 'AAAA' },
                    createdAt: 200,
                    updatedAt: 200,
                },
            }));

            expect(decryptMessage).toHaveBeenCalledOnce();
            expect(enqueueMessages).not.toHaveBeenCalled();
            expect(invalidate).toHaveBeenCalledOnce();
            expect(mocks.state.sessions['session-a']).toMatchObject({ thinking: false, seq: 10 });
            expect((sync as any).sessionLastSeq.get('session-a')).toBe(10);
        } finally {
            enqueueMessages.mockRestore();
        }
    });

    it('rejects a captured authenticated message rewrapped at a later sequence', async () => {
        const invalidate = vi.fn();
        const enqueueMessages = vi.spyOn(sync as any, 'enqueueMessages').mockImplementation(() => undefined);
        const decryptMessage = vi.fn(async (message: any) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: {
                messageIdentity: {
                    v: 1,
                    sessionId: 'session-a',
                    messageId: 'local-replay',
                },
                role: 'user',
                content: { type: 'text', text: 'run once' },
            },
        }));
        (sync as any).encryption = {
            getSessionEncryption: () => ({ decryptMessage }),
        };
        (sync as any).sessionLastSeq = new Map([['session-a', 10]]);
        (sync as any).messagesSync = new Map([['session-a', { invalidate }]]);

        const messageBody = (id: string, seq: number) => ({
            t: 'new-message',
            sid: 'session-a',
            message: {
                id,
                seq,
                localId: 'local-replay',
                content: { t: 'encrypted', c: 'AQID' },
                createdAt: 200,
                updatedAt: 200,
            },
        });

        try {
            await (sync as any).handleUpdate(container('message-first-delivery', 17, messageBody('message-first', 11)));
            await (sync as any).handleUpdate(container('message-rewrapped-replay', 18, messageBody('message-rewrapped', 12)));

            expect(enqueueMessages).toHaveBeenCalledOnce();
            // The accepted delivery refreshes the visible session once; the
            // rejected replay requests one catch-up rather than applying.
            expect(invalidate).toHaveBeenCalledTimes(2);
            expect((sync as any).sessionLastSeq.get('session-a')).toBe(11);
            expect(mocks.state.sessions['session-a'].seq).toBe(11);
        } finally {
            enqueueMessages.mockRestore();
        }
    });

    it('preserves legacy messages while rejecting exact legacy ciphertext replay', async () => {
        const invalidate = vi.fn();
        const enqueueMessages = vi.spyOn(sync as any, 'enqueueMessages').mockImplementation(() => undefined);
        const decryptMessage = vi.fn(async (message: any) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: {
                role: 'user',
                content: { type: 'text', text: 'legacy prompt' },
            },
        }));
        (sync as any).encryption = {
            getSessionEncryption: () => ({ decryptMessage }),
        };
        (sync as any).sessionLastSeq = new Map([['session-a', 10]]);
        (sync as any).messagesSync = new Map([['session-a', { invalidate }]]);

        const messageBody = (id: string, seq: number) => ({
            t: 'new-message',
            sid: 'session-a',
            message: {
                id,
                seq,
                localId: null,
                content: { t: 'encrypted', c: 'BAUG' },
                createdAt: 200,
                updatedAt: 200,
            },
        });

        try {
            await (sync as any).handleUpdate(container('legacy-message-first', 20, messageBody('legacy-first', 11)));
            await (sync as any).handleUpdate(container('legacy-message-replay', 21, messageBody('legacy-rewrapped', 12)));

            expect(enqueueMessages).toHaveBeenCalledOnce();
            expect((sync as any).sessionLastSeq.get('session-a')).toBe(11);
            expect(mocks.state.sessions['session-a'].seq).toBe(11);
        } finally {
            enqueueMessages.mockRestore();
        }
    });

    it('enforces authenticated identity during paginated message catch-up', async () => {
        const applyMessages = vi.spyOn(sync as any, 'applyMessages').mockImplementation(() => undefined);
        const messages = [
            {
                id: 'cross-session-row',
                seq: 11,
                localId: 'cross-local',
                content: { t: 'encrypted', c: 'AQID' },
                createdAt: 200,
                updatedAt: 200,
            },
            {
                id: 'valid-row',
                seq: 12,
                localId: 'valid-local',
                content: { t: 'encrypted', c: 'BAUG' },
                createdAt: 201,
                updatedAt: 201,
            },
        ];
        const encryption = {
            decryptMessages: vi.fn(async () => [
                {
                    id: 'cross-session-row',
                    localId: 'cross-local',
                    createdAt: 200,
                    content: {
                        messageIdentity: { v: 1, sessionId: 'session-b', messageId: 'cross-local' },
                        role: 'user',
                        content: { type: 'text', text: 'cross-session replay' },
                    },
                },
                {
                    id: 'valid-row',
                    localId: 'valid-local',
                    createdAt: 201,
                    content: {
                        messageIdentity: { v: 1, sessionId: 'session-a', messageId: 'valid-local' },
                        role: 'user',
                        content: { type: 'text', text: 'valid catch-up' },
                    },
                },
            ]),
        };

        try {
            await (sync as any).applyFetchedMessages('session-a', encryption, messages);

            expect(applyMessages).toHaveBeenCalledOnce();
            expect(applyMessages).toHaveBeenCalledWith('session-a', [
                expect.objectContaining({ id: 'valid-row', localId: 'valid-local' }),
            ]);
        } finally {
            applyMessages.mockRestore();
        }
    });

    it('does not advance versions or trigger side effects when fresh session ciphertext fails authentication', async () => {
        mocks.state.sessions = { 'session-a': session(5) };
        mocks.state.sessions['session-a'].metadataVersion = 7;
        const decryptAgentState = vi.fn(async () => ({
            requests: {
                forged: { tool: 'Bash', arguments: { command: 'open door' }, createdAt: 1 },
            },
        }));
        const decryptAgentStateResult = vi.fn(async () => ({ success: false as const }));
        const decryptMetadataResult = vi.fn(async () => ({ success: false as const }));
        (sync as any).encryption = {
            getSessionEncryption: () => ({
                decryptAgentState,
                decryptAgentStateResult,
                decryptMetadataResult,
            }),
        };

        await (sync as any).handleUpdate(container('bad-session-ciphertext', 19, {
            t: 'update-session',
            id: 'session-a',
            agentState: { version: 6, value: 'ciphertext-for-another-session' },
            metadata: { version: 8, value: 'bad-metadata' },
        }));

        expect(mocks.state.sessions['session-a']).toMatchObject({
            agentState: {},
            agentStateVersion: 5,
            metadata: { path: '/workspace', host: 'host' },
            metadataVersion: 7,
            seq: 10,
            updatedAt: 100,
        });
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
        expect(mocks.permissionRequested).not.toHaveBeenCalled();
    });

    it('does not let a failed snapshot authentication poison field versions or block the next bound update', async () => {
        const current = session(1) as any;
        current.metadataVersion = 1;
        current.agentState = { marker: 'current-v1' };
        mocks.state.sessions = { 'session-a': current };

        let acceptBoundUpdate = false;
        const sessionEncryption = {
            decryptMetadata: vi.fn(async () => null),
            decryptAgentState: vi.fn(async () => ({})),
            decryptMetadataResult: vi.fn(async () => ({ success: false as const })),
            decryptAgentStateResult: vi.fn(async (version: number) => acceptBoundUpdate
                ? { success: true as const, binding: 'bound' as const, value: { marker: `bound-v${version}` } }
                : { success: false as const }),
        };
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).sessionsSync = { awaitQueue: vi.fn(), invalidate: vi.fn() };
        (freshSync as any).encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => sessionEncryption,
            removeSessionEncryption: vi.fn(),
        };
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({ metadataVersion: 999, agentStateVersion: 999 }),
        ])));

        await (freshSync as any).fetchSessions();

        expect(mocks.state.sessions['session-a']).toMatchObject({
            metadata: { path: '/workspace', host: 'host' },
            metadataVersion: 1,
            agentState: { marker: 'current-v1' },
            agentStateVersion: 1,
        });

        acceptBoundUpdate = true;
        await (freshSync as any).handleUpdate(updateSession(
            'legitimate-after-failed-snapshot',
            30,
            2,
            'bound-v2',
        ));

        expect(mocks.state.sessions['session-a']).toMatchObject({
            agentState: { marker: 'bound-v2' },
            agentStateVersion: 2,
        });
    });

    it('rejects an oversized sessions body before allocating or parsing JSON', async () => {
        const json = vi.fn(async () => ({ sessions: [] }));
        const text = vi.fn(async () => JSON.stringify({ sessions: [] }));
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': '999999999' }),
            body: null,
            json,
            text,
        })));

        await expect((freshSync as any).fetchSessions()).rejects.toThrow('response limit');
        expect(json).not.toHaveBeenCalled();
        expect(text).not.toHaveBeenCalled();
    });

    it('rejects duplicate snapshot IDs before key setup or field decryption', async () => {
        const getSessionEncryption = vi.fn();
        const initializeSessions = vi.fn();
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).encryption = {
            getSessionEncryption,
            initializeSessions,
            removeSessionEncryption: vi.fn(),
        };
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({ metadata: 'bound-row' }),
            snapshotSession({ metadata: 'legacy-row' }),
        ])));

        await expect((freshSync as any).fetchSessions()).rejects.toThrow();
        expect(getSessionEncryption).not.toHaveBeenCalled();
        expect(initializeSessions).not.toHaveBeenCalled();
        expect(mocks.state.sessions['session-a']).toEqual(session());
    });

    it.each([
        ['stripped to legacy mode', null],
        ['swapped to another account-wrapped key', 'attacker-wrapped-key'],
    ])('keeps the installed session key when a snapshot key is %s', async (_label, incomingKey) => {
        const installedKey = new Uint8Array(32).fill(7);
        const attackerKey = new Uint8Array(32).fill(9);
        const removeSessionEncryption = vi.fn();
        const initializeSessions = vi.fn();
        const currentEncryption = {
            decryptMetadataResult: vi.fn(async () => ({ success: false as const })),
            decryptAgentStateResult: vi.fn(async () => ({ success: false as const })),
        };
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).sessionDataKeys = new Map([['session-a', installedKey]]);
        (freshSync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => attackerKey),
            getSessionEncryption: () => currentEncryption,
            initializeSessions,
            removeSessionEncryption,
        };
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({ dataEncryptionKey: incomingKey }),
        ])));

        await (freshSync as any).fetchSessions();

        expect(removeSessionEncryption).not.toHaveBeenCalled();
        expect(initializeSessions).not.toHaveBeenCalled();
        expect((freshSync as any).sessionDataKeys.get('session-a')).toEqual(installedKey);
        expect(mocks.state.sessions['session-a']).toBeDefined();
    });

    it('does not let a null agent field fix an attacker-selected key before honest hydration', async () => {
        mocks.state.sessions = {};
        const honestKey = new Uint8Array(32).fill(23);
        const honestAead = new AES256Encryption(honestKey);
        const failingEncryptor = {
            decrypt: vi.fn(async (values: Uint8Array[]) => values.map(() => null)),
            encrypt: vi.fn(),
        };
        const initializeSessions = vi.fn();
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => honestKey),
            openEncryption: vi.fn(async (dataKey: Uint8Array | null) => (
                dataKey ? honestAead : failingEncryptor
            )),
            getSessionEncryption: () => null,
            initializeSessions,
            removeSessionEncryption: vi.fn(),
        };
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                metadata: 'AA==',
                agentState: null,
                dataEncryptionKey: null,
            }),
        ])));

        await (freshSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toBeUndefined();
        expect(initializeSessions).not.toHaveBeenCalled();
        expect((freshSync as any).sessionDataKeys.has('session-a')).toBe(false);

        const [metadataBytes] = await honestAead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'metadata',
                1,
                { path: '/honest', host: 'host' },
            ),
        ]);
        const [agentStateBytes] = await honestAead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                1,
                { controlledByUser: false },
            ),
        ]);
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                metadata: Buffer.from(metadataBytes).toString('base64'),
                agentState: Buffer.from(agentStateBytes).toString('base64'),
                dataEncryptionKey: 'honest-wrapped-key',
            }),
        ])));

        await (freshSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toMatchObject({
            metadata: { path: '/honest', host: 'host' },
            agentState: { controlledByUser: false },
        });
        expect(initializeSessions).toHaveBeenCalledTimes(1);
        expect((freshSync as any).sessionDataKeys.get('session-a')).toEqual(honestKey);
    });

    it('keeps captured legacy display ciphertext from fixing a first-seen key or generation', async () => {
        mocks.state.sessions = {};
        const capturedKey = new Uint8Array(32).fill(31);
        const honestKey = new Uint8Array(32).fill(47);
        const capturedAead = new AES256Encryption(capturedKey);
        const honestAead = new AES256Encryption(honestKey);
        const [capturedMetadata] = await capturedAead.encrypt([{
            path: '/captured-display',
            host: 'captured-host',
        }]);
        const [honestMetadata] = await honestAead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'metadata',
                1,
                { path: '/honest', host: 'honest-host' },
            ),
        ]);
        const [honestAgentState] = await honestAead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                1,
                { controlledByUser: false },
            ),
        ]);
        const initializeSessions = vi.fn();
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).encryption = {
            decryptEncryptionKey: vi.fn(async (wrapped: string) => (
                wrapped === 'honest-wrapped-key' ? honestKey : capturedKey
            )),
            openEncryption: vi.fn(async (dataKey: Uint8Array | null) => (
                dataKey?.[0] === honestKey[0] ? honestAead : capturedAead
            )),
            getSessionEncryption: () => null,
            initializeSessions,
            removeSessionEncryption: vi.fn(),
        };

        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                metadata: Buffer.from(capturedMetadata).toString('base64'),
                agentState: null,
                dataEncryptionKey: 'captured-wrapped-key',
            }),
        ])));
        await (freshSync as any).fetchSessions();

        expect(mocks.state.sessions['session-a']).toMatchObject({
            metadata: { path: '/captured-display', host: 'captured-host' },
            metadataVersion: 0,
        });
        expect(initializeSessions).not.toHaveBeenCalled();
        expect((freshSync as any).sessionDataKeys.has('session-a')).toBe(false);

        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                createdAt: 200,
                updatedAt: 200,
                activeAt: 200,
                metadata: Buffer.from(honestMetadata).toString('base64'),
                agentState: Buffer.from(honestAgentState).toString('base64'),
                dataEncryptionKey: 'honest-wrapped-key',
            }),
        ])));
        await (freshSync as any).fetchSessions();

        expect(mocks.state.sessions['session-a']).toMatchObject({
            createdAt: 200,
            metadata: { path: '/honest', host: 'honest-host' },
            metadataVersion: 1,
            agentState: { controlledByUser: false },
            agentStateVersion: 1,
        });
        expect(initializeSessions).toHaveBeenCalledTimes(1);
        expect((freshSync as any).sessionDataKeys.get('session-a')).toEqual(honestKey);
    });

    it('persists authenticated version floors across Sync instances', async () => {
        mocks.state.sessions = {};
        const dataKey = new Uint8Array(32).fill(53);
        const firstCrypto = replayFenceTestEncryption(dataKey);
        const [metadataV5, agentStateV5] = await Promise.all([
            firstCrypto.aead.encrypt([
                createAuthenticatedSessionFieldEnvelope(
                    'session-a',
                    'metadata',
                    5,
                    { path: '/current-v5', host: 'host' },
                ),
            ]),
            firstCrypto.aead.encrypt([
                createAuthenticatedSessionFieldEnvelope(
                    'session-a',
                    'agentState',
                    5,
                    { controlledByUser: false },
                ),
            ]),
        ]);
        const firstSync = createTestSync();
        (firstSync as any).credentials = { token: 'test-token' };
        (firstSync as any).encryption = firstCrypto.encryption;
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                metadataVersion: 5,
                agentStateVersion: 5,
                metadata: Buffer.from(metadataV5[0]).toString('base64'),
                agentState: Buffer.from(agentStateV5[0]).toString('base64'),
                dataEncryptionKey: 'wrapped-key',
            }),
        ])));

        await (firstSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toMatchObject({
            metadataVersion: 5,
            agentStateVersion: 5,
        });
        expect(mocks.replayFencePersistence.save).toHaveBeenCalled();

        mocks.state.sessions = {};
        const secondCrypto = replayFenceTestEncryption(dataKey);
        const [metadataV4, agentStateV4] = await Promise.all([
            secondCrypto.aead.encrypt([
                createAuthenticatedSessionFieldEnvelope(
                    'session-a',
                    'metadata',
                    4,
                    { path: '/replayed-v4', host: 'host' },
                ),
            ]),
            secondCrypto.aead.encrypt([
                createAuthenticatedSessionFieldEnvelope(
                    'session-a',
                    'agentState',
                    4,
                    { controlledByUser: true },
                ),
            ]),
        ]);
        const secondSync = createTestSync();
        (secondSync as any).credentials = { token: 'test-token' };
        (secondSync as any).encryption = secondCrypto.encryption;
        await (secondSync as any).loadSessionReplayFences();
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                metadataVersion: 4,
                agentStateVersion: 4,
                metadata: Buffer.from(metadataV4[0]).toString('base64'),
                agentState: Buffer.from(agentStateV4[0]).toString('base64'),
                dataEncryptionKey: 'wrapped-key',
            }),
        ])));

        await (secondSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toBeUndefined();

        const [equivocatedMetadataV5, equivocatedAgentStateV5] = await Promise.all([
            secondCrypto.aead.encrypt([
                createAuthenticatedSessionFieldEnvelope(
                    'session-a',
                    'metadata',
                    5,
                    { path: '/equivocated-v5', host: 'host' },
                ),
            ]),
            secondCrypto.aead.encrypt([
                createAuthenticatedSessionFieldEnvelope(
                    'session-a',
                    'agentState',
                    5,
                    { controlledByUser: true },
                ),
            ]),
        ]);
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                metadataVersion: 5,
                agentStateVersion: 5,
                metadata: Buffer.from(equivocatedMetadataV5[0]).toString('base64'),
                agentState: Buffer.from(equivocatedAgentStateV5[0]).toString('base64'),
                dataEncryptionKey: 'wrapped-key',
            }),
        ])));
        await (secondSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toBeUndefined();

        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                metadataVersion: 5,
                agentStateVersion: 5,
                metadata: Buffer.from(metadataV5[0]).toString('base64'),
                agentState: Buffer.from(agentStateV5[0]).toString('base64'),
                dataEncryptionKey: 'wrapped-key',
            }),
        ])));
        await (secondSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toMatchObject({
            metadata: { path: '/current-v5', host: 'host' },
            metadataVersion: 5,
            agentStateVersion: 5,
        });
    });

    it('persists deletion tombstones across Sync instances', async () => {
        mocks.state.sessions = { 'session-a': session(1) };
        mocks.markAuthenticatedMetadata(mocks.state.sessions['session-a'].metadata);
        mocks.markAuthenticatedAgentState(mocks.state.sessions['session-a'].agentState);
        const dataKey = new Uint8Array(32).fill(59);
        const firstCrypto = replayFenceTestEncryption(dataKey);
        const firstSync = createTestSync();
        (firstSync as any).credentials = { token: 'test-token' };
        (firstSync as any).encryption = firstCrypto.encryption;
        (firstSync as any).sessionDataKeys = new Map([['session-a', dataKey]]);
        await (firstSync as any).handleUpdate(container('persisted-delete', 91, {
            t: 'delete-session',
            sid: 'session-a',
            recordCreatedAt: 100,
        }));

        expect(mocks.state.sessions['session-a']).toBeUndefined();
        expect(mocks.replayFencePersistence.save).toHaveBeenCalled();

        const replayCrypto = replayFenceTestEncryption(dataKey);
        const [metadata, agentState] = await Promise.all([
            replayCrypto.aead.encrypt([
                createAuthenticatedSessionFieldEnvelope(
                    'session-a',
                    'metadata',
                    1,
                    { path: '/deleted-replay', host: 'host' },
                ),
            ]),
            replayCrypto.aead.encrypt([
                createAuthenticatedSessionFieldEnvelope(
                    'session-a',
                    'agentState',
                    1,
                    { controlledByUser: false },
                ),
            ]),
        ]);
        const restartedSync = createTestSync();
        (restartedSync as any).credentials = { token: 'test-token' };
        (restartedSync as any).encryption = replayCrypto.encryption;
        await (restartedSync as any).loadSessionReplayFences();
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                metadata: Buffer.from(metadata[0]).toString('base64'),
                agentState: Buffer.from(agentState[0]).toString('base64'),
                dataEncryptionKey: 'wrapped-key',
            }),
        ])));

        await (restartedSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toBeUndefined();
        expect(replayCrypto.encryption.initializeSessions).not.toHaveBeenCalled();
    });

    it.each([
        ['deleted', null],
        ['corrupt', 'not-a-valid-encrypted-fence'],
    ])('enters explicit fail-closed recovery when an anchored fence blob is %s', async (_label, replacement) => {
        mocks.state.sessions = {};
        const dataKey = new Uint8Array(32).fill(63);
        const firstCrypto = replayFenceTestEncryption(dataKey);
        const firstSync = createTestSync();
        (firstSync as any).serverID = 'account-a';
        (firstSync as any).encryption = firstCrypto.encryption;
        (firstSync as any).sessionReplayFences = new Map([[
            'session-a',
            {
                sessionId: 'session-a',
                createdAt: 100,
                metadataVersion: 1,
                metadataCiphertextCommitment: 'metadata-v1',
                agentStateVersion: 1,
                agentStateCiphertextCommitment: 'agent-v1',
                dataKeyFingerprint: 'data-key',
            },
        ]]);
        await (firstSync as any).persistSessionReplayFences();

        mocks.replayFencePersistence.ciphertext = replacement;
        const restarted = createTestSync();
        (restarted as any).serverID = 'account-a';
        (restarted as any).credentials = { token: 'test-token' };
        (restarted as any).encryption = replayFenceTestEncryption(dataKey).encryption;
        await (restarted as any).loadSessionReplayFences();

        expect((restarted as any).sessionReplayProtectionState).toBe('degraded');
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([])));
        await expect((restarted as any).fetchSessions()).rejects.toThrow(/replay protection/i);
        expect(mocks.state.sessions).toEqual({});
    });

    it('treats an unanchored legacy fence ciphertext as recovery-required, not migratable', async () => {
        mocks.state.sessions = {};
        mocks.replayFencePersistence.ciphertext = Buffer.from(JSON.stringify({
            version: 1,
            sessions: [{
                sessionId: 'session-a',
                createdAt: 100,
                metadataVersion: 5,
                agentStateVersion: 5,
                dataKeyFingerprint: 'legacy-data-key',
            }],
            tombstones: [],
            tombstonesSaturated: false,
        })).toString('base64');

        const restarted = createTestSync();
        (restarted as any).serverID = 'account-a';
        (restarted as any).encryption = replayFenceTestEncryption(
            new Uint8Array(32).fill(64),
        ).encryption;
        await (restarted as any).loadSessionReplayFences();

        expect((restarted as any).sessionReplayProtectionState).toBe('degraded');
        expect((restarted as any).sessionReplayFences.size).toBe(0);
        expect(mocks.replayFenceAnchorPersistence.save).not.toHaveBeenCalled();
    });

    it('does not reinterpret a present empty fence value as genuine first use', async () => {
        mocks.state.sessions = {};
        mocks.replayFencePersistence.ciphertext = '';

        const restarted = createTestSync();
        (restarted as any).serverID = 'account-a';
        (restarted as any).encryption = replayFenceTestEncryption(
            new Uint8Array(32).fill(64),
        ).encryption;
        await (restarted as any).loadSessionReplayFences();

        expect((restarted as any).sessionReplayProtectionState).toBe('degraded');
        expect((restarted as any).sessionReplayFences.size).toBe(0);
        expect(mocks.replayFenceAnchorPersistence.save).not.toHaveBeenCalled();
    });

    it('establishes the secure anchor before the rollbackable encrypted blob on first use', async () => {
        mocks.state.sessions = {};
        const fresh = createTestSync();
        (fresh as any).serverID = 'account-a';
        (fresh as any).encryption = replayFenceTestEncryption(
            new Uint8Array(32).fill(64),
        ).encryption;

        await (fresh as any).loadSessionReplayFences();

        expect((fresh as any).sessionReplayProtectionState).toBe('ready');
        expect(mocks.writeOrder).toEqual(['anchor', 'blob']);
        expect(mocks.replayFenceAnchorPersistence.result).toMatchObject({
            status: 'available',
            anchor: { epoch: 1 },
        });
        expect(mocks.replayFencePersistence.ciphertext).not.toBeNull();
    });

    it('keeps the browser marker explicitly consistency-only after first use', async () => {
        mocks.state.sessions = {};
        mocks.replayFenceAnchorPersistence.result = {
            status: 'missing',
            protection: 'browser-consistency-only',
        };
        const fresh = createTestSync();
        (fresh as any).serverID = 'account-a';
        (fresh as any).encryption = replayFenceTestEncryption(
            new Uint8Array(32).fill(64),
        ).encryption;

        await (fresh as any).loadSessionReplayFences();

        expect((fresh as any).sessionReplayProtectionState)
            .toBe('ready-browser-consistency-only');
    });

    it('detects an older valid encrypted fence blob restored after a newer anchored epoch', async () => {
        mocks.state.sessions = {};
        const dataKey = new Uint8Array(32).fill(65);
        const firstCrypto = replayFenceTestEncryption(dataKey);
        const firstSync = createTestSync();
        (firstSync as any).serverID = 'account-a';
        (firstSync as any).encryption = firstCrypto.encryption;
        const fence = {
            sessionId: 'session-a',
            createdAt: 100,
            metadataVersion: 1,
            metadataCiphertextCommitment: 'metadata-v1',
            agentStateVersion: 1,
            agentStateCiphertextCommitment: 'agent-v1',
            dataKeyFingerprint: 'data-key',
        };
        (firstSync as any).sessionReplayFences = new Map([['session-a', fence]]);
        await (firstSync as any).persistSessionReplayFences();
        const olderValidCiphertext = mocks.replayFencePersistence.ciphertext;

        (firstSync as any).sessionReplayFences.set('session-a', {
            ...fence,
            metadataVersion: 2,
            metadataCiphertextCommitment: 'metadata-v2',
            agentStateVersion: 2,
            agentStateCiphertextCommitment: 'agent-v2',
        });
        await (firstSync as any).persistSessionReplayFences();
        expect(mocks.replayFencePersistence.ciphertext).not.toBe(olderValidCiphertext);

        mocks.replayFencePersistence.ciphertext = olderValidCiphertext;
        const restarted = createTestSync();
        (restarted as any).serverID = 'account-a';
        (restarted as any).encryption = replayFenceTestEncryption(dataKey).encryption;
        await (restarted as any).loadSessionReplayFences();

        expect((restarted as any).sessionReplayProtectionState).toBe('degraded');
        expect((restarted as any).sessionReplayFences.size).toBe(0);
    });

    it('detects a newer encrypted fence blob restored with an older secure anchor', async () => {
        mocks.state.sessions = {};
        const dataKey = new Uint8Array(32).fill(66);
        const firstCrypto = replayFenceTestEncryption(dataKey);
        const firstSync = createTestSync();
        (firstSync as any).serverID = 'account-a';
        (firstSync as any).encryption = firstCrypto.encryption;
        (firstSync as any).sessionReplayFences = new Map();
        await (firstSync as any).persistSessionReplayFences();
        const olderAnchor = structuredClone(mocks.replayFenceAnchorPersistence.result);

        (firstSync as any).sessionReplayFences.set('session-a', {
            sessionId: 'session-a',
            createdAt: 100,
            metadataVersion: 2,
            metadataCiphertextCommitment: 'metadata-v2',
            agentStateVersion: 2,
            agentStateCiphertextCommitment: 'agent-v2',
            dataKeyFingerprint: 'data-key',
        });
        await (firstSync as any).persistSessionReplayFences();
        mocks.replayFenceAnchorPersistence.result = olderAnchor;

        const restarted = createTestSync();
        (restarted as any).serverID = 'account-a';
        (restarted as any).encryption = replayFenceTestEncryption(dataKey).encryption;
        await (restarted as any).loadSessionReplayFences();

        expect((restarted as any).sessionReplayProtectionState).toBe('degraded');
        expect((restarted as any).sessionReplayFences.size).toBe(0);
    });

    it('rejects an otherwise valid replay anchor restored under another account', async () => {
        mocks.state.sessions = {};
        const dataKey = new Uint8Array(32).fill(67);
        const firstSync = createTestSync();
        (firstSync as any).serverID = 'account-a';
        (firstSync as any).encryption = replayFenceTestEncryption(dataKey).encryption;
        await (firstSync as any).persistSessionReplayFences();

        const otherAccount = createTestSync();
        (otherAccount as any).serverID = 'account-b';
        (otherAccount as any).encryption = replayFenceTestEncryption(dataKey).encryption;
        await (otherAccount as any).loadSessionReplayFences();

        expect((otherAccount as any).sessionReplayProtectionState).toBe('degraded');
        expect((otherAccount as any).sessionReplayFences.size).toBe(0);
    });

    it('persists live bound version advances before restart', async () => {
        const current = session(5) as any;
        current.metadataVersion = 5;
        current.agentState = { controlledByUser: false };
        mocks.state.sessions = { 'session-a': current };
        mocks.markAuthenticatedMetadata(current.metadata);
        mocks.markAuthenticatedAgentState(current.agentState);

        const dataKey = new Uint8Array(32).fill(61);
        const firstCrypto = replayFenceTestEncryption(dataKey);
        await firstCrypto.encryption.initializeSessions(new Map([['session-a', dataKey]]));
        const [liveAgentState] = await firstCrypto.aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                6,
                { controlledByUser: false, completedRequests: {} },
            ),
        ]);
        const firstSync = createTestSync();
        (firstSync as any).credentials = { token: 'test-token' };
        (firstSync as any).encryption = firstCrypto.encryption;
        (firstSync as any).sessionDataKeys = new Map([['session-a', dataKey]]);
        (firstSync as any).sessionReplayFences = new Map([[
            'session-a',
            {
                sessionId: 'session-a',
                createdAt: 100,
                metadataVersion: 5,
                metadataCiphertextCommitment: null,
                agentStateVersion: 5,
                agentStateCiphertextCommitment: null,
                dataKeyFingerprint: await (firstSync as any).sessionDataKeyFingerprint(dataKey),
            },
        ]]);
        await (firstSync as any).persistSessionReplayFences();
        mocks.replayFencePersistence.save.mockClear();

        await (firstSync as any).handleUpdate(updateSession(
            'live-v6-before-restart',
            81,
            6,
            Buffer.from(liveAgentState).toString('base64'),
        ));
        expect(mocks.state.sessions['session-a'].agentStateVersion).toBe(6);
        expect(mocks.replayFencePersistence.save).toHaveBeenCalled();

        mocks.state.sessions = {};
        const restartedCrypto = replayFenceTestEncryption(dataKey);
        const [metadataV5, replayedAgentStateV5] = await Promise.all([
            restartedCrypto.aead.encrypt([
                createAuthenticatedSessionFieldEnvelope(
                    'session-a',
                    'metadata',
                    5,
                    { path: '/current-v5', host: 'host' },
                ),
            ]),
            restartedCrypto.aead.encrypt([
                createAuthenticatedSessionFieldEnvelope(
                    'session-a',
                    'agentState',
                    5,
                    { controlledByUser: true },
                ),
            ]),
        ]);
        const restartedSync = createTestSync();
        (restartedSync as any).credentials = { token: 'test-token' };
        (restartedSync as any).encryption = restartedCrypto.encryption;
        await (restartedSync as any).loadSessionReplayFences();
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                metadataVersion: 5,
                agentStateVersion: 5,
                metadata: Buffer.from(metadataV5[0]).toString('base64'),
                agentState: Buffer.from(replayedAgentStateV5[0]).toString('base64'),
                dataEncryptionKey: 'wrapped-key',
            }),
        ])));

        await (restartedSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toMatchObject({
            metadataVersion: 5,
            agentState: null,
            agentStateVersion: 0,
        });
    });

    it('rejects a session snapshot below the durable message tip after restart', async () => {
        mocks.state.sessions = {};
        const firstSync = createTestSync();
        (firstSync as any).serverID = 'account-a';
        (firstSync as any).encryption = {};
        (firstSync as any).sessionReplayFences = new Map([[
            'session-a',
            {
                sessionId: 'session-a',
                createdAt: 100,
                metadataVersion: 1,
                metadataCiphertextCommitment: 'metadata-v1',
                agentStateVersion: 1,
                agentStateCiphertextCommitment: 'agent-v1',
                dataKeyFingerprint: 'legacy-master-key',
                messageSeq: 11,
                messageCiphertextCommitment: 'message-v11',
            },
        ]]);
        await (firstSync as any).persistSessionReplayFences();

        const getSessionEncryption = vi.fn(() => ({
            decryptMetadataResult: vi.fn(async () => ({
                success: true as const,
                binding: 'bound' as const,
                value: { path: '/rolled-back', host: 'host' },
            })),
            decryptAgentStateResult: vi.fn(async () => ({
                success: true as const,
                binding: 'bound' as const,
                value: { controlledByUser: false },
            })),
        }));
        const restarted = createTestSync();
        (restarted as any).serverID = 'account-a';
        (restarted as any).credentials = { token: 'test-token' };
        (restarted as any).encryption = {
            getSessionEncryption,
            initializeSessions: vi.fn(),
            removeSessionEncryption: vi.fn(),
        };
        await (restarted as any).loadSessionReplayFences();
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({ seq: 10 }),
        ])));

        await (restarted as any).fetchSessions();

        expect(mocks.state.sessions['session-a']).toBeUndefined();
        expect(getSessionEncryption).not.toHaveBeenCalled();
        expect((restarted as any).sessionReplayFences.get('session-a')).toMatchObject({
            messageSeq: 11,
            messageCiphertextCommitment: 'message-v11',
        });
    });

    it('rejects exact bound v1 snapshot ciphertext relabeled to outer v999, then accepts its honest coordinates', async () => {
        mocks.state.sessions = {};
        const aead = new AES256Encryption(new Uint8Array(32).fill(19));
        const [metadataBytes] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'metadata',
                1,
                { path: '/bound-snapshot', host: 'host' },
            ),
        ]);
        const [agentStateBytes] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                1,
                { controlledByUser: false },
            ),
        ]);
        const reader = new SessionEncryption('session-a', aead, new EncryptionCache());
        const freshSync = createTestSync();
        (freshSync as any).sessionDataKeys = new Map([['session-a', null]]);
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => reader,
            removeSessionEncryption: vi.fn(),
        };
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                metadata: Buffer.from(metadataBytes).toString('base64'),
                metadataVersion: 999,
                agentState: Buffer.from(agentStateBytes).toString('base64'),
                agentStateVersion: 999,
            }),
        ])));

        await (freshSync as any).fetchSessions();

        expect(mocks.state.sessions['session-a']).toBeUndefined();

        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                metadata: Buffer.from(metadataBytes).toString('base64'),
                metadataVersion: 1,
                agentState: Buffer.from(agentStateBytes).toString('base64'),
                agentStateVersion: 1,
            }),
        ])));
        await (freshSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toMatchObject({
            metadata: { path: '/bound-snapshot', host: 'host' },
            metadataVersion: 1,
            agentState: { controlledByUser: false },
            agentStateVersion: 1,
        });
    });

    it('serializes snapshot commit with live updates and keeps authenticated fields monotonic', async () => {
        const current = session(1) as any;
        current.agentState = { marker: 'current-v1' };
        mocks.state.sessions = { 'session-a': current };

        let releaseSnapshot!: (response: ReturnType<typeof sessionsResponse>) => void;
        const snapshotResponse = new Promise<ReturnType<typeof sessionsResponse>>((resolve) => {
            releaseSnapshot = resolve;
        });
        const sessionEncryption = {
            decryptMetadata: vi.fn(async (version: number) => ({ path: `/v${version}`, host: 'host' })),
            decryptAgentState: vi.fn(async (version: number) => ({ marker: `snapshot-v${version}` })),
            decryptMetadataResult: vi.fn(async (version: number) => ({
                success: true as const,
                binding: 'bound' as const,
                value: { path: `/v${version}`, host: 'host' },
            })),
            decryptAgentStateResult: vi.fn(async (version: number, value: string) => ({
                success: true as const,
                binding: 'bound' as const,
                value: { marker: value === 'live-v2' ? 'live-v2' : `snapshot-v${version}` },
            })),
        };
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).sessionsSync = { awaitQueue: vi.fn(), invalidate: vi.fn() };
        (freshSync as any).encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => sessionEncryption,
            removeSessionEncryption: vi.fn(),
        };
        const fetchMock = vi.fn(() => snapshotResponse);
        vi.stubGlobal('fetch', fetchMock);

        const fetchPromise = (freshSync as any).fetchSessions();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        await (freshSync as any).handleUpdate(updateSession('live-v2', 31, 2, 'live-v2'));
        releaseSnapshot(sessionsResponse([snapshotSession({ agentStateVersion: 1 })]));
        await fetchPromise;

        expect(mocks.state.sessions['session-a']).toMatchObject({
            agentState: { marker: 'live-v2' },
            agentStateVersion: 2,
        });
    });

    it('does not let slow snapshot decryption overwrite newer ephemeral activity', async () => {
        const current = session(1) as any;
        current.activeAt = 100;
        mocks.state.sessions = { 'session-a': current };
        let releaseMetadata!: () => void;
        let metadataStarted!: () => void;
        const waitForMetadata = new Promise<void>((resolve) => {
            metadataStarted = resolve;
        });
        const metadataBlocked = new Promise<void>((resolve) => {
            releaseMetadata = resolve;
        });
        const invalidate = vi.fn();
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).sessionDataKeys = new Map([['session-a', null]]);
        (freshSync as any).sessionsSync = { awaitQueue: vi.fn(), invalidate };
        (freshSync as any).encryption = {
            getSessionEncryption: () => ({
                decryptMetadataResult: vi.fn(async () => {
                    metadataStarted();
                    await metadataBlocked;
                    return {
                        success: true as const,
                        binding: 'bound' as const,
                        value: { path: '/snapshot', host: 'host' },
                    };
                }),
                decryptAgentStateResult: vi.fn(async () => ({
                    success: true as const,
                    binding: 'bound' as const,
                    value: { controlledByUser: false },
                })),
            }),
            removeSessionEncryption: vi.fn(),
        };
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({ activeAt: 200 }),
        ])));

        const fetchPromise = (freshSync as any).fetchSessions();
        await waitForMetadata;
        (freshSync as any).flushActivityUpdates(new Map([[
            'session-a',
            {
                type: 'activity',
                id: 'session-a',
                active: false,
                activeAt: 500,
                thinking: true,
            },
        ]]));
        releaseMetadata();
        await fetchPromise;

        expect(mocks.state.sessions['session-a']).toMatchObject({
            active: false,
            activeAt: 500,
            thinking: true,
        });
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('lets active hydration commit before an ordered update waiting on that sync', async () => {
        mocks.state.sessions = {};
        let releaseSnapshot!: (response: ReturnType<typeof sessionsResponse>) => void;
        const snapshotResponse = new Promise<ReturnType<typeof sessionsResponse>>((resolve) => {
            releaseSnapshot = resolve;
        });
        const sessionEncryption = {
            decryptMetadataResult: vi.fn(async () => ({
                success: true as const,
                binding: 'bound' as const,
                value: { path: '/snapshot', host: 'host' },
            })),
            decryptAgentStateResult: vi.fn(async (_version: number, value: string) => ({
                success: true as const,
                binding: 'bound' as const,
                value: { marker: value === 'live-v2' ? 'live-v2' : 'snapshot-v1' },
            })),
        };
        const freshSync = createTestSync();
        (freshSync as any).sessionDataKeys = new Map([['session-a', null]]);
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => sessionEncryption,
            removeSessionEncryption: vi.fn(),
        };
        const fetchMock = vi.fn(() => snapshotResponse);
        vi.stubGlobal('fetch', fetchMock);

        const fetchPromise = (freshSync as any).fetchSessions();
        (freshSync as any).sessionsSync = {
            awaitQueue: () => fetchPromise,
            invalidate: vi.fn(),
        };
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        const updatePromise = (freshSync as any).handleUpdate(updateSession(
            'update-waiting-for-hydration',
            35,
            2,
            'live-v2',
        ));
        releaseSnapshot(sessionsResponse([snapshotSession()]));

        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await expect(Promise.race([
                Promise.all([fetchPromise, updatePromise]),
                new Promise((_, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error('snapshot/update lock deadlock')),
                        1_000,
                    );
                }),
            ])).resolves.toBeDefined();
        } finally {
            if (timeout) clearTimeout(timeout);
        }
        expect(mocks.state.sessions['session-a']).toMatchObject({
            agentState: { marker: 'live-v2' },
            agentStateVersion: 2,
        });
    });

    it('rejects createdAt relabels for an existing UUID while accepting a newly discovered UUID', async () => {
        const current = session(5) as any;
        current.createdAt = 200;
        current.updatedAt = 250;
        current.agentState = { marker: 'generation-200-v5' };
        mocks.state.sessions = { 'session-a': current };
        mocks.markAuthenticatedMetadata(current.metadata);
        mocks.markAuthenticatedAgentState(current.agentState);

        const sessionEncryption = {
            decryptMetadata: vi.fn(async (version: number) => ({ path: `/v${version}`, host: 'host' })),
            decryptAgentState: vi.fn(async (version: number) => ({ marker: `snapshot-v${version}` })),
            decryptMetadataResult: vi.fn(async (version: number) => ({
                success: true as const,
                binding: 'bound' as const,
                value: { path: `/v${version}`, host: 'host' },
            })),
            decryptAgentStateResult: vi.fn(async (version: number) => ({
                success: true as const,
                binding: 'bound' as const,
                value: { marker: `snapshot-v${version}` },
            })),
        };
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => sessionEncryption,
            removeSessionEncryption: vi.fn(),
        };

        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({ createdAt: 100, agentStateVersion: 999 }),
        ])));
        await (freshSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toMatchObject({
            createdAt: 200,
            agentState: { marker: 'generation-200-v5' },
            agentStateVersion: 5,
        });

        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                createdAt: 300,
                updatedAt: 300,
                activeAt: 300,
                metadataVersion: 1,
                agentStateVersion: 1,
            }),
            snapshotSession({
                id: 'session-b',
                createdAt: 300,
                updatedAt: 300,
                activeAt: 300,
                metadataVersion: 1,
                agentStateVersion: 1,
            }),
        ])));
        await (freshSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toMatchObject({
            createdAt: 200,
            agentState: { marker: 'generation-200-v5' },
            agentStateVersion: 5,
        });
        expect(mocks.state.sessions['session-b']).toMatchObject({
            createdAt: 300,
            agentState: { marker: 'snapshot-v1' },
            agentStateVersion: 1,
        });
    });

    it('does not let an in-flight snapshot resurrect a generation deleted after the request began', async () => {
        mocks.state.sessions = { 'session-a': session(1) };
        let releaseSnapshot!: (response: ReturnType<typeof sessionsResponse>) => void;
        const snapshotResponse = new Promise<ReturnType<typeof sessionsResponse>>((resolve) => {
            releaseSnapshot = resolve;
        });
        const initializeSessions = vi.fn();
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).sessionsSync = { awaitQueue: vi.fn(), invalidate: vi.fn() };
        (freshSync as any).encryption = {
            initializeSessions,
            getSessionEncryption: () => ({
                decryptMetadata: vi.fn(async () => ({ path: '/replayed', host: 'host' })),
                decryptAgentState: vi.fn(async () => ({ marker: 'replayed' })),
                decryptMetadataResult: vi.fn(async () => ({
                    success: true as const,
                    binding: 'bound' as const,
                    value: { path: '/replayed', host: 'host' },
                })),
                decryptAgentStateResult: vi.fn(async () => ({
                    success: true as const,
                    binding: 'bound' as const,
                    value: { marker: 'replayed' },
                })),
            }),
            removeSessionEncryption: vi.fn(),
        };
        const fetchMock = vi.fn(() => snapshotResponse);
        vi.stubGlobal('fetch', fetchMock);

        const fetchPromise = (freshSync as any).fetchSessions();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        await (freshSync as any).handleUpdate(container('bound-delete-during-fetch', 32, {
            t: 'delete-session',
            sid: 'session-a',
            recordCreatedAt: 100,
        }));
        releaseSnapshot(sessionsResponse([snapshotSession()]));
        await fetchPromise;

        expect(mocks.state.sessions['session-a']).toBeUndefined();
        expect(initializeSessions).not.toHaveBeenCalled();

        // Even a later relay retry cannot relabel the deleted record's outer
        // generation and walk around the in-process UUID tombstone.
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({
                createdAt: 999,
                updatedAt: 999,
                activeAt: 999,
            }),
        ])));
        await (freshSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toBeUndefined();
        expect(initializeSessions).not.toHaveBeenCalled();
    });

    it('bounds deletion tombstones and fails closed instead of evicting replay fences', async () => {
        mocks.state.sessions = {};
        const freshSync = createTestSync();
        for (let index = 0; index < 4_097; index += 1) {
            (freshSync as any).rememberSessionDeletionTombstone(`deleted-${index}`, 100 + index);
        }

        expect((freshSync as any).sessionDeletionTombstones.size).toBe(4_096);
        expect((freshSync as any).sessionDeletionTombstonesSaturated).toBe(true);

        const getSessionEncryption = vi.fn();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).encryption = { getSessionEncryption };
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({ id: 'unknown-after-saturation' }),
        ])));
        await (freshSync as any).fetchSessions();

        expect(getSessionEncryption).not.toHaveBeenCalled();
        expect(mocks.state.sessions).toEqual({});
    });

    it('treats generation-less session deletes as refetch-only while exact bound deletes still apply', async () => {
        mocks.state.sessions = { 'session-a': session(1) };
        const invalidate = vi.fn();
        const removeSessionEncryption = vi.fn();
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).sessionsSync = { awaitQueue: vi.fn(), invalidate };
        (freshSync as any).encryption = {
            getSessionEncryption: vi.fn(),
            removeSessionEncryption,
        };

        await (freshSync as any).handleUpdate(container('unbound-delete', 33, {
            t: 'delete-session',
            sid: 'session-a',
        }));

        expect(mocks.state.sessions['session-a']).toBeDefined();
        expect(invalidate).toHaveBeenCalledOnce();
        expect(removeSessionEncryption).not.toHaveBeenCalled();

        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([])));
        await (freshSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toBeDefined();
        expect(removeSessionEncryption).not.toHaveBeenCalled();

        mocks.state.sessions = { 'session-a': session(1) };
        removeSessionEncryption.mockClear();
        await (freshSync as any).handleUpdate(container('bound-delete', 34, {
            t: 'delete-session',
            sid: 'session-a',
            recordCreatedAt: 100,
        }));

        expect(mocks.state.sessions['session-a']).toBeUndefined();
        expect(removeSessionEncryption).toHaveBeenCalledWith('session-a');
    });

    it('does not infer deletion when an older session is absent from the capped 150-row snapshot', async () => {
        mocks.state.sessions = { 'session-a': session(1) };
        const sessionEncryption = {
            decryptMetadataResult: vi.fn(async () => ({
                success: true as const,
                binding: 'bound' as const,
                value: { path: '/bound', host: 'host' },
            })),
            decryptAgentStateResult: vi.fn(async () => ({
                success: true as const,
                binding: 'bound' as const,
                value: { controlledByUser: false },
            })),
        };
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).encryption = {
            getSessionEncryption: () => sessionEncryption,
            initializeSessions: vi.fn(),
            removeSessionEncryption: vi.fn(),
        };
        (freshSync as any).sessionReplayFences = new Map([[
            'session-a',
            {
                sessionId: 'session-a',
                createdAt: 100,
                metadataVersion: 1,
                metadataCiphertextCommitment: 'metadata-v1',
                agentStateVersion: 1,
                agentStateCiphertextCommitment: 'agent-v1',
                dataKeyFingerprint: 'legacy-master-key',
            },
        ]]);

        const cappedPage = Array.from({ length: 150 }, (_, index) => snapshotSession({
            id: `newer-session-${index}`,
            createdAt: 200 + index,
            updatedAt: 200 + index,
            activeAt: 200 + index,
        }));
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse(cappedPage)));
        await (freshSync as any).fetchSessions();
        expect(mocks.state.sessions['session-a']).toBeDefined();
        expect((freshSync as any).sessionReplayFences.has('session-a')).toBe(true);
        expect((freshSync as any).sessionDeletionTombstones.has('session-a')).toBe(false);
    });

    it('keeps legacy hydration readable but version-neutral and explicitly non-effectful', async () => {
        mocks.state.sessions = {};
        const legacyMetadata = { path: '/legacy-display', host: 'legacy-host' };
        const legacyAgentState = {
            requests: {
                legacy: {
                    tool: 'Bash',
                    arguments: { command: 'pwd' },
                    createdAt: 1,
                },
            },
        };
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => ({
                decryptMetadata: vi.fn(async () => legacyMetadata),
                decryptAgentState: vi.fn(async () => legacyAgentState),
                decryptMetadataResult: vi.fn(async () => ({
                    success: true as const,
                    binding: 'legacy' as const,
                    value: legacyMetadata,
                })),
                decryptAgentStateResult: vi.fn(async () => ({
                    success: true as const,
                    binding: 'legacy' as const,
                    value: legacyAgentState,
                })),
            }),
            removeSessionEncryption: vi.fn(),
        };
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([
            snapshotSession({ metadataVersion: 77, agentStateVersion: 88 }),
        ])));

        await (freshSync as any).fetchSessions();

        expect(mocks.state.sessions['session-a']).toMatchObject({
            metadata: legacyMetadata,
            metadataVersion: 0,
            agentState: legacyAgentState,
            agentStateVersion: 0,
        });
        const context = mocks.sessionApplyContexts.at(-1) as any;
        expect(context?.source).toBe('hydration');
        expect(context?.effectfulAgentStateSessionIds?.has('session-a')).toBe(false);
        expect(mocks.permissionRequested).not.toHaveBeenCalled();
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
        expect(mocks.sessionOnline).not.toHaveBeenCalled();
        expect(mocks.sessionOffline).not.toHaveBeenCalled();
        expect(mocks.sessionFocus).not.toHaveBeenCalled();
    });

    it('keeps display-only legacy metadata out of later Git, voice, lifecycle, send, and telemetry sinks', async () => {
        mocks.state.sessions = {};
        mocks.state.settings = {
            agentDefaultOverrides: {
                codex: { permissionMode: 'bypassPermissions' },
            },
        };
        const legacyMetadata = {
            path: '/relay-selected-path',
            host: 'legacy-host',
            machineId: 'relay-machine',
            flavor: 'codex',
        };
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).sessionsSync = { awaitQueue: vi.fn(), invalidate: vi.fn() };
        (freshSync as any).encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => ({
                decryptMetadataResult: vi.fn(async () => ({
                    success: true as const,
                    binding: 'legacy' as const,
                    value: legacyMetadata,
                })),
                decryptAgentStateResult: vi.fn(async () => ({
                    success: true as const,
                    binding: 'legacy' as const,
                    value: {},
                })),
            }),
            removeSessionEncryption: vi.fn(),
        };
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([snapshotSession()])));
        await (freshSync as any).fetchSessions();

        freshSync.onSessionVisible('session-a');
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
        expect(mocks.sessionFocus).not.toHaveBeenCalled();

        (freshSync as any).applySessions([{
            ...mocks.state.sessions['session-a'],
            active: false,
            activeAt: 200,
        }]);
        expect(mocks.sessionOffline).not.toHaveBeenCalled();

        let encryptedRecord: any;
        (freshSync as any).encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: vi.fn(async (record: unknown) => {
                    encryptedRecord = record;
                    return 'encrypted-message';
                }),
            }),
        };
        (freshSync as any).getSendSync = () => ({ invalidate: vi.fn() });
        (freshSync as any).enqueueMessages = vi.fn();
        (freshSync as any).maybeStartBackgroundSendWatchdog = vi.fn();
        await freshSync.sendMessage('session-a', 'hello');

        expect(encryptedRecord?.meta?.permissionMode).toBeUndefined();
        expect(mocks.trackMessageSent).toHaveBeenCalledWith('chat', null);
    });

    it('retains bound snapshot agent-state processing eligibility as the compatibility control', async () => {
        mocks.state.sessions = {};
        const freshSync = createTestSync();
        (freshSync as any).credentials = { token: 'test-token' };
        (freshSync as any).encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => ({
                decryptMetadata: vi.fn(async () => ({ path: '/bound', host: 'host' })),
                decryptAgentState: vi.fn(async () => ({ controlledByUser: false })),
                decryptMetadataResult: vi.fn(async () => ({
                    success: true as const,
                    binding: 'bound' as const,
                    value: { path: '/bound', host: 'host' },
                })),
                decryptAgentStateResult: vi.fn(async () => ({
                    success: true as const,
                    binding: 'bound' as const,
                    value: { controlledByUser: false },
                })),
            }),
            removeSessionEncryption: vi.fn(),
        };
        vi.stubGlobal('fetch', vi.fn(async () => sessionsResponse([snapshotSession()])));

        await (freshSync as any).fetchSessions();

        const context = mocks.sessionApplyContexts.at(-1) as any;
        expect(context?.source).toBe('hydration');
        expect(context?.effectfulAgentStateSessionIds?.has('session-a')).toBe(true);
        expect(mocks.state.sessions['session-a']).toMatchObject({
            metadataVersion: 1,
            agentStateVersion: 1,
        });
    });

    it('notifies voice once per authenticated permission request identity', async () => {
        mocks.state.sessions = { 'session-a': session(5) };
        const decryptAgentStateResult = vi.fn(async (_version: number, value: string) => ({
            success: true as const,
            value: {
                requests: {
                    [value]: {
                        tool: 'Bash',
                        arguments: { command: 'pwd' },
                        createdAt: 1,
                    },
                },
            },
        }));
        (sync as any).encryption = {
            getSessionEncryption: () => ({
                decryptAgentStateResult,
                decryptMetadataResult: vi.fn(),
            }),
        };

        await (sync as any).handleUpdate(updateSession('permission-first', 22, 6, 'request-1'));
        await (sync as any).handleUpdate(updateSession('permission-replay', 23, 7, 'request-1'));
        await (sync as any).handleUpdate(updateSession('permission-new', 24, 8, 'request-2'));

        expect(mocks.permissionRequested).toHaveBeenCalledTimes(2);
        expect(mocks.permissionRequested).toHaveBeenNthCalledWith(
            1,
            'session-a',
            'request-1',
            'Bash',
        );
        expect(mocks.permissionRequested).toHaveBeenNthCalledWith(
            2,
            'session-a',
            'request-2',
            'Bash',
        );
    });

    it('ignores stale machine fields and preserves record state on a fresh partial update', async () => {
        mocks.state.machines = { 'machine-a': machine() };
        const decryptMetadata = vi.fn(async () => ({ host: 'incoming' }));
        const decryptDaemonState = vi.fn(async () => ({ status: 'incoming' }));
        (sync as any).encryption = {
            getMachineEncryption: () => ({ decryptMetadata, decryptDaemonState }),
        };

        await (sync as any).handleUpdate(container('machine-stale', 5, {
            t: 'update-machine',
            machineId: 'machine-a',
            metadata: { version: 4, value: 'stale-metadata' },
            daemonState: { version: 7, value: 'duplicate-state' },
        }));

        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(decryptDaemonState).not.toHaveBeenCalled();
        expect(mocks.state.machines['machine-a']).toEqual(machine());

        await (sync as any).handleUpdate(container('machine-fresh', 6, {
            t: 'update-machine',
            machineId: 'machine-a',
            metadata: { version: 6, value: 'fresh-metadata' },
        }));

        expect(mocks.state.machines['machine-a']).toMatchObject({
            seq: 3,
            active: false,
            activeAt: 240,
            metadata: { host: 'incoming' },
            metadataVersion: 6,
            daemonState: { status: 'current' },
            daemonStateVersion: 7,
        });
    });

    it('applies only strictly newer authenticated artifact fields', async () => {
        mocks.state.artifacts = { 'artifact-a': artifact() };
        (sync as any).artifactDataKeys = new Map([['artifact-a', new Uint8Array(32)]]);
        mocks.artifactDecryptHeader.mockResolvedValue({ title: 'incoming' });
        mocks.artifactDecryptBody.mockResolvedValue({ body: 'incoming body' });

        await (sync as any).handleUpdate(container('artifact-stale', 7, {
            t: 'update-artifact',
            artifactId: 'artifact-a',
            header: { version: 4, value: 'stale-header' },
            body: { version: 7, value: 'duplicate-body' },
        }));

        expect(mocks.artifactDecryptHeader).not.toHaveBeenCalled();
        expect(mocks.artifactDecryptBody).not.toHaveBeenCalled();
        expect(mocks.state.artifacts['artifact-a']).toEqual(artifact());

        await (sync as any).handleUpdate(container('artifact-mixed', 8, {
            t: 'update-artifact',
            artifactId: 'artifact-a',
            header: { version: 6, value: 'fresh-header' },
            body: { version: 6, value: 'stale-body' },
        }));

        expect(mocks.artifactDecryptHeader).toHaveBeenCalledOnce();
        expect(mocks.artifactDecryptBody).not.toHaveBeenCalled();
        expect(mocks.state.artifacts['artifact-a']).toMatchObject({
            title: 'incoming',
            body: 'current body',
            headerVersion: 6,
            bodyVersion: 7,
            seq: 9,
        });
    });

    it('rejects stale and cross-account profile updates before analytics side effects', async () => {
        mocks.state.profile = { ...mocks.state.profile, timestamp: 200, firstName: 'Current' };

        await (sync as any).handleUpdate(container('profile-stale', 9, {
            t: 'update-account',
            id: 'account-a',
            firstName: 'Stale',
        }, 100));
        await (sync as any).handleUpdate(container('profile-cross-account', 10, {
            t: 'update-account',
            id: 'account-b',
            firstName: 'Other',
        }, 300));

        expect(mocks.state.profile.firstName).toBe('Current');
        expect(mocks.state.profile.timestamp).toBe(200);
    });

    it('rejects replayed creation events before replacing record encryption keys', async () => {
        mocks.state.machines = { 'machine-a': machine() };
        mocks.state.artifacts = { 'artifact-a': artifact() };
        const decryptEncryptionKey = vi.fn(async () => new Uint8Array(32));
        const initializeMachines = vi.fn();
        (sync as any).encryption = {
            decryptEncryptionKey,
            initializeMachines,
            getMachineEncryption: vi.fn(),
        };

        await (sync as any).handleUpdate(container('old-machine-create', 11, {
            t: 'new-machine',
            machineId: 'machine-a',
            seq: 0,
            metadata: 'old-metadata',
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
            dataEncryptionKey: 'old-key',
            active: true,
            activeAt: 100,
            createdAt: 100,
            updatedAt: 100,
        }));
        await (sync as any).handleUpdate(container('old-artifact-create', 12, {
            t: 'new-artifact',
            artifactId: 'artifact-a',
            header: 'old-header',
            headerVersion: 0,
            body: 'old-body',
            bodyVersion: 0,
            dataEncryptionKey: 'old-key',
            seq: 0,
            createdAt: 100,
            updatedAt: 100,
        }));

        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expect(initializeMachines).not.toHaveBeenCalled();
        expect(mocks.state.machines['machine-a']).toEqual(machine());
        expect(mocks.state.artifacts['artifact-a']).toEqual(artifact());
    });

    it('binds delete events to the record generation they removed', async () => {
        mocks.state.sessions = { 'session-a': session() };
        mocks.state.machines = { 'machine-a': machine() };
        mocks.state.artifacts = { 'artifact-a': artifact() };

        await (sync as any).handleUpdate(container('old-session-delete', 13, {
            t: 'delete-session',
            sid: 'session-a',
            recordCreatedAt: 50,
        }));
        await (sync as any).handleUpdate(container('old-machine-delete', 14, {
            t: 'delete-machine',
            machineId: 'machine-a',
            recordCreatedAt: 50,
        }));
        await (sync as any).handleUpdate(container('old-artifact-delete', 15, {
            t: 'delete-artifact',
            artifactId: 'artifact-a',
            recordCreatedAt: 50,
        }));

        expect(mocks.state.sessions['session-a']).toBeDefined();
        expect(mocks.state.machines['machine-a']).toBeDefined();
        expect(mocks.state.artifacts['artifact-a']).toBeDefined();
    });
});
