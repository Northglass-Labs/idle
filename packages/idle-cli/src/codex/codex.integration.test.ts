/**
 * Integration tests for Codex app-server session lifecycle.
 *
 * Drives `codex app-server` via the CodexAppServerClient — exercises the
 * permission reject → turn_aborted flow and per-turn model changes that
 * were impossible with the legacy MCP tools.
 *
 * Requirements:
 *   - `codex` CLI installed and on PATH (>= 0.144)
 *   - OPENAI_API_KEY (or equivalent) configured
 *   - IDLE_RUN_LIVE_AGENT_INTEGRATION=1
 *
 * Run:
 *   yarn test:integration:live
 */

import { afterEach, describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { CodexAppServerClient } from "./codexAppServerClient";
import type { ReviewDecision, EventMsg, ReasoningEffort } from "./codexAppServerTypes";
import { getIntegrationEnv } from "@/testing/currentIntegrationEnv";
import { shouldRunLiveAgentIntegration } from "@/testing/liveAgentIntegration";

// ── Helpers ──────────────────────────────────────────────────────────────────

// Keep the live fixture aligned with Idle's production defaults instead of
// inheriting the operator's Codex model/effort pair. A host-level effort can be
// valid for the host's default model while being rejected by this test model.
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_EFFORT: ReasoningEffort = "medium";
const MIN_CODEX_MINOR_WITH_DISPOSABLE_THREADS = 144;
const integrationEnv = getIntegrationEnv();

type PermissionPolicy = "approve" | "deny" | "cancel" | "hold";

function policyToDecision(policy: Exclude<PermissionPolicy, "hold">): ReviewDecision {
    switch (policy) {
        case "approve":
            return "approved";
        case "deny":
            return "denied";
        case "cancel":
            return "abort";
    }
}

async function isCodexAppServerAvailable(): Promise<boolean> {
    try {
        const version = execSync("codex --version", { encoding: "utf8" }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
        if (!match) return false;
        const [major, minor] = match[1].split(".").map(Number);
        return major > 0 || minor >= MIN_CODEX_MINOR_WITH_DISPOSABLE_THREADS;
    } catch {
        return false;
    }
}

// ── CodexDriver ──────────────────────────────────────────────────────────────

interface TurnResult {
    aborted: boolean;
    elapsed_ms: number;
}

interface CodexEvent {
    type: string;
    data: any;
}

/**
 * Thin wrapper around CodexAppServerClient for testing.
 * Tracks events, permissions, and provides a simple send/continue API.
 */
class CodexDriver {
    private client: CodexAppServerClient;
    private threadStarted = false;
    private deleteThreadOnClose = false;
    private heldApprovals: Array<(decision: ReviewDecision) => void> = [];

    events: CodexEvent[] = [];
    permissionPolicy: PermissionPolicy = "approve";
    permissionCount = 0;

    constructor() {
        this.client = new CodexAppServerClient();

        this.client.setEventHandler((msg: EventMsg) => {
            this.events.push({ type: msg.type, data: msg });
        });

        this.client.setApprovalHandler(async () => {
            this.permissionCount++;
            if (this.permissionPolicy === "hold") {
                return new Promise<ReviewDecision>((resolve) => {
                    this.heldApprovals.push(resolve);
                });
            }
            return policyToDecision(this.permissionPolicy);
        });
    }

    resolveHeldApprovals(decision: ReviewDecision): void {
        for (const resolve of this.heldApprovals) {
            resolve(decision);
        }
        this.heldApprovals = [];
    }

    /**
     * Interrupt the active turn. Unblock held approvals and send
     * turn/interrupt concurrently — codex may be blocked on the approval
     * callback and unable to process the interrupt until we respond.
     */
    async interrupt(): Promise<void> {
        this.resolveHeldApprovals("abort");
        await this.client.abortTurnWithFallback({
            gracePeriodMs: 5_000,
            forceRestartOnTimeout: true,
        });
    }

    async connect(): Promise<void> {
        await this.client.connect();
    }

    async restartBackendAndResume(): Promise<void> {
        if (!this.threadStarted) {
            throw new Error("No active thread — call send() first");
        }

        const resumed = await this.client.reconnectAndResumeThread();
        if (!resumed) {
            throw new Error("Expected reconnectAndResumeThread() to resume the existing thread");
        }
    }

    /** Start a new thread and send the first turn. */
    async send(
        prompt: string,
        opts?: {
            approvalPolicy?: string;
            sandbox?: string;
            cwd?: string;
            model?: string;
            effort?: ReasoningEffort;
            ephemeral?: boolean;
        }
    ): Promise<TurnResult> {
        if (!this.threadStarted) {
            const ephemeral = opts?.ephemeral ?? true;
            await this.client.startThread({
                model: opts?.model ?? DEFAULT_MODEL,
                cwd: opts?.cwd,
                approvalPolicy: opts?.approvalPolicy as any,
                sandbox: opts?.sandbox as any,
                ephemeral,
            });
            this.threadStarted = true;
            this.deleteThreadOnClose = !ephemeral;
        }

        const start = Date.now();
        const result = await this.client.sendTurnAndWait(prompt, {
            model: opts?.model,
            approvalPolicy: opts?.approvalPolicy as any,
            sandbox: opts?.sandbox as any,
            cwd: opts?.cwd,
            effort: opts?.effort ?? DEFAULT_EFFORT,
        });

        return {
            aborted: result.aborted,
            elapsed_ms: Date.now() - start,
        };
    }

    /** Continue an existing thread with a new turn. */
    async continue(
        prompt: string,
        opts?: {
            model?: string;
            timeout?: number;
            approvalPolicy?: string;
            sandbox?: string;
            effort?: ReasoningEffort;
        }
    ): Promise<TurnResult> {
        if (!this.threadStarted) {
            throw new Error("No active thread — call send() first");
        }

        const start = Date.now();
        const result = await this.client.sendTurnAndWait(prompt, {
            model: opts?.model,
            approvalPolicy: opts?.approvalPolicy as any,
            sandbox: opts?.sandbox as any,
            effort: opts?.effort ?? DEFAULT_EFFORT,
        });

        return {
            aborted: result.aborted,
            elapsed_ms: Date.now() - start,
        };
    }

    getMessages(): string[] {
        return this.events
            .filter((e) => e.type === "agent_message")
            .map((e) => e.data?.message ?? "")
            .filter(Boolean);
    }

    hasEvent(type: string): boolean {
        return this.events.some((e) => e.type === type);
    }

    clearEvents(): void {
        this.events = [];
        this.permissionCount = 0;
    }

    async close(): Promise<void> {
        try {
            if (this.deleteThreadOnClose && this.client.threadId) {
                await this.client.deleteThread({ threadId: this.client.threadId });
            }
        } finally {
            await this.client.disconnect();
        }
    }
}

function expectTerminalEventMatchesResult(driver: CodexDriver, result: TurnResult): void {
    const terminalEvents = driver.events
        .map((event) => event.type)
        .filter((type) => type === "task_complete" || type === "turn_aborted");
    const expectedTerminalEvent = result.aborted ? "turn_aborted" : "task_complete";

    expect(
        terminalEvents,
        `Expected ${expectedTerminalEvent}; observed event types: ${driver.events.map((event) => event.type).join(", ")}`,
    ).toEqual([expectedTerminalEvent]);
}

// ── Tests ────────────────────────────────────────────────────────────────────

const codexAvailable = shouldRunLiveAgentIntegration() && await isCodexAppServerAvailable();

it("keeps the isolated environment eligible for teardown", () => {
    expect(integrationEnv.projectPath).toBeTruthy();
});

it("requires a compatible Codex app-server when live integration is explicitly enabled", () => {
    expect(shouldRunLiveAgentIntegration()).toBe(true);
    expect(codexAvailable).toBe(true);
});

describe.skipIf(
    !codexAvailable,
)(
    "Codex Integration (app-server)",
    { timeout: 180_000 },
    () => {
        let driver: CodexDriver | null = null;

        afterEach(async () => {
            if (driver) {
                await driver.close();
                driver = null;
            }
        });

        it("should terminate safely after permission cancel", async () => {
            driver = new CodexDriver();
            await driver.connect();

            driver.permissionPolicy = "cancel";
            const result = await driver.send(
                'This is an automated Idle integration test. Create /tmp/idle-codex-cancel-test.txt with the text "hello".',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath }
            );

            // Provider behavior after a cancelled approval is intentionally not
            // prescribed: Codex may stop the turn or let the model explain the
            // denial. Idle must surface exactly one matching terminal event.
            expect(result.elapsed_ms).toBeLessThan(30_000);
            expect(driver.permissionCount).toBeGreaterThan(0);
            expectTerminalEventMatchesResult(driver, result);
        });

        it("should preserve context when continuing after cancel", async () => {
            driver = new CodexDriver();
            await driver.connect();

            // Turn 1: establish context with a mundane phrase
            driver.permissionPolicy = "approve";
            const firstTurn = await driver.send(
                'This is an automated Idle integration test. The test marker is "idle-codex-cancel-context". Repeat only that marker. Do NOT use tools or run commands.',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath }
            );
            expect(firstTurn.aborted).toBe(false);
            expect(driver.getMessages().join(" ").toLowerCase()).toContain("idle-codex-cancel-context");

            // Turn 2: permission cancellation can either abort the provider turn
            // or complete after the model observes the denial. Both are safe as
            // long as Idle emits the matching terminal event exactly once.
            driver.clearEvents();
            driver.permissionPolicy = "cancel";
            const r2 = await driver.continue(
                'Create /tmp/idle-codex-cancel-context.txt with the text "test". Use a shell command.',
                { approvalPolicy: "on-request", sandbox: "read-only" }
            );
            expectTerminalEventMatchesResult(driver, r2);

            // Turn 3: Codex must remember the project name from turn 1
            driver.clearEvents();
            driver.permissionPolicy = "approve";
            await driver.continue(
                "What automated Idle test marker did I mention earlier? Reply with just the marker."
            );

            const text = driver.getMessages().join(" ").toLowerCase();
            expect(text).toContain("idle-codex-cancel-context");
        });

        it("should abort turn via interruptTurn while permission is pending", async () => {
            driver = new CodexDriver();
            await driver.connect();

            // Hold permissions — simulates user not responding to approval
            driver.permissionPolicy = "hold";

            const turnPromise = driver.send(
                'This is an automated Idle integration test. Create /tmp/idle-codex-interrupt-test.txt with the text "hello" using a shell command.',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath }
            );

            // Wait for a permission request to arrive
            const deadline = Date.now() + 30_000;
            while (driver.permissionCount === 0 && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(driver.permissionCount).toBeGreaterThan(0);

            // Simulate the web app abort button: abort held approvals + interrupt turn.
            // Codex v2: approval cancel = decline, model may finish before interrupt
            // lands. The key invariant: the turn must NOT hang.
            await driver.interrupt();

            const result = await turnPromise;
            expect(result.elapsed_ms).toBeLessThan(30_000);
        });

        it("should preserve context after backend reconnect and thread/resume", async () => {
            driver = new CodexDriver();
            await driver.connect();

            driver.permissionPolicy = "approve";
            await driver.send(
                'This is an automated Idle integration test. The persistent reconnect marker is "idle-codex-persistent-resume". Repeat only that marker. Do NOT use tools or run commands.',
                {
                    approvalPolicy: "on-request",
                    sandbox: "read-only",
                    cwd: integrationEnv.projectPath,
                    ephemeral: false,
                }
            );
            expect(driver.getMessages().join(" ").toLowerCase()).toContain("idle-codex-persistent-resume");

            driver.clearEvents();
            await driver.restartBackendAndResume();

            driver.clearEvents();
            await driver.continue(
                "What automated Idle persistent reconnect marker did I mention earlier? Reply with just the marker."
            );

            const text = driver.getMessages().join(" ").toLowerCase();
            expect(text).toContain("idle-codex-persistent-resume");
        });

        it("should preserve context when continuing after interruptTurn abort", async () => {
            driver = new CodexDriver();
            await driver.connect();

            // Turn 1: establish context with a mundane phrase
            driver.permissionPolicy = "approve";
            await driver.send(
                'This is an automated Idle integration test. The interrupt marker is "idle-codex-interrupt-context". Repeat only that marker. Do NOT use tools or run commands.',
                { approvalPolicy: "on-request", sandbox: "read-only", cwd: integrationEnv.projectPath }
            );
            expect(driver.getMessages().join(" ").toLowerCase()).toContain("idle-codex-interrupt-context");

            // Turn 2: hold permission, then abort via interruptTurn
            driver.clearEvents();
            driver.permissionPolicy = "hold";

            const abortedTurn = driver.continue(
                'Run this exact shell command: printf "test" > /tmp/idle-codex-interrupt-context.txt',
                { approvalPolicy: "on-request", sandbox: "read-only" }
            );

            const deadline = Date.now() + 30_000;
            while (driver.permissionCount === 0 && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(driver.permissionCount).toBeGreaterThan(0);

            // Codex v2: cancel = decline, model may finish normally before
            // interrupt lands. The important thing is it doesn't hang.
            await driver.interrupt();
            const r2 = await abortedTurn;
            expect(r2.elapsed_ms).toBeLessThan(30_000);

            // Turn 3: context must be preserved — Codex should remember the project name
            driver.clearEvents();
            driver.permissionPolicy = "approve";
            await driver.continue(
                "What automated Idle interrupt marker did I mention earlier? Reply with just the marker."
            );

            const text = driver.getMessages().join(" ").toLowerCase();
            expect(text).toContain("idle-codex-interrupt-context");
        });
    }
);
