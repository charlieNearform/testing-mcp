import { TestResult } from "./contracts.js";

// Placeholder in Story 1.0 — real shape defined with the Coverage Engine (Epic 2).
export type CoverageDelta = Record<string, unknown>;

export type ToWorker =
  | { type: "run"; runId: string; files: string[]; coverage: boolean; allTestsRun: boolean }
  | { type: "cancel"; runId: string }
  | { type: "shutdown" };

export type FromWorker =
  | { type: "ready" }
  | { type: "progress"; runId: string; completed: number; total: number }
  | { type: "result"; runId: string; result: TestResult; coverageDelta?: CoverageDelta }
  | { type: "error"; runId: string; message: string; stack?: string };
