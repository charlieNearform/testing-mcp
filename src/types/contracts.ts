import { z } from "zod";

/**
 * How confident selection is that the tests it ran fully cover the changes (Story 6.8).
 * `high` = provably complete (a full run, only-test-file changes, or all changed sources mapped);
 * `degraded` = bounded but not provably complete (an unmapped source, a deletion we can't bound,
 * or no coverage map), with `reasons` naming each cause so the agent can run a full pass.
 * Single source of truth — the Selection Engine and orchestrator import this shape.
 */
export interface Confidence {
  level: "high" | "degraded";
  reasons: string[];
}

/** Percentage coverage across the four V8/istanbul metrics (Story 6.3). */
export interface CoveragePct {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

export interface TestResult {
  success: boolean;
  /** One-line, failure-forward summary for cheap agent consumption (Story 4.3). */
  summary: string;
  duration: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: Array<{
    id: string;
    name: string;
    file: string;
    message: string;
  }>;
  selection: {
    strategy: "full" | "incremental";
    reason: string;
    files: string[];
  };
  /** Selection confidence (Story 6.8). Optional/additive — absent on runs that predate the signal. */
  confidence?: Confidence;
  /**
   * Every test case that ran, by outcome (Story 6.1) — for the UI run-detail view. Passing/skipped
   * entries carry only `{ name, file, status }` (no message/stack; those stay in `failures`).
   * Optional/additive and bounded (see `testsTruncated`).
   */
  tests?: Array<{ name: string; file: string; status: "passed" | "failed" | "skipped" }>;
  /** True when `tests` was capped and no longer lists every case (Story 6.1). */
  testsTruncated?: boolean;
  /**
   * Coverage report for a `coverage: true` run — overall + per-file percentages
   * (statements/branches/functions/lines). Absent on plain runs (coverage is only measured when
   * requested) and when no coverage provider is present. As of Story 6.10 this is the COMBINED
   * (whole-project) picture: the union of every test file's latest measurement, so an incremental
   * run reports whole-project coverage without re-running everything. `combined` marks that; each
   * file carries `fresh` (re-measured this run) / `stale` (source changed since measured); and
   * `confidence` is `degraded` when a changed source is unmeasured (Story 6.8) so "100%" is only
   * asserted at `high` confidence.
   */
  coverage?: {
    total: CoveragePct;
    files: Array<{ file: string; fresh?: boolean; stale?: boolean } & CoveragePct>;
    combined?: boolean;
    confidence?: Confidence;
    /**
     * The project's own configured global Vitest coverage % thresholds (Story 6.3 AC4) — test-mcp
     * reports them, it does not invent its own. Only the global numeric-% form is surfaced.
     */
    thresholds?: Partial<CoveragePct>;
    /**
     * Whether the combined coverage meets every configured threshold (Story 6.3 AC4). Only asserted
     * (true/false) when `confidence` is `high`; `undefined` on a `degraded` report means "numbers may
     * be stale — run a full coverage pass to confirm the gate" rather than a false verdict.
     */
    thresholdsMet?: boolean;
  };
  /** Timing breakdown so daemon/worker overhead is observable (NFR7). Optional; added in Story 2.1. */
  metadata?: {
    wallClockMs: number;
    testExecMs: number;
    overheadMs: number;
    /** Resolved Vitest per-file isolation for this run (Story 2.3). */
    isolate: boolean;
  };
}

/** Full detail for a single failure, returned on demand by get_failure_details (Story 2.2). */
export interface FailureDetail {
  id: string;
  name: string;
  file: string;
  message: string;
  stack?: string;
  expected?: string;
  actual?: string;
  diff?: string;
}

export interface TestPlan {
  planId: string;
  projectId: string;
  strategy: "full" | "incremental";
  /** Concrete test files to run; empty means "determined at run time" (full suite or git --changed). */
  files: string[];
  reasoning: string;
  /** Selection confidence for this plan (Story 6.8), so a dry-run preview surfaces the verdict too. */
  confidence?: Confidence;
  createdAt: string;
  expiresAt: string;
  metadata: {
    /** Time to compute the plan; recorded for NFR1 tuning (not a hard gate). */
    latencyMs: number;
  };
}

// Placeholder schemas only in Story 1.0 — real validation lands in Story 1.2.
export const TestResultSchema = z.object({});

export const TestPlanSchema = z.object({});

/**
 * Shape of `<project.path>/.test-mcp/config.json`. `defaultRunWaitMs` (Story 8.3/8.6) is an
 * optional per-project override for run_tests's async grace period -- absent unless a user
 * hand-edits the file; `null` means "wait forever" for this project specifically. Single source
 * of truth for both the CLI writer (src/cli/main.ts) and the MCP reader (src/mcp/server.ts).
 */
export const ProjectLocalConfigSchema = z.object({
  schemaVersion: z.number(),
  projectId: z.string(),
  stateDir: z.string(),
  defaultRunWaitMs: z.number().nullable().optional(),
});

export type ProjectLocalConfig = z.infer<typeof ProjectLocalConfigSchema>;
