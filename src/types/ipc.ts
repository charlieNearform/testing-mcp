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
