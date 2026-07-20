import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => {
    const dbMock = {
        account: { count: vi.fn() },
        session: { count: vi.fn() },
        sessionMessage: { count: vi.fn() },
        machine: { count: vi.fn() },
        $queryRaw: vi.fn()
    };

    return { dbMock };
});

// Use relative paths — tsconfig aliases don't resolve in vi.mock (vitest 4)
vi.mock("../../storage/db", () => ({
    db: dbMock
}));

import { getMetricsLabelsFromRequest, updateDatabaseMetrics } from "./metrics2";

describe("client metric labels", () => {
    it("uses only a fixed-cardinality client family label", () => {
        expect(getMetricsLabelsFromRequest({
            headers: { "x-happy-client": "cli-coding-session/0.4.13" }
        })).toEqual({
            client: "cli-coding-session",
            client_type: "cli-coding-session"
        });
    });

    it("collapses attacker-controlled and multi-value headers to unknown", () => {
        expect(getMetricsLabelsFromRequest({
            headers: { "x-happy-client": "attacker-controlled/unique-value" }
        })).toEqual({ client: "unknown", client_type: "unknown" });
        expect(getMetricsLabelsFromRequest({
            headers: { "x-happy-client": ["ios/0.4.0", "web/0.4.0"] }
        })).toEqual({ client: "unknown", client_type: "unknown" });
    });
});

describe("updateDatabaseMetrics", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.account.count.mockResolvedValue(10);
        dbMock.session.count.mockResolvedValue(20);
        dbMock.sessionMessage.count.mockResolvedValue(30);
        dbMock.machine.count.mockResolvedValue(40);
        dbMock.$queryRaw.mockResolvedValue([{ estimated_count: 123n }]);
    });

    it("uses estimated counts instead of exact table counts", async () => {
        await updateDatabaseMetrics();

        expect(dbMock.account.count).not.toHaveBeenCalled();
        expect(dbMock.session.count).not.toHaveBeenCalled();
        expect(dbMock.sessionMessage.count).not.toHaveBeenCalled();
        expect(dbMock.machine.count).not.toHaveBeenCalled();
        expect(dbMock.$queryRaw).toHaveBeenCalledTimes(4);

        const queriedTables = dbMock.$queryRaw.mock.calls.map((call) => call[1]);
        expect(queriedTables).toEqual(['"Account"', '"Session"', '"SessionMessage"', '"Machine"']);
    });
});
