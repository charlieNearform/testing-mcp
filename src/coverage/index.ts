import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Coverage Engine — builds and persists a source-file -> test-file reverse map
 * from runtime V8 coverage (Story 3.2).
 *
 * The map answers "which test files exercise this source file?" so a source edit
 * can be resolved to the tests that cover it. It is NOT produced by a standard
 * coverage report (which is aggregate, not per-test); it is built by measuring
 * each test file's coverage and attributing the source files it executed.
 *
 * This story uses per-test-file measurement (one Vitest run per test file), which
 * the coverage spike proved correct. Single-pass V8 snapshot-diffing (same
 * accuracy, lower cost) is a deferred performance optimisation — see
 * deferred-work.md. Setup-baseline subtraction (Story 3.3) and unmeasurable-test
 * handling (Story 3.4) build on this map.
 *
 * The pure map operations here take a `measure` callback so the module has no
 * Vitest coupling and is unit-testable; the worker supplies the real measurer.
 */

export const COVERAGE_MAP_SCHEMA_VERSION = 2;

export interface CoverageMapEntry {
  /** Test files (relative to the project root) that executed this source file. */
  tests: string[];
  /** ISO timestamp of the most recent measurement contributing to this entry. */
  lastMeasured: string;
}

export interface CoverageMapFile {
  schemaVersion: number;
  /** Keyed by projectId so the map is unambiguous even if the file is copied. */
  projectId: string;
  updatedAt: string;
  /** sourceFile (relative to project root) -> attribution. */
  map: Record<string, CoverageMapEntry>;
  /** Source files reached only via setupFiles — a change to any selects the whole suite (Story 3.5). */
  fullSuiteTriggers: string[];
}

export interface MeasurementSummary {
  /** Test files whose coverage was successfully attributed this build. */
  measuredTestFiles: number;
  /** Test files that produced no coverage (timeout/crash/no output). */
  unmeasuredTestFiles: string[];
  /** Total source files present in the resulting map. */
  sourceFilesMapped: number;
  /** True when this build updated an existing map rather than creating one. */
  incremental: boolean;
}

/** One test file's measured attribution: the source files it executed. */
export interface FileMeasurement {
  /** Source files (relative to project root) with executed statements. */
  sources: string[];
  /** False if the file could not be measured (no coverage produced). */
  measured: boolean;
}

export function coverageMapPath(projectRoot: string): string {
  return path.join(projectRoot, ".test-mcp", "coverage-map.json");
}

/** Load a persisted map, or null if absent/unreadable/wrong schema. */
export function loadCoverageMap(projectRoot: string): CoverageMapFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(coverageMapPath(projectRoot), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CoverageMapFile;
    if (parsed?.schemaVersion !== COVERAGE_MAP_SCHEMA_VERSION || typeof parsed.map !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Persist a map atomically-ish (write then rename) under the project's .test-mcp dir. */
export function saveCoverageMap(projectRoot: string, file: CoverageMapFile): void {
  const target = coverageMapPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, target);
}

/** Deep-copy the edge map so a build never mutates the caller's loaded object. */
function cloneMap(map: Record<string, CoverageMapEntry>): Record<string, CoverageMapEntry> {
  const out: Record<string, CoverageMapEntry> = {};
  for (const [src, entry] of Object.entries(map)) {
    out[src] = { tests: [...entry.tests], lastMeasured: entry.lastMeasured };
  }
  return out;
}

/** Remove every edge attributing a source to any of `testRels` (for incremental re-measure). */
function pruneTests(map: Record<string, CoverageMapEntry>, testRels: ReadonlySet<string>): void {
  for (const src of Object.keys(map)) {
    const kept = map[src].tests.filter((t) => !testRels.has(t));
    if (kept.length === 0) delete map[src];
    else map[src].tests = kept;
  }
}

/** Attribute one test file's executed source files into the map. */
function addEdges(
  map: Record<string, CoverageMapEntry>,
  testRel: string,
  sourceRels: readonly string[],
  now: string,
): void {
  for (const src of sourceRels) {
    const entry = (map[src] ??= { tests: [], lastMeasured: now });
    if (!entry.tests.includes(testRel)) {
      entry.tests.push(testRel);
      entry.tests.sort();
    }
    entry.lastMeasured = now;
  }
}

export interface BuildInput {
  projectRoot: string;
  projectId: string;
  /** Absolute paths of the test files to measure this build. */
  targetTestFiles: string[];
  /** Existing map to update incrementally, or null to build fresh. */
  existing: CoverageMapFile | null;
  /** Measure one test file's coverage. Supplied by the worker (Vitest-backed). */
  measure: (absTestFile: string) => Promise<FileMeasurement>;
  /** Source files (relative) reached purely by setupFiles; subtracted from every test's attribution. */
  baseline: string[];
}

/**
 * Build or incrementally update the reverse coverage map.
 *
 * Full build (`existing === null`): measures every target and creates the map.
 * Incremental (`existing` provided): drops the old edges for the target test
 * files, re-measures only those, and preserves all other edges — so a change to
 * a few test files does not force re-measuring the whole suite.
 */
export async function buildCoverageMap(
  input: BuildInput,
): Promise<{ file: CoverageMapFile; summary: MeasurementSummary }> {
  const now = new Date().toISOString();
  const incremental = input.existing != null;
  const map = incremental ? cloneMap(input.existing!.map) : {};

  const targetRels = input.targetTestFiles.map((f) => path.relative(input.projectRoot, f));
  // Incremental: forget prior attribution for the files we're about to re-measure,
  // so removed dependencies disappear instead of lingering.
  if (incremental) {
    pruneTests(map, new Set(targetRels));
    // Also drop any edges that are now baseline-only: remove baseline sources from the whole map
    // so a module promoted to the baseline stops appearing as a per-test edge.
    for (const src of input.baseline) delete map[src];
  }

  const baselineSet = new Set(input.baseline);

  const unmeasured: string[] = [];
  for (const abs of input.targetTestFiles) {
    const rel = path.relative(input.projectRoot, abs);
    const m = await input.measure(abs);
    if (!m.measured) {
      unmeasured.push(rel);
      continue;
    }
    // Subtract the baseline from each measured file's sources before adding edges.
    const attributed = m.sources.filter((s) => !baselineSet.has(s));
    addEdges(map, rel, attributed, now);
  }

  const file: CoverageMapFile = {
    schemaVersion: COVERAGE_MAP_SCHEMA_VERSION,
    projectId: input.projectId,
    updatedAt: now,
    map,
    fullSuiteTriggers: [...new Set(input.baseline)].sort(),
  };
  return {
    file,
    summary: {
      measuredTestFiles: input.targetTestFiles.length - unmeasured.length,
      unmeasuredTestFiles: unmeasured,
      sourceFilesMapped: Object.keys(map).length,
      incremental,
    },
  };
}

/**
 * Turn a V8 `coverage-final.json` (Istanbul-shaped, absolute-path keyed) into the
 * set of project source files with at least one executed statement. Excludes the
 * measured test file itself, other test files, node_modules, and out-of-tree files.
 */
export function extractCoveredSources(
  coverageFinal: Record<string, { s?: Record<string, number> }>,
  projectRoot: string,
  measuredTestAbs: string,
): string[] {
  const measuredRel = path.relative(projectRoot, measuredTestAbs);
  const sources = new Set<string>();
  for (const [absPath, entry] of Object.entries(coverageFinal)) {
    const rel = path.relative(projectRoot, absPath);
    if (rel.startsWith("..") || rel.split(path.sep).includes("node_modules")) continue;
    if (rel === measuredRel) continue;
    if (isTestFile(rel)) continue;
    const counts = entry.s ? Object.values(entry.s) : [];
    if (counts.some((c) => c > 0)) sources.add(rel);
  }
  return [...sources].sort();
}

function isTestFile(rel: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) ||
    rel.split(path.sep).includes("__tests__")
  );
}
