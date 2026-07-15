import * as fs from "node:fs";
import * as path from "node:path";
import libCoverage from "istanbul-lib-coverage";
import { isTestFile } from "./index.js";
import type { Confidence, CoveragePct } from "../types/contracts.js";

/**
 * Combined incremental coverage (Story 6.10).
 *
 * An incremental run only re-measures a subset of test files, so its own coverage can't describe
 * the whole project. This module persists each test file's LATEST coverage (the istanbul-shaped
 * `coverage-final.json` the map build already produces — captured, not re-run) in a file separate
 * from the reverse map (so the map that selection reads stays small), and merges the latest
 * measurement of every test file into a whole-project picture via `istanbul-lib-coverage` — a
 * line-hit union, so two tests each covering different halves of a file combine to full coverage.
 *
 * Honesty (Story 6.8 confidence): each test records the content hash of every source it measured.
 * A source is STALE when any contributing test measured a version different from the file on disk
 * now (an edit since measurement, or two tests that measured different versions) — the combined
 * number for it can't be trusted, so it's flagged and the report reports `degraded` confidence.
 */

export const COVERAGE_DATA_SCHEMA_VERSION = 1;

/** Raw `coverage-final.json` content (istanbul-shaped, absolute-path keyed). Treated as opaque. */
export type IstanbulCoverageData = Record<string, unknown>;

/** One test file's latest measurement: its coverage data + the source hashes at measurement time. */
export interface TestCoverage {
  measuredAt: string;
  /** Project-relative source file -> content hash when this test measured it (staleness key). */
  sourceHashes: Record<string, string>;
  data: IstanbulCoverageData;
}

export interface CoverageDataFile {
  schemaVersion: number;
  projectId: string;
  updatedAt: string;
  /** Per-test-file latest coverage (the merge inputs), keyed by project-relative test file. */
  tests: Record<string, TestCoverage>;
}

/** A combined per-file coverage row: percentages plus freshness/staleness flags. */
export interface CombinedFile extends CoveragePct {
  file: string;
  /** Re-measured in the current run (vs carried from an earlier baseline). */
  fresh?: boolean;
  /** A contributing test measured a different version than the file on disk — % is untrustworthy. */
  stale?: boolean;
}

export interface CombinedCoverage {
  total: CoveragePct;
  files: CombinedFile[];
  /** Marks this as the union-of-latest whole-project report (vs a single-run summary). */
  combined: true;
  /** `degraded` when a changed source is unmeasured in the combined set (Story 6.8). */
  confidence: Confidence;
  /** The project's configured global % thresholds, if any (Story 6.3 AC4). */
  thresholds?: Partial<CoveragePct>;
  /** Met verdict — only set (true/false) at `high` confidence; undefined when degraded. */
  thresholdsMet?: boolean;
}

const METRICS = ["statements", "branches", "functions", "lines"] as const;

/**
 * Extract the project's GLOBAL numeric-% coverage thresholds from a Vitest `coverage.thresholds`
 * config (Story 6.3 AC4). Handles the plain metric form (`{ lines: 90, ... }`) and the `100: true`
 * shorthand ("require 100% everywhere"). Per-glob thresholds, `perFile`, `autoUpdate`, and negative
 * (absolute-count) thresholds are intentionally NOT surfaced — we report only what we can compare to
 * the combined percentages, rather than invent a verdict. Returns null when there's no global % form.
 */
export function parseGlobalThresholds(raw: unknown): Partial<CoveragePct> | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (t["100"] === true) return { statements: 100, branches: 100, functions: 100, lines: 100 };
  const out: Partial<CoveragePct> = {};
  for (const m of METRICS) {
    const v = t[m];
    // Positive 0–100 is a percentage target; a negative value is a max-uncovered-count (skipped).
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) out[m] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** True when `total` meets every configured threshold. */
export function meetsThresholds(total: CoveragePct, thresholds: Partial<CoveragePct>): boolean {
  return METRICS.every((m) => thresholds[m] === undefined || total[m] >= (thresholds[m] as number));
}

/** Cap the confidence reason list so a large refactor can't bloat the result/UI unboundedly. */
const MAX_CONFIDENCE_REASONS = 20;

export function coverageDataPath(projectRoot: string): string {
  return path.join(projectRoot, ".test-mcp", "coverage-data.json");
}

/** Load persisted per-test coverage data, or null if absent/unreadable/wrong schema. */
export function loadCoverageData(projectRoot: string): CoverageDataFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(coverageDataPath(projectRoot), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CoverageDataFile;
    if (
      parsed?.schemaVersion !== COVERAGE_DATA_SCHEMA_VERSION ||
      typeof parsed.tests !== "object" ||
      parsed.tests === null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Persist per-test coverage data atomically (temp file + rename). */
export function saveCoverageData(projectRoot: string, file: CoverageDataFile): void {
  const target = coverageDataPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file));
  fs.renameSync(tmp, target);
}

/**
 * Refresh the persisted data for the test files measured this run: replace their coverage, carry
 * every other test file's coverage forward, and drop entries for test files that no longer exist
 * (`existsTest`) — so a deleted/renamed test's stale coverage stops inflating the combined report.
 */
export function updateCoverageData(
  existing: CoverageDataFile | null,
  projectId: string,
  now: string,
  measured: Record<string, TestCoverage>,
  existsTest: (testRel: string) => boolean,
): CoverageDataFile {
  const tests: Record<string, TestCoverage> = {};
  for (const [testRel, tc] of Object.entries(existing?.tests ?? {})) {
    if (existsTest(testRel)) tests[testRel] = tc; // carry forward only live test files
  }
  for (const [testRel, tc] of Object.entries(measured)) {
    tests[testRel] = { ...tc, measuredAt: now };
  }
  return {
    schemaVersion: COVERAGE_DATA_SCHEMA_VERSION,
    projectId,
    updatedAt: now,
    tests,
  };
}

/** Project-relative source files (incl. zero-hit) in one test's coverage data, excluding tests/deps. */
export function coveredSourceFiles(data: IstanbulCoverageData, projectRoot: string): string[] {
  const out: string[] = [];
  for (const abs of Object.keys(data)) {
    const rel = path.relative(projectRoot, abs);
    if (isOutOfReport(rel)) continue;
    out.push(rel);
  }
  return out;
}

/** Files excluded from the combined report: out-of-tree, node_modules, and test files. */
function isOutOfReport(rel: string): boolean {
  return (
    rel.startsWith("..") ||
    path.isAbsolute(rel) || // Windows: different drive -> path.relative returns an absolute path
    rel.split(path.sep).includes("node_modules") ||
    isTestFile(rel)
  );
}

/** Coerce an istanbul pct (0–100) to a finite number; a non-numeric sentinel becomes 0. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Merge every test file's latest coverage into a whole-project report. `currentHashes` are the
 * present content hashes of the source files. A source is `stale` when a contributing test measured
 * a version whose hash differs from the current one (or the file is gone). `freshSources` were
 * re-measured this run. Returns null when there is no coverage data to combine.
 */
export function combineCoverage(
  dataFile: CoverageDataFile,
  projectRoot: string,
  currentHashes: Record<string, string>,
  freshSources: ReadonlySet<string>,
  rawThresholds?: unknown,
): CombinedCoverage | null {
  const entries = Object.values(dataFile.tests);
  if (entries.length === 0) return null;

  // The set of source-version hashes each source was measured at, across all contributing tests.
  const measuredHashes: Record<string, Set<string>> = {};
  for (const tc of entries) {
    for (const [src, h] of Object.entries(tc.sourceHashes ?? {})) {
      (measuredHashes[src] ??= new Set<string>()).add(h);
    }
  }

  const map = libCoverage.createCoverageMap({});
  for (const tc of entries) {
    try {
      map.merge(tc.data as libCoverage.CoverageMapData);
    } catch (err) {
      // A corrupt/partial entry must not poison the whole report — skip it, loud on stderr.
      process.stderr.write(
        `[test-mcp] skipping unmergeable coverage entry: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  const total = libCoverage.createCoverageSummary();
  const files: CombinedFile[] = [];
  const staleSources: string[] = [];
  for (const abs of map.files()) {
    const rel = path.relative(projectRoot, abs) || abs;
    if (isOutOfReport(rel)) continue;
    const summary = map.fileCoverageFor(abs).toSummary();
    total.merge(summary);
    // Stale when the current file differs from every/any version a contributing test measured,
    // or the file is gone (no current hash), or we never recorded a measurement hash for it.
    const versions = measuredHashes[rel];
    const current = currentHashes[rel];
    const stale = current === undefined || !versions || [...versions].some((h) => h !== current);
    if (stale) staleSources.push(rel);
    files.push({
      file: rel,
      statements: num(summary.data.statements.pct),
      branches: num(summary.data.branches.pct),
      functions: num(summary.data.functions.pct),
      lines: num(summary.data.lines.pct),
      ...(freshSources.has(rel) && !stale ? { fresh: true } : {}),
      ...(stale ? { stale: true } : {}),
    });
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  staleSources.sort();
  const reasons = staleSources
    .slice(0, MAX_CONFIDENCE_REASONS)
    .map((s) => `source changed since its coverage was measured — run a full coverage pass: ${s}`);
  if (staleSources.length > MAX_CONFIDENCE_REASONS) {
    reasons.push(`…and ${staleSources.length - MAX_CONFIDENCE_REASONS} more stale source(s)`);
  }
  const confidence: Confidence = staleSources.length
    ? { level: "degraded", reasons }
    : { level: "high", reasons: [] };

  const totalPct: CoveragePct = {
    statements: num(total.data.statements.pct),
    branches: num(total.data.branches.pct),
    functions: num(total.data.functions.pct),
    lines: num(total.data.lines.pct),
  };

  // Threshold gate (AC4): report the project's global % thresholds and whether they're met — but
  // only ASSERT met/failed at high confidence; when degraded, leave it undefined ("run a full pass").
  const thresholds = parseGlobalThresholds(rawThresholds) ?? undefined;
  const thresholdsMet =
    thresholds && confidence.level === "high" ? meetsThresholds(totalPct, thresholds) : undefined;

  return {
    total: totalPct,
    files,
    combined: true,
    confidence,
    ...(thresholds ? { thresholds } : {}),
    ...(thresholdsMet !== undefined ? { thresholdsMet } : {}),
  };
}
