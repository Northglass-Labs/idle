import { describe, expect, it } from "vitest";
import { isStandaloneEntrypoint, requireValidStandaloneSecret } from "./standalone";

describe("isStandaloneEntrypoint", () => {
    it("recognizes standalone script paths on Windows and POSIX", () => {
        expect(isStandaloneEntrypoint("C:\\Projects\\Work\\idle\\packages\\idle-server\\sources\\standalone.ts")).toBe(true);
        expect(isStandaloneEntrypoint("/repo/packages/idle-server/sources/standalone.ts")).toBe(true);
        expect(isStandaloneEntrypoint("/repo/packages/idle-server/bin/idle-server.cjs")).toBe(true);
        expect(isStandaloneEntrypoint("/repo/packages/idle-server/dist/idle-server")).toBe(true);
        expect(isStandaloneEntrypoint("C:\\repo\\packages\\idle-server\\dist\\idle-server.exe")).toBe(true);
    });

    it("rejects unrelated entrypoints", () => {
        expect(isStandaloneEntrypoint("C:\\repo\\node_modules\\vitest\\vitest.mjs")).toBe(false);
        expect(isStandaloneEntrypoint("/repo/packages/idle-server/sources/main.ts")).toBe(false);
    });
});

describe("standalone boot secret guard", () => {
    it("rejects weak or placeholder secrets before migrate or serve starts", () => {
        for (const secret of [undefined, "change-me", "a".repeat(32), "z".repeat(64)]) {
            expect(() => requireValidStandaloneSecret(secret)).toThrow(/IDLE_MASTER_SECRET/);
        }
    });

    it("accepts the canonical 32-byte hexadecimal form", () => {
        const secret = "a0".repeat(32);
        expect(requireValidStandaloneSecret(secret)).toBe(secret);
    });
});
