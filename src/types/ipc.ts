import { z } from "zod";
import { TestResult, FailureDetail } from "./contracts.js";

// Placeholder in Story 1.0 — real shape defined with the Coverage Engine (Epic 2).
export type CoverageDelta = Record<string, unknown>;

export type ToWorker =
  | {
      type: "run";
      runId: string;
      projectId: string;
      files: string[];
      coverage: boolean;
      allTestsRun: boolean;
      changed: boolean;
    }
  | { type: "cancel"; runId: string }
  | { type: "shutdown" };

export type FromWorker =
  | { type: "ready" }
  | { type: "progress"; runId: string; completed: number; total: number }
  // testTimeoutMs is optional so a pool-start-retry heartbeat (Story: vitest-pool worker-start
  // retry) can resend `config` purely to reset the orchestrator's stall watchdog even when no
  // real testTimeout is known yet -- armWatchdog() already treats an absent value as "just
  // reset the timer, don't touch the effective one," so this is additive, not a behavior change
  // for the original (testTimeoutMs-bearing) use of this message.
  | { type: "config"; runId: string; testTimeoutMs?: number }
  | { type: "case-start"; runId: string; file: string; name: string }
  | {
      type: "case-result";
      runId: string;
      file: string;
      name: string;
      status: "passed" | "failed" | "skipped";
    }
  | {
      type: "phase-progress";
      runId: string;
      phase: "coverage";
      completed: number;
      total: number;
    }
  | {
      type: "result";
      runId: string;
      result: TestResult;
      coverageDelta?: CoverageDelta;
      failureDetails?: FailureDetail[];
    }
  | { type: "error"; runId: string; message: string; stack?: string };

// --- Runtime validation at the fork() IPC boundary (CLAUDE.md: validate all IPC messages). ---
// These schemas validate the message ENVELOPE crossing the process edge and reject garbage
// so a malformed/version-skewed message can never corrupt daemon state. The nested test
// `result` is validated on the fields the daemon actually reads (passthrough for the rest);
// the authoritative TestResult *type* remains defined in contracts.ts.

const resultShape = z
  .object({
    success: z.boolean(),
    summary: z.string(),
    duration: z.number(),
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    failures: z.array(z.object({}).passthrough()),
    selection: z.object({}).passthrough(),
    // Per-test detail (Story 6.1) — optional/additive. `.catch(undefined)` so a malformed entry
    // degrades to "no detail" instead of rejecting the whole run result (correctness over cleverness).
    tests: z
      .array(
        z.object({
          name: z.string(),
          file: z.string(),
          status: z.enum(["passed", "failed", "skipped"]),
        }),
      )
      .optional()
      .catch(undefined),
    // Coverage summary (Story 6.3) — optional/additive; `.catch(undefined)` so a malformed report
    // degrades to "no coverage" rather than rejecting the whole run.
    coverage: z
      .object({
        total: z.object({}).passthrough(),
        files: z.array(z.object({}).passthrough()),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

const ToWorkerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run"),
    runId: z.string(),
    projectId: z.string(),
    files: z.array(z.string()),
    coverage: z.boolean(),
    allTestsRun: z.boolean(),
    changed: z.boolean(),
  }),
  z.object({ type: z.literal("cancel"), runId: z.string() }),
  z.object({ type: z.literal("shutdown") }),
]);

const FromWorkerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("progress"),
    runId: z.string(),
    completed: z.number(),
    total: z.number(),
  }),
  z.object({
    type: z.literal("config"),
    runId: z.string(),
    testTimeoutMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("case-start"),
    runId: z.string(),
    file: z.string(),
    name: z.string(),
  }),
  z.object({
    type: z.literal("case-result"),
    runId: z.string(),
    file: z.string(),
    name: z.string(),
    status: z.enum(["passed", "failed", "skipped"]),
  }),
  z.object({
    type: z.literal("phase-progress"),
    runId: z.string(),
    phase: z.literal("coverage"),
    completed: z.number(),
    total: z.number(),
  }),
  z.object({
    type: z.literal("result"),
    runId: z.string(),
    result: resultShape,
    coverageDelta: z.record(z.string(), z.unknown()).optional(),
    failureDetails: z.array(z.object({ id: z.string() }).passthrough()).optional(),
  }),
  z.object({
    type: z.literal("error"),
    runId: z.string(),
    message: z.string(),
    stack: z.string().optional(),
  }),
]);

/** Validate a message received by the worker; throws if malformed. */
export function parseToWorker(raw: unknown): ToWorker {
  return ToWorkerSchema.parse(raw) as ToWorker;
}

/** Validate a message received by the daemon from a worker; throws if malformed. */
export function parseFromWorker(raw: unknown): FromWorker {
  return FromWorkerSchema.parse(raw) as FromWorker;
}
