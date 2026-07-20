import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";
// Cross-package contract check: the app's real update schema. apiTypes.ts is
// pure zod (no react-native / @/ aliases), so it imports cleanly in node.
import { ApiUpdateContainerSchema } from "../../../../../idle-app/sources/sync/apiTypes";

const {
    state,
    dbMock,
    resetState,
    allocateUserSeqMock,
    emitUpdateSpy,
    emitEphemeralSpy,
    disconnectMachineConnectionsSpy,
} = vi.hoisted(() => {
    const emitUpdateSpy = vi.fn();
    const emitEphemeralSpy = vi.fn();
    const disconnectMachineConnectionsSpy = vi.fn().mockResolvedValue(undefined);
    const state = {
        existingMachine: null as any,
        created: [] as any[],
        seq: 0,
    };

    const resetState = () => {
        state.existingMachine = null;
        state.created = [];
        state.seq = 0;
    };

    const machineFindFirst = vi.fn(async () => state.existingMachine);
    const machineCreate = vi.fn(async (args: any) => {
        // Mirror a Prisma Machine row: server defaults active=false on create
        // ("Default to offline - in case the user does not start daemon").
        const now = new Date("2026-01-01T00:00:00.000Z");
        const row = {
            id: args.data.id,
            accountId: args.data.accountId,
            seq: 7,
            metadata: args.data.metadata,
            metadataVersion: args.data.metadataVersion ?? 1,
            daemonState: args.data.daemonState ?? null,
            daemonStateVersion: args.data.daemonStateVersion ?? 0,
            dataEncryptionKey: args.data.dataEncryptionKey ?? null,
            active: false,
            lastActiveAt: now,
            createdAt: now,
            updatedAt: now,
        };
        state.created.push(row);
        return row;
    });

    const dbMock = {
        machine: {
            findFirst: machineFindFirst,
            count: vi.fn(async () => state.created.length),
            create: machineCreate,
            delete: vi.fn(async () => ({})),
        },
        accessKey: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    };
    const allocateUserSeqMock = vi.fn(async () => ++state.seq);

    return {
        state,
        dbMock,
        resetState,
        allocateUserSeqMock,
        emitUpdateSpy,
        emitEphemeralSpy,
        disconnectMachineConnectionsSpy,
    };
});

// Keep the REAL event-builder functions (buildNewMachineUpdate etc.), but
// replace the eventRouter singleton with a spy so we can capture exactly what
// the create handler emits.
// Use relative paths — tsconfig aliases don't resolve in vi.mock (vitest 4)
vi.mock("../../events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    return {
        ...actual,
        eventRouter: {
            emitUpdate: emitUpdateSpy,
            emitEphemeral: emitEphemeralSpy,
            disconnectMachineConnections: disconnectMachineConnectionsSpy,
        },
    };
});
vi.mock("../../../storage/db", () => ({ db: dbMock }));
vi.mock("../../../storage/seq", () => ({ allocateUserSeq: allocateUserSeqMock }));
vi.mock("../../../storage/inTx", () => ({ inTx: async (fn: any) => fn(dbMock), afterTx: (_tx: any, cb: () => void) => cb() }));
vi.mock("../../../utils/log", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { machinesRoutes } from "./machinesRoutes";

async function createApp() {
    const app = fastify();
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
    machinesRoutes(typed);
    await typed.ready();
    return typed;
}

function findEmit(t: string) {
    return emitUpdateSpy.mock.calls.find(([p]) => p?.payload?.body?.t === t)?.[0];
}

describe("machinesRoutes — POST /v1/machines creation emits", () => {
    let app: Fastify;
    beforeEach(() => {
        resetState();
        allocateUserSeqMock.mockClear();
        emitUpdateSpy.mockClear();
        emitEphemeralSpy.mockClear();
        disconnectMachineConnectionsSpy.mockReset();
        disconnectMachineConnectionsSpy.mockResolvedValue(undefined);
    });
    afterEach(async () => { if (app) await app.close(); });

    it("emits new-machine to the user's app AND a key-less update-machine companion", async () => {
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: { "x-user-id": "user-1" },
            payload: {
                id: "machine-1",
                metadata: "encrypted-metadata-blob",
                dataEncryptionKey: Buffer.from("the-data-key").toString("base64"),
            },
        });
        expect(res.statusCode).toBe(200);

        const newMachine = findEmit("new-machine");
        const updateMachine = findEmit("update-machine");

        // Both updates are emitted on creation.
        expect(newMachine).toBeDefined();
        expect(updateMachine).toBeDefined();

        // new-machine is the signal the user's app gets to LEARN about the
        // machine, and it carries the per-machine data encryption key.
        expect(newMachine.recipientFilter).toEqual({ type: "user-scoped-only" });
        expect(newMachine.payload.body.dataEncryptionKey).toBeTruthy();

        // The update-machine companion ALSO reaches the app (machine-scoped-only
        // resolves to a union that includes the user-scoped room), but it carries
        // NO data encryption key, so the app cannot initialize a brand-new
        // machine from this event alone. The new-machine event is required.
        expect(updateMachine.recipientFilter).toEqual({ type: "machine-scoped-only", machineId: "machine-1" });
        expect(updateMachine.payload.body).not.toHaveProperty("dataEncryptionKey");
    });

    it("emits a new-machine update that validates against the app's update schema (the fix accepts the real payload)", async () => {
        app = await createApp();

        await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: { "x-user-id": "user-1" },
            payload: {
                id: "machine-2",
                metadata: "encrypted-metadata-blob",
                dataEncryptionKey: Buffer.from("the-data-key").toString("base64"),
            },
        });

        const newMachine = findEmit("new-machine");
        expect(newMachine).toBeDefined();

        // The exact container the server pushes over the 'update' socket event —
        // this is what Sync.handleUpdate runs ApiUpdateContainerSchema.safeParse()
        // on. The new-machine member must validate at this exact boundary.
        const parsed = ApiUpdateContainerSchema.safeParse(newMachine.payload);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body.t).toBe("new-machine");
        }
    });

    it("emits a new-machine update that also validates when there is no data encryption key", async () => {
        app = await createApp();

        await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: { "x-user-id": "user-1" },
            payload: { id: "machine-3", metadata: "encrypted-metadata-blob" },
        });

        const newMachine = findEmit("new-machine");
        expect(newMachine).toBeDefined();
        expect(newMachine.payload.body.dataEncryptionKey).toBeNull();
        expect(ApiUpdateContainerSchema.safeParse(newMachine.payload).success).toBe(true);
    });

    it("allocates the delete update sequence inside the machine deletion transaction", async () => {
        app = await createApp();
        state.existingMachine = {
            id: 'machine-delete-1',
            accountId: 'user-1',
            createdAt: new Date(0),
        };

        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/machines/machine-delete-1',
            headers: { 'x-user-id': 'user-1' },
        });

        expect(res.statusCode).toBe(200);
        expect(allocateUserSeqMock).toHaveBeenCalledWith('user-1', dbMock);
        expect(findEmit('delete-machine')).toBeDefined();
        expect(dbMock.machine.delete.mock.invocationCallOrder[0])
            .toBeLessThan(disconnectMachineConnectionsSpy.mock.invocationCallOrder[0]);
        expect(disconnectMachineConnectionsSpy).toHaveBeenCalledWith('user-1', 'machine-delete-1');
    });

    it('sweeps the machine room on an idempotent retry when the row is already absent', async () => {
        app = await createApp();

        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/machines/machine-missing-1',
            headers: { 'x-user-id': 'user-1' },
        });

        expect(res.statusCode).toBe(404);
        expect(disconnectMachineConnectionsSpy).toHaveBeenCalledWith('user-1', 'machine-missing-1');
    });

    it('does not report deletion success when the adapter room sweep fails', async () => {
        app = await createApp();
        state.existingMachine = {
            id: 'machine-delete-2',
            accountId: 'user-1',
            createdAt: new Date(0),
        };
        disconnectMachineConnectionsSpy.mockRejectedValueOnce(new Error('adapter unavailable'));

        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/machines/machine-delete-2',
            headers: { 'x-user-id': 'user-1' },
        });

        expect(res.statusCode).toBe(500);
        expect(dbMock.machine.delete).toHaveBeenCalledWith({ where: { id: 'machine-delete-2' } });
    });
});
