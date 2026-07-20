import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';

import {
    buildDeleteArtifactUpdate,
    buildDeleteMachineUpdate,
    buildDeleteSessionUpdate,
    eventRouter,
} from './eventRouter';
import { pendingSocketAdmissions } from '../api/socket/pendingSocketAdmissions';

describe('eventRouter live capability revocation', () => {
    const disconnectSockets = vi.fn(async () => undefined);

    beforeEach(() => {
        vi.clearAllMocks();
        eventRouter.init({
            sockets: { adapter: { disconnectSockets } },
        } as unknown as Server);
    });

    it('disconnects every established account socket across the configured adapter', async () => {
        const pending = pendingSocketAdmissions.track('account-1', 'pending-socket');
        await eventRouter.disconnectUserConnections('account-1');

        expect(pending?.canceled).toBe(true);
        expect(disconnectSockets).toHaveBeenCalledWith({
            rooms: new Set(['user:account-1']),
            except: new Set(),
            flags: {},
        }, true);
        pending?.release();
    });

    it('waits for every relay to cancel pending admissions before sweeping established sockets', async () => {
        let acknowledgeRemote!: (responses: unknown[]) => void;
        const remoteCancellation = new Promise<unknown[]>((resolve) => {
            acknowledgeRemote = resolve;
        });
        const serverSideEmitWithAck = vi.fn(() => remoteCancellation);
        eventRouter.init({
            on: vi.fn(),
            sockets: { adapter: { disconnectSockets } },
            serverSideEmitWithAck,
        } as unknown as Server, {
            distributePendingAdmissionCancellation: true,
        });

        const revocation = eventRouter.disconnectUserConnections('account-1');
        await vi.waitFor(() => expect(serverSideEmitWithAck).toHaveBeenCalled());
        expect(disconnectSockets).not.toHaveBeenCalled();

        acknowledgeRemote([{ ok: true }, { ok: true }]);
        await revocation;

        expect(disconnectSockets).toHaveBeenCalledTimes(1);
    });

    it('still sweeps established sockets when distributed pending cancellation fails closed', async () => {
        eventRouter.init({
            on: vi.fn(),
            sockets: { adapter: { disconnectSockets } },
            serverSideEmitWithAck: vi.fn(async () => [{ ok: false }]),
        } as unknown as Server, {
            distributePendingAdmissionCancellation: true,
        });

        await expect(eventRouter.disconnectUserConnections('account-1')).rejects.toThrow(
            'A relay rejected pending admission cancellation',
        );
        expect(disconnectSockets).toHaveBeenCalledTimes(1);
    });

    it('acknowledges a remote pending-admission cancellation only after local state is canceled', () => {
        let cancellationListener!: (userId: unknown, acknowledge: (response: unknown) => void) => void;
        const on = vi.fn((_event: string, listener: typeof cancellationListener) => {
            cancellationListener = listener;
        });
        eventRouter.init({
            on,
            sockets: { adapter: { disconnectSockets } },
        } as unknown as Server);
        const pending = pendingSocketAdmissions.track('account-remote', 'pending-remote');
        const acknowledge = vi.fn();

        cancellationListener('account-remote', acknowledge);

        expect(pending?.canceled).toBe(true);
        expect(acknowledge).toHaveBeenCalledWith({ ok: true });
        pending?.release();
    });

    it('disconnects only the exact account and session room', async () => {
        await eventRouter.disconnectSessionConnections('account-1', 'session-1');

        expect(disconnectSockets).toHaveBeenCalledWith({
            rooms: new Set(['user:account-1:session:session-1']),
            except: new Set(),
            flags: {},
        }, true);
    });

    it('disconnects only the exact account and machine room', async () => {
        await eventRouter.disconnectMachineConnections('account-1', 'machine-1');

        expect(disconnectSockets).toHaveBeenCalledWith({
            rooms: new Set(['user:account-1:machine:machine-1']),
            except: new Set(),
            flags: {},
        }, true);
    });
});

describe('persistent delete generation binding', () => {
    it('emits the removed record creation time for every persistent record type', () => {
        const generation = new Date('2026-07-13T06:00:00.000Z');

        expect(buildDeleteSessionUpdate('session-1', 1, 'update-session', generation).body).toEqual({
            t: 'delete-session',
            sid: 'session-1',
            recordCreatedAt: generation.getTime(),
        });
        expect(buildDeleteMachineUpdate('machine-1', 2, 'update-machine', generation).body).toEqual({
            t: 'delete-machine',
            machineId: 'machine-1',
            recordCreatedAt: generation.getTime(),
        });
        expect(buildDeleteArtifactUpdate('artifact-1', 3, 'update-artifact', generation).body).toEqual({
            t: 'delete-artifact',
            artifactId: 'artifact-1',
            recordCreatedAt: generation.getTime(),
        });
    });

    it('keeps the generation optional for rolling-upgrade compatibility', () => {
        expect(buildDeleteSessionUpdate('session-1', 1, 'update-session').body).not.toHaveProperty('recordCreatedAt');
        expect(buildDeleteMachineUpdate('machine-1', 2, 'update-machine').body).not.toHaveProperty('recordCreatedAt');
        expect(buildDeleteArtifactUpdate('artifact-1', 3, 'update-artifact').body).not.toHaveProperty('recordCreatedAt');
    });
});
