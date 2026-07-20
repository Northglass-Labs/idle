import Constants from 'expo-constants';
import { apiSocket, getCurrentAppState, getIdleClientId } from '@/sync/apiSocket';
import { notifyUnreadMessage } from '@/sync/webTabTitle';
import { AuthCredentials } from '@/auth/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { resolveMachineDataKey } from '@/sync/encryption/machineKeyPolicy';
import { isStrictlyNewerVersion } from '@/sync/versionPolicy';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import {
    isAgentStateAuthenticatedForEffects,
    isMetadataAuthenticatedForEffects,
    storage,
    type SessionApplyContext,
} from './storage';
import { getImageAttachmentSendPlan } from './attachmentSupport';
import {
    ApiEphemeralUpdateSchema,
    ApiMessage,
    ApiMachinesResponseSchema,
    ApiNativeVersionResponseSchema,
    ApiPostSessionMessagesResponseSchema,
    ApiSessionsResponseSchema,
    ApiSettingsResponseSchema,
    ApiSettingsUpdateResponseSchema,
    ApiUpdateContainerSchema,
} from './apiTypes';
import type {
    ApiEphemeralActivityUpdate,
    ApiSessionSnapshot,
    ApiUpdateContainer,
} from './apiTypes';
import {
    MAX_FORWARD_HISTORY_PAGES,
    MAX_MESSAGE_RESPONSE_BODY_BYTES,
    MAX_STORED_SESSION_MESSAGES,
    MESSAGE_HISTORY_PAGE_SIZE,
    parseBoundedMessagePage,
} from './messageHistoryLimits';
import { readBoundedJsonResponse } from './boundedJsonResponse';
import { streamingFetch } from './streamingFetch';
import { Session, Machine } from './storageTypes';
import type { AgentState, Metadata } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { dismissAllNotifications, dismissSessionNotifications } from '@/utils/notificationDismiss';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { syncCurrentPushToken } from './pushRegistration';
import { Platform, AppState, type AppStateStatus } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { NormalizedMessage, normalizeRawMessage, RawRecord, RawRecordSchema } from './typesRaw';
import {
    AuthenticatedMessageIdentitySchema,
} from '@northglass/idle-wire';
import { selectNextMessageIngressBatch } from './messageIngressTransport';
import {
    analyticsConsentUpdate,
    applySettings,
    isAnalyticsConsentGranted,
    Settings,
    settingsDefaults,
    settingsParse,
    settingsToSyncPayload,
    SUPPORTED_SCHEMA_VERSION,
} from './settings';
import { Profile, ProfileSchema } from './profile';
import {
    loadPendingSettings,
    loadSessionReplayFenceCiphertext,
    savePendingSettings,
    saveSessionReplayFenceCiphertext,
} from './persistence';
import {
    setTrackingConsent,
    trackGitHubConnected,
    trackMessageSent,
    trackPaywallCancelled,
    trackPaywallError,
    trackPaywallPresented,
    trackPaywallPurchased,
    trackPaywallRestored,
} from '@/track';
import type { MessageSentSource } from '@/track';
import { parseToken } from '@/utils/parseToken';
import { RevenueCat, LogLevel, PaywallResult } from './revenueCat';
import { getServerUrl } from './serverConfig';
import { config } from '@/config';
import { log } from '@/log';
import { gitStatusSync } from './gitStatusSync';
import { AsyncLock } from '@/utils/lock';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { Message } from './typesMessage';
import { EncryptionCache } from './encryption/encryptionCache';
import { systemPrompt } from './prompt/systemPrompt';
import { fetchArtifact, fetchArtifacts, createArtifact, updateArtifact } from './apiArtifacts';
import { DecryptedArtifact, Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from './artifactTypes';
import { ArtifactEncryption } from './encryption/artifactEncryption';
import { resolveMessageModeMeta } from './messageMeta';
import { parseInlineThinkDirective } from './parseInlineThinkDirective';
import { getCachedSessionOrderV2, saveSessionOrderV2 } from './sessionOrderPersistence';
import { loadSessionFailedMessage } from './persistence';
import { moveSessionToTop as moveSessionToTopFn, moveSessionToGroup as moveSessionToGroupFn, createGroup, renameGroup, deleteGroup, reorderUngrouped as reorderUngroupedFn, reorderSessionsInGroup as reorderSessionsInGroupFn, SessionOrderV2 } from './sessionOrder';
import type { AttachmentPreview, UploadedAttachment } from './attachmentTypes';
import { requestAttachmentUpload, uploadEncryptedBlob } from './apiAttachments';
import { encryptBlob } from '@/encryption/blob';
import { readFileBytes } from '@/utils/readFileBytes';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    SessionEncryption,
    type AgentStateDecryptionResult,
    type MetadataDecryptionResult,
} from './encryption/sessionEncryption';
import {
    MAX_PERSISTED_SESSION_REPLAY_FENCES,
    SessionReplayFencePayloadSchema,
    type SessionReplayFence,
} from './sessionReplayFences';
import {
    loadSessionReplayAnchor,
    saveSessionReplayAnchor,
} from './sessionReplayAnchor';

// Sentinel used as `before_seq` for the very first backward fetch of a
// session. It must exceed any real `seq` value the server can produce.
// `seq` is stored as Postgres int4 on the server, so the maximum is
// 2_147_483_647. We use that exact upper bound to keep the request safely
// within int4 while still being effectively "infinite" for any session.
const SEQ_BACKWARD_INITIAL_SENTINEL = 2_147_483_647;
const MAX_SESSIONS_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
const MAX_MACHINES_RESPONSE_BODY_BYTES = 12 * 1024 * 1024;
const MAX_SETTINGS_RESPONSE_BODY_BYTES = 128 * 1024;
const MAX_PROFILE_RESPONSE_BODY_BYTES = 256 * 1024;
const MAX_VERSION_RESPONSE_BODY_BYTES = 64 * 1024;

type OutboxMessage = {
    localId: string;
    content: string;
    // Retained locally for the failed-send retry path.
    // Not transmitted; only `localId` and `content` go over the wire.
    // Optional: attachment file-event entries have no meaningful plaintext and
    // are skipped by the retry banner (failPendingOutboxMessages guards on it).
    plaintext?: string;
    source?: MessageSentSource;
    displayText?: string;
};

type SendMessageOptions = {
    displayText?: string;
    source?: MessageSentSource;
    /** Optional image attachments to send before the text message. */
    attachments?: AttachmentPreview[];
};

type SessionWithoutPresence = Omit<Session, 'presence'> & {
    presence?: 'online' | number;
};

type SnapshotFieldResult<T> =
    | { success: true; value: T; binding: 'bound' | 'legacy' }
    | { success: false };

function sameSessionDataKey(
    left: Uint8Array | null | undefined,
    right: Uint8Array | null,
): boolean {
    if (left === null || left === undefined || right === null) {
        return left === right;
    }
    if (left.length !== right.length) {
        return false;
    }
    for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) {
            return false;
        }
    }
    return true;
}

function mergeSnapshotField<T>(
    currentValue: T | null,
    currentVersion: number,
    incomingVersion: number,
    result: SnapshotFieldResult<T>,
    isNewGeneration: boolean,
): { value: T | null; version: number } {
    if (!result.success) {
        return { value: currentValue, version: currentVersion };
    }

    if (result.binding === 'legacy') {
        // The raw legacy plaintext is AEAD-readable but does not authenticate
        // the relay-supplied session/field/version coordinate. It may be shown
        // for a newly discovered legacy record, but it never owns a version or
        // overwrites a value already installed for this generation.
        return isNewGeneration
            ? { value: result.value, version: 0 }
            : { value: currentValue, version: currentVersion };
    }

    if (
        isNewGeneration
        || incomingVersion > currentVersion
        || (incomingVersion === currentVersion && currentValue === null)
    ) {
        return { value: result.value, version: incomingVersion };
    }
    return { value: currentValue, version: currentVersion };
}

function boundSnapshotFieldWillApply<T>(
    currentValue: T | null,
    currentVersion: number,
    incomingVersion: number,
    result: SnapshotFieldResult<T>,
    isNewGeneration: boolean,
): boolean {
    return result.success
        && result.binding === 'bound'
        && (
            isNewGeneration
            || incomingVersion > currentVersion
            || (incomingVersion === currentVersion && currentValue === null)
        );
}

function enforceBoundSnapshotVersionFloor<T>(
    result: SnapshotFieldResult<T>,
    incomingVersion: number,
    minimumVersion: number,
    incomingCiphertextCommitment: string | null,
    minimumCiphertextCommitment: string | null,
): SnapshotFieldResult<T> {
    if (
        result.success
        && result.binding === 'bound'
        && (
            incomingVersion < minimumVersion
            || (
                incomingVersion === minimumVersion
                && minimumCiphertextCommitment !== null
                && incomingCiphertextCommitment !== minimumCiphertextCommitment
            )
        )
    ) {
        return { success: false };
    }
    return result;
}

function mergeSessionSnapshot(
    incoming: ApiSessionSnapshot,
    current: Session | undefined,
    metadataResult: MetadataDecryptionResult,
    agentStateResult: AgentStateDecryptionResult,
): SessionWithoutPresence {
    const isNewGeneration = !current;
    const metadata = mergeSnapshotField<Metadata>(
        isNewGeneration ? null : current.metadata,
        isNewGeneration ? 0 : current.metadataVersion,
        incoming.metadataVersion,
        metadataResult,
        isNewGeneration,
    );
    const agentState = mergeSnapshotField<AgentState>(
        isNewGeneration ? null : current.agentState,
        isNewGeneration ? 0 : current.agentStateVersion,
        incoming.agentStateVersion,
        agentStateResult,
        isNewGeneration,
    );
    const acceptsSnapshotActivity = isNewGeneration
        || incoming.activeAt > (current?.activeAt ?? -1);

    return {
        ...(isNewGeneration ? {} : current),
        id: incoming.id,
        seq: isNewGeneration ? incoming.seq : Math.max(current.seq, incoming.seq),
        createdAt: incoming.createdAt,
        updatedAt: isNewGeneration
            ? incoming.updatedAt
            : Math.max(current.updatedAt, incoming.updatedAt),
        active: acceptsSnapshotActivity ? incoming.active : current.active,
        activeAt: acceptsSnapshotActivity ? incoming.activeAt : current.activeAt,
        metadata: metadata.value,
        metadataVersion: metadata.version,
        agentState: agentState.value,
        agentStateVersion: agentState.version,
        thinking: isNewGeneration ? false : current.thinking,
        thinkingAt: isNewGeneration ? 0 : current.thinkingAt,
    };
}

export class Sync {
    private static readonly BACKGROUND_SEND_TIMEOUT_MS = 30_000;
    private static readonly MAX_RECENT_PERSISTENT_UPDATE_IDS = 4_096;
    private static readonly MAX_RECENT_PERSISTENT_MESSAGE_REPLAY_KEYS = 4_096;
    private static readonly MAX_RECENT_PERMISSION_REQUEST_REPLAY_KEYS = 4_096;
    private static readonly MAX_SESSION_DELETION_TOMBSTONES = MAX_PERSISTED_SESSION_REPLAY_FENCES;
    private static readonly MAX_SESSION_REPLAY_FENCE_CIPHERTEXT_BYTES = 2 * 1024 * 1024;
    encryption!: Encryption;
    serverID!: string;
    private credentials!: AuthCredentials;
    public encryptionCache = new EncryptionCache();
    private sessionsSync: InvalidateSync;
    private messagesSync = new Map<string, InvalidateSync>();
    private sendSync = new Map<string, InvalidateSync>();
    private sendAbortControllers = new Map<string, AbortController>();
    private sessionLastSeq = new Map<string, number>();
    // Lowest seq value we have already fetched and applied for a session.
    // Used as the cursor for backward pagination when the user scrolls up to
    // load older history. Set after the initial latest-page fetch and
    // advanced downward by loadOlderMessages.
    private sessionOldestSeq = new Map<string, number>();
    private pendingOutbox = new Map<string, OutboxMessage[]>();
    private sessionMessageQueue = new Map<string, NormalizedMessage[]>();
    private sessionQueueProcessing = new Set<string>();
    private sessionMessageLocks = new Map<string, AsyncLock>();
    // Socket.IO does not await async listeners. Keep persistent updates in
    // delivery order so a slower decrypt cannot commit after a newer event and
    // roll a record back.
    private persistentUpdateLock = new AsyncLock();
    // Snapshot hydration must share a commit boundary with persistent updates,
    // but it cannot take the delivery-order lock: an update may be waiting for
    // the active sessions sync to finish.
    private persistentStateCommitLock = new AsyncLock();
    private replayFencePersistenceLock = new AsyncLock();
    private recentPersistentUpdateIds = new Map<string, true>();
    private recentPersistentMessageReplayKeys = new Map<string, true>();
    private recentPermissionRequestReplayKeys = new Map<string, true>();
    private sessionDataKeys = new Map<string, Uint8Array | null>(); // Store session data encryption keys internally
    // A full snapshot may have started before a persistent deletion arrived.
    // Bind deletions to their record generation so that delayed snapshots can
    // never recreate the generation that was just removed.
    private sessionSnapshotEpoch = 0;
    private sessionDeletionTombstones = new Map<string, number>();
    private sessionDeletionTombstonesSaturated = false;
    private sessionReplayFences = new Map<string, SessionReplayFence>();
    private sessionReplayProtectionState:
        | 'ready'
        | 'ready-browser-consistency-only'
        | 'loading'
        | 'degraded' = 'ready';
    private sessionReplayFenceEpoch = 0;
    private sessionReplayFenceAccountCommitment: string | null = null;
    private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
    private artifactDataKeys = new Map<string, Uint8Array>(); // Store artifact data encryption keys internally
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private purchasesSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private pushTokenSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private activityAccumulator: ActivityUpdateAccumulator;
    private pendingSettings: Partial<Settings> = loadPendingSettings();
    private appState: AppStateStatus = AppState.currentState;
    private backgroundSendTimeout: ReturnType<typeof setTimeout> | null = null;
    private backgroundSendNotificationId: string | null = null;
    private backgroundSendStartedAt: number | null = null;
    revenueCatInitialized = false;

    // Generic locking mechanism
    private recalculationLockCount = 0;
    private lastRecalculationTime = 0;

    constructor() {
        this.sessionsSync = new InvalidateSync(this.fetchSessions);
        this.settingsSync = new InvalidateSync(this.syncSettings);
        this.profileSync = new InvalidateSync(this.fetchProfile);
        this.purchasesSync = new InvalidateSync(this.syncPurchases);
        this.machinesSync = new InvalidateSync(this.fetchMachines);
        this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate);
        this.artifactsSync = new InvalidateSync(this.fetchArtifactsList);

        const registerPushToken = async () => {
            await this.registerPushToken();
        }
        this.pushTokenSync = new InvalidateSync(registerPushToken);
        this.activityAccumulator = new ActivityUpdateAccumulator(this.flushActivityUpdates.bind(this), 2000);

        // Listen for app state changes to refresh purchases
        AppState.addEventListener('change', (nextAppState) => {
            this.appState = nextAppState;

            // Notify server of focus state for push notification routing.
            // Mobile: AppState.currentState reflects fg/bg directly.
            // Web/desktop: visibilitychange/focus listeners below drive this same path
            // by updating this.appState too — re-derive via getCurrentAppState() so
            // the wire value matches what the server uses for suppression.
            apiSocket.sendAppState(getCurrentAppState());

            if (nextAppState === 'active') {
                const shouldFailAfterResume = this.backgroundSendStartedAt !== null
                    && this.hasPendingOutboxMessages()
                    && (Date.now() - this.backgroundSendStartedAt) >= Sync.BACKGROUND_SEND_TIMEOUT_MS;
                void this.cancelBackgroundSendTimeoutNotification();
                this.clearBackgroundSendWatchdog();
                if (shouldFailAfterResume) {
                    void this.notifyMessageSendFailed();
                    this.failPendingOutboxMessages('Message failed to send in background after 30s. Please retry.');
                }
                log.log('📱 App became active');
                // notification handling: blanket-dismiss notifications + reset badge as the
                // user re-engages. Per-session dismissal in onSessionVisible
                // handles the targeted case (notification tap → routes to a
                // session); this handler covers everything else (cold launch,
                // tab-back without a notification trigger, etc.) so the
                // Notification Center doesn't accumulate stale Idle entries.
                void dismissAllNotifications();
                this.purchasesSync.invalidate();
                this.profileSync.invalidate();
                this.machinesSync.invalidate();
                this.pushTokenSync.invalidate();
                this.sessionsSync.invalidate();
                this.messagesSync.forEach((sync) => sync.invalidate()); // refresh per-session messages — sessionsSync alone leaves them stale on resume
                this.nativeUpdateSync.invalidate();
                log.log('📱 App became active: Invalidating artifacts sync');
                this.artifactsSync.invalidate();
            } else {
                log.log(`📱 App state changed to: ${nextAppState}`);
                this.maybeStartBackgroundSendWatchdog();
            }
        });

        // Web/desktop: AppState alone doesn't capture tab focus/visibility.
        // Notify server when the tab becomes hidden, regains visibility,
        // or window focus changes — so push routing can suppress only when
        // the user is actually looking at this client.
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
            const broadcast = () => {
                apiSocket.sendAppState(getCurrentAppState());
            };
            document.addEventListener('visibilitychange', broadcast);
            window.addEventListener('focus', broadcast);
            window.addEventListener('blur', broadcast);
        }
    }

    async create(credentials: AuthCredentials, encryption: Encryption) {
        this.credentials = credentials;
        this.encryption = encryption;
        this.serverID = parseToken(credentials.token);
        await this.loadSessionReplayFences();
        if (!this.isSessionReplayProtectionOperational()) return;
        await this.#init();

        // Await settings sync to have fresh settings
        await this.settingsSync.awaitQueue();

        // Await profile sync to have fresh profile
        await this.profileSync.awaitQueue();

        // Await purchases sync to have fresh purchases
        await this.purchasesSync.awaitQueue();
    }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        this.credentials = credentials;
        this.encryption = encryption;
        this.serverID = parseToken(credentials.token);
        await this.loadSessionReplayFences();
        if (!this.isSessionReplayProtectionOperational()) return;
        await this.#init();
    }

    async #init() {

        // Subscribe to updates
        this.subscribeToUpdates();

        // Do not construct an analytics client before the stored consent state
        // explicitly enables it.
        setTrackingConsent(isAnalyticsConsentGranted(storage.getState().settings));

        // Invalidate sync
        log.log('🔄 #init: Invalidating all syncs');
        this.sessionsSync.invalidate();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.purchasesSync.invalidate();
        this.machinesSync.invalidate();
        this.pushTokenSync.invalidate();
        this.nativeUpdateSync.invalidate();
        this.artifactsSync.invalidate();
        log.log('🔄 #init: All syncs invalidated, including artifacts');

        // Mark UI ready as soon as sessions load. Machines sync may hang
        // when encryption keys are unavailable (e.g. V1 auth fallback) —
        // let it resolve in the background instead of blocking the UI.
        this.sessionsSync.awaitQueue().then(() => {
            storage.getState().applyReady();
        }).catch(() => {
            console.error('Failed to load sessions');
            // Still mark ready so the UI doesn't stay on a blank screen forever
            storage.getState().applyReady();
        });
    }


    /**
     * Idempotent message-stream refresh for an open session. SessionView's
     * keepalive poll uses it to defend against
     * server-side subscription drift where the socket stays "connected" but
     * the live `update` stream goes silent until the client speaks. Cheap:
     * forward-since-last-seq fetch returns empty when nothing's new.
     */
    refreshSessionMessages = (sessionId: string) => {
        this.getMessagesSync(sessionId).invalidate();
    }

    onSessionVisible = (sessionId: string) => {
        this.getMessagesSync(sessionId).invalidate();

        // notification handling: dismiss any iOS / Android notifications for this session.
        // The user is now actively viewing it; the notifications were useful
        // before they engaged, and are noise now. iOS does not auto-dismiss
        // on tap — the app has to call dismissNotificationAsync explicitly.
        void dismissSessionNotifications(sessionId);

        // Hydrate the local failed-message draft here as well as during session
        // loading so navigation can safely win the cold-start race.
        const failed = storage.getState().failedMessageDrafts[sessionId];
        if (!failed) {
            const cached = loadSessionFailedMessage(sessionId);
            if (cached) {
                storage.getState().setFailedMessageDraft(sessionId, cached);
            }
        }

        // Notify voice assistant about session visibility
        const session = storage.getState().sessions[sessionId];
        if (session && isMetadataAuthenticatedForEffects(session.metadata)) {
            // Operational sinks must never consume display-only legacy paths,
            // machine IDs, flavors, or host metadata.
            gitStatusSync.getSync(sessionId).invalidate();
            voiceHooks.onSessionFocus(sessionId, session.metadata ?? undefined);
        }
    }

    private getMessagesSync(sessionId: string): InvalidateSync {
        let sync = this.messagesSync.get(sessionId);
        if (!sync) {
            sync = new InvalidateSync(() => this.fetchMessages(sessionId));
            this.messagesSync.set(sessionId, sync);
        }
        return sync;
    }

    private getSendSync(sessionId: string): InvalidateSync {
        let sync = this.sendSync.get(sessionId);
        if (!sync) {
            sync = new InvalidateSync(() => this.flushOutbox(sessionId));
            this.sendSync.set(sessionId, sync);
        }
        return sync;
    }

    private enqueueMessages(sessionId: string, messages: NormalizedMessage[]) {
        if (messages.length === 0) {
            return;
        }

        let queue = this.sessionMessageQueue.get(sessionId);
        if (!queue) {
            queue = [];
            this.sessionMessageQueue.set(sessionId, queue);
        }
        queue.push(...messages);

        this.scheduleQueuedMessagesProcessing(sessionId);
    }

    private getSessionMessageLock(sessionId: string): AsyncLock {
        let lock = this.sessionMessageLocks.get(sessionId);
        if (!lock) {
            lock = new AsyncLock();
            this.sessionMessageLocks.set(sessionId, lock);
        }
        return lock;
    }

    private scheduleQueuedMessagesProcessing(sessionId: string) {
        if (this.sessionQueueProcessing.has(sessionId)) {
            return;
        }

        this.sessionQueueProcessing.add(sessionId);
        const lock = this.getSessionMessageLock(sessionId);
        void lock.inLock(() => {
            while (true) {
                const pending = this.sessionMessageQueue.get(sessionId);
                if (!pending || pending.length === 0) {
                    break;
                }
                const batch = pending.splice(0, pending.length);
                this.applyMessages(sessionId, batch);
            }
        }).finally(() => {
            this.sessionQueueProcessing.delete(sessionId);
            const pending = this.sessionMessageQueue.get(sessionId);
            if (pending && pending.length > 0) {
                this.scheduleQueuedMessagesProcessing(sessionId);
            }
        });
    }

    private hasPendingOutboxMessages() {
        if (this.sendAbortControllers.size > 0) {
            return true;
        }
        for (const messages of this.pendingOutbox.values()) {
            if (messages.length > 0) {
                return true;
            }
        }
        return false;
    }

    private maybeStartBackgroundSendWatchdog() {
        if (Platform.OS === 'web' || this.appState === 'active') {
            return;
        }
        if (!this.hasPendingOutboxMessages() || this.backgroundSendTimeout) {
            return;
        }

        log.log('📨 Pending messages detected in background. Starting 30s send watchdog.');
        this.backgroundSendStartedAt = Date.now();
        this.backgroundSendTimeout = setTimeout(() => {
            this.backgroundSendTimeout = null;
            void this.handleBackgroundSendTimeout();
        }, Sync.BACKGROUND_SEND_TIMEOUT_MS);
        void this.scheduleBackgroundSendTimeoutNotification();
    }

    private clearBackgroundSendWatchdog() {
        if (this.backgroundSendTimeout) {
            clearTimeout(this.backgroundSendTimeout);
            this.backgroundSendTimeout = null;
        }
        this.backgroundSendStartedAt = null;
    }

    private async scheduleBackgroundSendTimeoutNotification() {
        if (Platform.OS === 'web' || this.backgroundSendNotificationId) {
            return;
        }
        try {
            this.backgroundSendNotificationId = await Notifications.scheduleNotificationAsync({
                content: {
                    title: 'Message not sent',
                    body: 'A message is still sending in the background. It will fail in 30 seconds if not delivered.',
                    sound: true
                },
                trigger: {
                    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
                    seconds: Math.ceil(Sync.BACKGROUND_SEND_TIMEOUT_MS / 1000)
                }
            });
        } catch {
            log.log('Failed to schedule background send timeout notification');
        }
    }

    private async cancelBackgroundSendTimeoutNotification() {
        if (!this.backgroundSendNotificationId) {
            return;
        }
        try {
            await Notifications.cancelScheduledNotificationAsync(this.backgroundSendNotificationId);
        } catch {
            log.log('Failed to cancel background send timeout notification');
        } finally {
            this.backgroundSendNotificationId = null;
        }
    }

    private async notifyMessageSendFailed() {
        if (Platform.OS === 'web') {
            return;
        }
        try {
            await Notifications.scheduleNotificationAsync({
                content: {
                    title: 'Message failed',
                    body: 'A message failed to send while the app was in background. Open Idle and retry.',
                    sound: true
                },
                trigger: null
            });
        } catch {
            log.log('Failed to schedule message failure notification');
        }
    }

    private failPendingOutboxMessages(reasonText: string) {
        for (const controller of this.sendAbortControllers.values()) {
            controller.abort();
        }
        this.sendAbortControllers.clear();

        const now = Date.now();
        const sessionIds: string[] = [];
        for (const [sessionId, pending] of this.pendingOutbox) {
            if (pending.length === 0) {
                continue;
            }
            // Capture only the most recent failed plaintext and options so the UI
            // can offer one bounded Retry or Discard action per session.
            const lastFailed = pending[pending.length - 1];
            if (lastFailed?.plaintext) {
                storage.getState().setFailedMessageDraft(sessionId, {
                    text: lastFailed.plaintext,
                    failedAt: now,
                    source: lastFailed.source,
                    displayText: lastFailed.displayText,
                });
            }
            pending.length = 0;
            this.pendingOutbox.delete(sessionId);
            sessionIds.push(sessionId);
        }

        for (const sessionId of sessionIds) {
            this.enqueueMessages(sessionId, [{
                id: randomUUID(),
                localId: null,
                createdAt: now,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'message',
                    message: reasonText
                }
            }]);
        }
    }

    private async handleBackgroundSendTimeout() {
        if (!this.hasPendingOutboxMessages()) {
            await this.cancelBackgroundSendTimeoutNotification();
            this.backgroundSendStartedAt = null;
            return;
        }

        await this.cancelBackgroundSendTimeoutNotification();
        await this.notifyMessageSendFailed();
        this.failPendingOutboxMessages('Message failed to send in background after 30s. Please retry.');
        this.backgroundSendStartedAt = null;
    }

    /**
     * Upload image attachments for a session: read bytes → encrypt → upload to server.
     * Returns UploadedAttachment records to embed as file events before the text message.
     * Failures are logged and skipped rather than aborting the whole message send.
     */
    private async uploadAttachmentsForSession(
        sessionId: string,
        attachments: AttachmentPreview[],
    ): Promise<{ uploaded: UploadedAttachment[]; failed: number }> {
        if (!this.credentials) return { uploaded: [], failed: attachments.length };

        const blobKey = this.encryption.getSessionBlobKey(sessionId);
        if (!blobKey) {
            console.error('[attachments] Session blob key unavailable');
            return { uploaded: [], failed: attachments.length };
        }

        const uploaded: UploadedAttachment[] = [];
        let failed = 0;

        for (const attachment of attachments) {
            try {
                const bytes = await readFileBytes(attachment.uri);
                const encrypted = encryptBlob(bytes, blobKey);

                const upload = await requestAttachmentUpload(
                    this.credentials,
                    sessionId,
                    attachment.name,
                    encrypted.length,
                );

                await uploadEncryptedBlob(upload, encrypted, this.credentials);
                const { ref } = upload;

                uploaded.push({
                    ref,
                    name: attachment.name,
                    size: attachment.size,
                    width: attachment.width,
                    height: attachment.height,
                    thumbhash: attachment.thumbhash,
                });
            } catch {
                console.error('Failed to upload image attachment');
                failed++;
                // Skip this attachment; do not abort the whole message send.
            }
        }

        return { uploaded, failed };
    }

    async sendMessage(sessionId: string, text: string, options?: SendMessageOptions) {

        // Session encryption may lag the initial session sync. Wait for the
        // active sync once and re-check before declining to send.
        let encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            await this.sessionsSync.awaitQueue();
            encryption = this.encryption.getSessionEncryption(sessionId);
            if (!encryption) {
                console.error('Session encryption unavailable after sync');
                return;
            }
        }

        // Get session data from storage — same race protection.
        let session = storage.getState().sessions[sessionId];
        if (!session) {
            await this.sessionsSync.awaitQueue();
            session = storage.getState().sessions[sessionId];
            if (!session) {
                console.error('Session unavailable after sync');
                return;
            }
        }

        const operationalMetadata = isMetadataAuthenticatedForEffects(session.metadata)
            ? session.metadata
            : null;
        const modeMeta = resolveMessageModeMeta(
            { ...session, metadata: operationalMetadata },
            storage.getState().settings,
        );
        const { displayText, source = 'chat', attachments } = options ?? {};

        // One-shot effort override via `/think <tier>` slash prefix at the
        // start of the message body. Matches the cogwheel's effort tiers
        // exactly (low/medium/high/xhigh/max) so slash command and cogwheel
        // share vocabulary. When present:
        //   - Strip the prefix from the message text (Claude sees just the
        //     real prompt, not the command noise)
        //   - Override the session-default effort for THIS message only
        //     (applied to modeMeta.effort, the validated effort meta key)
        // Bare `/think` (no tier) is left as-is in the text and falls through
        // to natural-language interpretation.
        let messageText = text;
        const inlineDirective = parseInlineThinkDirective(text);
        if (inlineDirective) {
            messageText = inlineDirective.remainingText;
            modeMeta.effort = inlineDirective.tier;
        }

        const flavor = operationalMetadata?.flavor;
        const attachmentPlan = getImageAttachmentSendPlan({
            flavor,
            text: messageText,
            attachmentCount: attachments?.length ?? 0,
        });
        const effectiveAttachments = attachmentPlan.shouldUseAttachments ? attachments : undefined;

        if (attachmentPlan.shouldShowUnsupportedAlert) {
            Modal.alert(
                t('imageUpload.notSupportedTitle'),
                t('imageUpload.notSupportedMessage'),
                [{ text: t('common.ok'), style: 'cancel' }],
            );
            if (!attachmentPlan.shouldSendText) {
                return;
            }
        }

        // Upload attachments and queue file events before the text message.
        if (effectiveAttachments && effectiveAttachments.length > 0) {
            const { uploaded, failed } = await this.uploadAttachmentsForSession(sessionId, effectiveAttachments);

            if (failed > 0) {
                Modal.alert(
                    t('imageUpload.uploadFailedTitle'),
                    t('imageUpload.uploadFailedMessage', { count: failed }),
                    [{ text: t('common.ok'), style: 'cancel' }],
                );
            }

            if (uploaded.length > 0) {
                let pending = this.pendingOutbox.get(sessionId);
                if (!pending) {
                    pending = [];
                    this.pendingOutbox.set(sessionId, pending);
                }

                for (const att of uploaded) {
                    const fileLocalId = randomUUID();
                    const fileRecord: RawRecord = {
                        role: 'session',
                        content: {
                            type: 'session',
                            data: {
                                id: randomUUID(),
                                time: Date.now(),
                                role: 'user',
                                ev: {
                                    t: 'file',
                                    ref: att.ref,
                                    name: att.name,
                                    size: att.size,
                                    // Include image metadata when we have dimensions; thumbhash is
                                    // optional. The native iOS picker can't generate a thumbhash
                                    // without Canvas, so requiring it here would reduce the chat
                                    // bubble to a compact filename row instead of an inline picture.
                                    // FileView only needs w/h to size the inline render — placeholder
                                    // is absent, but the real image is decrypted on mount.
                                    ...(att.width > 0 && att.height > 0
                                        ? {
                                            image: {
                                                width: att.width,
                                                height: att.height,
                                                ...(att.thumbhash ? { thumbhash: att.thumbhash } : {}),
                                            },
                                        }
                                        : {}),
                                },
                            },
                        },
                    };
                    const encryptedFileRecord = await encryption.encryptRawRecord(fileRecord, fileLocalId);
                    const fileNormalized = normalizeRawMessage(fileLocalId, fileLocalId, Date.now(), fileRecord);
                    if (fileNormalized) {
                        this.enqueueMessages(sessionId, [fileNormalized]);
                    }
                    pending.push({ localId: fileLocalId, content: encryptedFileRecord });
                }
            }
        }

        // Generate local ID
        const localId = randomUUID();

        // Determine sentFrom based on platform
        let sentFrom: string;
        if (Platform.OS === 'web') {
            sentFrom = 'web';
        } else if (Platform.OS === 'android') {
            sentFrom = 'android';
        } else if (Platform.OS === 'ios') {
            // Check if running on Mac (Catalyst or Designed for iPad on Mac)
            if (isRunningOnMac()) {
                sentFrom = 'mac';
            } else {
                sentFrom = 'ios';
            }
        } else {
            sentFrom = 'web'; // fallback
        }

        // Create user message content with metadata
        const content: RawRecord = {
            role: 'user',
            content: {
                type: 'text',
                text: messageText
            },
            meta: {
                sentFrom,
                appendSystemPrompt: systemPrompt,
                ...(modeMeta.permissionMode !== undefined ? { permissionMode: modeMeta.permissionMode } : {}),
                ...(modeMeta.model !== undefined ? { model: modeMeta.model } : {}),
                ...(modeMeta.effort !== undefined ? { effort: modeMeta.effort } : {}),
                ...(displayText && { displayText }) // Add displayText if provided
            }
        };
        const encryptedRawRecord = await encryption.encryptRawRecord(content, localId);

        // Add to messages - normalize the raw record
        const createdAt = Date.now();
        const normalizedMessage = normalizeRawMessage(localId, localId, createdAt, content);
        if (normalizedMessage) {
            this.enqueueMessages(sessionId, [normalizedMessage]);
        }

        let pending = this.pendingOutbox.get(sessionId);
        if (!pending) {
            pending = [];
            this.pendingOutbox.set(sessionId, pending);
        }
        pending.push({
            localId,
            content: encryptedRawRecord,
            // Retain plaintext and send options locally for retry; they never
            // cross the wire through this field.
            plaintext: messageText,
            source,
            displayText,
        });
        // A new send supersedes the session's failed-message marker. Success
        // clears it during flush; failure replaces it with the current attempt.
        storage.getState().setFailedMessageDraft(sessionId, null);

        trackMessageSent(source, operationalMetadata);

        this.getSendSync(sessionId).invalidate();
        this.maybeStartBackgroundSendWatchdog();
    }

    // Retry clears the persisted draft before using the normal send path.
    async retryFailedMessage(sessionId: string) {
        const draft = storage.getState().failedMessageDrafts[sessionId];
        if (!draft) return;
        storage.getState().setFailedMessageDraft(sessionId, null);
        await this.sendMessage(sessionId, draft.text, {
            source: draft.source,
            displayText: draft.displayText,
        });
    }

    // Discard clears the failed draft without retrying.
    discardFailedMessage(sessionId: string) {
        storage.getState().setFailedMessageDraft(sessionId, null);
    }

    /** Server sent us settings — merge any pending local changes on top, then apply as one update. */
    private applyServerSettings = (serverSettings: Settings, version: number): Settings => {
        const merged = Object.keys(this.pendingSettings).length > 0
            ? applySettings(serverSettings, this.pendingSettings)
            : serverSettings;
        storage.getState().applySettings(merged, version);
        return storage.getState().settings;
    }

    applySettings = (delta: Partial<Settings>) => {
        const effectiveDelta = typeof delta.analyticsOptOut === 'boolean'
            ? { ...delta, ...analyticsConsentUpdate(!delta.analyticsOptOut) }
            : delta;

        storage.getState().applySettingsLocal(effectiveDelta);

        // Save pending settings
        this.pendingSettings = { ...this.pendingSettings, ...effectiveDelta };
        savePendingSettings(this.pendingSettings);

        // Sync analytics consent if it was changed.
        if ('analyticsOptOut' in effectiveDelta) {
            setTrackingConsent(isAnalyticsConsentGranted(storage.getState().settings));
        }

        // Invalidate settings sync
        this.settingsSync.invalidate();
    }

    refreshPurchases = () => {
        this.purchasesSync.invalidate();
    }

    refreshProfile = async () => {
        await this.profileSync.invalidateAndAwait();
    }

    purchaseProduct = async (productId: string): Promise<{ success: boolean; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            // Fetch the product
            const products = await RevenueCat.getProducts([productId]);
            if (products.length === 0) {
                return { success: false, error: `Product '${productId}' not found` };
            }

            // Purchase the product
            const product = products[0];
            const { customerInfo } = await RevenueCat.purchaseStoreProduct(product);

            // Update local purchases data
            storage.getState().applyPurchases(customerInfo);

            return { success: true };
        } catch (error: any) {
            // Check if user cancelled
            if (error.userCancelled) {
                return { success: false, error: 'Purchase cancelled' };
            }

            // Return the error message
            return { success: false, error: error.message || 'Purchase failed' };
        }
    }

    getOfferings = async (): Promise<{ success: boolean; offerings?: any; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            // Fetch offerings
            const offerings = await RevenueCat.getOfferings();

            // Return the offerings data
            return {
                success: true,
                offerings: {
                    current: offerings.current,
                    all: offerings.all
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message || 'Failed to fetch offerings' };
        }
    }

    presentPaywall = async (flow?: string): Promise<{ success: boolean; purchased?: boolean; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                const error = 'RevenueCat not initialized';
                trackPaywallError(error, flow);
                return { success: false, error };
            }

            // Track paywall presentation
            trackPaywallPresented(flow);

            // Present the paywall (with flow custom variable if specified)
            const result = await RevenueCat.presentPaywall(
                flow ? { customVariables: { flow } } : undefined
            );

            // Handle the result
            switch (result) {
                case PaywallResult.PURCHASED:
                    trackPaywallPurchased(flow);
                    // Refresh customer info after purchase
                    await this.syncPurchases();
                    return { success: true, purchased: true };
                case PaywallResult.RESTORED:
                    trackPaywallRestored(flow);
                    // Refresh customer info after restore
                    await this.syncPurchases();
                    return { success: true, purchased: true };
                case PaywallResult.CANCELLED:
                    trackPaywallCancelled(flow);
                    return { success: true, purchased: false };
                case PaywallResult.NOT_PRESENTED:
                    trackPaywallError('Paywall not presented', flow);
                    return { success: false, error: 'Paywall not available on this platform' };
                case PaywallResult.ERROR:
                default:
                    const errorMsg = 'Failed to present paywall';
                    trackPaywallError(errorMsg, flow);
                    return { success: false, error: errorMsg };
            }
        } catch (error: any) {
            const errorMessage = error.message || 'Failed to present paywall';
            trackPaywallError(errorMessage, flow);
            return { success: false, error: errorMessage };
        }
    }

    //
    // Private
    //

    private markSessionReplayProtectionDegraded(): void {
        this.sessionReplayProtectionState = 'degraded';
        this.sessionReplayFences.clear();
        this.sessionDeletionTombstones.clear();
        this.sessionDeletionTombstonesSaturated = true;
        console.error('Session replay protection unavailable; local recovery is required');

        // A corrupt, missing, or rolled-back fence must not leave a live socket
        // able to deliver operational updates. Logout and re-pairing clear both
        // halves of the local fence and are the explicit recovery path.
        if (typeof (apiSocket as unknown as { disconnect?: () => void }).disconnect === 'function') {
            apiSocket.disconnect();
        }
        const currentStorage = storage.getState() as unknown as {
            setSocketStatus?: (status: 'error') => void;
            setSocketDetails?: (details: { lastErrorMessage: string }) => void;
        };
        currentStorage.setSocketStatus?.('error');
        currentStorage.setSocketDetails?.({
            lastErrorMessage: 'Local session security state needs recovery. Sign out and pair this device again.',
        });
    }

    private isSessionReplayProtectionOperational(): boolean {
        return this.sessionReplayProtectionState === 'ready'
            || this.sessionReplayProtectionState === 'ready-browser-consistency-only';
    }

    private async replayFenceCommitment(value: string): Promise<string> {
        return digestStringAsync(CryptoDigestAlgorithm.SHA256, value);
    }

    private async messageCiphertextCommitment(
        sessionId: string,
        message: ApiMessage,
    ): Promise<string> {
        // Hash the potentially multi-megabyte ciphertext separately so the
        // coordinate commitment stays small and does not duplicate that body
        // in a second concatenated string.
        const contentCommitment = await this.replayFenceCommitment(message.content.c);
        return this.replayFenceCommitment(JSON.stringify({
            version: 1,
            sessionId,
            id: message.id,
            seq: message.seq,
            localId: message.localId ?? null,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
            contentCommitment,
        }));
    }

    private async advanceLiveMessageReplayFloor(
        sessionId: string,
        message: ApiMessage,
    ): Promise<'advanced' | 'existing' | 'unfenced'> {
        const fence = this.sessionReplayFences.get(sessionId);
        if (!fence) return 'unfenced';

        const floor = fence.messageSeq ?? 0;
        const commitment = await this.messageCiphertextCommitment(sessionId, message);
        if (message.seq < floor) {
            throw new Error('Message replay floor rejected a stale live message');
        }
        if (message.seq === floor) {
            if (fence.messageCiphertextCommitment !== commitment) {
                throw new Error('Message replay floor rejected equivocated ciphertext');
            }
            return 'existing';
        }

        this.sessionReplayFences.set(sessionId, {
            ...fence,
            messageSeq: message.seq,
            messageCiphertextCommitment: commitment,
        });
        await this.persistSessionReplayFences();
        return 'advanced';
    }

    private async verifyAndAdvanceFetchedMessageReplayFloor(
        sessionId: string,
        messages: readonly ApiMessage[],
        pageKind: 'tip' | 'history',
    ): Promise<void> {
        if (pageKind === 'history') return;
        const fence = this.sessionReplayFences.get(sessionId);
        if (!fence) return;

        const floor = fence.messageSeq ?? 0;
        if (messages.length === 0) {
            if (floor > 0) {
                throw new Error('Message replay floor rejected an empty tip page');
            }
            return;
        }
        const atFloor = floor > 0
            ? messages.find((message) => message.seq === floor)
            : undefined;
        if (atFloor) {
            const commitment = await this.messageCiphertextCommitment(sessionId, atFloor);
            if (fence.messageCiphertextCommitment !== commitment) {
                throw new Error('Message replay floor rejected equivocated ciphertext');
            }
        }

        let newest: ApiMessage | undefined;
        for (const message of messages) {
            if (!newest || message.seq > newest.seq) newest = message;
        }
        if (!newest) return;
        if (newest.seq < floor) {
            throw new Error('Message replay floor rejected a truncated tip page');
        }
        if (newest.seq === floor) return;

        const commitment = await this.messageCiphertextCommitment(sessionId, newest);
        this.sessionReplayFences.set(sessionId, {
            ...fence,
            messageSeq: newest.seq,
            messageCiphertextCommitment: commitment,
        });
        await this.persistSessionReplayFences();
    }

    private async replayFenceAccountCommitment(): Promise<string> {
        if (typeof this.serverID !== 'string' || this.serverID.length === 0) {
            throw new Error('Session replay account identity unavailable');
        }
        return this.replayFenceCommitment(`idle-session-replay-account-v1:${this.serverID}`);
    }

    private installSessionReplayFencePayload(payload: {
        sessions: readonly SessionReplayFence[];
        tombstones: readonly { sessionId: string; recordCreatedAt: number }[];
        tombstonesSaturated: boolean;
    }): void {
        for (const fence of payload.sessions) {
            this.sessionReplayFences.set(fence.sessionId, fence);
        }
        for (const tombstone of payload.tombstones) {
            this.sessionDeletionTombstones.set(
                tombstone.sessionId,
                tombstone.recordCreatedAt,
            );
        }
        this.sessionDeletionTombstonesSaturated = payload.tombstonesSaturated;
    }

    private async loadSessionReplayFences(): Promise<void> {
        this.sessionReplayFences.clear();
        this.sessionDeletionTombstones.clear();
        this.sessionDeletionTombstonesSaturated = false;
        this.sessionReplayProtectionState = 'loading';
        this.sessionReplayFenceEpoch = 0;
        this.sessionReplayFenceAccountCommitment = null;

        try {
            if (
                typeof this.encryption?.decryptRaw !== 'function'
                || typeof this.encryption?.encryptRaw !== 'function'
            ) {
                this.markSessionReplayProtectionDegraded();
                return;
            }

            const accountCommitment = await this.replayFenceAccountCommitment();
            this.sessionReplayFenceAccountCommitment = accountCommitment;
            const [anchorResult, ciphertext] = await Promise.all([
                loadSessionReplayAnchor(),
                Promise.resolve(loadSessionReplayFenceCiphertext()),
            ]);

            if (anchorResult.status === 'available') {
                if (
                    anchorResult.anchor.accountCommitment !== accountCommitment
                    || ciphertext === null
                    || ciphertext.length > Sync.MAX_SESSION_REPLAY_FENCE_CIPHERTEXT_BYTES
                    || await this.replayFenceCommitment(ciphertext)
                        !== anchorResult.anchor.ciphertextCommitment
                ) {
                    this.markSessionReplayProtectionDegraded();
                    return;
                }

                const decrypted = await this.encryption.decryptRaw(ciphertext);
                const parsed = SessionReplayFencePayloadSchema.safeParse(decrypted);
                if (
                    !parsed.success
                    || parsed.data.accountCommitment !== accountCommitment
                    || parsed.data.epoch !== anchorResult.anchor.epoch
                ) {
                    this.markSessionReplayProtectionDegraded();
                    return;
                }

                this.installSessionReplayFencePayload(parsed.data);
                this.sessionReplayFenceEpoch = parsed.data.epoch;
                this.sessionReplayProtectionState = anchorResult.protection === 'device-secure'
                    ? 'ready'
                    : 'ready-browser-consistency-only';
                return;
            }

            if (anchorResult.status !== 'missing') {
                this.markSessionReplayProtectionDegraded();
                return;
            }

            if (ciphertext === null) {
                // Genuine first use is the only state where both halves may be
                // absent. Establish an empty epoch before accepting a snapshot.
                await this.persistSessionReplayFences();
                this.sessionReplayProtectionState = anchorResult.protection === 'device-secure'
                    ? 'ready'
                    : 'ready-browser-consistency-only';
                return;
            }

            // A ciphertext without its independent anchor may be a restored
            // legacy floor or a partially rolled-back v2 state. No local data
            // can establish freshness, so migration must require recovery.
            this.markSessionReplayProtectionDegraded();
        } catch {
            this.markSessionReplayProtectionDegraded();
        }
    }

    private async persistSessionReplayFences(): Promise<void> {
        if (
            this.sessionReplayProtectionState === 'degraded'
            || typeof this.encryption?.encryptRaw !== 'function'
        ) {
            throw new Error('Session replay protection unavailable');
        }

        try {
            await this.replayFencePersistenceLock.inLock(async () => {
                const accountCommitment = this.sessionReplayFenceAccountCommitment
                    ?? await this.replayFenceAccountCommitment();
                if (this.sessionReplayFenceEpoch >= Number.MAX_SAFE_INTEGER) {
                    throw new Error('Session replay-fence epoch exhausted');
                }
                const nextEpoch = this.sessionReplayFenceEpoch + 1;
                const payload = SessionReplayFencePayloadSchema.parse({
                    version: 2,
                    accountCommitment,
                    epoch: nextEpoch,
                    sessions: [...this.sessionReplayFences.values()]
                        .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
                    tombstones: [...this.sessionDeletionTombstones.entries()]
                        .sort(([left], [right]) => left.localeCompare(right))
                        .map(([sessionId, recordCreatedAt]) => ({
                            sessionId,
                            recordCreatedAt,
                        })),
                    tombstonesSaturated: this.sessionDeletionTombstonesSaturated,
                });
                const ciphertext = await this.encryption.encryptRaw(payload);
                if (
                    typeof ciphertext !== 'string'
                    || ciphertext.length === 0
                    || ciphertext.length > Sync.MAX_SESSION_REPLAY_FENCE_CIPHERTEXT_BYTES
                ) {
                    throw new Error('Invalid encrypted session replay-fence payload');
                }
                const ciphertextCommitment = await this.replayFenceCommitment(ciphertext);

                // Advance the non-rollbackable half first. A crash or write
                // failure between these writes yields a mismatch and explicit
                // recovery mode, never acceptance of the older blob.
                await saveSessionReplayAnchor({
                    version: 1,
                    accountCommitment,
                    epoch: nextEpoch,
                    ciphertextCommitment,
                });
                saveSessionReplayFenceCiphertext(ciphertext);
                this.sessionReplayFenceAccountCommitment = accountCommitment;
                this.sessionReplayFenceEpoch = nextEpoch;
            });
        } catch (error) {
            this.markSessionReplayProtectionDegraded();
            throw error;
        }
    }

    private async sessionDataKeyFingerprint(
        dataKey: Uint8Array | null,
    ): Promise<string> {
        if (dataKey === null) return 'legacy-master-key';
        return digestStringAsync(
            CryptoDigestAlgorithm.SHA256,
            encodeBase64(dataKey, 'base64'),
        );
    }

    private rememberSessionDeletionTombstone(sessionId: string, recordCreatedAt: number): void {
        this.sessionReplayFences.delete(sessionId);
        if (this.sessionDeletionTombstones.has(sessionId)) {
            this.sessionDeletionTombstones.set(sessionId, recordCreatedAt);
            return;
        }
        if (
            this.sessionDeletionTombstones.size
            >= Sync.MAX_SESSION_DELETION_TOMBSTONES
        ) {
            // Never evict an integrity fence to make room for relay-selected
            // IDs. Once saturated, hydration fails closed for unknown session
            // IDs until process restart while existing sessions keep working.
            this.sessionDeletionTombstonesSaturated = true;
            return;
        }
        this.sessionDeletionTombstones.set(sessionId, recordCreatedAt);
    }

    private removeLocalSession(sessionId: string): void {
        if (storage.getState().sessions[sessionId]) {
            storage.getState().deleteSession(sessionId);
        }
        this.encryption.removeSessionEncryption(sessionId);
        this.sessionDataKeys.delete(sessionId);
        gitStatusSync.clearForSession(sessionId);
        this.messagesSync.delete(sessionId);
        this.sendSync.delete(sessionId);
        this.pendingOutbox.delete(sessionId);
        this.sessionLastSeq.delete(sessionId);
        this.sessionOldestSeq.delete(sessionId);
        this.sessionMessageLocks.delete(sessionId);
        this.sessionMessageQueue.delete(sessionId);
        this.sessionQueueProcessing.delete(sessionId);
    }

    private fetchSessions = async () => {
        if (!this.credentials) return;
        if (!this.isSessionReplayProtectionOperational()) {
            throw new Error('Session replay protection unavailable');
        }

        const requestSnapshotEpoch = this.sessionSnapshotEpoch;
        const API_ENDPOINT = getServerUrl();
        const response = await streamingFetch(`${API_ENDPOINT}/v1/sessions`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch sessions: ${response.status}`);
        }

        const { sessions } = ApiSessionsResponseSchema.parse(
            await readBoundedJsonResponse(response, MAX_SESSIONS_RESPONSE_BODY_BYTES),
        );
        let processedCount = 0;
        let retryAfterConcurrentChange = false;

        // Decryption and commit use the state-commit lock shared by persistent
        // updates. This keeps a slow snapshot from reading one live version
        // and overwriting another after an update or bound delete commits.
        await this.persistentStateCommitLock.inLock(async () => {
            if (requestSnapshotEpoch !== this.sessionSnapshotEpoch) {
                retryAfterConcurrentChange = true;
                return;
            }

            const decryptedCandidates: Array<{
                incoming: ApiSessionSnapshot;
                metadataResult: MetadataDecryptionResult;
                agentStateResult: AgentStateDecryptionResult;
                dataKeyFingerprint: string;
                metadataCiphertextCommitment: string;
                agentStateCiphertextCommitment: string | null;
                candidateDataKey?: Uint8Array | null;
            }> = [];

            for (const incoming of sessions) {
                const current = storage.getState().sessions[incoming.id];
                const replayFence = this.sessionReplayFences.get(incoming.id);
                const hasKnownKey = this.sessionDataKeys.has(incoming.id);
                const knownKey = this.sessionDataKeys.get(incoming.id);
                const currentIsReplaceableLegacyDisplay = Boolean(
                    current
                    && !hasKnownKey
                    && !isMetadataAuthenticatedForEffects(current.metadata)
                    && !isAgentStateAuthenticatedForEffects(current.agentState),
                );
                if (
                    this.sessionDeletionTombstones.has(incoming.id)
                    || (this.sessionDeletionTombstonesSaturated && !current)
                ) {
                    // Session IDs are UUID generation identities and are not
                    // reusable. Do not let a relay relabel createdAt on a
                    // captured deleted record to step around a tombstone. A
                    // saturated fence fails closed for unknown IDs.
                    continue;
                }

                if (
                    current
                    && !currentIsReplaceableLegacyDisplay
                    && incoming.createdAt !== current.createdAt
                ) {
                    // The authenticated envelope binds the session UUID, so a
                    // relay cannot claim a second createdAt generation for the
                    // same ID. Legitimate sessions use a fresh UUID.
                    continue;
                }
                if (replayFence && incoming.createdAt !== replayFence.createdAt) {
                    continue;
                }
                if (replayFence && incoming.seq < (replayFence.messageSeq ?? 0)) {
                    // Session.seq is the server's durable message cursor. A
                    // restart snapshot below the independently anchored tip is
                    // a rollback/truncation attempt, not an older display row.
                    continue;
                }

                let dataKey: Uint8Array | null = null;
                if (incoming.dataEncryptionKey) {
                    const decryptedKey = await this.encryption.decryptEncryptionKey(
                        incoming.dataEncryptionKey,
                    );
                    if (!decryptedKey) {
                        console.error('Failed to authenticate a session data encryption key');
                        continue;
                    }
                    dataKey = decryptedKey;
                }
                const dataKeyFingerprint = await this.sessionDataKeyFingerprint(dataKey);
                if (
                    replayFence
                    && replayFence.dataKeyFingerprint !== dataKeyFingerprint
                ) {
                    continue;
                }

                if (hasKnownKey && !sameSessionDataKey(knownKey, dataKey)) {
                    // Per-session data keys are immutable for the UUID
                    // generation. Relay-selected stripping or replacement is
                    // rejected before it can replace the live encryptor/blob key.
                    continue;
                }

                let sessionEncryption = this.encryption.getSessionEncryption(incoming.id);
                let candidateDataKey: Uint8Array | null | undefined;
                if (!sessionEncryption && hasKnownKey) {
                    await this.encryption.initializeSessions(new Map([[
                        incoming.id,
                        knownKey ?? null,
                    ]]));
                    sessionEncryption = this.encryption.getSessionEncryption(incoming.id);
                } else if (!sessionEncryption) {
                    // Authenticate with an uncommitted encryptor. A relay key
                    // cannot become the outbound/session blob key until an
                    // exact bound field advances, or a truly new legacy row is
                    // accepted for display compatibility.
                    sessionEncryption = new SessionEncryption(
                        incoming.id,
                        await this.encryption.openEncryption(dataKey),
                        new EncryptionCache(),
                    );
                    candidateDataKey = dataKey;
                }

                if (!sessionEncryption) {
                    console.error('Session encryption unavailable');
                    continue;
                }

                const [rawMetadataResult, rawAgentStateResult] = await Promise.all([
                    sessionEncryption.decryptMetadataResult(
                        incoming.metadataVersion,
                        incoming.metadata,
                        { allowLegacy: true },
                    ),
                    sessionEncryption.decryptAgentStateResult(
                        incoming.agentStateVersion,
                        incoming.agentState,
                        { allowLegacy: true },
                    ),
                ]);
                const [
                    metadataCiphertextCommitment,
                    agentStateCiphertextCommitment,
                ] = await Promise.all([
                    this.replayFenceCommitment(incoming.metadata),
                    incoming.agentState === null
                        ? Promise.resolve(null)
                        : this.replayFenceCommitment(incoming.agentState),
                ]);
                const metadataResult = enforceBoundSnapshotVersionFloor(
                    rawMetadataResult,
                    incoming.metadataVersion,
                    replayFence?.metadataVersion ?? 0,
                    metadataCiphertextCommitment,
                    replayFence?.metadataCiphertextCommitment ?? null,
                );
                const agentStateResult = enforceBoundSnapshotVersionFloor(
                    rawAgentStateResult,
                    incoming.agentStateVersion,
                    replayFence?.agentStateVersion ?? 0,
                    agentStateCiphertextCommitment,
                    replayFence?.agentStateCiphertextCommitment ?? null,
                );

                const hasBoundCandidateField = (
                    metadataResult.success && metadataResult.binding === 'bound'
                ) || (
                    agentStateResult.success && agentStateResult.binding === 'bound'
                );
                const currentForMerge = currentIsReplaceableLegacyDisplay
                    && hasBoundCandidateField
                    ? undefined
                    : current;

                const metadataWillApply = boundSnapshotFieldWillApply(
                    currentForMerge?.metadata ?? null,
                    currentForMerge?.metadataVersion ?? 0,
                    incoming.metadataVersion,
                    metadataResult,
                    !currentForMerge,
                );
                const agentStateWillApply = boundSnapshotFieldWillApply(
                    currentForMerge?.agentState ?? null,
                    currentForMerge?.agentStateVersion ?? 0,
                    incoming.agentStateVersion,
                    agentStateResult,
                    !currentForMerge,
                );
                const acceptsNewLegacyDisplay = !currentForMerge && (
                    (metadataResult.success && metadataResult.binding === 'legacy')
                    || (
                        incoming.agentState !== null
                        && agentStateResult.success
                        && agentStateResult.binding === 'legacy'
                    )
                );
                const hasReadableField = metadataResult.success || (
                    incoming.agentState !== null && agentStateResult.success
                );
                if (!current && !hasReadableField) {
                    continue;
                }
                if (
                    replayFence
                    && !current
                    && !metadataWillApply
                    && !agentStateWillApply
                ) {
                    // A persisted authenticated generation may only be
                    // rehydrated by a bound field at or above its version floor.
                    continue;
                }
                if (
                    candidateDataKey !== undefined
                    && !metadataWillApply
                    && !agentStateWillApply
                    && !acceptsNewLegacyDisplay
                ) {
                    continue;
                }

                decryptedCandidates.push({
                    incoming,
                    metadataResult,
                    agentStateResult,
                    dataKeyFingerprint,
                    metadataCiphertextCommitment,
                    agentStateCiphertextCommitment,
                    ...(
                        candidateDataKey !== undefined
                        && (metadataWillApply || agentStateWillApply)
                            ? { candidateDataKey }
                            : {}
                    ),
                });
            }

            // Persistent session changes advance the structural epoch while
            // decryptions await. Ephemeral activity is merged again from the
            // latest store below so busy sessions do not starve hydration.
            if (requestSnapshotEpoch !== this.sessionSnapshotEpoch) {
                retryAfterConcurrentChange = true;
                return;
            }

            const decryptedSessions: SessionWithoutPresence[] = [];
            const effectfulAgentStateSessionIds = new Set<string>();
            const effectfulMetadataSessionIds = new Set<string>();
            const candidateDataKeys = new Map<string, Uint8Array | null>();
            const replayFenceUpdates = new Map<string, SessionReplayFence>();

            for (const candidate of decryptedCandidates) {
                const { incoming, metadataResult, agentStateResult } = candidate;
                const current = storage.getState().sessions[incoming.id];
                const currentIsReplaceableLegacyDisplay = Boolean(
                    current
                    && !this.sessionDataKeys.has(incoming.id)
                    && !isMetadataAuthenticatedForEffects(current.metadata)
                    && !isAgentStateAuthenticatedForEffects(current.agentState),
                );
                const hasBoundCandidateField = (
                    metadataResult.success && metadataResult.binding === 'bound'
                ) || (
                    agentStateResult.success && agentStateResult.binding === 'bound'
                );
                const currentForMerge = currentIsReplaceableLegacyDisplay
                    && hasBoundCandidateField
                    ? undefined
                    : current;
                if (
                    this.sessionDeletionTombstones.has(incoming.id)
                    || (this.sessionDeletionTombstonesSaturated && !current)
                    || (
                        current
                        && !currentIsReplaceableLegacyDisplay
                        && current.createdAt !== incoming.createdAt
                    )
                ) {
                    continue;
                }

                const metadataWillApply = boundSnapshotFieldWillApply(
                    currentForMerge?.metadata ?? null,
                    currentForMerge?.metadataVersion ?? 0,
                    incoming.metadataVersion,
                    metadataResult,
                    !currentForMerge,
                );
                const agentStateWillApply = boundSnapshotFieldWillApply(
                    currentForMerge?.agentState ?? null,
                    currentForMerge?.agentStateVersion ?? 0,
                    incoming.agentStateVersion,
                    agentStateResult,
                    !currentForMerge,
                );
                const acceptsNewLegacyDisplay = !currentForMerge && (
                    (metadataResult.success && metadataResult.binding === 'legacy')
                    || (
                        incoming.agentState !== null
                        && agentStateResult.success
                        && agentStateResult.binding === 'legacy'
                    )
                );
                if (
                    candidate.candidateDataKey !== undefined
                    && !metadataWillApply
                    && !agentStateWillApply
                    && !acceptsNewLegacyDisplay
                ) {
                    continue;
                }

                decryptedSessions.push(mergeSessionSnapshot(
                    incoming,
                    currentForMerge,
                    metadataResult,
                    agentStateResult,
                ));
                if (agentStateWillApply) {
                    effectfulAgentStateSessionIds.add(incoming.id);
                }
                if (metadataWillApply) {
                    effectfulMetadataSessionIds.add(incoming.id);
                }
                if (candidate.candidateDataKey !== undefined) {
                    candidateDataKeys.set(incoming.id, candidate.candidateDataKey);
                }
                if (metadataWillApply || agentStateWillApply) {
                    const existingFence = this.sessionReplayFences.get(incoming.id);
                    replayFenceUpdates.set(incoming.id, {
                        sessionId: incoming.id,
                        createdAt: incoming.createdAt,
                        metadataVersion: metadataWillApply
                            ? incoming.metadataVersion
                            : existingFence?.metadataVersion ?? 0,
                        metadataCiphertextCommitment: metadataWillApply
                            ? candidate.metadataCiphertextCommitment
                            : existingFence?.metadataCiphertextCommitment ?? null,
                        agentStateVersion: agentStateWillApply
                            ? incoming.agentStateVersion
                            : existingFence?.agentStateVersion ?? 0,
                        agentStateCiphertextCommitment: agentStateWillApply
                            ? candidate.agentStateCiphertextCommitment
                            : existingFence?.agentStateCiphertextCommitment ?? null,
                        messageSeq: existingFence?.messageSeq ?? 0,
                        messageCiphertextCommitment:
                            existingFence?.messageCiphertextCommitment ?? null,
                        dataKeyFingerprint: candidate.dataKeyFingerprint,
                    });
                }
            }

            const replayFenceStateChanged = replayFenceUpdates.size > 0;
            for (const [sessionId, fence] of replayFenceUpdates) {
                this.sessionReplayFences.set(sessionId, fence);
            }
            if (replayFenceStateChanged) {
                await this.persistSessionReplayFences();
            }

            if (candidateDataKeys.size > 0) {
                await this.encryption.initializeSessions(candidateDataKeys);
                if (requestSnapshotEpoch !== this.sessionSnapshotEpoch) {
                    for (const sessionId of candidateDataKeys.keys()) {
                        this.encryption.removeSessionEncryption(sessionId);
                    }
                    retryAfterConcurrentChange = true;
                    return;
                }
                for (const [sessionId, dataKey] of candidateDataKeys) {
                    this.sessionDataKeys.set(sessionId, dataKey);
                }
            }

            // `/v1/sessions` is a capped recent-session page, not a complete
            // account inventory. Omission therefore cannot prove deletion.
            // Only an explicitly generation-bound delete event may retire a
            // local session and install its durable tombstone.
            this.applySessions(decryptedSessions, {
                source: 'hydration',
                effectfulAgentStateSessionIds,
                effectfulMetadataSessionIds,
            });
            processedCount = decryptedSessions.length;
        });

        if (retryAfterConcurrentChange) {
            // Coalesce a clean post-change snapshot through the owning sync.
            this.sessionsSync.invalidate();
            return;
        }
        log.log(`📥 fetchSessions completed - processed ${processedCount} sessions`);

    }

    public refreshMachines = async () => {
        return this.fetchMachines();
    }

    public refreshSessions = async () => {
        return this.sessionsSync.invalidateAndAwait();
    }

    public getCredentials() {
        return this.credentials;
    }

    // Artifact methods
    public fetchArtifactsList = async (): Promise<void> => {
        log.log('📦 fetchArtifactsList: Starting artifact sync');
        if (!this.credentials) {
            log.log('📦 fetchArtifactsList: No credentials, skipping');
            return;
        }

        try {
            log.log('📦 fetchArtifactsList: Fetching artifacts from server');
            const artifacts = await fetchArtifacts(this.credentials);
            log.log(`📦 fetchArtifactsList: Received ${artifacts.length} artifacts from server`);
            const decryptedArtifacts: DecryptedArtifact[] = [];

            for (const artifact of artifacts) {
                try {
                    // Decrypt the data encryption key
                    const decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
                    if (!decryptedKey) {
                        console.error('Failed to decrypt an artifact key');
                        continue;
                    }

                    // Store the decrypted key in memory
                    this.artifactDataKeys.set(artifact.id, decryptedKey);

                    // Create artifact encryption instance
                    const artifactEncryption = new ArtifactEncryption(decryptedKey);

                    // Decrypt header
                    const header = await artifactEncryption.decryptHeader(artifact.header);

                    decryptedArtifacts.push({
                        id: artifact.id,
                        title: header?.title || null,
                        sessions: header?.sessions,  // Include sessions from header
                        draft: header?.draft,        // Include draft flag from header
                        body: undefined, // Body not loaded in list
                        headerVersion: artifact.headerVersion,
                        bodyVersion: artifact.bodyVersion,
                        seq: artifact.seq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: !!header,
                    });
                } catch {
                    console.error('Failed to decrypt an artifact');
                    // Add with decryption failed flag
                    decryptedArtifacts.push({
                        id: artifact.id,
                        title: null,
                        body: undefined,
                        headerVersion: artifact.headerVersion,
                        seq: artifact.seq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: false,
                    });
                }
            }

            log.log(`📦 fetchArtifactsList: Successfully decrypted ${decryptedArtifacts.length} artifacts`);
            storage.getState().applyArtifacts(decryptedArtifacts);
            log.log('📦 fetchArtifactsList: Artifacts applied to storage');
        } catch (error) {
            log.log('📦 fetchArtifactsList: Failed to fetch artifacts');
            console.error('Failed to fetch artifacts');
            throw error;
        }
    }

    public async fetchArtifactWithBody(artifactId: string): Promise<DecryptedArtifact | null> {
        if (!this.credentials) return null;

        try {
            const artifact = await fetchArtifact(this.credentials, artifactId);

            // Decrypt the data encryption key
            const decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
            if (!decryptedKey) {
                console.error('Failed to decrypt an artifact key');
                return null;
            }

            // Store the decrypted key in memory
            this.artifactDataKeys.set(artifact.id, decryptedKey);

            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(decryptedKey);

            // Decrypt header and body
            const header = await artifactEncryption.decryptHeader(artifact.header);
            const body = artifact.body ? await artifactEncryption.decryptBody(artifact.body) : null;

            return {
                id: artifact.id,
                title: header?.title || null,
                sessions: header?.sessions,  // Include sessions from header
                draft: header?.draft,        // Include draft flag from header
                body: body?.body || null,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: !!header,
            };
        } catch {
            console.error('Failed to fetch artifact');
            return null;
        }
    }

    public async createArtifact(
        title: string | null,
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<string> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        try {
            // Generate unique artifact ID
            const artifactId = this.encryption.generateId();

            // Generate data encryption key
            const dataEncryptionKey = ArtifactEncryption.generateDataEncryptionKey();

            // Store the decrypted key in memory
            this.artifactDataKeys.set(artifactId, dataEncryptionKey);

            // Encrypt the data encryption key with user's key
            const encryptedKey = await this.encryption.encryptEncryptionKey(dataEncryptionKey);

            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

            // Encrypt header and body
            const encryptedHeader = await artifactEncryption.encryptHeader({ title, sessions, draft });
            const encryptedBody = await artifactEncryption.encryptBody({ body });

            // Create the request
            const request: ArtifactCreateRequest = {
                id: artifactId,
                header: encryptedHeader,
                body: encryptedBody,
                dataEncryptionKey: encodeBase64(encryptedKey, 'base64'),
            };

            // Send to server
            const artifact = await createArtifact(this.credentials, request);

            // Add to local storage
            const decryptedArtifact: DecryptedArtifact = {
                id: artifact.id,
                title,
                sessions,
                draft,
                body,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: true,
            };

            storage.getState().addArtifact(decryptedArtifact);

            return artifactId;
        } catch (error) {
            console.error('Failed to create artifact');
            throw error;
        }
    }

    public async updateArtifact(
        artifactId: string,
        title: string | null,
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<void> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        try {
            // Get current artifact to get versions and encryption key
            const currentArtifact = storage.getState().artifacts[artifactId];
            if (!currentArtifact) {
                throw new Error('Artifact not found');
            }

            // Get the data encryption key from memory or fetch it
            let dataEncryptionKey = this.artifactDataKeys.get(artifactId);

            // Fetch full artifact if we don't have version info or encryption key
            let headerVersion = currentArtifact.headerVersion;
            let bodyVersion = currentArtifact.bodyVersion;

            if (headerVersion === undefined || bodyVersion === undefined || !dataEncryptionKey) {
                const fullArtifact = await fetchArtifact(this.credentials, artifactId);
                headerVersion = fullArtifact.headerVersion;
                bodyVersion = fullArtifact.bodyVersion;

                // Decrypt and store the data encryption key if we don't have it
                if (!dataEncryptionKey) {
                    const decryptedKey = await this.encryption.decryptEncryptionKey(fullArtifact.dataEncryptionKey);
                    if (!decryptedKey) {
                        throw new Error('Failed to decrypt encryption key');
                    }
                    this.artifactDataKeys.set(artifactId, decryptedKey);
                    dataEncryptionKey = decryptedKey;
                }
            }

            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

            // Prepare update request
            const updateRequest: ArtifactUpdateRequest = {};

            // Check if header needs updating (title, sessions, or draft changed)
            if (title !== currentArtifact.title ||
                JSON.stringify(sessions) !== JSON.stringify(currentArtifact.sessions) ||
                draft !== currentArtifact.draft) {
                const encryptedHeader = await artifactEncryption.encryptHeader({
                    title,
                    sessions,
                    draft
                });
                updateRequest.header = encryptedHeader;
                updateRequest.expectedHeaderVersion = headerVersion;
            }

            // Only update body if it changed
            if (body !== currentArtifact.body) {
                const encryptedBody = await artifactEncryption.encryptBody({ body });
                updateRequest.body = encryptedBody;
                updateRequest.expectedBodyVersion = bodyVersion;
            }

            // Skip if no changes
            if (Object.keys(updateRequest).length === 0) {
                return;
            }

            // Send update to server
            const response = await updateArtifact(this.credentials, artifactId, updateRequest);

            if (!response.success) {
                // Handle version mismatch
                if (response.error === 'version-mismatch') {
                    throw new Error('Artifact was modified by another client. Please refresh and try again.');
                }
                throw new Error('Failed to update artifact');
            }

            // Update local storage
            const updatedArtifact: DecryptedArtifact = {
                ...currentArtifact,
                title,
                sessions,
                draft,
                body,
                headerVersion: response.headerVersion !== undefined ? response.headerVersion : headerVersion,
                bodyVersion: response.bodyVersion !== undefined ? response.bodyVersion : bodyVersion,
                updatedAt: Date.now(),
            };

            storage.getState().updateArtifact(updatedArtifact);
        } catch (error) {
            console.error('Failed to update artifact');
            throw error;
        }
    }

    private fetchMachines = async () => {
        if (!this.credentials) return;

        console.log('📊 Sync: Fetching machines...');
        const API_ENDPOINT = getServerUrl();
        const response = await streamingFetch(`${API_ENDPOINT}/v1/machines`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            }
        });

        if (!response.ok) {
            console.error('Failed to fetch machines');
            return;
        }

        const machines = ApiMachinesResponseSchema.parse(
            await readBoundedJsonResponse(
                response,
                MAX_MACHINES_RESPONSE_BODY_BYTES,
            ),
        );
        console.log('Machine snapshot received');

        // First, collect and decrypt encryption keys for all machines.
        //
        // A missing key denotes an actual legacy machine. A present key that
        // fails authentication is different: fail that machine closed rather
        // than silently assigning the account-wide legacy encryptor. The
        // machine remains visible with opaque metadata, and one bad record
        // still cannot abort the rest of the sync.
        const machineKeysMap = new Map<string, Uint8Array | null>();
        for (const machine of machines) {
            const keyResolution = await resolveMachineDataKey(
                machine.dataEncryptionKey,
                (encryptedKey) => this.encryption.decryptEncryptionKey(encryptedKey),
            );
            if (keyResolution.kind === 'current') {
                machineKeysMap.set(machine.id, keyResolution.key);
                this.machineDataKeys.set(machine.id, keyResolution.key);
            } else if (keyResolution.kind === 'legacy') {
                machineKeysMap.set(machine.id, null);
            } else {
                console.error('Failed to authenticate a machine data encryption key');
                this.encryption.removeMachineEncryption(machine.id);
                this.machineDataKeys.delete(machine.id);
            }
        }

        // Initialize machine encryptions. Guard so an init failure cannot
        // reject the whole sync and wipe the machine list.
        try {
            await this.encryption.initializeMachines(machineKeysMap);
        } catch {
            console.error('Failed to initialize machine encryptions');
        }

        // Process all machines first, then update state once. Every machine is
        // pushed exactly once — decryption failures degrade to null metadata
        // instead of dropping the machine, so a machine never disappears from
        // the picker just because its metadata could not be read.
        const decryptedMachines: Machine[] = [];

        for (const machine of machines) {
            try {
                const machineEncryption = this.encryption.getMachineEncryption(machine.id);

                // Use machine-specific encryption (which handles fallback internally)
                const metadata = machineEncryption && machine.metadata
                    ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata)
                    : null;

                const daemonState = machineEncryption && machine.daemonState
                    ? await machineEncryption.decryptDaemonState(machine.daemonStateVersion, machine.daemonState)
                    : null;

                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState,
                    daemonStateVersion: machine.daemonStateVersion
                });
            } catch {
                console.error('Failed to decrypt machine state');
                // Still add the machine with null metadata so it stays visible.
                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata: null,
                    metadataVersion: machine.metadataVersion,
                    daemonState: null,
                    daemonStateVersion: 0
                });
            }
        }

        // Replace entire machine state with fetched machines — but never wipe
        // a populated store with an empty result. An empty list here almost
        // always means a transient fetch/decrypt problem, not "user has no
        // machines"; destroying good state would blank /new until restart.
        const existingMachineCount = Object.keys(storage.getState().machines).length;
        if (decryptedMachines.length === 0 && existingMachineCount > 0) {
            log.log(`🖥️ fetchMachines: empty result, keeping ${existingMachineCount} existing machine(s)`);
            return;
        }
        storage.getState().applyMachines(decryptedMachines, true);
        log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
    }

    private syncSettings = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        const maxRetries = 3;
        let retryCount = 0;

        // Apply pending settings
        if (Object.keys(this.pendingSettings).length > 0) {

            while (retryCount < maxRetries) {
                // Snapshot what we're about to send so we can detect concurrent changes
                const sentPending = { ...this.pendingSettings };
                let version = storage.getState().settingsVersion;
                let settings = applySettings(storage.getState().settings, this.pendingSettings);
                const response = await streamingFetch(`${API_ENDPOINT}/v1/account/settings`, {
                    method: 'POST',
                    body: JSON.stringify({
                        settings: await this.encryption.encryptRaw(settingsToSyncPayload(settings)),
                        expectedVersion: version ?? 0
                    }),
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`,
                        'Content-Type': 'application/json',
                        'X-Happy-Client': getIdleClientId(),
                    }
                });
                if (!response.ok) {
                    throw new Error(`Failed to update settings: ${response.status}`);
                }
                const data = ApiSettingsUpdateResponseSchema.parse(
                    await readBoundedJsonResponse(
                        response,
                        MAX_SETTINGS_RESPONSE_BODY_BYTES,
                    ),
                );
                if (data.success) {
                    // Only clear keys we actually sent — preserve any settings
                    // added by applySettings() calls during the POST roundtrip
                    const newPending: Partial<Settings> = {};
                    for (const key of Object.keys(this.pendingSettings) as (keyof Settings)[]) {
                        if (!(key in sentPending) || this.pendingSettings[key] !== sentPending[key]) {
                            (newPending as any)[key] = this.pendingSettings[key];
                        }
                    }
                    this.pendingSettings = newPending;
                    savePendingSettings(this.pendingSettings);
                    break;
                }
                if (data.error === 'version-mismatch') {
                    // Parse server settings
                    const serverSettings = data.currentSettings
                        ? settingsParse(await this.encryption.decryptRaw(data.currentSettings))
                        : { ...settingsDefaults };

                    // Merge: server base + our pending changes (our changes win)
                    const mergedSettings = applySettings(serverSettings, this.pendingSettings);

                    // Update local storage with merged result at server's version
                    const finalSettings = this.applyServerSettings(mergedSettings, data.currentVersion);

                    setTrackingConsent(isAnalyticsConsentGranted(finalSettings));

                    retryCount++;
                    continue;
                } else {
                    throw new Error(`Failed to sync settings: ${data.error}`);
                }
            }
        }

        // If exhausted retries, throw to trigger outer backoff delay
        if (retryCount >= maxRetries) {
            throw new Error(`Settings sync failed after ${maxRetries} retries due to version conflicts`);
        }

        // Run request
        const response = await streamingFetch(`${API_ENDPOINT}/v1/account/settings`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch settings: ${response.status}`);
        }
        const data = ApiSettingsResponseSchema.parse(
            await readBoundedJsonResponse(
                response,
                MAX_SETTINGS_RESPONSE_BODY_BYTES,
            ),
        );

        // Parse response
        let parsedSettings: Settings;
        if (data.settings) {
            parsedSettings = settingsParse(await this.encryption.decryptRaw(data.settings));
        } else {
            parsedSettings = { ...settingsDefaults };
        }

        // Apply settings to storage, re-layering any pending local changes on top
        const finalSettings = this.applyServerSettings(parsedSettings, data.settingsVersion);

        setTrackingConsent(isAnalyticsConsentGranted(finalSettings));
    }

    private fetchProfile = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        const response = await streamingFetch(`${API_ENDPOINT}/v1/account/profile`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch profile: ${response.status}`);
        }

        const parsedProfile = ProfileSchema.parse(
            await readBoundedJsonResponse(
                response,
                MAX_PROFILE_RESPONSE_BODY_BYTES,
            ),
        );

        // Apply profile to storage
        storage.getState().applyProfile(parsedProfile);
    }

    private fetchNativeUpdate = async () => {
        try {
            // Skip in development
            if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !Constants.expoConfig?.version) {
                return;
            }
            if (Platform.OS === 'ios' && !Constants.expoConfig?.ios?.bundleIdentifier) {
                return;
            }
            if (Platform.OS === 'android' && !Constants.expoConfig?.android?.package) {
                return;
            }

            const serverUrl = getServerUrl();

            // Get platform and app identifiers
            const platform = Platform.OS;
            const version = Constants.expoConfig?.version!;
            const appId = (Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier! : Constants.expoConfig?.android?.package!);

            const response = await streamingFetch(`${serverUrl}/v1/version`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Happy-Client': getIdleClientId(),
                },
                body: JSON.stringify({
                    platform,
                    version,
                    app_id: appId,
                }),
            });

            if (!response.ok) {
                console.log('Native update request failed');
                return;
            }

            ApiNativeVersionResponseSchema.parse(
                await readBoundedJsonResponse(
                    response,
                    MAX_VERSION_RESPONSE_BODY_BYTES,
                ),
            );

            // The current native release channel does not advertise an in-app
            // store redirect. Parsing the null-only contract above rejects any
            // unexpected URL before it can become a user-visible update action.
            storage.getState().applyNativeUpdateStatus({
                available: false
            });
        } catch {
            console.log('[fetchNativeUpdate] Request failed');
            storage.getState().applyNativeUpdateStatus(null);
        }
    }

    private syncPurchases = async () => {
        try {
            // Initialize RevenueCat if not already done
            if (!this.revenueCatInitialized) {
                // Get the appropriate API key based on platform
                let apiKey: string | undefined;

                if (Platform.OS === 'ios') {
                    apiKey = config.revenueCatAppleKey;
                } else if (Platform.OS === 'android') {
                    apiKey = config.revenueCatGoogleKey;
                } else if (Platform.OS === 'web') {
                    apiKey = config.revenueCatStripeKey;
                }

                if (!apiKey) {
                    console.log('RevenueCat API key unavailable for this platform');
                    return;
                }

                // Configure RevenueCat
                if (__DEV__) {
                    RevenueCat.setLogLevel(LogLevel.DEBUG);
                }

                // Initialize with the public ID as user ID
                RevenueCat.configure({
                    apiKey,
                    appUserID: this.serverID, // In server this is a CUID, which we can assume is globaly unique even between servers
                    useAmazon: false,
                });

                this.revenueCatInitialized = true;
                console.log('RevenueCat initialized successfully');
            }

            // Sync purchases
            await RevenueCat.syncPurchases();

            // Fetch customer info
            const customerInfo = await RevenueCat.getCustomerInfo();

            // Apply to storage (storage handles the transformation)
            storage.getState().applyPurchases(customerInfo);

        } catch {
            console.error('Failed to sync purchases');
            // Don't throw - purchases are optional
        }
    }

    private flushOutbox = async (sessionId: string) => {
        const pending = this.pendingOutbox.get(sessionId);
        if (!pending || pending.length === 0) {
            if (!this.hasPendingOutboxMessages()) {
                this.clearBackgroundSendWatchdog();
                await this.cancelBackgroundSendTimeoutNotification();
                this.backgroundSendStartedAt = null;
            }
            return;
        }

        const batch = selectNextMessageIngressBatch(pending);
        const encodedSessionId = encodeURIComponent(sessionId);
        const controller = new AbortController();
        this.sendAbortControllers.set(sessionId, controller);
        try {
            const response = await apiSocket.request(`/v3/sessions/${encodedSessionId}/messages`, {
                method: 'POST',
                body: JSON.stringify({
                    messages: batch,
                }),
                headers: {
                    'Content-Type': 'application/json'
                },
                signal: controller.signal
            });
            if (!response.ok) {
                throw new Error(`Failed to send messages: ${response.status}`);
            }

            const data = ApiPostSessionMessagesResponseSchema.parse(
                await readBoundedJsonResponse(
                    response,
                    MAX_MESSAGE_RESPONSE_BODY_BYTES,
                ),
            );
            pending.splice(0, batch.length);
            if (Array.isArray(data.messages) && data.messages.length > 0) {
                const currentLastSeq = this.sessionLastSeq.get(sessionId) ?? 0;
                let maxSeq = currentLastSeq;
                for (const message of data.messages) {
                    if (message.seq > maxSeq) {
                        maxSeq = message.seq;
                    }
                }
                this.sessionLastSeq.set(sessionId, maxSeq);
            }
        } catch (error) {
            this.maybeStartBackgroundSendWatchdog();
            throw error;
        } finally {
            this.sendAbortControllers.delete(sessionId);
        }

        if (pending.length === 0) {
            this.pendingOutbox.delete(sessionId);
        }
        if (!this.hasPendingOutboxMessages()) {
            this.clearBackgroundSendWatchdog();
            await this.cancelBackgroundSendTimeoutNotification();
            this.backgroundSendStartedAt = null;
        } else if (this.appState !== 'active') {
            this.maybeStartBackgroundSendWatchdog();
        }
    }

    private fetchMessages = async (sessionId: string) => {
        log.log('💬 fetchMessages starting');
        const lock = this.getSessionMessageLock(sessionId);
        await lock.inLock(async () => {
            const encryption = this.encryption.getSessionEncryption(sessionId);
            if (!encryption) {
                log.log('💬 fetchMessages: Session encryption not ready; will retry');
                throw new Error('Session encryption is not ready');
            }

            const knownLastSeq = this.sessionLastSeq.get(sessionId);
            const isInitialLoad = knownLastSeq === undefined;
            if (isInitialLoad) {
                // Initial load. Pull only the most recent page so the user can
                // start chatting immediately. Older history is fetched only
                // when the user explicitly scrolls up, within the local cap.
                await this.fetchInitialLatestPage(sessionId, encryption);
            } else {
                // Forward incremental sync. Used after reconnect, invalidate,
                // or any subsequent visit. Only pulls messages newer than what
                // we already have, so it's bounded and fast in normal use.
                await this.fetchForwardSince(sessionId, encryption, knownLastSeq);
            }

            storage.getState().applyMessagesLoaded(sessionId);
            log.log('💬 fetchMessages completed');
        });
    }

    private fetchInitialLatestPage = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {}
    ) => {
        const encodedSessionId = encodeURIComponent(sessionId);
        const response = await apiSocket.request(
            `/v3/sessions/${encodedSessionId}/messages?before_seq=${SEQ_BACKWARD_INITIAL_SENTINEL}&limit=${MESSAGE_HISTORY_PAGE_SIZE}`
        );
        if (!response.ok) {
            throw new Error(`Failed to fetch initial message page: ${response.status}`);
        }
        const data = parseBoundedMessagePage(await readBoundedJsonResponse(
            response,
            MAX_MESSAGE_RESPONSE_BODY_BYTES,
        ));
        if (!data) {
            throw new Error('Invalid initial message page');
        }
        const messages = data.messages;

        await this.applyFetchedMessages(sessionId, encryption, messages);

        // Anchor both ends so future incremental forward sync resumes from
        // maxSeq, and loadOlderMessages can page backward from minSeq.
        let maxSeq = 0;
        let minSeq = Number.POSITIVE_INFINITY;
        for (const message of messages) {
            if (message.seq > maxSeq) maxSeq = message.seq;
            if (message.seq < minSeq) minSeq = message.seq;
        }
        this.sessionLastSeq.set(sessionId, maxSeq);
        if (messages.length > 0) {
            this.sessionOldestSeq.set(sessionId, minSeq);
        }
        storage.getState().applyOlderMessagesPagination(sessionId, {
            hasMore: !!data.hasMore && messages.length > 0
        });
    }

    private fetchForwardSince = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        fromSeq: number
    ) => {
        const encodedSessionId = encodeURIComponent(sessionId);
        let afterSeq = fromSeq;
        for (let page = 0; page < MAX_FORWARD_HISTORY_PAGES; page++) {
            const response = await apiSocket.request(
                `/v3/sessions/${encodedSessionId}/messages?after_seq=${afterSeq}&limit=${MESSAGE_HISTORY_PAGE_SIZE}`
            );
            if (!response.ok) {
                throw new Error(`Failed to forward-sync messages: ${response.status}`);
            }
            const data = parseBoundedMessagePage(await readBoundedJsonResponse(
                response,
                MAX_MESSAGE_RESPONSE_BODY_BYTES,
            ));
            if (!data) {
                throw new Error('Invalid forward message page');
            }
            const messages = data.messages;

            await this.applyFetchedMessages(sessionId, encryption, messages);

            let maxSeq = afterSeq;
            for (const message of messages) {
                if (message.seq > maxSeq) maxSeq = message.seq;
            }
            this.sessionLastSeq.set(sessionId, maxSeq);

            if (!data.hasMore) return;
            if (maxSeq === afterSeq) {
                log.log('💬 fetchForwardSince: pagination stalled; stopping to avoid an infinite loop');
                return;
            }
            afterSeq = maxSeq;
        }

        // A large reconnect gap should not force the client to decrypt an
        // unbounded backlog. Jump to a fresh latest page after the bounded
        // forward window; explicit scrolling can retrieve older history.
        await this.fetchInitialLatestPage(sessionId, encryption);
    }

    private applyFetchedMessages = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        messages: ApiMessage[],
        pageKind: 'tip' | 'history' = 'tip',
    ) => {
        if (messages.length === 0) {
            await this.verifyAndAdvanceFetchedMessageReplayFloor(
                sessionId,
                [],
                pageKind,
            );
            return;
        }
        const decryptedMessages = await encryption.decryptMessages(messages);
        const authenticated: Array<{
            encrypted: ApiMessage;
            decrypted: NonNullable<(typeof decryptedMessages)[number]>;
            replayKey: string;
            rawContent: RawRecord;
        }> = [];
        for (let i = 0; i < decryptedMessages.length; i++) {
            const decrypted = decryptedMessages[i];
            const encrypted = messages[i];
            if (!decrypted || !encrypted) continue;
            const replayKey = await this.getPersistentMessageReplayKey(
                sessionId,
                encrypted,
                decrypted.content,
            );
            const parsedRawContent = RawRecordSchema.safeParse(decrypted.content);
            if (
                !replayKey
                || !parsedRawContent.success
            ) {
                continue;
            }
            authenticated.push({
                encrypted,
                decrypted,
                replayKey,
                rawContent: parsedRawContent.data,
            });
        }
        await this.verifyAndAdvanceFetchedMessageReplayFloor(
            sessionId,
            authenticated.map((candidate) => candidate.encrypted),
            pageKind,
        );

        const normalizedMessages: NormalizedMessage[] = [];
        for (const candidate of authenticated) {
            if (!this.rememberPersistentMessageReplayKey(candidate.replayKey)) {
                continue;
            }
            const normalized = normalizeRawMessage(
                candidate.decrypted.id,
                candidate.decrypted.localId,
                candidate.decrypted.createdAt,
                candidate.rawContent,
            );
            if (normalized) {
                normalizedMessages.push(normalized);
            }
        }
        if (normalizedMessages.length > 0) {
            this.applyMessages(sessionId, normalizedMessages);
        }
    }

    /**
     * Fetch one page of older messages for a session and prepend them to the
     * store. Called from the chat UI when the user scrolls past the top of
     * the currently loaded history. No-op when we have already fetched the
     * earliest message, when no initial fetch has happened yet, or when an
     * older-fetch is already in flight for this session.
     */
    loadOlderMessages = async (sessionId: string) => {
        const oldestSeq = this.sessionOldestSeq.get(sessionId);
        if (oldestSeq === undefined || oldestSeq <= 1) {
            return;
        }
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        if (!sessionMessages || sessionMessages.isLoadingOlder || !sessionMessages.hasMoreOlder) {
            return;
        }
        if (sessionMessages.messages.length >= MAX_STORED_SESSION_MESSAGES) {
            storage.getState().applyOlderMessagesPagination(sessionId, { hasMore: false });
            return;
        }

        storage.getState().applyOlderMessagesLoading(sessionId, true);
        const lock = this.getSessionMessageLock(sessionId);
        try {
            await lock.inLock(async () => {
                const encryption = this.encryption.getSessionEncryption(sessionId);
                if (!encryption) {
                    log.log('💬 loadOlderMessages: encryption not ready');
                    return;
                }
                // Re-read the cursor inside the lock. A concurrent
                // socket-pushed update or reload could have changed it.
                const beforeSeq = this.sessionOldestSeq.get(sessionId);
                if (beforeSeq === undefined || beforeSeq <= 1) {
                    return;
                }
                const currentSessionMessages = storage.getState().sessionMessages[sessionId];
                const remainingCapacity = MAX_STORED_SESSION_MESSAGES
                    - (currentSessionMessages?.messages.length ?? 0);
                if (remainingCapacity <= 0) {
                    storage.getState().applyOlderMessagesPagination(sessionId, { hasMore: false });
                    return;
                }
                const pageSize = Math.min(MESSAGE_HISTORY_PAGE_SIZE, remainingCapacity);
                const encodedSessionId = encodeURIComponent(sessionId);
                const response = await apiSocket.request(
                    `/v3/sessions/${encodedSessionId}/messages?before_seq=${beforeSeq}&limit=${pageSize}`
                );
                if (!response.ok) {
                    throw new Error(`Failed to load older messages: ${response.status}`);
                }
                const data = parseBoundedMessagePage(await readBoundedJsonResponse(
                    response,
                    MAX_MESSAGE_RESPONSE_BODY_BYTES,
                ));
                if (!data || data.messages.length > pageSize) {
                    throw new Error('Invalid older message page');
                }
                const messages = data.messages;

                await this.applyFetchedMessages(
                    sessionId,
                    encryption,
                    messages,
                    'history',
                );

                let minSeq = beforeSeq;
                for (const message of messages) {
                    if (message.seq < minSeq) minSeq = message.seq;
                }
                if (messages.length > 0) {
                    this.sessionOldestSeq.set(sessionId, minSeq);
                }
                const retainedCount = storage.getState().sessionMessages[sessionId]?.messages.length ?? 0;
                storage.getState().applyOlderMessagesPagination(sessionId, {
                    hasMore: data.hasMore
                        && messages.length > 0
                        && retainedCount < MAX_STORED_SESSION_MESSAGES
                });
            });
        } finally {
            storage.getState().applyOlderMessagesLoading(sessionId, false);
        }
    }

    private registerPushToken = async () => {
        log.log('registerPushToken');
        try {
            const result = await syncCurrentPushToken(this.credentials);
            log.log('Push token sync result: ' + JSON.stringify({
                registered: result.registered,
                hasToken: !!result.token,
                permission: result.permission.status,
            }));
            if (!result.permission.granted) {
                console.log('Failed to get push token for push notification!');
            }
        } catch {
            log.log('Failed to register push token');
        }
    }

    private subscribeToUpdates = () => {
        // Subscribe to message updates
        apiSocket.onMessage('update', this.handleUpdate.bind(this));
        apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this));

        // Subscribe to connection state changes
        apiSocket.onReconnected(() => {
            log.log('🔌 Socket reconnected');

            // Send current focus state on reconnect so the server's
            // suppression rules pick up where we left off (handshake.auth.appState
            // covers the very first connect; this covers reconnects).
            apiSocket.sendAppState(getCurrentAppState());

            this.sessionsSync.invalidate();
            this.machinesSync.invalidate();
            log.log('🔌 Socket reconnected: Invalidating artifacts sync');
            this.artifactsSync.invalidate();
            // Re-fetch messages for every known session. SessionView's
            // onSessionVisible effect depends on `realtimeStatus` (LiveKit voice)
            // not `socketStatus` (WebSocket messages). Voice not toggling means the
            // effect doesn't re-fire, leaving users staring at a stale session with no
            // new messages until they manually send something after returning from
            // the background.
            //
            // Belt-and-suspenders with the AppState 'active' handler — that one fires
            // on iOS resume, this one fires on every socket reconnect (network blips,
            // server restarts, etc.).
            this.messagesSync.forEach((sync) => sync.invalidate());
            for (const sync of this.sendSync.values()) {
                sync.invalidate();
            }
        });
    }

    private rememberPersistentMessageReplayKey(key: string): boolean {
        if (this.recentPersistentMessageReplayKeys.has(key)) {
            return false;
        }
        this.recentPersistentMessageReplayKeys.set(key, true);
        if (
            this.recentPersistentMessageReplayKeys.size
            > Sync.MAX_RECENT_PERSISTENT_MESSAGE_REPLAY_KEYS
        ) {
            const oldest = this.recentPersistentMessageReplayKeys.keys().next().value;
            if (typeof oldest === 'string') {
                this.recentPersistentMessageReplayKeys.delete(oldest);
            }
        }
        return true;
    }

    private async getPersistentMessageReplayKey(
        sessionId: string,
        message: ApiMessage,
        decryptedContent: unknown,
    ): Promise<string | null> {
        if (decryptedContent === null || typeof decryptedContent !== 'object' || Array.isArray(decryptedContent)) {
            return null;
        }

        if (Object.prototype.hasOwnProperty.call(decryptedContent, 'messageIdentity')) {
            const identity = AuthenticatedMessageIdentitySchema.safeParse(
                (decryptedContent as Record<string, unknown>).messageIdentity,
            );
            if (
                !identity.success
                || identity.data.sessionId !== sessionId
                || identity.data.messageId !== message.localId
            ) {
                return null;
            }
            return JSON.stringify(['authenticated', sessionId, identity.data.messageId]);
        }

        // Legacy clients did not bind a sender-owned ID inside the ciphertext.
        // Preserve compatibility while keying replay detection by a fixed-size
        // digest instead of retaining attacker-sized ciphertext strings.
        try {
            const [sessionFingerprint, ciphertextFingerprint] = await Promise.all([
                digestStringAsync(CryptoDigestAlgorithm.SHA256, sessionId),
                digestStringAsync(CryptoDigestAlgorithm.SHA256, message.content.c),
            ]);
            return JSON.stringify([
                'legacy-ciphertext',
                sessionFingerprint,
                ciphertextFingerprint,
            ]);
        } catch {
            return null;
        }
    }

    private async rememberPermissionRequestReplayKey(
        sessionId: string,
        requestId: string,
    ): Promise<boolean> {
        if (requestId.length === 0) {
            return false;
        }

        let key: string;
        try {
            const [sessionFingerprint, requestFingerprint] = await Promise.all([
                digestStringAsync(CryptoDigestAlgorithm.SHA256, sessionId),
                digestStringAsync(CryptoDigestAlgorithm.SHA256, requestId),
            ]);
            key = `${sessionFingerprint}:${requestFingerprint}`;
        } catch {
            return false;
        }

        if (this.recentPermissionRequestReplayKeys.has(key)) {
            return false;
        }
        this.recentPermissionRequestReplayKeys.set(key, true);
        if (
            this.recentPermissionRequestReplayKeys.size
            > Sync.MAX_RECENT_PERMISSION_REQUEST_REPLAY_KEYS
        ) {
            const oldest = this.recentPermissionRequestReplayKeys.keys().next().value;
            if (typeof oldest === 'string') {
                this.recentPermissionRequestReplayKeys.delete(oldest);
            }
        }
        return true;
    }

    private handleUpdate = async (update: unknown) => {
        if (!this.isSessionReplayProtectionOperational()) {
            return;
        }
        await this.persistentUpdateLock.inLock(async () => {
            const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
            if (!validatedUpdate.success) {
                console.warn('Sync rejected an invalid update');
                return;
            }

            const body = validatedUpdate.data.body;
            const sessionId = body.t === 'new-message'
                ? body.sid
                : body.t === 'update-session'
                    ? body.id
                    : null;
            if (
                sessionId
                && (
                    !storage.getState().sessions[sessionId]
                    || !this.encryption.getSessionEncryption(sessionId)
                )
            ) {
                // Keep delivery order while allowing the active snapshot to
                // acquire the separate state-commit lock and finish.
                await this.sessionsSync.awaitQueue();
            }

            await this.persistentStateCommitLock.inLock(
                () => this.handleUpdateSerial(validatedUpdate.data),
            );
        });
    }

    private handleUpdateSerial = async (updateData: ApiUpdateContainer) => {
        if (this.recentPersistentUpdateIds.has(updateData.id)) {
            return;
        }
        this.recentPersistentUpdateIds.set(updateData.id, true);
        if (this.recentPersistentUpdateIds.size > Sync.MAX_RECENT_PERSISTENT_UPDATE_IDS) {
            const oldest = this.recentPersistentUpdateIds.keys().next().value;
            if (typeof oldest === 'string') {
                this.recentPersistentUpdateIds.delete(oldest);
            }
        }
        console.log('Sync validated a persistent update');

        if (updateData.body.t === 'new-message') {
            const messageUpdate = updateData.body;
            const messageLock = this.getSessionMessageLock(messageUpdate.sid);
            await messageLock.inLock(async () => {
                const currentLastSeq = this.sessionLastSeq.get(messageUpdate.sid);
                const incomingSeq = messageUpdate.message.seq;
                if (!Number.isSafeInteger(incomingSeq) || incomingSeq <= 0) {
                    return;
                }
                if (currentLastSeq === undefined || incomingSeq !== currentLastSeq + 1) {
                    if (currentLastSeq === undefined || incomingSeq > currentLastSeq) {
                        this.getMessagesSync(messageUpdate.sid).invalidate();
                    }
                    return;
                }

                const encryption = this.encryption.getSessionEncryption(messageUpdate.sid);
                if (!encryption) {
                    console.error('Session encryption unavailable after sync');
                    this.sessionsSync.invalidate();
                    return;
                }

                const session = storage.getState().sessions[messageUpdate.sid];
                if (!session) {
                    this.sessionsSync.invalidate();
                    return;
                }

                const decrypted = await encryption.decryptMessage(messageUpdate.message);
                const replayKey = decrypted
                    ? await this.getPersistentMessageReplayKey(
                        messageUpdate.sid,
                        messageUpdate.message,
                        decrypted.content,
                    )
                    : null;
                const parsedRawContent = decrypted
                    ? RawRecordSchema.safeParse(decrypted.content)
                    : null;
                if (
                    !decrypted
                    || !replayKey
                    || !parsedRawContent?.success
                    || !this.rememberPersistentMessageReplayKey(replayKey)
                ) {
                    this.getMessagesSync(messageUpdate.sid).invalidate();
                    return;
                }

                const rawContent = parsedRawContent.data;
                const lastMessage = normalizeRawMessage(
                    decrypted.id,
                    decrypted.localId,
                    decrypted.createdAt,
                    rawContent,
                );

                const messageFloorResult = await this.advanceLiveMessageReplayFloor(
                    messageUpdate.sid,
                    messageUpdate.message,
                );
                if (messageFloorResult === 'existing') {
                    // The independently anchored tip was committed before any
                    // visible/lifecycle side effects. An exact redelivery is
                    // therefore inert even if volatile replay caches reset.
                    return;
                }

                // Check for task lifecycle events to update thinking state. This
                // only runs after the encrypted sender identity and replay key are
                // accepted, so a captured event cannot toggle session state twice.
                const lifecycleContent = rawContent as {
                    role?: string;
                    content?: {
                        type?: string;
                        data?: {
                            type?: string;
                            ev?: { t?: string };
                        }
                    }
                };
                const contentType = lifecycleContent.content?.type;
                const dataType = lifecycleContent.content?.data?.type;
                const sessionEventType = lifecycleContent.content?.data?.ev?.t;

                const isTaskComplete =
                    ((contentType === 'acp' || contentType === 'codex')
                        && (dataType === 'task_complete' || dataType === 'turn_aborted'))
                    || (contentType === 'session' && sessionEventType === 'turn-end');

                const isTaskStarted =
                    ((contentType === 'acp' || contentType === 'codex') && dataType === 'task_started')
                    || (contentType === 'session' && sessionEventType === 'turn-start');

                this.applySessions([{
                    ...session,
                    updatedAt: Math.max(session.updatedAt, updateData.createdAt),
                    seq: incomingSeq,
                    ...(isTaskComplete ? { thinking: false } : {}),
                    ...(isTaskStarted ? { thinking: true } : {})
                }]);

                // Even non-rendered protocol events consume a session sequence.
                // Otherwise the next legitimate push appears to have a gap and
                // forces a redundant full message catch-up.
                this.sessionLastSeq.set(messageUpdate.sid, incomingSeq);
                this.sessionSnapshotEpoch += 1;
                if (lastMessage) {
                    this.enqueueMessages(messageUpdate.sid, [lastMessage]);
                    let hasMutableTool = false;
                    if (lastMessage.role === 'agent' && lastMessage.content[0] && lastMessage.content[0].type === 'tool-result') {
                        hasMutableTool = storage.getState().isMutableToolCall(messageUpdate.sid, lastMessage.content[0].tool_use_id);
                    }
                    if (
                        hasMutableTool
                        && isMetadataAuthenticatedForEffects(
                            storage.getState().sessions[messageUpdate.sid]?.metadata,
                        )
                    ) {
                        gitStatusSync.invalidate(messageUpdate.sid);
                    }
                }

                // Ping session
                this.onSessionVisible(messageUpdate.sid);
            });

        } else if (updateData.body.t === 'new-session') {
            log.log('🆕 New session update received');
            this.sessionSnapshotEpoch += 1;
            this.sessionsSync.invalidate();
        } else if (updateData.body.t === 'delete-session') {
            log.log('🗑️ Delete session update received');
            const sessionId = updateData.body.sid;
            const recordCreatedAt = updateData.body.recordCreatedAt;
            if (recordCreatedAt === undefined) {
                // Rolling-upgrade payloads have no generation binding. They
                // may request an authoritative refresh, but must never mutate
                // a possibly newer local generation.
                this.sessionSnapshotEpoch += 1;
                this.sessionsSync.invalidate();
                return;
            }

            const currentSession = storage.getState().sessions[sessionId];
            if (currentSession && recordCreatedAt !== currentSession.createdAt) {
                return;
            }

            this.rememberSessionDeletionTombstone(sessionId, recordCreatedAt);
            await this.persistSessionReplayFences();
            this.sessionSnapshotEpoch += 1;
            this.removeLocalSession(sessionId);

            log.log('🗑️ Session deleted from local storage');
        } else if (updateData.body.t === 'update-session') {
            // handleUpdate awaits any active snapshot before taking the
            // persistent-update lock, then this serial branch re-checks.
            const session = storage.getState().sessions[updateData.body.id];
            const sessionEncryption = this.encryption.getSessionEncryption(updateData.body.id);
            if (!session || !sessionEncryption) {
                console.error('Session state unavailable after sync');
                this.sessionsSync.invalidate();
                return;
            }

                let agentState = session.agentState;
                let agentStateVersion = session.agentStateVersion;
                let agentStateApplied = false;
                const priorAgentStateIsAuthenticated = isAgentStateAuthenticatedForEffects(
                    session.agentState,
                );
                const previouslyAppliedPermissionRequestIds = new Set(
                    priorAgentStateIsAuthenticated
                        ? Object.keys(session.agentState?.requests ?? {})
                        : [],
                );
                if (
                    updateData.body.agentState
                    && isStrictlyNewerVersion(
                        updateData.body.agentState.version,
                        session.agentStateVersion,
                    )
                ) {
                    const result = await sessionEncryption.decryptAgentStateResult(
                        updateData.body.agentState.version,
                        updateData.body.agentState.value,
                    );
                    if (result.success) {
                        agentState = result.value;
                        agentStateVersion = updateData.body.agentState.version;
                        agentStateApplied = true;
                    }
                }

                let metadata = session.metadata;
                let metadataVersion = session.metadataVersion;
                let metadataApplied = false;
                if (
                    updateData.body.metadata
                    && isStrictlyNewerVersion(
                        updateData.body.metadata.version,
                        session.metadataVersion,
                    )
                ) {
                    const result = await sessionEncryption.decryptMetadataResult(
                        updateData.body.metadata.version,
                        updateData.body.metadata.value,
                    );
                    if (result.success) {
                        metadata = result.value;
                        metadataVersion = updateData.body.metadata.version;
                        metadataApplied = true;
                    }
                }

                if (!agentStateApplied && !metadataApplied) {
                    return;
                }

                if (typeof this.encryption?.encryptRaw === 'function') {
                    const hasDataKey = this.sessionDataKeys.has(updateData.body.id);
                    if (!hasDataKey) {
                        // Production encryption always supports durable replay
                        // fences. Do not apply an operational bound update when
                        // its immutable session key was not established.
                        return;
                    }
                    const dataKeyFingerprint = await this.sessionDataKeyFingerprint(
                        this.sessionDataKeys.get(updateData.body.id) ?? null,
                    );
                    const [
                        metadataCiphertextCommitment,
                        agentStateCiphertextCommitment,
                    ] = await Promise.all([
                        metadataApplied && updateData.body.metadata
                            ? this.replayFenceCommitment(updateData.body.metadata.value)
                            : Promise.resolve(null),
                        agentStateApplied
                            && typeof updateData.body.agentState?.value === 'string'
                            ? this.replayFenceCommitment(updateData.body.agentState.value)
                            : Promise.resolve(null),
                    ]);
                    const existingFence = this.sessionReplayFences.get(updateData.body.id);
                    if (
                        existingFence
                        && (
                            existingFence.createdAt !== session.createdAt
                            || existingFence.dataKeyFingerprint !== dataKeyFingerprint
                        )
                    ) {
                        return;
                    }
                    this.sessionReplayFences.set(updateData.body.id, {
                        sessionId: updateData.body.id,
                        createdAt: session.createdAt,
                        metadataVersion: metadataApplied
                            ? metadataVersion
                            : existingFence?.metadataVersion
                                ?? (isMetadataAuthenticatedForEffects(session.metadata)
                                    ? session.metadataVersion
                                    : 0),
                        metadataCiphertextCommitment: metadataApplied
                            ? metadataCiphertextCommitment
                            : existingFence?.metadataCiphertextCommitment ?? null,
                        agentStateVersion: agentStateApplied
                            ? agentStateVersion
                            : existingFence?.agentStateVersion
                                ?? (priorAgentStateIsAuthenticated
                                    ? session.agentStateVersion
                                    : 0),
                        agentStateCiphertextCommitment: agentStateApplied
                            ? agentStateCiphertextCommitment
                            : existingFence?.agentStateCiphertextCommitment ?? null,
                        messageSeq: existingFence?.messageSeq ?? 0,
                        messageCiphertextCommitment:
                            existingFence?.messageCiphertextCommitment ?? null,
                        dataKeyFingerprint,
                    });
                    await this.persistSessionReplayFences();
                }

                this.applySessions([{
                    ...session,
                    agentState,
                    agentStateVersion,
                    metadata,
                    metadataVersion,
                    // Session.seq is the message cursor. Account update seqs
                    // must never overwrite it.
                    seq: session.seq,
                    updatedAt: Math.max(session.updatedAt, updateData.createdAt),
                }], {
                    source: 'live',
                    effectfulAgentStateSessionIds: agentStateApplied
                        ? new Set([updateData.body.id])
                        : new Set(),
                    effectfulMetadataSessionIds: metadataApplied
                        ? new Set([updateData.body.id])
                        : new Set(),
                });
                this.sessionSnapshotEpoch += 1;

                // Invalidate git status when agent state changes (files may have been modified)
                if (agentStateApplied) {
                    if (isMetadataAuthenticatedForEffects(metadata)) {
                        gitStatusSync.invalidate(updateData.body.id);
                    }

                    // Check for new permission requests and notify voice assistant
                    if (agentState?.requests && Object.keys(agentState.requests).length > 0) {
                        const requestIds = Object.keys(agentState.requests);
                        for (const requestId of requestIds) {
                            // The prior authenticated session state is the
                            // durable replay boundary. The bounded in-memory
                            // set below is only defense in depth for IDs that
                            // disappear and are later reintroduced.
                            if (previouslyAppliedPermissionRequestIds.has(requestId)) {
                                continue;
                            }
                            if (!await this.rememberPermissionRequestReplayKey(updateData.body.id, requestId)) {
                                continue;
                            }
                            const request = agentState.requests[requestId];
                            voiceHooks.onPermissionRequested(
                                updateData.body.id,
                                requestId,
                                request?.tool,
                            );
                            // Preserve the existing one-notification-per-state
                            // behavior while selecting the first unseen request.
                            break;
                        }
                    }

                    // Re-fetch messages when control returns to mobile (local -> remote mode switch)
                    // This catches up on any messages that were exchanged while desktop had control
                    const wasControlledByUser = priorAgentStateIsAuthenticated
                        ? session.agentState?.controlledByUser
                        : false;
                    const isNowControlledByUser = agentState?.controlledByUser;
                    if (!wasControlledByUser && isNowControlledByUser) {
                        log.log('🔄 Control returned to mobile; re-fetching messages');
                        this.onSessionVisible(updateData.body.id);
                    }
                }
        } else if (updateData.body.t === 'update-account') {
            const accountUpdate = updateData.body;
            if (accountUpdate.id !== this.serverID) {
                return;
            }
            const currentProfile = storage.getState().profile;
            const hasProfileFields = accountUpdate.firstName !== undefined
                || accountUpdate.lastName !== undefined
                || accountUpdate.avatar !== undefined
                || accountUpdate.github !== undefined;
            if (hasProfileFields && updateData.createdAt > currentProfile.timestamp) {
                const hadGitHub = !!currentProfile.github?.login;
                const updatedProfile: Profile = {
                    ...currentProfile,
                    firstName: accountUpdate.firstName !== undefined ? accountUpdate.firstName : currentProfile.firstName,
                    lastName: accountUpdate.lastName !== undefined ? accountUpdate.lastName : currentProfile.lastName,
                    avatar: accountUpdate.avatar !== undefined ? accountUpdate.avatar : currentProfile.avatar,
                    github: accountUpdate.github !== undefined ? accountUpdate.github : currentProfile.github,
                    timestamp: updateData.createdAt,
                };
                storage.getState().applyProfile(updatedProfile);

                if (!hadGitHub && updatedProfile.github?.login) {
                    trackGitHubConnected();
                }
            }

            // Handle settings updates (new for profile sync)
            const currentSettingsVersion = storage.getState().settingsVersion;
            const hasFreshSettings = accountUpdate.settings
                && Number.isSafeInteger(accountUpdate.settings.version)
                && accountUpdate.settings.version >= 0
                && (currentSettingsVersion === null || accountUpdate.settings.version > currentSettingsVersion);
            if (hasFreshSettings && accountUpdate.settings) {
                try {
                    const parsedSettings = accountUpdate.settings.value
                        ? settingsParse(await this.encryption.decryptRaw(accountUpdate.settings.value))
                        : { ...settingsDefaults };

                    // Version compatibility check
                    const settingsSchemaVersion = parsedSettings.schemaVersion ?? 1;
                    if (settingsSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
                        console.warn('Settings schema is newer than this app supports');
                    }

                    this.applyServerSettings(parsedSettings, accountUpdate.settings.version);
                    log.log(`📋 Settings synced from server (schema v${settingsSchemaVersion}, version ${accountUpdate.settings.version})`);
                } catch {
                    console.error('❌ Failed to process settings update');
                    // Don't crash on settings sync errors, just log
                }
            }
        } else if (updateData.body.t === 'new-machine') {
            const machineUpdate = updateData.body;
            const machineId = machineUpdate.machineId;
            const existing = storage.getState().machines[machineId];
            if (existing && machineUpdate.createdAt <= existing.createdAt) {
                return;
            }

            // Brand-new machines (cold onboarding) are delivered via 'new-machine'
            // before any fetchMachines has seen them, so their per-machine
            // encryption isn't initialized yet. The update carries the data
            // encryption key — register it here (mirroring fetchMachines) or every
            // later decrypt for this machine fails and it never lands in storage,
            // leaving the new-session screen unable to start a session until an app
            // restart / socket reconnect triggers a full machine refetch.
            const machineKeysMap = new Map<string, Uint8Array | null>();
            const keyResolution = await resolveMachineDataKey(
                machineUpdate.dataEncryptionKey,
                (encryptedKey) => this.encryption.decryptEncryptionKey(encryptedKey),
            );
            if (keyResolution.kind === 'current') {
                machineKeysMap.set(machineId, keyResolution.key);
                this.machineDataKeys.set(machineId, keyResolution.key);
            } else if (keyResolution.kind === 'legacy') {
                machineKeysMap.set(machineId, null);
            } else {
                console.error('Failed to authenticate a new machine data encryption key');
                this.encryption.removeMachineEncryption(machineId);
                this.machineDataKeys.delete(machineId);
            }
            await this.encryption.initializeMachines(machineKeysMap);

            const machineEncryption = this.encryption.getMachineEncryption(machineId);
            if (!machineEncryption) {
                console.error('Machine encryption unavailable after initialization');
                return;
            }

            const newMachine: Machine = {
                id: machineId,
                seq: machineUpdate.seq,
                createdAt: machineUpdate.createdAt,
                updatedAt: machineUpdate.updatedAt,
                active: machineUpdate.active,
                activeAt: machineUpdate.activeAt,
                metadata: null,
                metadataVersion: machineUpdate.metadataVersion,
                daemonState: null,
                daemonStateVersion: machineUpdate.daemonStateVersion
            };

            // Decrypt best-effort; still apply the machine on failure so it stays
            // visible/usable (matches fetchMachines' fallback behavior).
            try {
                newMachine.metadata = machineUpdate.metadata
                    ? await machineEncryption.decryptMetadata(machineUpdate.metadataVersion, machineUpdate.metadata)
                    : null;
                newMachine.daemonState = machineUpdate.daemonState
                    ? await machineEncryption.decryptDaemonState(machineUpdate.daemonStateVersion, machineUpdate.daemonState)
                    : null;
            } catch {
                console.error('Failed to decrypt new machine state');
            }

            storage.getState().applyMachines([newMachine]);
        } else if (updateData.body.t === 'update-machine') {
            const machineUpdate = updateData.body;
            const machineId = machineUpdate.machineId;
            const machine = storage.getState().machines[machineId];
            if (!machine) {
                this.machinesSync.invalidate();
                return;
            }

            // Get machine-specific encryption (might not exist if machine wasn't initialized)
            const machineEncryption = this.encryption.getMachineEncryption(machineId);
            if (!machineEncryption) {
                console.error('Machine encryption unavailable for update');
                return;
            }

            const updatedMachine: Machine = { ...machine };
            let applied = false;

            const metadataUpdate = machineUpdate.metadata;
            if (metadataUpdate && isStrictlyNewerVersion(metadataUpdate.version, machine.metadataVersion)) {
                try {
                    const metadata = await machineEncryption.decryptMetadata(metadataUpdate.version, metadataUpdate.value);
                    if (metadata !== null) {
                        updatedMachine.metadata = metadata;
                        updatedMachine.metadataVersion = metadataUpdate.version;
                        applied = true;
                    }
                } catch {
                    console.error('Failed to decrypt machine metadata');
                }
            }

            const daemonStateUpdate = machineUpdate.daemonState;
            if (daemonStateUpdate && isStrictlyNewerVersion(daemonStateUpdate.version, machine.daemonStateVersion)) {
                try {
                    const daemonState = await machineEncryption.decryptDaemonState(daemonStateUpdate.version, daemonStateUpdate.value);
                    if (daemonState !== null) {
                        updatedMachine.daemonState = daemonState;
                        updatedMachine.daemonStateVersion = daemonStateUpdate.version;
                        applied = true;
                    }
                } catch {
                    console.error('Failed to decrypt machine daemon state');
                }
            }

            if (
                machineUpdate.active !== undefined
                && machineUpdate.activeAt !== undefined
                && Number.isSafeInteger(machineUpdate.activeAt)
                && machineUpdate.activeAt > machine.activeAt
            ) {
                updatedMachine.active = machineUpdate.active;
                updatedMachine.activeAt = machineUpdate.activeAt;
                applied = true;
            }

            if (applied) {
                updatedMachine.updatedAt = Math.max(machine.updatedAt, updateData.createdAt);
                storage.getState().applyMachines([updatedMachine]);
            }
        } else if (updateData.body.t === 'delete-machine') {
            const machineId = updateData.body.machineId;
            log.log('🗑️ Delete machine update received');
            const currentMachine = storage.getState().machines[machineId];
            if (!currentMachine) {
                log.log('Machine not in storage; skipping delete');
                return;
            }
            if (
                updateData.body.recordCreatedAt !== undefined
                && updateData.body.recordCreatedAt !== currentMachine.createdAt
            ) {
                return;
            }
            storage.getState().deleteMachine(machineId);
            this.encryption.removeMachineEncryption(machineId);
            this.machineDataKeys.delete(machineId);
        } else if (updateData.body.t === 'new-artifact') {
            log.log('📦 Received new-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            const existingArtifact = storage.getState().artifacts[artifactId];
            if (existingArtifact && artifactUpdate.createdAt <= existingArtifact.createdAt) {
                return;
            }

            try {
                // Decrypt the data encryption key
                const decryptedKey = await this.encryption.decryptEncryptionKey(artifactUpdate.dataEncryptionKey);
                if (!decryptedKey) {
                    console.error('Failed to decrypt a new artifact key');
                    return;
                }

                // Store the decrypted key in memory
                this.artifactDataKeys.set(artifactId, decryptedKey);

                // Create artifact encryption instance
                const artifactEncryption = new ArtifactEncryption(decryptedKey);

                // Decrypt header
                const header = await artifactEncryption.decryptHeader(artifactUpdate.header);

                // Decrypt body if provided
                let decryptedBody: string | null | undefined = undefined;
                if (artifactUpdate.body && artifactUpdate.bodyVersion !== undefined) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body);
                    decryptedBody = body?.body || null;
                }

                // Add to storage
                const decryptedArtifact: DecryptedArtifact = {
                    id: artifactId,
                    title: header?.title || null,
                    body: decryptedBody,
                    headerVersion: artifactUpdate.headerVersion,
                    bodyVersion: artifactUpdate.bodyVersion,
                    seq: artifactUpdate.seq,
                    createdAt: artifactUpdate.createdAt,
                    updatedAt: artifactUpdate.updatedAt,
                    isDecrypted: !!header,
                };

                storage.getState().addArtifact(decryptedArtifact);
                log.log('📦 Added new artifact to storage');
            } catch {
                console.error('Failed to process new artifact');
            }
        } else if (updateData.body.t === 'update-artifact') {
            log.log('📦 Received update-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;

            // Get existing artifact
            const existingArtifact = storage.getState().artifacts[artifactId];
            if (!existingArtifact) {
                console.error('Artifact unavailable in storage');
                // Fetch all artifacts to sync
                this.artifactsSync.invalidate();
                return;
            }

            try {
                // Get the data encryption key from memory
                let dataEncryptionKey = this.artifactDataKeys.get(artifactId);
                if (!dataEncryptionKey) {
                    console.error('Artifact encryption key unavailable');
                    this.artifactsSync.invalidate();
                    return;
                }

                // Create artifact encryption instance
                const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);
                const updatedArtifact: DecryptedArtifact = { ...existingArtifact };
                let applied = false;

                // Decrypt and update header if provided
                if (
                    artifactUpdate.header
                    && isStrictlyNewerVersion(artifactUpdate.header.version, existingArtifact.headerVersion)
                ) {
                    const header = await artifactEncryption.decryptHeader(artifactUpdate.header.value);
                    if (header !== null) {
                        updatedArtifact.title = header.title;
                        updatedArtifact.sessions = header.sessions;
                        updatedArtifact.draft = header.draft;
                        updatedArtifact.headerVersion = artifactUpdate.header.version;
                        applied = true;
                    }
                }

                // Decrypt and update body if provided
                if (
                    artifactUpdate.body
                    && isStrictlyNewerVersion(
                        artifactUpdate.body.version,
                        existingArtifact.bodyVersion ?? 0,
                    )
                ) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body.value);
                    if (body !== null) {
                        updatedArtifact.body = body.body;
                        updatedArtifact.bodyVersion = artifactUpdate.body.version;
                        applied = true;
                    }
                }

                if (applied) {
                    updatedArtifact.updatedAt = Math.max(existingArtifact.updatedAt, updateData.createdAt);
                    storage.getState().updateArtifact(updatedArtifact);
                    log.log('📦 Updated artifact in storage');
                }
            } catch {
                console.error('Failed to process artifact update');
            }
        } else if (updateData.body.t === 'delete-artifact') {
            log.log('📦 Received delete-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            const existingArtifact = storage.getState().artifacts[artifactId];
            if (!existingArtifact || (
                artifactUpdate.recordCreatedAt !== undefined
                && artifactUpdate.recordCreatedAt !== existingArtifact.createdAt
            )) {
                return;
            }

            // Remove from storage
            storage.getState().deleteArtifact(artifactId);

            // Remove encryption key from memory
            this.artifactDataKeys.delete(artifactId);
        }
    }

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>) => {
        const sessions: Session[] = [];

        for (const [sessionId, update] of updates) {
            const session = storage.getState().sessions[sessionId];
            if (session) {
                sessions.push({
                    ...session,
                    active: update.active,
                    activeAt: update.activeAt,
                    thinking: update.thinking ?? false,
                    thinkingAt: update.activeAt // Always use activeAt for consistency
                });
            }
        }

        if (sessions.length > 0) {
            this.applySessions(sessions);
        }
    }

    private handleEphemeralUpdate = (update: unknown) => {
        const validatedUpdate = ApiEphemeralUpdateSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.warn('Sync rejected an invalid ephemeral update');
            return;
        }
        const updateData = validatedUpdate.data;

        // Process activity updates through smart debounce accumulator
        if (updateData.type === 'activity') {
            this.activityAccumulator.addUpdate(updateData);
        }

        // Handle machine activity updates
        if (updateData.type === 'machine-activity') {
            // Update machine's active status and lastActiveAt
            const machine = storage.getState().machines[updateData.id];
            if (machine) {
                const updatedMachine: Machine = {
                    ...machine,
                    active: updateData.active,
                    activeAt: updateData.activeAt
                };
                storage.getState().applyMachines([updatedMachine]);
            }
        }

        // Handle session usage updates. The CLI emits raw Claude SDK usage
        // via a separate `usage-report` socket event (apiSession.ts:530)
        // rather than embedding it in agent message envelopes. The server
        // forwards that as an ephemeral 'usage' event to the session room
        // (usageHandler.ts → buildUsageEphemeral). Without this branch the
        // update validated against the schema but fell through, so
        // `session.latestUsage` stayed null and AgentInput's context
        // indicator showed "100% left" forever even mid-session.
        // contextSize math mirrors processUsageData in reducer.ts.
        if (updateData.type === 'usage') {
            const sessionId = updateData.id;
            const session = storage.getState().sessions[sessionId];
            if (session) {
                const tokens = updateData.tokens;
                if (!session.latestUsage || updateData.timestamp > session.latestUsage.timestamp) {
                    const updatedSession: Session = {
                        ...session,
                        latestUsage: {
                            inputTokens: tokens.input,
                            outputTokens: tokens.output,
                            cacheCreation: tokens.cache_creation,
                            cacheRead: tokens.cache_read,
                            contextSize: tokens.cache_creation + tokens.cache_read + tokens.input,
                            timestamp: updateData.timestamp,
                        },
                    };
                    storage.getState().applySessions([updatedSession]);
                }
            }
        }

        // Session-level lifecycle event (Claude finished, needs permission, asks question).
        // This is the same signal that triggers the mobile push — bump browser-tab
        // unread counter on these only, ignore the noisy per-message stream.
        if (updateData.type === 'session-event') {
            notifyUnreadMessage();
        }

        // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
    }

    //
    // Apply store
    //

    private applyMessages = (sessionId: string, messages: NormalizedMessage[]) => {
        const result = storage.getState().applyMessages(sessionId, messages);
        let m: Message[] = [];
        for (let messageId of result.changed) {
            const message = storage.getState().sessionMessages[sessionId].messagesMap[messageId];
            if (message) {
                m.push(message);
            }
        }
        if (m.length > 0) {
            voiceHooks.onMessages(sessionId, m);
        }
        if (result.hasReadyEvent) {
            voiceHooks.onReady(sessionId);
        }
    }

    private applySessions = (
        sessions: SessionWithoutPresence[],
        context: SessionApplyContext = { source: 'live' },
    ) => {
        const active = storage.getState().getActiveSessions();
        storage.getState().applySessions(sessions, context);
        if (context.source === 'hydration') {
            // A snapshot describes current display state; it is not a live
            // lifecycle transition and must not generate voice events.
            return;
        }
        const newActive = storage.getState().getActiveSessions();
        this.applySessionDiff(active, newActive);
    }

    private applySessionDiff = (active: Session[], newActive: Session[]) => {
        let wasActive = new Set(active.map(s => s.id));
        let isActive = new Set(newActive.map(s => s.id));
        for (let s of active) {
            if (!isActive.has(s.id) && isMetadataAuthenticatedForEffects(s.metadata)) {
                voiceHooks.onSessionOffline(s.id, s.metadata ?? undefined);
            }
        }
        for (let s of newActive) {
            if (!wasActive.has(s.id) && isMetadataAuthenticatedForEffects(s.metadata)) {
                voiceHooks.onSessionOnline(s.id, s.metadata ?? undefined);
            }
        }
    }

    // === Session Group Management ===

    /** Move a session to the top of the ungrouped list */
    moveSessionToTop(sessionId: string) {
        if (!this.credentials || !this.encryption) return;
        const order = getCachedSessionOrderV2();
        const updated = { ...order, ungrouped: moveSessionToTopFn(order.ungrouped, sessionId) };
        void saveSessionOrderV2(this.credentials, this.encryption, updated);
    }

    /** Move a session into a group (or ungrouped if groupId is null) */
    moveSessionToGroup(sessionId: string, groupId: string | null) {
        if (!this.credentials || !this.encryption) return;
        const order = getCachedSessionOrderV2();
        const updated = moveSessionToGroupFn(order, sessionId, groupId);
        void saveSessionOrderV2(this.credentials, this.encryption, updated);
    }

    /** Create a new session group and return its ID */
    async createSessionGroup(name: string): Promise<string> {
        if (!this.credentials || !this.encryption) return '';
        const groupId = randomUUID();
        const order = getCachedSessionOrderV2();
        const updated = createGroup(order, groupId, name);
        await saveSessionOrderV2(this.credentials, this.encryption, updated);
        return groupId;
    }

    /** Rename an existing session group */
    renameSessionGroup(groupId: string, name: string) {
        if (!this.credentials || !this.encryption) return;
        const order = getCachedSessionOrderV2();
        const updated = renameGroup(order, groupId, name);
        void saveSessionOrderV2(this.credentials, this.encryption, updated);
    }

    /** Delete a session group (sessions move back to ungrouped) */
    deleteSessionGroup(groupId: string) {
        if (!this.credentials || !this.encryption) return;
        const order = getCachedSessionOrderV2();
        const updated = deleteGroup(order, groupId);
        void saveSessionOrderV2(this.credentials, this.encryption, updated);
    }

    /** Reorder the ungrouped sessions to match the given ID list */
    reorderUngroupedSessions(newOrder: string[]) {
        if (!this.credentials || !this.encryption) return;
        const order = getCachedSessionOrderV2();
        const updated = reorderUngroupedFn(order, newOrder);
        void saveSessionOrderV2(this.credentials, this.encryption, updated);
    }

    /** Reorder sessions within a single group */
    reorderSessionsInGroup(groupId: string, newOrder: string[]) {
        if (!this.credentials || !this.encryption) return;
        const order = getCachedSessionOrderV2();
        const updated = reorderSessionsInGroupFn(order, groupId, newOrder);
        void saveSessionOrderV2(this.credentials, this.encryption, updated);
    }

    /**
     * Replace the V2 session order outright. Used by drag-to-reorder to apply
     * the rebuilt structure in one round-trip — saves a chain of N moves.
     */
    replaceSessionOrderV2(order: SessionOrderV2) {
        if (!this.credentials || !this.encryption) return;
        void saveSessionOrderV2(this.credentials, this.encryption, order);
    }

}

// Global singleton instance
export const sync = new Sync();

//
// Init sequence
//

let isInitialized = false;
export async function syncCreate(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, false);
}

export async function syncRestore(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, true);
}

async function syncInit(credentials: AuthCredentials, restore: boolean) {

    // Initialize sync engine
    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    const encryption = await Encryption.create(secretKey);

    // Initialize socket connection
    const API_ENDPOINT = getServerUrl();
    apiSocket.initialize({ endpoint: API_ENDPOINT, token: credentials.token }, encryption);

    // Wire socket status to storage
    apiSocket.onStatusChange((status) => {
        storage.getState().setSocketStatus(status);
    });
    // Diagnostic details use a separate store channel so the stable connection
    // status remains a small state machine.
    apiSocket.onDetailsChange((details) => {
        storage.getState().setSocketDetails({
            lastErrorMessage: details.lastErrorMessage,
            reconnectAttempts: details.reconnectAttempts,
        });
    });

    // Initialize sessions engine
    if (restore) {
        await sync.restore(credentials, encryption);
    } else {
        await sync.create(credentials, encryption);
    }
}
