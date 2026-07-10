#!/usr/bin/env node
// Coverage-map de-risking spike for the MCP Test Runner.
//
// Goal: prove we can build a source-file -> test-file reverse map from V8
// coverage using a *project's own* Vitest, and measure the cost + selection
// benefit on a real repo. Writes ALL output into this (spike host) repo; makes
// no source changes in the target repo.
//
// Approach (naive, per-file): run each test file on its own with
// `coverage.all=false` and read the resulting coverage-final.json. Every source
// file with >0 executed statements is attributed to that test file. This is the
// pessimistic-cost baseline; the production design uses single-pass V8 snapshot
// diffing (faster). Accuracy of the resulting map is identical.
//
// Usage:
//   node build-map.mjs --target <frontendDir> [--limit N] [--filter substr] [--baseline]

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const TARGET = resolve(args.target || `${process.env.HOME}/code/example-app/frontend`);
const OUT = resolve(args.out || join(process.cwd(), 'spike/coverage-map/out'));
const LIMIT = args.limit ? Number(args.limit) : 20;
const FILTER = args.filter || null;
const RUN_BASELINE = !!args.baseline;

const COV_TMP = join(OUT, 'cov'); // per-test-file coverage-final.json lands here (in THIS repo)
mkdirSync(OUT, { recursive: true });
mkdirSync(COV_TMP, { recursive: true });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
    }
  }
  return out;
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function discoverTestFiles() {
  const roots = [join(TARGET, 'src'), join(TARGET, 'scripts', 'lib')];
  const all = roots.flatMap((r) => walk(r));
  let tests = all.filter((p) => /\.test\.(ts|tsx)$/.test(p) && (p.includes(`${sep}__tests__${sep}`) || p.includes(`${sep}scripts${sep}lib${sep}`)));
  tests = tests.map((p) => relative(TARGET, p)).sort();
  if (FILTER) tests = tests.filter((p) => p.includes(FILTER));
  return tests;
}

function runVitestForFile(relTestFile, covDir) {
  mkdirSync(covDir, { recursive: true });
  const cmd = 'pnpm';
  const cliArgs = [
    'exec', 'vitest', 'run', relTestFile,
    '--pool=threads',
    '--coverage',
    '--coverage.all=false',
    '--coverage.reporter=json',
    `--coverage.reportsDirectory=${covDir}`,
    '--silent',
    '--passWithNoTests',
  ];
  const started = Date.now();
  const res = spawnSync(cmd, cliArgs, {
    cwd: TARGET,
    encoding: 'utf8',
    timeout: 120_000,
    // thresholds in the project config will "fail" (exit 1) on a single-file run;
    // that's fine — coverage-final.json is still written. We ignore exit code.
    env: { ...process.env, CI: 'true' },
  });
  const ms = Date.now() - started;
  return { ms, status: res.status, stderr: (res.stderr || '').slice(-500) };
}

function readCoveredSources(covDir, relTestFile) {
  const file = join(covDir, 'coverage-final.json');
  if (!existsSync(file)) return { ok: false, sources: [] };
  let json;
  try { json = JSON.parse(readFileSync(file, 'utf8')); } catch { return { ok: false, sources: [] }; }
  const sources = [];
  for (const [absPath, entry] of Object.entries(json)) {
    const relPath = relative(TARGET, absPath);
    if (relPath.startsWith('..') || relPath.includes('node_modules')) continue;
    if (relPath === relTestFile) continue;
    if (relPath.includes(`${sep}__tests__${sep}`)) continue;
    const counts = entry.s ? Object.values(entry.s) : [];
    const executed = counts.some((c) => c > 0);
    if (executed) sources.push(relPath);
  }
  return { ok: true, sources: sources.sort() };
}

function main() {
  const tests = discoverTestFiles();
  const subset = tests.slice(0, LIMIT);
  console.log(`[spike] target: ${TARGET}`);
  console.log(`[spike] discovered ${tests.length} test files; measuring ${subset.length} (limit=${LIMIT}${FILTER ? `, filter='${FILTER}'` : ''})`);

  const reverseMap = {};        // sourceFile -> Set(testFiles)
  const perTest = [];           // timing + attribution per test file
  let totalMs = 0;

  subset.forEach((rel, i) => {
    const covDir = join(COV_TMP, String(i));
    const { ms, status, stderr } = runVitestForFile(rel, covDir);
    const { ok, sources } = readCoveredSources(covDir, rel);
    totalMs += ms;
    perTest.push({ testFile: rel, ms, exitStatus: status, coverageParsed: ok, sourcesTouched: sources.length });
    for (const s of sources) (reverseMap[s] ||= new Set()).add(rel);
    console.log(`  [${i + 1}/${subset.length}] ${rel}  (${(ms / 1000).toFixed(1)}s, ${sources.length} src${ok ? '' : ', NO-COVERAGE'})${status !== 0 && !ok ? ` [stderr: ${stderr.replace(/\n/g, ' ')}]` : ''}`);
    rmSync(covDir, { recursive: true, force: true });
  });

  // Serialize map (sets -> arrays)
  const mapObj = {};
  for (const [src, set] of Object.entries(reverseMap)) mapObj[src] = [...set].sort();

  // --- Setup-baseline analysis (real-world gotcha) ---
  // Source files touched by (nearly) every test file are almost certainly pulled
  // in by setupFiles (vitest.setup.ts), not by the test's own subject. A change
  // to such a file would select the whole suite. We flag them and recompute the
  // selection benefit with them excluded (the "subtract setup baseline" fix).
  const n = subset.length;
  const HOT = 0.8; // touched by >=80% of measured tests => treated as setup-induced
  const hotSources = Object.entries(mapObj).filter(([, t]) => t.length >= Math.ceil(HOT * n)).map(([s]) => s);
  const hotSet = new Set(hotSources);
  const mapObjClean = Object.fromEntries(Object.entries(mapObj).filter(([s]) => !hotSet.has(s)));

  const selBenefit = (m) => {
    const counts = Object.values(m).map((t) => t.length);
    const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
    return {
      avgTestFilesPerChangedSource: Number(avg.toFixed(2)),
      maxTestFilesPerChangedSource: counts.length ? Math.max(...counts) : 0,
      avgSelectionRatio: n ? Number((avg / n).toFixed(3)) : 0,
    };
  };

  const summary = {
    target: TARGET,
    generatedAt: new Date().toISOString(),
    totalTestFilesDiscovered: tests.length,
    measuredTestFiles: subset.length,
    naivePerFileWallSeconds: Number((totalMs / 1000).toFixed(1)),
    avgPerFileSeconds: Number((totalMs / 1000 / subset.length).toFixed(2)),
    sourceFilesMapped: Object.keys(mapObj).length,
    setupBaseline: {
      hotSourceCount: hotSources.length,
      hotSources,
      note: 'Touched by >=80% of measured tests; almost certainly setupFiles-induced. A change here should trigger full-suite (or be excluded from delta selection).',
    },
    selectionRaw: { measuredSuiteSize: n, ...selBenefit(mapObj) },
    selectionAfterSubtractingSetupBaseline: { measuredSuiteSize: n, ...selBenefit(mapObjClean) },
    coverageParseFailures: perTest.filter((t) => !t.coverageParsed).length,
  };

  writeFileSync(join(OUT, 'coverage-map.json'), JSON.stringify(mapObj, null, 2));
  writeFileSync(join(OUT, 'per-test.json'), JSON.stringify(perTest, null, 2));
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  rmSync(COV_TMP, { recursive: true, force: true });

  console.log('\n[spike] SUMMARY');
  console.log(JSON.stringify(summary, null, 2));

  if (RUN_BASELINE) {
    console.log('\n[spike] running full-subset baseline (single vitest run of the measured files)...');
    const started = Date.now();
    const res = spawnSync('pnpm', ['exec', 'vitest', 'run', ...subset, '--pool=threads', '--coverage', '--coverage.all=false', '--silent', '--passWithNoTests'], {
      cwd: TARGET, encoding: 'utf8', timeout: 600_000, env: { ...process.env, CI: 'true' },
    });
    const baselineMs = Date.now() - started;
    console.log(`[spike] baseline (all ${subset.length} files, one process): ${(baselineMs / 1000).toFixed(1)}s (exit ${res.status})`);
    summary.baselineSingleRunSeconds = Number((baselineMs / 1000).toFixed(1));
    summary.naiveOverheadVsBaseline = Number((totalMs / baselineMs).toFixed(1));
    writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  }
}

main();
