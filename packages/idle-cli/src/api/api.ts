import axios from 'axios'
import { logger } from '@/ui/logger'
import {
  CreateSessionResponseSchema,
  type AgentState,
  type CreateSessionResponse,
  type Metadata,
  type Session,
  type Machine,
  type MachineMetadata,
  type DaemonState,
} from '@/api/types'
import { ApiSessionClient } from './apiSession';
import { ApiMachineClient } from './apiMachine';
import { decodeBase64, encodeBase64, getRandomBytes, encrypt, decrypt, libsodiumEncryptForPublicKey } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import chalk from 'chalk';
import { Credentials } from '@/persistence';
import { connectionState, isNetworkError } from '@/utils/serverConnectionErrors';
import { randomUUID } from 'node:crypto';
import { decryptSessionField, encryptSessionField } from './sessionFieldEncryption';
import {
  getOrCreateSessionCreateIdentity,
  type SessionCreateIdentity,
} from './sessionCreateIdentity';

const SESSION_CREATE_HTTP_CONFIG = Object.freeze({
  timeout: 60_000,
  maxContentLength: 256 * 1024,
  maxBodyLength: 128 * 1024,
  maxRedirects: 0,
});

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient(credential);
  }

  private readonly credential: Credentials;
  private readonly pushClient: PushNotificationClient;

  private constructor(credential: Credentials) {
    this.credential = credential
    this.pushClient = new PushNotificationClient(credential.token, configuration.serverUrl)
  }

  /**
   * Create a new session or load existing one with the given tag
   */
  async getOrCreateSession(opts: {
    tag: string,
    metadata: Metadata,
    state: AgentState | null
  }): Promise<Session | null> {
    if (typeof opts.tag !== 'string' || opts.tag.length < 1 || opts.tag.length > 128) {
      throw new Error('Session tag must be between 1 and 128 characters');
    }

    // Resolve encryption key
    let dataEncryptionKey: Uint8Array | null = null;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    let sessionCreateIdentity: SessionCreateIdentity | null = null;
    let requestedSessionId: string;
    if (this.credential.encryption.type === 'dataKey') {
      // Retain the proposed coordinate and data key for the lifetime of this
      // tag. This covers lost responses and keeps later same-tag responses
      // decryptable after the relay has acknowledged creation.
      sessionCreateIdentity = await getOrCreateSessionCreateIdentity(
        opts.tag,
        this.credential.encryption.machineKey,
      );
      encryptionKey = sessionCreateIdentity.encryptionKey;
      requestedSessionId = sessionCreateIdentity.sessionId;
      encryptionVariant = 'dataKey';

      // Wrap the data key to the account content public key for other clients.
      const encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, this.credential.encryption.publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Data key
    } else {
      encryptionKey = this.credential.encryption.secret;
      encryptionVariant = 'legacy';
      requestedSessionId = randomUUID();
    }

    const sessionEncryption = { key: encryptionKey, variant: encryptionVariant };

    // Create session
    try {
      const response = await axios.post<CreateSessionResponse>(
        `${configuration.serverUrl}/v2/sessions`,
        {
          id: requestedSessionId,
          tag: opts.tag,
          metadata: encryptSessionField(
            sessionEncryption,
            requestedSessionId,
            'metadata',
            0,
            opts.metadata,
          ),
          agentState: opts.state
            ? encryptSessionField(
                sessionEncryption,
                requestedSessionId,
                'agentState',
                0,
                opts.state,
              )
            : null,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : null,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
          },
          ...SESSION_CREATE_HTTP_CONFIG,
        }
      )

      logger.debug('[API] Session created or loaded');
      const parsedResponse = CreateSessionResponseSchema.safeParse(response.data);
      if (!parsedResponse.success) {
        throw new Error('Relay returned an invalid session response');
      }
      const raw = parsedResponse.data.session;
      const metadata = decryptSessionField<Metadata>(
        sessionEncryption,
        raw.id,
        'metadata',
        raw.metadataVersion,
        raw.metadata,
        { allowLegacy: true },
      );
      const agentState = raw.agentState
        ? decryptSessionField<AgentState>(
            sessionEncryption,
            raw.id,
            'agentState',
            raw.agentStateVersion,
            raw.agentState,
            { allowLegacy: true },
          )
        : null;
      if (!metadata.success || (agentState && !agentState.success)) {
        if (raw.id !== requestedSessionId) {
          throw new Error(
            'The relay returned a different session ID with unreadable bound fields. '
            + 'Current clients require a relay that preserves client-selected IDs for new sessions. '
            + 'Upgrade the relay and retry.',
          );
        }
        throw new Error('Session fields failed authenticated decryption');
      }
      const session: Session = {
        id: raw.id,
        seq: raw.seq,
        metadata: metadata.value,
        metadataVersion: raw.metadataVersion,
        agentState: agentState?.success ? agentState.value : null,
        agentStateVersion: raw.agentStateVersion,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant
      }
      return session;
    } catch (error) {
      logger.debug('[API] Session creation failed');

      // Check if it's a connection error
      if (error && typeof error === 'object' && 'code' in error) {
        const errorCode = (error as any).code;
        if (isNetworkError(errorCode)) {
          connectionState.fail({
            operation: 'Session creation',
            errorCode,
          });
          return null;
        }
      }

      // Handle 404 gracefully - server endpoint may not be available yet
      const is404Error = (
        (axios.isAxiosError(error) && error.response?.status === 404) ||
        (error && typeof error === 'object' && 'response' in error && (error as any).response?.status === 404)
      );
      if (is404Error) {
        connectionState.fail({
          operation: 'Session creation',
          errorCode: '404',
        });
        return null;
      }

      // Handle 5xx server errors - use offline mode with auto-reconnect
      if (axios.isAxiosError(error) && error.response?.status) {
        const status = error.response.status;
        if (status >= 500) {
          connectionState.fail({
            operation: 'Session creation',
            errorCode: String(status),
          });
          return null;
        }
      }

      throw new Error(`Failed to get or create session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Register or update machine with the server
   * Returns the current machine state from the server with decrypted metadata and daemonState
   */
  async getOrCreateMachine(opts: {
    machineId: string,
    metadata: MachineMetadata,
    daemonState?: DaemonState,
  }): Promise<Machine> {

    // Resolve encryption key
    let dataEncryptionKey: Uint8Array | null = null;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    if (this.credential.encryption.type === 'dataKey') {
      // Encrypt data encryption key
      encryptionVariant = 'dataKey';
      encryptionKey = this.credential.encryption.machineKey;
      let encryptedDataKey = libsodiumEncryptForPublicKey(this.credential.encryption.machineKey, this.credential.encryption.publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Data key
    } else {
      // Legacy encryption
      encryptionKey = this.credential.encryption.secret;
      encryptionVariant = 'legacy';
    }

    // Helper to create minimal machine object for offline mode (DRY)
    const createMinimalMachine = (): Machine => ({
      id: opts.machineId,
      encryptionKey: encryptionKey,
      encryptionVariant: encryptionVariant,
      metadata: opts.metadata,
      metadataVersion: 0,
      daemonState: opts.daemonState || null,
      daemonStateVersion: 0,
    });

    // Create machine
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/machines`,
        {
          id: opts.machineId,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          daemonState: opts.daemonState ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.daemonState)) : undefined,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : undefined
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
          },
          timeout: 60000, // 1 minute timeout for very bad network connections
          maxRedirects: 0,
        }
      );


      const raw = response.data.machine;
      logger.debug('[API] Machine registered or updated with server');

      // Return decrypted machine like we do for sessions
      const machine: Machine = {
        id: raw.id,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant,
        metadata: raw.metadata ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) : null,
        metadataVersion: raw.metadataVersion || 0,
        daemonState: raw.daemonState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.daemonState)) : null,
        daemonStateVersion: raw.daemonStateVersion || 0,
      };
      return machine;
    } catch (error) {
      // Handle connection errors gracefully
      if (axios.isAxiosError(error) && error.code && isNetworkError(error.code)) {
        connectionState.fail({
          operation: 'Machine registration',
          errorCode: error.code,
        });
        return createMinimalMachine();
      }

      // Handle 403/409 - server rejected request due to authorization conflict
      // This is NOT "server unreachable" - server responded, so don't use connectionState
      if (axios.isAxiosError(error) && error.response?.status) {
        const status = error.response.status;

        if (status === 403 || status === 409) {
          // Re-auth conflict: machine registered to old account, re-association not allowed
          console.log(chalk.yellow(
            `⚠️  Machine registration rejected by the server with status ${status}`
          ));
          console.log(chalk.yellow(
            `   → This machine ID is already registered to another account on the server`
          ));
          console.log(chalk.yellow(
            `   → This usually happens after re-authenticating with a different account`
          ));
          console.log(chalk.yellow(
            `   → Run 'idle doctor clean' to reset local state and generate a new machine ID`
          ));
          console.log(chalk.yellow(
            `   → Open a GitHub issue if this problem persists`
          ));
          return createMinimalMachine();
        }

        // Handle 5xx - server error, use offline mode with auto-reconnect
        if (status >= 500) {
          connectionState.fail({
            operation: 'Machine registration',
            errorCode: String(status),
          });
          return createMinimalMachine();
        }

        // Handle 404 - endpoint may not be available yet
        if (status === 404) {
          connectionState.fail({
            operation: 'Machine registration',
            errorCode: '404',
          });
          return createMinimalMachine();
        }
      }

      // For other errors, rethrow
      throw error;
    }
  }

  sessionSyncClient(session: Session): ApiSessionClient {
    return new ApiSessionClient(
      this.credential.token,
      session,
      this.credential.rpcRegistrationToken ?? this.credential.token,
    );
  }

  machineSyncClient(machine: Machine): ApiMachineClient {
    return new ApiMachineClient(
      this.credential.token,
      machine,
      this.credential.rpcRegistrationToken ?? this.credential.token,
    );
  }

  push(): PushNotificationClient {
    return this.pushClient;
  }

  /**
   * Mark a session as inactive on the server (active=false). Does NOT
   * change `lifecycleState`, so the session remains visible in the app
   * and resumable — same effect as the in-app "Archive" button hitting
   * the /archive endpoint, but without the extra metadata.
   *
   * Used during graceful shutdown (Ctrl-C / SIGTERM) as a synchronous
   * fallback for the socket-based session-end signal: even if the
   * socket emit doesn't drain before the process exits, the HTTP
   * response confirms the deactivate landed.
   */
  async deactivateSession(sessionId: string): Promise<boolean> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/sessions/${sessionId}/archive`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
          },
          timeout: 3000,
          maxRedirects: 0,
        },
      );
      return response.status >= 200 && response.status < 300;
    } catch {
      logger.debug('[API] Session deactivation failed');
      return false;
    }
  }
}
