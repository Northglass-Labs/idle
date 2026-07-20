import { Socket } from "socket.io";
import { AsyncLock } from "@/utils/lock";
import { db } from "@/storage/db";
import { buildUsageEphemeral, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import type { ClientConnection } from "@/app/events/eventRouter";
import { onAuthorizedSocketEvent } from "./socketScope";
import {
    MAX_USAGE_REPORT_DATA_BYTES,
    USAGE_REPORT_KEY,
    UsageReportPayloadSchema,
    usageReportRateLimiter,
} from "../usagePolicy";

const INVALID_USAGE_REPORT_ERROR = 'Invalid usage report';
const USAGE_REPORT_RATE_LIMIT_ERROR = 'Usage report rate limit exceeded';

export function usageHandler(userId: string, socket: Socket, connection: ClientConnection) {
    const receiveUsageLock = new AsyncLock();
    onAuthorizedSocketEvent(socket, connection, 'usage-report', async (data: unknown, callback?: (response: any) => void) => {
        // Consume the account-wide budget before parsing or entering the
        // serialized database path. Opening sibling sockets cannot multiply it.
        if (!usageReportRateLimiter.allow(userId)) {
            callback?.({ success: false, error: USAGE_REPORT_RATE_LIMIT_ERROR });
            return;
        }

        const parsed = UsageReportPayloadSchema.safeParse(data);
        if (!parsed.success) {
            callback?.({ success: false, error: INVALID_USAGE_REPORT_ERROR });
            return;
        }
        const usageData: PrismaJson.UsageReportData = {
            tokens: parsed.data.tokens,
            cost: parsed.data.cost,
        };
        if (Buffer.byteLength(JSON.stringify(usageData), 'utf8') > MAX_USAGE_REPORT_DATA_BYTES) {
            callback?.({ success: false, error: INVALID_USAGE_REPORT_ERROR });
            return;
        }

        await receiveUsageLock.inLock(async () => {
            try {
                // The handshake and central socket guard already proved this is
                // the exact authenticated session. The unique session key and
                // composite foreign key keep the same invariant in storage.
                const report = await db.usageReport.upsert({
                    where: {
                        sessionId: parsed.data.sessionId,
                        accountId: userId,
                    },
                    update: {
                        data: usageData,
                        updatedAt: new Date(),
                    },
                    create: {
                        accountId: userId,
                        sessionId: parsed.data.sessionId,
                        key: USAGE_REPORT_KEY,
                        data: usageData,
                    },
                });

                log({ module: 'websocket' }, 'Usage report saved');

                const usageEvent = buildUsageEphemeral(
                    parsed.data.sessionId,
                    USAGE_REPORT_KEY,
                    usageData.tokens,
                    usageData.cost,
                );
                eventRouter.emitEphemeral({
                    userId,
                    payload: usageEvent,
                    recipientFilter: { type: 'user-scoped-only' },
                });

                callback?.({
                    success: true,
                    reportId: report.id,
                    createdAt: report.createdAt.getTime(),
                    updatedAt: report.updatedAt.getTime(),
                });
            } catch {
                // Database errors can include identifiers or serialized values;
                // keep diagnostics and the client response value-free.
                log({ module: 'websocket', level: 'error' }, 'Failed to save usage report');
                callback?.({ success: false, error: 'Failed to save usage report' });
            }
        });
    });
}
