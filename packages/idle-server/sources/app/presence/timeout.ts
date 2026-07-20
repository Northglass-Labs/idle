import { db } from "@/storage/db";
import { delay } from "@/utils/delay";
import { forever } from "@/utils/forever";
import { shutdownSignal } from "@/utils/shutdown";
import { buildMachineActivityEphemeral, buildSessionActivityEphemeral, eventRouter } from "@/app/events/eventRouter";

export interface PresenceTimeoutDependencies {
    db: {
        machine: Pick<typeof db.machine, 'findMany' | 'updateManyAndReturn'>;
        session: Pick<typeof db.session, 'findMany' | 'updateManyAndReturn'>;
    };
    delay: typeof delay;
    forever: typeof forever;
    shutdownSignal: AbortSignal;
    buildMachineActivityEphemeral: typeof buildMachineActivityEphemeral;
    buildSessionActivityEphemeral: typeof buildSessionActivityEphemeral;
    eventRouter: Pick<typeof eventRouter, 'emitEphemeral'>;
}

const defaultDependencies: PresenceTimeoutDependencies = {
    db,
    delay,
    forever,
    shutdownSignal,
    buildMachineActivityEphemeral,
    buildSessionActivityEphemeral,
    eventRouter,
};

export const PRESENCE_TIMEOUT_BATCH_SIZE = 500;

export function startTimeout(dependencies: PresenceTimeoutDependencies = defaultDependencies) {
    dependencies.forever('session-timeout', async () => {
        // Find timed out sessions
        const sessions = await dependencies.db.session.findMany({
            where: {
                active: true,
                lastActiveAt: {
                    lte: new Date(Date.now() - 1000 * 60 * 10) // 10 minutes
                }
            },
            orderBy: { lastActiveAt: 'asc' },
            take: PRESENCE_TIMEOUT_BATCH_SIZE,
            select: { id: true, accountId: true, lastActiveAt: true },
        });
        for (const session of sessions) {
            const updated = await dependencies.db.session.updateManyAndReturn({
                where: { id: session.id, active: true },
                data: { active: false }
            });
            if (updated.length === 0) {
                continue;
            }
            dependencies.eventRouter.emitEphemeral({
                userId: session.accountId,
                payload: dependencies.buildSessionActivityEphemeral(session.id, false, updated[0].lastActiveAt.getTime(), false),
                recipientFilter: { type: 'user-scoped-only' }
            });
        }

        // Find timed out machines
        const machines = await dependencies.db.machine.findMany({
            where: {
                active: true,
                lastActiveAt: {
                    lte: new Date(Date.now() - 1000 * 60 * 10) // 10 minutes
                }
            },
            orderBy: { lastActiveAt: 'asc' },
            take: PRESENCE_TIMEOUT_BATCH_SIZE,
            select: { id: true, accountId: true, lastActiveAt: true },
        });
        for (const machine of machines) {
            const updated = await dependencies.db.machine.updateManyAndReturn({
                where: { id: machine.id, active: true },
                data: { active: false }
            });
            if (updated.length === 0) {
                continue;
            }
            dependencies.eventRouter.emitEphemeral({
                userId: machine.accountId,
                payload: dependencies.buildMachineActivityEphemeral(machine.id, false, updated[0].lastActiveAt.getTime()),
                recipientFilter: { type: 'user-scoped-only' }
            });
        }

        // Wait for 1 minute before the outer shutdown-aware loop schedules the next pass.
        await dependencies.delay(1000 * 60, dependencies.shutdownSignal);
    });
}
