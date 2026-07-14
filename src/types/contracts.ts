import { z } from "zod";

export interface TestResult {
  success: boolean;
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
  /** Timing breakdown so daemon/worker overhead is observable (NFR7). Optional; added in Story 2.1. */
  metadata?: {
    wallClockMs: number;
    testExecMs: number;
    overheadMs: number;
  };
}

export interface TestPlan {
  planId: string;
  files: string[];
  reasoning: string;
  expiresAt: string;
}

// Placeholder schemas only in Story 1.0 — real validation lands in Story 1.2.
export const TestResultSchema = z.object({});

export const TestPlanSchema = z.object({});
