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
