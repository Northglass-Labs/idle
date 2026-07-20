import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

type SessionRecord = {
    id: string;
    accountId: string;
    seq: number;
};

type MessageRecord = {
    id: string;
    sessionId: string;
    seq: number;
    localId: string | null;
    content: unknown;
    contentBytes: number;
    createdAt: Date;
    updatedAt: Date;
};

const encryptedFixture = (value: string): string => Buffer.from(value).toString('base64');

const {
    state,
    emitUpdateMock,
    dbMock,
    resetState,
    seedSession,
    seedMessage
} = vi.hoisted(() => {
    const state = {
        sessions: [] as SessionRecord[],
        messages: [] as MessageRecord[],
        accountSeqById: new Map<string, number>(),
        messageCountBySession: new Map<string, number>(),
        messageCountByAccount: new Map<string, number>(),
        messageBytesBySession: new Map<string, number>(),
        messageBytesByAccount: new Map<string, number>(),
        nextMessageId: 1,
        nowMs: 1700000000000
    };

    const resetState = () => {
        state.sessions = [];
        state.messages = [];
        state.accountSeqById = new Map<string, number>();
        state.messageCountBySession = new Map<string, number>();
        state.messageCountByAccount = new Map<string, number>();
        state.messageBytesBySession = new Map<string, number>();
        state.messageBytesByAccount = new Map<string, number>();
        state.nextMessageId = 1;
        state.nowMs = 1700000000000;
    };

    const seedSession = (input: Partial<SessionRecord> & Pick<SessionRecord, "id" | "accountId">) => {
        state.sessions.push({
            id: input.id,
            accountId: input.accountId,
            seq: input.seq ?? 0
        });
        if (!state.accountSeqById.has(input.accountId)) {
            state.accountSeqById.set(input.accountId, 0);
        }
    };

    const seedMessage = (input: {
        sessionId: string;
        seq: number;
        localId: string | null;
        content: unknown;
    }) => {
        const createdAt = new Date(state.nowMs);
        state.nowMs += 1;
        const msg: MessageRecord = {
            id: `seed-${state.nextMessageId}`,
            sessionId: input.sessionId,
            seq: input.seq,
            localId: input.localId,
            content: input.content,
            contentBytes: typeof (input.content as any)?.c === "string"
                ? Buffer.byteLength((input.content as any).c, "utf8")
                : 0,
            createdAt,
            updatedAt: createdAt
        };
        state.nextMessageId += 1;
        state.messages.push(msg);
    };

    const selectFields = <T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) => {
        if (!select) {
            return { ...row };
        }
        const picked: Record<string, unknown> = {};
        for (const [key, enabled] of Object.entries(select)) {
            if (enabled) {
                picked[key] = row[key];
            }
        }
        return picked;
    };

    const sessionFindFirst = vi.fn(async (args: any) => {
        const row = state.sessions.find((session) => (
            session.id === args?.where?.id &&
            session.accountId === args?.where?.accountId
        ));
        if (!row) {
            return null;
        }
        return selectFields(row as unknown as Record<string, unknown>, args?.select) as SessionRecord;
    });

    const sessionUpdate = vi.fn(async (args: any) => {
        const session = state.sessions.find((item) => item.id === args?.where?.id);
        if (!session) {
            throw new Error("Session not found");
        }
        const increment = args?.data?.seq?.increment ?? 0;
        session.seq += increment;
        return selectFields(session as unknown as Record<string, unknown>, args?.select);
    });

    const accountUpdate = vi.fn(async (args: any) => {
        const accountId = args?.where?.id as string;
        const current = state.accountSeqById.get(accountId) ?? 0;
        const increment = args?.data?.seq?.increment ?? 0;
        const next = current + increment;
        state.accountSeqById.set(accountId, next);
        return selectFields({ seq: next }, args?.select);
    });

    const sessionMessageFindMany = vi.fn(async (args: any) => {
        let rows = [...state.messages];

        if (args?.where?.sessionId) {
            rows = rows.filter((message) => message.sessionId === args.where.sessionId);
        }
        if (typeof args?.where?.seq?.gt === "number") {
            rows = rows.filter((message) => message.seq > args.where.seq.gt);
        }
        if (typeof args?.where?.seq?.lt === "number") {
            rows = rows.filter((message) => message.seq < args.where.seq.lt);
        }
        if (Array.isArray(args?.where?.localId?.in)) {
            const localIds = new Set(args.where.localId.in);
            rows = rows.filter((message) => localIds.has(message.localId));
        }
        if (Array.isArray(args?.where?.id?.in)) {
            const ids = new Set(args.where.id.in);
            rows = rows.filter((message) => ids.has(message.id));
        }
        if (args?.orderBy?.seq === "asc") {
            rows.sort((a, b) => a.seq - b.seq);
        }
        if (args?.orderBy?.seq === "desc") {
            rows.sort((a, b) => b.seq - a.seq);
        }
        if (args?.orderBy?.createdAt === "desc") {
            rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        if (typeof args?.take === "number") {
            rows = rows.slice(0, args.take);
        }

        return rows.map((row) => selectFields(row as unknown as Record<string, unknown>, args?.select));
    });

    const sessionMessageCreate = vi.fn(async (args: any) => {
        const createdAt = new Date(state.nowMs);
        state.nowMs += 1;
        const row: MessageRecord = {
            id: `msg-${state.nextMessageId}`,
            sessionId: args?.data?.sessionId,
            seq: args?.data?.seq,
            localId: args?.data?.localId ?? null,
            content: args?.data?.content,
            contentBytes: args?.data?.contentBytes ?? 0,
            createdAt,
            updatedAt: createdAt
        };
        state.nextMessageId += 1;
        state.messages.push(row);
        return selectFields(row as unknown as Record<string, unknown>, args?.select);
    });

    const sessionMessageCount = vi.fn(async (args: any) => {
        const sessionId = args?.where?.sessionId as string | undefined;
        if (sessionId) {
            return state.messageCountBySession.get(sessionId)
                ?? state.messages.filter((message) => message.sessionId === sessionId).length;
        }
        const accountId = args?.where?.session?.accountId as string | undefined;
        if (accountId) {
            return state.messageCountByAccount.get(accountId)
                ?? state.messages.filter((message) => state.sessions.some((session) => (
                    session.id === message.sessionId && session.accountId === accountId
                ))).length;
        }
        return state.messages.length;
    });

    const sessionMessageAggregate = vi.fn(async (args: any) => {
        const sessionId = args?.where?.sessionId as string | undefined;
        if (sessionId) {
            return {
                _sum: {
                    contentBytes: state.messageBytesBySession.get(sessionId)
                        ?? state.messages
                            .filter((message) => message.sessionId === sessionId)
                            .reduce((sum, message) => sum + message.contentBytes, 0),
                },
            };
        }
        const accountId = args?.where?.session?.accountId as string | undefined;
        return {
            _sum: {
                contentBytes: accountId === undefined
                    ? state.messages.reduce((sum, message) => sum + message.contentBytes, 0)
                    : state.messageBytesByAccount.get(accountId)
                        ?? state.messages
                            .filter((message) => state.sessions.some((session) => (
                                session.id === message.sessionId && session.accountId === accountId
                            )))
                            .reduce((sum, message) => sum + message.contentBytes, 0),
            },
        };
    });

    const txClient = {
        session: {
            findFirst: sessionFindFirst,
            update: sessionUpdate
        },
        sessionMessage: {
            findMany: sessionMessageFindMany,
            create: sessionMessageCreate,
            count: sessionMessageCount,
            aggregate: sessionMessageAggregate,
        },
        account: {
            update: accountUpdate
        }
    };

    const dbMock = {
        session: {
            findFirst: sessionFindFirst,
            update: sessionUpdate
        },
        account: {
            update: accountUpdate
        },
        sessionMessage: {
            findMany: sessionMessageFindMany,
            create: sessionMessageCreate,
            count: sessionMessageCount,
            aggregate: sessionMessageAggregate,
        },
        $transaction: vi.fn(async (fn: any) => fn(txClient))
    };

    const emitUpdateMock = vi.fn();

    return {
        state,
        emitUpdateMock,
        dbMock,
        resetState,
        seedSession,
        seedMessage
    };
});

// Use relative paths — tsconfig aliases don't resolve in vi.mock
vi.mock("../../../storage/db", () => ({
    db: dbMock
}));

vi.mock("../../../storage/inTx", () => ({
    inTx: vi.fn(async (fn: any) => dbMock.$transaction(fn)),
    afterTx: vi.fn()
}));

// Mock seq module to avoid transitive Prisma import (needs DATABASE_URL at load time)
vi.mock("../../../storage/seq", () => ({
    allocateUserSeq: vi.fn(async (accountId: string) => {
        const current = state.accountSeqById.get(accountId) ?? 0;
        const next = current + 1;
        state.accountSeqById.set(accountId, next);
        return next;
    }),
    allocateSessionSeq: vi.fn(async (sessionId: string) => {
        const session = state.sessions.find((s: any) => s.id === sessionId);
        if (!session) throw new Error("Session not found");
        session.seq += 1;
        return session.seq;
    }),
    allocateSessionSeqBatch: vi.fn(async (sessionId: string, count: number, _tx?: any) => {
        if (count <= 0) return [] as number[];
        const session = state.sessions.find((s: any) => s.id === sessionId);
        if (!session) throw new Error("Session not found");
        session.seq += count;
        const endSeq = session.seq;
        const startSeq = endSeq - count + 1;
        return Array.from({ length: count }, (_: any, i: number) => startSeq + i);
    })
}));

vi.mock("../../../utils/randomKeyNaked", () => ({
    randomKeyNaked: vi.fn(() => "update-id")
}));

vi.mock("../../events/eventRouter", () => ({
    eventRouter: {
        emitUpdate: emitUpdateMock
    },
    buildNewMessageUpdate: vi.fn((message: unknown, sessionId: string, updateSeq: number, updateId: string) => ({
        id: updateId,
        seq: updateSeq,
        body: {
            t: "new-message",
            sid: sessionId,
            message
        },
        createdAt: Date.now()
    }))
}));

import { v3SessionRoutes } from "./v3SessionRoutes";
import {
    MAX_MESSAGE_BYTES_PER_ACCOUNT,
    MAX_MESSAGE_BYTES_PER_SESSION,
    MAX_MESSAGES_PER_ACCOUNT,
    MAX_MESSAGES_PER_SESSION,
} from "../../limits/persistedResourceQuotas";
import { AUTHENTICATED_MESSAGE_BODY_LIMIT } from "../requestSecurity";

async function createApp() {
    // Match the production public-request limit. The authenticated message
    // ingestion route must opt into its compatibility allowance explicitly.
    const app = fastify({ bodyLimit: 1024 * 1024 });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    v3SessionRoutes(typed);
    await typed.ready();
    return typed;
}

describe("v3SessionRoutes", () => {
    let app: Fastify;

    beforeEach(() => {
        resetState();
        emitUpdateMock.mockClear();
    });

    afterEach(async () => {
        if (app) {
            await app.close();
        }
    });

    it("reads messages in seq order from the beginning", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        seedMessage({ sessionId: "session-1", seq: 2, localId: "l2", content: { t: "encrypted", c: "b" } });
        seedMessage({ sessionId: "session-1", seq: 1, localId: "l1", content: { t: "encrypted", c: "a" } });

        app = await createApp();
        const response = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.hasMore).toBe(false);
        expect(body.messages.map((message: any) => message.seq)).toEqual([1, 2]);
    });

    it("supports cursor pagination with hasMore", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        for (let seq = 1; seq <= 5; seq += 1) {
            seedMessage({ sessionId: "session-1", seq, localId: `l${seq}`, content: { t: "encrypted", c: String(seq) } });
        }

        app = await createApp();
        const page1 = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?after_seq=0&limit=2",
            headers: { "x-user-id": "user-1" }
        });
        const body1 = page1.json();
        expect(body1.messages.map((message: any) => message.seq)).toEqual([1, 2]);
        expect(body1.hasMore).toBe(true);

        const page2 = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?after_seq=2&limit=2",
            headers: { "x-user-id": "user-1" }
        });
        const body2 = page2.json();
        expect(body2.messages.map((message: any) => message.seq)).toEqual([3, 4]);
        expect(body2.hasMore).toBe(true);

        const page3 = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?after_seq=4&limit=2",
            headers: { "x-user-id": "user-1" }
        });
        const body3 = page3.json();
        expect(body3.messages.map((message: any) => message.seq)).toEqual([5]);
        expect(body3.hasMore).toBe(false);
    });

    it("supports backward pagination with before_seq returning newest first", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        for (let seq = 1; seq <= 5; seq += 1) {
            seedMessage({ sessionId: "session-1", seq, localId: `l${seq}`, content: { t: "encrypted", c: String(seq) } });
        }

        app = await createApp();
        // No before_seq cursor → ask for the latest page.
        // Use Number.MAX_SAFE_INTEGER as the upper bound so the server returns
        // the newest messages first without the client needing to know the
        // current max seq.
        const latest = await app.inject({
            method: "GET",
            url: `/v3/sessions/session-1/messages?before_seq=${Number.MAX_SAFE_INTEGER}&limit=2`,
            headers: { "x-user-id": "user-1" }
        });
        expect(latest.statusCode).toBe(200);
        const latestDatabaseQuery = dbMock.sessionMessage.findMany.mock.calls
            .slice()
            .reverse()
            .map((call: any[]) => call[0])
            .find((query: any) => query.select?.contentBytes === true && query.select?.content !== true);
        expect(latestDatabaseQuery.where).toEqual({ sessionId: "session-1" });
        expect(latestDatabaseQuery.select).not.toHaveProperty('content');
        const body1 = latest.json();
        expect(body1.messages.map((message: any) => message.seq)).toEqual([5, 4]);
        expect(body1.hasMore).toBe(true);

        // Cursor backward from the lowest seq returned in the previous page.
        const older = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?before_seq=4&limit=2",
            headers: { "x-user-id": "user-1" }
        });
        const body2 = older.json();
        expect(body2.messages.map((message: any) => message.seq)).toEqual([3, 2]);
        expect(body2.hasMore).toBe(true);

        // Final page: only seq=1 remains.
        const oldest = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?before_seq=2&limit=2",
            headers: { "x-user-id": "user-1" }
        });
        const body3 = oldest.json();
        expect(body3.messages.map((message: any) => message.seq)).toEqual([1]);
        expect(body3.hasMore).toBe(false);
    });

    it("rejects requests that combine after_seq and before_seq", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        seedMessage({ sessionId: "session-1", seq: 1, localId: "l1", content: { t: "encrypted", c: "a" } });

        app = await createApp();
        const response = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?after_seq=0&before_seq=10",
            headers: { "x-user-id": "user-1" }
        });
        expect(response.statusCode).toBe(400);
    });

    it("returns empty results for empty sessions and after_seq beyond latest", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        seedMessage({ sessionId: "session-1", seq: 1, localId: "l1", content: { t: "encrypted", c: "a" } });

        app = await createApp();
        const emptyResponse = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?after_seq=1",
            headers: { "x-user-id": "user-1" }
        });

        expect(emptyResponse.statusCode).toBe(200);
        const body = emptyResponse.json();
        expect(body.messages).toEqual([]);
        expect(body.hasMore).toBe(false);

        const farFutureResponse = await app.inject({
            method: "GET",
            url: `/v3/sessions/session-1/messages?after_seq=${Number.MAX_SAFE_INTEGER}`,
            headers: { "x-user-id": "user-1" }
        });
        expect(farFutureResponse.statusCode).toBe(200);
        expect(farFutureResponse.json()).toEqual({ messages: [], hasMore: false });
        const farFutureDatabaseQuery = dbMock.sessionMessage.findMany.mock.calls.at(-1)?.[0];
        expect(farFutureDatabaseQuery.where).toEqual({
            sessionId: "session-1",
            seq: { gt: 2_147_483_647 }
        });
    });

    it("enforces read query bounds and auth/session ownership", async () => {
        seedSession({ id: "session-1", accountId: "owner-user" });
        app = await createApp();

        const invalidLimit = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?limit=0",
            headers: { "x-user-id": "owner-user" }
        });
        expect(invalidLimit.statusCode).toBe(400);

        const tooLargeLimit = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?limit=501",
            headers: { "x-user-id": "owner-user" }
        });
        expect(tooLargeLimit.statusCode).toBe(400);

        const unauthorized = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages"
        });
        expect(unauthorized.statusCode).toBe(401);

        const wrongOwner = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "another-user" }
        });
        expect(wrongOwner.statusCode).toBe(404);
    });

    it("sends a single message and emits a new-message update", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [
                    { localId: "l1", content: encryptedFixture("enc-content-1") }
                ]
            }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].seq).toBe(1);
        expect(body.messages[0].localId).toBe("l1");

        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].content).toEqual({ t: "encrypted", c: encryptedFixture("enc-content-1") });
        expect(state.messages[0].contentBytes).toBe(Buffer.byteLength(encryptedFixture("enc-content-1"), "utf8"));
        expect(emitUpdateMock).toHaveBeenCalledTimes(1);
    });

    it("sends multiple messages with sequential seq numbers", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [
                    { localId: "l1", content: encryptedFixture("enc-1") },
                    { localId: "l2", content: encryptedFixture("enc-2") },
                    { localId: "l3", content: encryptedFixture("enc-3") }
                ]
            }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.messages.map((message: any) => message.seq)).toEqual([1, 2, 3]);
        expect(emitUpdateMock).toHaveBeenCalledTimes(3);
    });

    it("deduplicates by localId and returns mixed existing/new messages sorted by seq", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 1 });
        seedMessage({ sessionId: "session-1", seq: 1, localId: "existing", content: { t: "encrypted", c: "old" } });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [
                    { localId: "new-1", content: encryptedFixture("new-content") },
                    { localId: "existing", content: encryptedFixture("ignored") }
                ]
            }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.messages.map((message: any) => message.localId)).toEqual(["existing", "new-1"]);
        expect(body.messages.map((message: any) => message.seq)).toEqual([1, 2]);
        expect(state.messages).toHaveLength(2);
        expect(emitUpdateMock).toHaveBeenCalledTimes(1);
    });

    it("refuses new durable rows at the session or account cap but preserves idempotent retries", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 1 });
        seedMessage({
            sessionId: "session-1",
            seq: 1,
            localId: "existing",
            content: { t: "encrypted", c: encryptedFixture("existing") },
        });
        state.messageCountBySession.set("session-1", MAX_MESSAGES_PER_SESSION);

        app = await createApp();
        const sessionLimited = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [{ localId: "new-message", content: encryptedFixture("new") }]
            }
        });
        expect(sessionLimited.statusCode).toBe(429);
        expect(sessionLimited.json()).toMatchObject({ code: "MESSAGE_LIMIT_REACHED" });
        expect(state.messages).toHaveLength(1);

        const idempotent = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [{ localId: "existing", content: encryptedFixture("ignored") }]
            }
        });
        expect(idempotent.statusCode).toBe(200);
        expect(idempotent.json().messages).toHaveLength(1);

        state.messageCountBySession.delete("session-1");
        state.messageCountByAccount.set("user-1", MAX_MESSAGES_PER_ACCOUNT);
        const accountLimited = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [{ localId: "another-new-message", content: encryptedFixture("new") }]
            }
        });
        expect(accountLimited.statusCode).toBe(429);
        expect(accountLimited.json()).toMatchObject({ code: "MESSAGE_LIMIT_REACHED" });
        expect(state.messages).toHaveLength(1);
    });

    it("refuses new encrypted bytes at the session or account cap but preserves idempotent retries", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 1 });
        seedMessage({
            sessionId: "session-1",
            seq: 1,
            localId: "existing",
            content: { t: "encrypted", c: encryptedFixture("existing") },
        });
        state.messageBytesBySession.set("session-1", MAX_MESSAGE_BYTES_PER_SESSION);

        app = await createApp();
        const sessionLimited = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [{ localId: "new-message", content: encryptedFixture("new") }]
            }
        });
        expect(sessionLimited.statusCode).toBe(429);
        expect(sessionLimited.json()).toMatchObject({ code: "MESSAGE_LIMIT_REACHED", scope: "session" });
        expect(state.messages).toHaveLength(1);

        const idempotent = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [{ localId: "existing", content: encryptedFixture("ignored") }]
            }
        });
        expect(idempotent.statusCode).toBe(200);
        expect(idempotent.json().messages).toHaveLength(1);

        state.messageBytesBySession.delete("session-1");
        state.messageBytesByAccount.set("user-1", MAX_MESSAGE_BYTES_PER_ACCOUNT);
        const accountLimited = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [{ localId: "another-new-message", content: encryptedFixture("new") }]
            }
        });
        expect(accountLimited.statusCode).toBe(429);
        expect(accountLimited.json()).toMatchObject({ code: "MESSAGE_LIMIT_REACHED", scope: "account" });
        expect(state.messages).toHaveLength(1);
    });

    it("enforces send validation limits and auth/session ownership", async () => {
        seedSession({ id: "session-1", accountId: "owner-user" });
        app = await createApp();

        const emptyBatch = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "owner-user" },
            payload: { messages: [] }
        });
        expect(emptyBatch.statusCode).toBe(400);

        const overLimitBatch = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "owner-user" },
            payload: {
                messages: Array.from({ length: 101 }, (_, index) => ({
                    localId: `l-${index}`,
                    content: encryptedFixture(`enc-${index}`)
                }))
            }
        });
        expect(overLimitBatch.statusCode).toBe(400);

        const unauthorized = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            payload: {
                messages: [{ localId: "l1", content: encryptedFixture("enc-1") }]
            }
        });
        expect(unauthorized.statusCode).toBe(401);

        const wrongOwner = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "another-user" },
            payload: {
                messages: [{ localId: "l1", content: encryptedFixture("enc-1") }]
            }
        });
        expect(wrongOwner.statusCode).toBe(404);
    });

    it("accepts large encrypted message content up to the 4 MiB decoded cap (encrypted-content limit regression)", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        app = await createApp();

        const unauthenticatedLargePayload = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            payload: { messages: [{ localId: "l-unauth", content: "u".repeat(1024 * 1024) }] }
        });
        expect(unauthenticatedLargePayload.statusCode).toBe(401);

        // 100KB content — realistic mid-sized Claude tool output that was
        // rejected when the field reused EncryptedBlobSchema (64KB cap).
        const mediumContent = "x".repeat(100 * 1024);
        const mediumPayload = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: { messages: [{ localId: "l-medium", content: mediumContent }] }
        });
        expect(mediumPayload.statusCode).toBe(200);

        // 1MB content — large tool output (e.g., reading a big file). Must
        // pass with the new EncryptedMessageContentSchema bound.
        const largeContent = "y".repeat(1024 * 1024);
        const largePayload = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: { messages: [{ localId: "l-large", content: largeContent }] }
        });
        expect(largePayload.statusCode).toBe(200);

        // One decoded byte over 4 MiB must reject with 400
        // so a runaway payload still hits a defined boundary.
        const oversizedContent = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
        const oversizedPayload = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: { messages: [{ localId: "l-oversized", content: oversizedContent }] }
        });
        expect(oversizedPayload.statusCode).toBe(400);
    });

    it("rejects an authenticated message body above the reserved ingress ceiling before parsing", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        app = await createApp();

        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: {
                "content-type": "application/json",
                "x-user-id": "user-1",
            },
            payload: JSON.stringify({
                messages: [{ localId: "too-large", content: "x".repeat(AUTHENTICATED_MESSAGE_BODY_LIMIT) }],
            }),
        });

        expect(response.statusCode).toBe(413);
        expect(response.json()).toMatchObject({ code: "MESSAGE_BODY_LIMIT_REACHED" });
    });
});
