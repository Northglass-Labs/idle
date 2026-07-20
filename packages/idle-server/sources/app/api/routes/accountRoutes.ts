import { eventRouter, buildUpdateAccountUpdate } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { Fastify } from "../types";
import { getPublicUrl } from "@/storage/files";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import { EncryptedMetadataSchema } from "@/app/api/routes/_schemas";
import { accountDelete } from "@/app/account/accountDelete";
import {
    MAX_USAGE_REPORTS_PER_QUERY,
    USAGE_COST_FIELDS,
    USAGE_TOKEN_FIELDS,
    UsageQuerySchema,
    UsageReportDataSchema,
} from "../usagePolicy";

export function accountRoutes(app: Fastify) {
    // Permanently delete the authenticated account and all of its data.
    // Required by App Store Guideline 5.1.1(v) — in-app account deletion.
    app.post('/v1/account/delete', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({ success: z.boolean() })
            }
        }
    }, async (request, reply) => {
        const deleted = await accountDelete({ uid: request.userId });
        return reply.send({ success: deleted });
    });

    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const user = await db.account.findUniqueOrThrow({
            where: { id: userId },
            select: {
                firstName: true,
                lastName: true,
                username: true,
                avatar: true,
                githubUser: true
            }
        });
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null,
            github: user.githubUser ? user.githubUser.profile : null
        });
    });

    // Get Account Settings API
    app.get('/v1/account/settings', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    settings: EncryptedMetadataSchema.nullable(),
                    settingsVersion: z.number()
                }),
                500: z.object({
                    error: z.literal('Failed to get account settings')
                })
            }
        }
    }, async (request, reply) => {
        try {
            const user = await db.account.findUnique({
                where: { id: request.userId },
                select: { settings: true, settingsVersion: true }
            });

            if (!user) {
                return reply.code(500).send({ error: 'Failed to get account settings' });
            }

            return reply.send({
                settings: user.settings,
                settingsVersion: user.settingsVersion
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get account settings' });
        }
    });

    // Update Account Settings API
    app.post('/v1/account/settings', {
        schema: {
            body: z.object({
                settings: EncryptedMetadataSchema.nullable(),
                expectedVersion: z.number().int().min(0)
            }),
            response: {
                200: z.union([z.object({
                    success: z.literal(true),
                    version: z.number()
                }), z.object({
                    success: z.literal(false),
                    error: z.literal('version-mismatch'),
                    currentVersion: z.number(),
                    currentSettings: EncryptedMetadataSchema.nullable()
                })]),
                500: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update account settings')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { settings, expectedVersion } = request.body;

        try {
            // Get current user data for version check
            const currentUser = await db.account.findUnique({
                where: { id: userId },
                select: { settings: true, settingsVersion: true }
            });

            if (!currentUser) {
                return reply.code(500).send({
                    success: false,
                    error: 'Failed to update account settings'
                });
            }

            // Check current version
            if (currentUser.settingsVersion !== expectedVersion) {
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: currentUser.settingsVersion,
                    currentSettings: currentUser.settings
                });
            }

            // Update settings with version check
            const { count } = await db.account.updateMany({
                where: {
                    id: userId,
                    settingsVersion: expectedVersion
                },
                data: {
                    settings: settings,
                    settingsVersion: expectedVersion + 1,
                    updatedAt: new Date()
                }
            });

            if (count === 0) {
                // Re-fetch to get current version
                const account = await db.account.findUnique({
                    where: { id: userId }
                });
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: account?.settingsVersion || 0,
                    currentSettings: account?.settings || null
                });
            }

            // Generate update for connected clients
            const updSeq = await allocateUserSeq(userId);
            const settingsUpdate = {
                value: settings,
                version: expectedVersion + 1
            };

            // Send account update to user-scoped connections only
            const updatePayload = buildUpdateAccountUpdate(userId, { settings: settingsUpdate }, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                success: true,
                version: expectedVersion + 1
            });
        } catch {
            log({ module: 'api', level: 'error' }, 'Failed to update account settings');
            return reply.code(500).send({
                success: false,
                error: 'Failed to update account settings'
            });
        }
    });

    app.post('/v1/usage/query', {
        schema: {
            body: UsageQuerySchema,
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, startTime, endTime, groupBy } = request.body;
        const actualGroupBy = groupBy || 'day';

        try {
            // Build query conditions
            const where: {
                accountId: string;
                sessionId?: string;
                createdAt?: {
                    gte?: Date;
                    lte?: Date;
                };
            } = {
                accountId: userId
            };

            if (sessionId) {
                // Verify session belongs to user
                const session = await db.session.findFirst({
                    where: {
                        id: sessionId,
                        accountId: userId
                    }
                });
                if (!session) {
                    return reply.code(404).send({ error: 'Session not found' });
                }
                where.sessionId = sessionId;
            }

            if (
                (startTime !== null && startTime !== undefined)
                || (endTime !== null && endTime !== undefined)
            ) {
                where.createdAt = {};
                if (startTime !== null && startTime !== undefined) {
                    where.createdAt.gte = new Date(startTime * 1000);
                }
                if (endTime !== null && endTime !== undefined) {
                    where.createdAt.lte = new Date(endTime * 1000);
                }
            }

            // Fetch usage reports
            const reports = await db.usageReport.findMany({
                where,
                select: {
                    createdAt: true,
                    data: true,
                },
                orderBy: {
                    createdAt: 'desc'
                },
                // The schema permits at most one row per retained session. Read
                // one extra so a pre-migration/externally-corrupt database
                // fails closed instead of materializing or truncating silently.
                take: MAX_USAGE_REPORTS_PER_QUERY + 1,
            });
            if (reports.length > MAX_USAGE_REPORTS_PER_QUERY) {
                return reply.code(409).send({ error: 'Usage query exceeds retained report limit' });
            }

            // Aggregate data by time period
            const aggregated = new Map<string, {
                tokens: PrismaJson.UsageReportData['tokens'];
                cost: PrismaJson.UsageReportData['cost'];
                count: number;
                timestamp: number;
            }>();
            let validReportCount = 0;

            for (const report of reports) {
                // A migrated database enforces the same fixed shape and byte
                // cap. Keep the read boundary fail-closed for mocked, legacy,
                // or externally modified rows as well.
                const parsed = UsageReportDataSchema.safeParse(report.data);
                if (!parsed.success) continue;
                const data = parsed.data;
                validReportCount++;

                const bucketSeconds = actualGroupBy === 'hour' ? 60 * 60 : 24 * 60 * 60;
                const timestamp = Math.floor(
                    report.createdAt.getTime() / 1000 / bucketSeconds,
                ) * bucketSeconds;

                const key = timestamp.toString();

                if (!aggregated.has(key)) {
                    aggregated.set(key, {
                        tokens: {
                            total: 0,
                            input: 0,
                            output: 0,
                            cache_creation: 0,
                            cache_read: 0,
                        },
                        cost: { total: 0, input: 0, output: 0 },
                        count: 0,
                        timestamp
                    });
                }

                const agg = aggregated.get(key)!;
                agg.count++;

                for (const tokenKey of USAGE_TOKEN_FIELDS) {
                    agg.tokens[tokenKey] += data.tokens[tokenKey];
                }
                for (const costKey of USAGE_COST_FIELDS) {
                    agg.cost[costKey] += data.cost[costKey];
                }
            }

            // Convert to array and sort by timestamp
            const result = Array.from(aggregated.values())
                .map(data => ({
                    timestamp: data.timestamp,
                    tokens: data.tokens,
                    cost: data.cost,
                    reportCount: data.count
                }))
                .sort((a, b) => a.timestamp - b.timestamp);

            return reply.send({
                usage: result,
                groupBy: actualGroupBy,
                totalReports: validReportCount
            });
        } catch {
            log({ module: 'api', level: 'error' }, 'Failed to query usage reports');
            return reply.code(500).send({ error: 'Failed to query usage reports' });
        }
    });
}
