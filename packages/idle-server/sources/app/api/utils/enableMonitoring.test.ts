import { describe, expect, it } from "vitest";

import { getMetricsRoute } from "./enableMonitoring";

describe("getMetricsRoute", () => {
    it("uses a registered route template", () => {
        expect(getMetricsRoute({
            routeOptions: { url: "/v1/sessions/:id" },
            url: "/v1/sessions/private-session-id?include=messages"
        })).toBe("/v1/sessions/:id");
    });

    it("does not turn attacker-controlled 404 paths into metric labels", () => {
        expect(getMetricsRoute({
            routeOptions: undefined,
            url: "/unique-attacker-path/private-value"
        })).toBe("unmatched");
    });
});
