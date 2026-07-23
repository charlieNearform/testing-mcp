import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectRegistry } from "../registry/project-registry.js";
import type { Orchestrator, RunRecord, LiveLogLine } from "../orchestrator/index.js";

/**
 * Human Monitoring UI (Epic 5, Phase 2). A convenience web view served by the daemon on
 * loopback: a status page (`/ui`), a JSON snapshot (`/ui/api/status`), and a Server-Sent
 * Events stream (`/ui/events`) that pushes live updates and re-sends the latest snapshot on
 * every (re)connect for resilience. GET-only and loopback-gated by the caller (like /health).
 */

export interface UiDeps {
  registry?: ProjectRegistry;
  orchestrator?: Orchestrator;
}

/** Live per-test/log snapshot embedded in a running project's view (Story 8.7). Sliced smaller
 *  than the orchestrator's own bounds -- this rides the SSE push on every test event across
 *  every running project, unlike the full-fidelity /log routes below (AD-21). */
interface LiveView {
  /** The in-progress run's id -- lets the UI link a "running" history row straight to this run's
   *  live detail view instead of only ever linking to completed RunRecords. */
  runId: string;
  tests: Array<{ file: string; name: string; status: string }>;
  testsTruncated: boolean;
  testsShown: number;
  logTail: Array<{ stream: string; text: string; at: string }>;
  /** Coverage-measurement heartbeat (AD-20/AD-21) -- the ONLY progress signal during that phase:
   *  it uses a silent reporter, so the console log and per-test list both go quiet, which reads as
   *  a hang on a large project without this surfaced somewhere explicit. */
  phase?: { phase: "coverage"; completed: number; total: number };
}

const MAX_SNAPSHOT_TESTS = 200;
const MAX_SNAPSHOT_LOG_LINES = 20;

interface ProjectView {
  projectId: string;
  path: string;
  registryStatus: string;
  runCount: number;
  /** Count of distinct (file, test name) pairs seen across the project's retained run history. */
  totalTests: number;
  /** Recent runs (compact, newest first) embedded so the history sub-view is live via the same SSE push as the root list. */
  runs: ReturnType<typeof runSummary>[];
  run: {
    state: string;
    progress?: { completed: number; total: number };
    summary?: string;
    success?: boolean;
    total?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
    updatedAt?: string;
    strategy?: string;
    reason?: string;
  };
  /** Present only while state === "running" (Story 8.7). */
  live?: LiveView;
}

/** Compact run summary for the history list (heavy fields dropped). */
function runSummary(rec: RunRecord) {
  const r = rec.result;
  return {
    runId: rec.runId,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    durationMs: rec.durationMs,
    status: rec.status,
    error: rec.error,
    success: r?.success,
    strategy: r?.selection.strategy,
    reason: r?.selection.reason,
    total: r?.total,
    passed: r?.passed,
    failed: r?.failed,
    skipped: r?.skipped,
    // Overall line coverage % at a glance on the run row (Story 6.3); undefined on non-coverage runs.
    coverageLines: r?.coverage?.total.lines,
  };
}

/** Build the current snapshot of all registered projects and their run state. */
export async function uiSnapshot(deps: UiDeps): Promise<{ serverTime: string; projects: ProjectView[] }> {
  const projects = deps.registry ? await deps.registry.list() : [];
  return {
    serverTime: new Date().toISOString(),
    projects: projects.map((p) => {
      const run = deps.orchestrator?.getRunStatus(p.projectId) ?? { state: "idle" as const };
      const r = run.lastResult;
      const history = deps.orchestrator?.getRunHistory(p.projectId) ?? [];
      // Sliced smaller than the orchestrator's own bounds (AD-21) -- this snapshot rides the SSE
      // push to every connected tab on every single test event; the full ring is available via
      // the dedicated /log routes below, or by polling get_test_status over MCP.
      const live = run.state === "running" ? deps.orchestrator?.getLiveRun(p.projectId) : undefined;
      const liveView: LiveView | undefined = live && {
        runId: live.runId,
        tests: live.tests.slice(-MAX_SNAPSHOT_TESTS),
        testsTruncated: live.testsTruncated,
        testsShown: Math.min(live.tests.length, MAX_SNAPSHOT_TESTS),
        logTail: live.log.slice(-MAX_SNAPSHOT_LOG_LINES),
        ...(live.phase ? { phase: live.phase } : {}),
      };
      return {
        projectId: p.projectId,
        path: p.path,
        registryStatus: p.status,
        runCount: history.length,
        totalTests: deps.orchestrator?.getTestInventoryCount(p.projectId) ?? 0,
        runs: history.map(runSummary),
        run: {
          state: run.state,
          progress: run.progress,
          summary: r?.summary,
          success: r?.success,
          total: r?.total,
          passed: r?.passed,
          failed: r?.failed,
          skipped: r?.skipped,
          updatedAt: run.updatedAt,
          // Live selection strategy/reason (set the moment the run starts) so the "running" history
          // row isn't blank while the run is still in flight -- sourced live rather than only ever
          // appearing once the run settles into a RunRecord.
          strategy: run.strategy,
          reason: run.reason,
        },
        ...(liveView ? { live: liveView } : {}),
      };
    }),
  };
}

/**
 * Handle a `/ui*` request. Returns true if it consumed the request, false otherwise so the
 * caller can continue routing. Assumes Host/Origin security has already been enforced.
 */
export async function handleUiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UiDeps,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0];
  if (method !== "GET" || (path !== "/ui" && path !== "/ui/" && !path.startsWith("/ui/"))) {
    return false;
  }

  if (path === "/ui" || path === "/ui/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(UI_HTML);
    return true;
  }

  if (path === "/ui/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(await uiSnapshot(deps)));
    return true;
  }

  if (path === "/ui/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // An abrupt client disconnect (e.g. the tab closing, or a test destroying its socket) can
    // surface as an async 'error' event on the response/socket rather than a synchronous throw
    // from res.write() -- without a listener, that would be an unhandled error, not something a
    // try/catch around res.write() catches.
    res.on("error", () => {});
    const push = async () => {
      try {
        res.write(`data: ${JSON.stringify(await uiSnapshot(deps))}\n\n`);
      } catch {
        // socket closed mid-write; the close handler will clean up
      }
    };
    // Resilience: send the latest known state immediately on (re)connect.
    void push();
    const unsub = deps.orchestrator?.onStatusChange(() => void push()) ?? (() => {});
    const keepAlive = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch {
        // ignore
      }
    }, 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsub();
    });
    return true;
  }

  // /ui/api/projects/<projectId>/runs            -> run history (summaries, newest first)
  // /ui/api/projects/<projectId>/runs/<runId>     -> full run detail (selection + failures)
  const parts = path.split("/").filter(Boolean); // ["ui","api","projects",pid,"runs",runId?]
  if (parts[0] === "ui" && parts[1] === "api" && parts[2] === "projects" && parts[4] === "runs") {
    const projectId = decodeURIComponent(parts[3]);
    const runId = parts[5] ? decodeURIComponent(parts[5]) : undefined;
    if (runId) {
      const rec = deps.orchestrator?.getRun(projectId, runId);
      if (!rec) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "ValidationError", message: "Unknown run" }));
        return true;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rec));
      return true;
    }
    const runs = (deps.orchestrator?.getRunHistory(projectId) ?? []).map(runSummary);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ projectId, runs }));
    return true;
  }

  // /ui/api/projects/<projectId>/log            -> one-shot full live log ring (Story 8.7)
  // /ui/api/projects/<projectId>/log/events     -> SSE "follow" -- pushes only new lines
  if (parts[0] === "ui" && parts[1] === "api" && parts[2] === "projects" && parts[4] === "log" && !parts[5]) {
    const projectId = decodeURIComponent(parts[3]);
    const live = deps.orchestrator?.getLiveRun(projectId);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ projectId, runId: live?.runId, log: live?.log ?? [] }));
    return true;
  }
  if (parts[0] === "ui" && parts[1] === "api" && parts[2] === "projects" && parts[4] === "log" && parts[5] === "events") {
    const projectId = decodeURIComponent(parts[3]);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // See the /ui/events handler above -- an abrupt client disconnect can surface as an async
    // 'error' event rather than a synchronous res.write() throw.
    res.on("error", () => {});
    // Track the last log line object we've already sent (by reference, not index -- the ring
    // buffer shifts entries out from the front, so a plain length/index would drift once eviction
    // starts). If the ring evicted past it, fall back to sending the whole current ring.
    let lastSeenLine: LiveLogLine | undefined;
    // Track which run we were last seeing lines for. A new run replaces `live.log` with a fresh
    // array, so `lastSeenLine`'s object reference is never found in it -- without tracking runId
    // separately, that "not found" would be sent as an *append* of the whole new ring on top of
    // whatever the client's one-shot reseed already rendered, duplicating lines. Detecting the
    // run change lets us tell the client to replace instead.
    let lastSeenRunId: string | undefined;
    const push = (): void => {
      const current = deps.orchestrator?.getLiveRun(projectId);
      const currentLog = current?.log ?? [];
      const isNewRun = current?.runId !== lastSeenRunId;
      const idx = !isNewRun && lastSeenLine ? currentLog.indexOf(lastSeenLine) : -1;
      const newLines = idx === -1 ? currentLog : currentLog.slice(idx + 1);
      // A run can start (replacing the live state with a fresh, empty log) well before it writes
      // its first line -- if THIS call finds isNewRun but nothing to send yet, committing
      // lastSeenRunId here would permanently lose the transition: the next call (once real lines
      // exist) would compare against a runId that's already been updated and see isNewRun=false,
      // silently downgrading what should be a run-boundary push to a plain append. Only commit
      // once we've actually decided to send something.
      if (!newLines.length) return;
      lastSeenRunId = current?.runId;
      lastSeenLine = newLines[newLines.length - 1];
      try {
        res.write(`data: ${JSON.stringify({ log: newLines, replace: isNewRun })}\n\n`);
      } catch {
        // socket closed mid-write; the close handler will clean up
      }
    };
    push(); // seed with whatever's already in the ring on connect
    const unsub = deps.orchestrator?.onStatusChange(push) ?? (() => {});
    const keepAlive = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch {
        // ignore
      }
    }, 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsub();
    });
    return true;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: "ValidationError", message: "Not found" }));
  return true;
}

const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>test-mcp · status</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --border:#30363d; --muted:#8b949e;
    --ok:#3fb950; --fail:#f85149; --run:#d29922; --text:#e6edf3; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:var(--bg); color:var(--text); }
  header { padding:20px 24px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:12px; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--muted); }
  .dot.live { background:var(--ok); box-shadow:0 0 8px var(--ok); }
  main { padding:24px; }
  a { color:inherit; text-decoration:none; }
  .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; display:block; }
  a.card:hover { border-color:var(--muted); }
  .card h2 { font-size:14px; margin:0 0 4px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .path { color:var(--muted); font-size:12px; word-break:break-all; margin-bottom:12px; }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600; }
  .badge.idle{ background:#21262d; color:var(--muted); }
  .badge.running{ background:rgba(210,153,34,.15); color:var(--run); }
  .badge.complete{ background:rgba(63,185,80,.15); color:var(--ok); }
  .badge.error{ background:rgba(248,81,73,.15); color:var(--fail); }
  .badge.high{ background:rgba(63,185,80,.15); color:var(--ok); }
  .badge.degraded{ background:rgba(210,153,34,.15); color:var(--run); }
  .summary { margin-top:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .summary.fail { color:var(--fail); }
  .counts { margin-top:10px; display:flex; gap:14px; align-items:baseline; font-size:13px; }
  .counts .ts { margin-top:0; }
  .empty { color:var(--muted); padding:40px; text-align:center; }
  .ts { color:var(--muted); font-size:11px; margin-top:10px; }
  .back { color:var(--muted); font-size:13px; display:inline-block; margin-bottom:16px; }
  .back:hover { color:var(--text); }
  h2.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:15px; margin:0 0 4px; }
  .ok { color:var(--ok); } .fail { color:var(--fail); } .skip { color:var(--muted); } .run { color:var(--run); }
  .banner { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:12px 14px; margin-bottom:16px;
    background:var(--card); border:1px solid var(--border); border-radius:8px; }
  /* .counts/.summary are stacked block elements elsewhere (their margin-top spaces them from a
     heading above); as flex siblings of the badge here, that top margin offsets their box within
     the centered row, so cancel it to keep all three vertically centered with the badge. */
  .banner .counts, .banner .summary { margin-top:0; }
  ul.tests { list-style:none; padding:0; margin:8px 0; }
  ul.tests li { padding:3px 0; font-size:13px; border-bottom:1px solid var(--border); }
  ul.tests li span.ok, ul.tests li span.fail, ul.tests li span.skip { display:inline-block; width:56px; font-weight:600; font-size:11px; text-transform:uppercase; }
  ul.tests .loc { color:var(--muted); font-size:11px; }
  table.runs { width:100%; border-collapse:collapse; font-size:13px; margin-top:12px; }
  table.runs th { text-align:left; color:var(--muted); font-weight:500; padding:8px 10px; border-bottom:1px solid var(--border); }
  table.runs td { padding:8px 10px; border-bottom:1px solid var(--border); }
  table.runs tr.row:hover { background:var(--card); cursor:pointer; }
  .detail-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; margin:14px 0; }
  .phase-progress { margin:14px 0; }
  .phase-progress .label { display:flex; justify-content:space-between; font-size:12px; color:var(--muted); margin-bottom:4px; }
  .phase-progress .bar { height:8px; border-radius:4px; background:var(--card); border:1px solid var(--border); overflow:hidden; }
  .phase-progress .fill { height:100%; background:var(--run); transition:width .2s ease; }
  .kv { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
  .kv .k { color:var(--muted); font-size:11px; } .kv .v { font-size:15px; margin-top:2px; }
  .section-title { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; margin:22px 0 8px; }
  details > summary { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; margin:22px 0 8px; cursor:pointer; }
  ul.files { list-style:none; padding:0; margin:8px 0; }
  ul.files li { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; padding:3px 0; }
  .fail-item { background:var(--card); border:1px solid var(--border); border-left:3px solid var(--fail); border-radius:6px; padding:10px 12px; margin:8px 0; }
  .fail-item .name { font-weight:600; } .fail-item .loc { color:var(--muted); font-size:12px; margin-top:2px; }
  pre { background:#0d1117; border:1px solid var(--border); border-radius:6px; padding:10px; overflow-x:auto; font-size:12px; margin:8px 0 0; }
  /* Fixed (not max-) height so content can't push the panel taller as lines arrive -- height
     itself is user-resizable (native CSS resize) and persisted to localStorage in JS. */
  #log-pre { height:640px; overflow-y:auto; white-space:pre-wrap; word-break:break-all; resize:vertical; min-height:120px; }
  /* display:flex (needed to lay out the label on the right) drops the browser's own <summary>
     disclosure triangle that the other <details> blocks on this page get for free, so it's
     recreated explicitly here and rotated to match the [open] state. */
  .log-summary { display:flex; align-items:center; justify-content:space-between; }
  .log-summary .chevron { display:inline-block; margin-right:6px; transition:transform .15s ease; }
  .log-playpause { font:inherit; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted);
    background:#21262d; border:1px solid var(--border); border-radius:4px; padding:2px 10px; cursor:pointer; }
  .log-playpause:hover { color:var(--text); }
  details[open] > .log-summary .chevron { transform:rotate(90deg); }
  .log-marker { color:var(--muted); text-align:center; margin:6px 0; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
</style>
</head>
<body>
<header><span class="dot" id="live"></span><h1>test-mcp</h1><span id="clock" style="color:var(--muted);font-size:12px;"></span></header>
<main id="app"><div id="view-top"><div class="empty">Connecting…</div></div><div id="view-log-slot"></div><div id="view-bottom"></div></main>
<script>
// #app itself is never assigned .innerHTML -- only its two children view-top/view-bottom are, on
// every render. view-log-slot sits between them, untouched by either, so it stays a stable,
// never-rebuilt ancestor of the persistent log element (see ensureLogEl/placeLogEl below). That's
// what actually keeps it attached to the live document across every SSE-driven re-render, rather
// than merely being detached and immediately reattached into a freshly-recreated placeholder --
// the latter (an earlier version of this fix) still cleared the user's text selection on every
// render, confirmed via Playwright: detach-then-reattach in the same tick does NOT reliably
// preserve a live Selection/Range, even when it's literally the same DOM node object.
const viewTop = document.getElementById("view-top");
const viewLogSlot = document.getElementById("view-log-slot");
const viewBottom = document.getElementById("view-bottom");
const live = document.getElementById("live");
let snapshot = { projects: [], serverTime: null };

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtTime = (t) => t ? new Date(t).toLocaleTimeString() : "";
const fmtDur = (ms) => (ms == null) ? "" : (ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s");
const badge = (s) => '<span class="badge ' + esc(s || "idle") + '">' + esc(s || "idle") + '</span>';
const go = (path) => { location.hash = "#" + path; };
const routeParts = () => (location.hash || "#/").slice(1).split("/").filter(Boolean);
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }

// Every file path from the worker is absolute (project root + relative bit). The root is shown
// once per page — strip it back off here so file lists don't repeat it on every single row.
function relPath(file, root) {
  if (!file || !root) return file || "";
  const withSlash = root.endsWith("/") ? root : root + "/";
  return file === root ? "." : (file.startsWith(withSlash) ? file.slice(withSlash.length) : file);
}
const projectLine = (root) => root ? '<div class="path">Project: ' + esc(root) + '</div>' : "";

// A single pass/total figure, colored red only when there's an actual failure to flag (0 failures
// is green, never red) — replaces a separate pass/fail/total trio that showed red even at 0 fails.
// The denominator is EXECUTED tests (passed+failed) so skips can't dilute the ratio; a skip count
// is called out separately alongside it instead of being folded into "total".
const kv = (k, v) => '<div class="kv"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';

function passTotal(r) {
  if (r.total == null) return "";
  const executed = (r.passed || 0) + (r.failed || 0);
  // Every selected test was skipped: passed/0 would read as an ambiguous, vacuous "0/0 passed"
  // in green instead of communicating that nothing actually ran.
  if (executed === 0) return '<span class="skip">' + (r.skipped || 0) + ' skipped, none executed</span>';
  const cls = (r.failed || 0) > 0 ? "fail" : "ok";
  const skippedNote = r.skipped ? ' <span class="skip">(' + r.skipped + ' skipped)</span>' : "";
  return '<span class="' + cls + '"><b>' + (r.passed || 0) + '</b>/<b>' + executed + '</b> passed</span>' + skippedNote;
}

// INNER content only -- the outer <a class="card"> tag is now owned by the grid's persistent
// shell (see renderList/reconcileChildren below), created once per projectId and never destroyed
// on a re-render, so a mousedown-on-card followed by an SSE-driven repaint before pointerup no
// longer drops the click (a browser does not synthesize "click" when the pointerdown target was
// removed from the DOM before pointerup).
function cardInner(p) {
  const r = p.run || {};
  const counts = (r.total != null) ? '<div class="counts">' + passTotal(r)
    + '<span class="ts">' + (p.totalTests || 0) + ' total tests</span></div>' : "";
  const summary = r.summary ? '<div class="summary ' + (r.failed ? 'fail' : '') + '">' + esc(r.summary) + '</div>' : "";
  const n = p.runCount || 0;
  const runs = '<div class="ts">' + n + ' run' + (n === 1 ? '' : 's') + ' · click for history</div>';
  return '<h2>' + esc(p.projectId) + '</h2>' + projectLine(p.path) + badge(r.state) + counts + summary + runs;
}

// Minimal keyed reconciliation (no virtual-DOM diffing): cache is a Map from key to {html, el} --
// the element itself is looked up by MAP key (never by querying the DOM for it), so a key
// containing characters that would be invalid/dangerous inside a CSS attribute-selector string
// (e.g. a quote) can never break or mis-select anything (found via adversarial review: a raw
// querySelector call built from string concatenation throws a SyntaxError on such a key, breaking
// the whole render pass). A pass only writes .innerHTML to a key's node when that string actually
// changed, creates a node (via createEl) for a brand-new key, and removes nodes for keys no
// longer present -- an unchanged key keeps its exact node identity (and whatever listeners
// createEl wired up at creation time) across the whole render pass. This is the actual fix for
// dropped clicks / re-highlighted nodes on unrelated SSE pushes, not an optimization on top of one.
function reconcileChildren(container, items, keyOf, renderHtml, cache, createEl) {
  const seen = new Set();
  let prevEl = null;
  for (const item of items) {
    const key = String(keyOf(item)); // coerced once, consistently -- keyOf need not return a string
    seen.add(key);
    const html = renderHtml(item);
    let entry = cache.get(key);
    if (!entry) {
      entry = { html: null, el: createEl(item, key) };
      entry.el.dataset.key = key; // debugging/inspection only -- never read back via querySelector
      cache.set(key, entry);
    }
    if (entry.html !== html) {
      entry.el.innerHTML = html; // renderHtml returns INNER content only -- the outer tag is createEl's
      entry.html = html;
    }
    if (prevEl ? prevEl.nextSibling !== entry.el : container.firstChild !== entry.el) {
      container.insertBefore(entry.el, prevEl ? prevEl.nextSibling : container.firstChild);
    }
    prevEl = entry.el;
  }
  for (const [key, entry] of [...cache]) {
    if (!seen.has(key)) { entry.el.remove(); cache.delete(key); }
  }
}

// Pinned live status banner for the project history view (Story 6.1, AC5) — the same state the
// root card shows, sourced from the SSE-updated snapshot.projects so it ticks live for free.
function statusBanner(pid) {
  const p = (snapshot.projects || []).find((x) => x.projectId === pid);
  if (!p) return "";
  const r = p.run || {};
  const counts = (r.total != null) ? '<div class="counts">' + passTotal(r)
    + '<span class="ts">' + (p.totalTests || 0) + ' total tests</span></div>' : "";
  const summary = r.summary ? '<div class="summary ' + (r.failed ? 'fail' : '') + '">' + esc(r.summary) + '</div>' : "";
  return '<div class="banner">' + badge(r.state) + counts + summary + '</div>';
}

// Persistent shell for the project-cards grid (list route only) -- built once, reused across
// every SSE-driven re-render of the list route, and released via teardownGrid() when navigating
// away to a project/run view (mirrors ensureLogEl/placeLogEl's persistent-node lifecycle for the
// console log panel).
let gridEl = null;
const gridCache = new Map();

function teardownGrid() {
  gridEl = null;
  gridCache.clear();
}

function createCardEl(p, key) {
  const a = document.createElement("a");
  a.className = "card";
  a.href = "#/project/" + encodeURIComponent(key);
  return a;
}

function renderList() {
  closeLogStream(); // leaving any project's running view -- never leak an open follow connection
  teardownHistoryTable(); // leaving the project route -- never leave its SSE-independent state live
  viewingLiveRunId = null;
  const ps = snapshot.projects || [];
  if (!ps.length) {
    teardownGrid();
    viewTop.innerHTML = '<div class="empty">No projects registered.</div>';
    viewBottom.innerHTML = "";
    return;
  }
  if (!gridEl) { gridEl = document.createElement("div"); gridEl.className = "grid"; }
  if (viewTop.firstChild !== gridEl) { viewTop.innerHTML = ""; viewTop.appendChild(gridEl); }
  reconcileChildren(gridEl, ps, (p) => p.projectId, cardInner, gridCache, createCardEl);
  viewBottom.innerHTML = "";
}

// Sourced from the SSE-pushed snapshot (like statusBanner) rather than a one-shot fetch, so the
// history table lands new rows live instead of only refreshing on the next manual navigation.
// Live per-test list (Story 8.7), grouped by file, shown only for a state:"running" project.
function liveTestsBlock(live, root, isOpen) {
  if (!live || !live.tests || !live.tests.length) return "";
  const byFile = new Map();
  for (const t of live.tests) {
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    byFile.get(t.file).push(t);
  }
  const statusClass = (s) => (s === "passed" ? "ok" : s === "failed" ? "fail" : s === "running" ? "run" : "skip");
  const rows = [...byFile.entries()].map(([file, tests]) =>
    '<div class="ts">' + esc(relPath(file, root)) + '</div>'
    + '<ul class="tests">' + tests.map((t) =>
        '<li><span class="' + statusClass(t.status) + '">' + esc(t.status) + '</span> ' + esc(t.name) + '</li>').join("") + '</ul>'
  ).join("");
  const truncNote = live.testsTruncated
    ? '<div class="ts">showing the ' + live.testsShown + ' most recent — suite is large</div>'
    : "";
  return '<details id="live-tests-details"' + (isOpen ? " open" : "") + '><summary>live tests</summary>' + rows + truncNote + '</details>';
}

// Console log panel state. Module-level, not persisted -- resets on reload, matching the existing
// no-framework/inline-JS simplicity of this page. logOpen/liveTestsOpen track each <details>
// element's open/closed state across navigation. logPlaying replaces the old "follow" checkbox:
// while playing, new lines append immediately and the view auto-scrolls to the bottom; paused
// defers DOM updates entirely (queued in pendingLogEntries, nothing is lost from the transcript)
// so an in-progress text selection/copy is never disturbed by incoming lines -- flushed on resume.
let logPlaying = true;
let logOpen = true;
let liveTestsOpen = true;
let logEventSource = null;
let logStreamProjectId = null;
let pendingLogEntries = [];

// The <details id="log-details"> DOM node itself persists across re-renders of the SAME project
// (unlike everything else on this page, which renderProject()/renderLiveRun() rebuild from a
// fresh HTML string on every SSE push). Destroying and recreating it on every test-progress event
// was clearing the user's text selection mid-copy and defeating the browser's natural "stay
// scrolled where you are" behavior (which only works if the scrollable element is never removed).
// Reused across renderProject() and renderLiveRun() for the same project (both show the same
// transcript); released via closeLogStream() when navigating to a different project or away
// entirely -- see ensureLogEl() below.
let logEl = null;
let logElProjectId = null;

// The console log transcript itself, kept independent of whichever run happens to be in flight --
// the backend's own live ring is scoped to a single run and gets wiped the instant the next one
// starts, but per request this panel should read as one continuous transcript across runs (with a
// marker line at each boundary) that only a manual collapse of the <details> hides, never a run
// completing/starting. Per-project (not per-run); cleared only when the user views a DIFFERENT
// project. Not persisted across a real page reload, and not a substitute for run history -- see
// the /runs/:runId route for what's actually durable (no console output there, see its own route
// comment).
let logBuffer = [];
let logBufferProjectId = null;
const MAX_BUFFERED_LOG_LINES = 2000;

function resetLogBufferForProject(pid) {
  if (logBufferProjectId === pid) return;
  logBufferProjectId = pid;
  logBuffer = [];
  pendingLogEntries = [];
}

// Appends to the transcript and returns just the newly-added entries, so an incremental push can
// append only the delta onto the persistent #log-pre (or queue it while paused -- see
// setLogPlaying). isNewRun inserts a separator instead of wiping the panel back to empty -- but
// only when there's prior content to separate from, so the very first run shown in a fresh buffer
// doesn't open with a spurious "new run" banner.
function appendToLogBuffer(lines, isNewRun) {
  const added = [];
  if (isNewRun && logBuffer.length) {
    // The real server-provided timestamp of the first line in this batch, not client "now" --
    // "now" used to be a reasonable enough approximation when every batch rendered immediately,
    // but now that a paused stream can defer rendering indefinitely (see setLogPlaying), "now"
    // could lag the actual run start by however long the user stayed paused.
    const at = lines[0] && lines[0].at ? fmtTime(lines[0].at) : new Date().toLocaleTimeString();
    const marker = { marker: true, text: "New test run started " + at };
    logBuffer.push(marker);
    added.push(marker);
  }
  for (const l of lines) {
    const entry = { marker: false, stream: l.stream, text: l.text };
    logBuffer.push(entry);
    added.push(entry);
  }
  if (logBuffer.length > MAX_BUFFERED_LOG_LINES) logBuffer.splice(0, logBuffer.length - MAX_BUFFERED_LOG_LINES);
  return added;
}

// A minimal ANSI SGR (foreground color) escape-sequence parser -- not a full terminal emulator,
// just enough to respect real console-log colors (chalk, Vitest's own coloring when forced, etc.)
// instead of force-coloring every stderr line red regardless of its actual content. Text with no
// escape codes at all (the common case once color-detecting libraries see a non-TTY pipe) renders
// in the panel's default (light) color rather than red. Any well-formed CSI sequence that ISN'T
// SGR (cursor movement, line-clear, show/hide -- common in progress-spinner output, e.g. ESC[2K
// or ESC[?25l) is consumed and ignored without touching the color state; only unrecognized SGR
// parameters (256-color, truecolor, bold/underline, background colors) are the ones silently
// dropped with no visual signal.
const ANSI_ESC_CHAR = String.fromCharCode(27);
// A CSI sequence is ESC "[" then parameter bytes (0x30-0x3F: digits, semicolon/colon/lt/eq/gt/?) then exactly one
// final byte (0x40-0x7E). Matching the REAL terminator (whatever it is) -- not just searching for
// the next literal "m" anywhere in the string -- matters: a non-SGR sequence never contains "m" at
// all, so blindly searching for one would swallow everything up to some unrelated "m" inside later
// plain text (e.g. the word "message") as if it were color parameters, or drop the rest of the
// line entirely if no later "m" happened to exist.
// Every backslash in this regex is doubled in the source below so it survives being embedded
// inside the outer UI_HTML template literal -- a single backslash here would be consumed as an
// unrecognized, silently-dropped escape by the OUTER string's own parsing before the browser ever
// sees it (the same reason a literal newline elsewhere in this file is written doubled too).
const ANSI_CSI_RE = /^\\[([0-9:;<=>?]*)([\\x40-\\x7e])/;
const ANSI_FG = {
  30: "#6e7681", 31: "#f85149", 32: "#3fb950", 33: "#d29922", 34: "#58a6ff", 35: "#bc8cff", 36: "#39c5cf", 37: "#c9d1d9",
  90: "#6e7681", 91: "#ff7b72", 92: "#56d364", 93: "#e3b341", 94: "#79c0ff", 95: "#d2a8ff", 96: "#56d4dd", 97: "#f0f6fc",
};
function ansiToHtml(text) {
  const wrap = (s, color) => (s ? (color ? '<span style="color:' + color + '">' + esc(s) + '</span>' : esc(s)) : "");
  let out = "";
  let color = null;
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(ANSI_ESC_CHAR, i);
    if (start === -1) { out += wrap(text.slice(i), color); break; }
    out += wrap(text.slice(i, start), color);
    const match = ANSI_CSI_RE.exec(text.slice(start + 1));
    if (!match) { i = start + 1; continue; } // stray ESC not followed by a CSI sequence -- drop just that byte
    if (match[2] === "m") {
      for (const raw of match[1].split(";")) {
        const p = raw === "" ? 0 : Number(raw);
        if (p === 0 || p === 39) color = null;
        else if (ANSI_FG[p] !== undefined) color = ANSI_FG[p];
      }
    }
    // Any other terminator (K, G, l, h, A, B, ...) -- consumed, color state left untouched.
    i = start + 1 + match[0].length;
  }
  return out;
}

function logEntryHtml(l) {
  return l.marker ? '<div class="log-marker">— ' + esc(l.text) + ' —</div>' : ansiToHtml(l.text);
}
// The run-detail page's own live view re-renders on every SSE push while it's open (a completed
// run's detail is otherwise immutable, see the SSE handler below) -- this is the runId that's
// currently allowed to keep doing that, cleared once the run finishes or the user navigates away.
let viewingLiveRunId = null;

const LOG_HEIGHT_KEY = "test-mcp:log-height-px";
let logHeightObserver = null;

// Applied once, when #log-pre is first created (it now persists -- see ensureLogEl -- so this
// never needs to be re-applied to a "fresh" node on every render the way it used to).
function applyStoredLogHeight(pre) {
  const saved = Number(localStorage.getItem(LOG_HEIGHT_KEY));
  if (saved > 0) pre.style.height = saved + "px";
  if (logHeightObserver) logHeightObserver.disconnect();
  logHeightObserver = new ResizeObserver(() => {
    localStorage.setItem(LOG_HEIGHT_KEY, String(Math.round(pre.getBoundingClientRect().height)));
  });
  logHeightObserver.observe(pre);
}

// Full teardown: closes the live stream and releases the persistent log element -- used when
// navigating to a different project, to the project list, or to a completed (non-live) run detail
// page, none of which show this project's log. NOT used for ordinary re-renders of the SAME
// project's view (that's the entire point of ensureLogEl persisting the element instead).
function closeLogStream() {
  if (logEventSource) { logEventSource.close(); logEventSource = null; }
  logStreamProjectId = null;
  if (logHeightObserver) { logHeightObserver.disconnect(); logHeightObserver = null; }
  logEl = null;
  logElProjectId = null;
  viewLogSlot.innerHTML = ""; // release whatever was actually in the DOM, not just our own refs
}

// Appends new entries onto the persistent #log-pre. Always scrolls to the bottom when called --
// callers only ever call this while actively playing, or once (from setLogPlaying) to catch up
// after a pause, both of which want to land at the bottom; a paused stream never calls this at all
// (entries are queued in pendingLogEntries instead), so there is no "should I scroll?" branch here.
function appendLogPreIncremental(added) {
  if (!added.length) return;
  const pre = document.getElementById("log-pre");
  if (!pre) return;
  const html = added.map(logEntryHtml).join("\\n");
  pre.insertAdjacentHTML("beforeend", (pre.childNodes.length ? "\\n" : "") + html);
  pre.scrollTop = pre.scrollHeight;
}

function setLogPlaying(playing) {
  logPlaying = playing;
  if (playing && pendingLogEntries.length) {
    appendLogPreIncremental(pendingLogEntries);
    pendingLogEntries = [];
  }
}

// Persistent EventSource per project -- opened once and reused across renderProject()/
// renderLiveRun() re-renders and view switches for the SAME project; only reconnected when the
// project actually changes. New lines append directly onto the persistent #log-pre (or queue in
// pendingLogEntries while paused) -- never a full repaint of the whole transcript.
function connectLogStream(pid) {
  if (logStreamProjectId === pid) return;
  if (logEventSource) { logEventSource.close(); logEventSource = null; }
  logStreamProjectId = pid;
  logEventSource = new EventSource("/ui/api/projects/" + encodeURIComponent(pid) + "/log/events");
  logEventSource.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      const added = appendToLogBuffer(payload.log || [], !!payload.replace);
      if (logPlaying) {
        appendLogPreIncremental(added);
      } else {
        pendingLogEntries.push(...added);
        // Capped AFTER the push (not inside appendToLogBuffer, which returns before the caller
        // -- here -- actually queues anything) so a paused stream can't run over by one batch.
        if (pendingLogEntries.length > MAX_BUFFERED_LOG_LINES) {
          pendingLogEntries.splice(0, pendingLogEntries.length - MAX_BUFFERED_LOG_LINES);
        }
      }
    } catch (_) { /* ignore */ }
  };
}

// Builds (or reuses, for the same project) the persistent <details id="log-details"> node --
// listeners and the height observer are wired exactly once, at creation, since re-wiring them on
// every render would stack up duplicate listeners on a node that's no longer recreated each time.
function ensureLogEl(pid) {
  if (logEl && logElProjectId === pid) return logEl;
  resetLogBufferForProject(pid);
  const details = document.createElement("details");
  details.id = "log-details";
  details.open = logOpen;
  details.addEventListener("toggle", () => { logOpen = details.open; });
  const summary = document.createElement("summary");
  summary.className = "log-summary";
  summary.innerHTML = '<span><span class="chevron">▸</span>console log</span>'
    + '<button type="button" id="log-playpause" class="log-playpause"'
    + ' aria-pressed="' + (!logPlaying) + '" aria-label="' + (logPlaying ? "Pause" : "Resume") + ' console log updates">'
    + (logPlaying ? "⏸ pause" : "▶ play") + '</button>';
  const playBtn = summary.querySelector("#log-playpause");
  playBtn.addEventListener("click", (e) => {
    e.preventDefault(); // clicking inside <summary> would otherwise also toggle open/closed
    e.stopPropagation();
    setLogPlaying(!logPlaying);
    playBtn.textContent = logPlaying ? "⏸ pause" : "▶ play";
    // aria-pressed reflects "pause" as the toggled-on state (paused = pressed), same convention
    // as a mute button -- paired with aria-label so a screen reader also hears what clicking it
    // will do next, since (like the visible label) that's the opposite of the current state.
    playBtn.setAttribute("aria-pressed", String(!logPlaying));
    playBtn.setAttribute("aria-label", (logPlaying ? "Pause" : "Resume") + " console log updates");
  });
  const pre = document.createElement("pre");
  pre.id = "log-pre";
  pre.innerHTML = logBuffer.map(logEntryHtml).join("\\n");
  details.appendChild(summary);
  details.appendChild(pre);
  applyStoredLogHeight(pre);
  if (logPlaying) pre.scrollTop = pre.scrollHeight;
  logEl = details;
  logElProjectId = pid;
  connectLogStream(pid);
  return details;
}

// Puts this project's persistent log element into view-log-slot -- but only touches the slot's DOM
// at all when it doesn't already hold this exact node. Re-render after re-render of the SAME
// project, ensureLogEl() returns the same object and this becomes a complete no-op: view-log-slot
// itself is never touched, which is the whole point (see the comment on view-log-slot's
// declaration) -- an in-progress text selection or a manual scroll inside it survives untouched.
function placeLogEl(pid) {
  const el = ensureLogEl(pid);
  if (viewLogSlot.firstChild !== el) {
    viewLogSlot.innerHTML = "";
    viewLogSlot.appendChild(el);
  }
}

function wireLiveTestsPanel() {
  const details = document.getElementById("live-tests-details");
  if (details) details.addEventListener("toggle", () => { liveTestsOpen = details.open; });
}

// Persistent shell for a project's run-history table (project-detail route only) -- the <table>
// (thead+tbody) is built once per project id, reused across every SSE-driven re-render of that
// SAME project's view, and released via teardownHistoryTable() when navigating to a different
// project, to the list, or to a run-detail page (mirrors ensureLogEl/placeLogEl's lifecycle).
let historyTableEl = null;
let historyTbodyEl = null;
let historyPid = null;
const historyCache = new Map();

function teardownHistoryTable() {
  historyTableEl = null;
  historyTbodyEl = null;
  historyPid = null;
  historyCache.clear();
}

function ensureHistoryTable(pid) {
  if (historyTableEl && historyPid === pid) return historyTableEl;
  teardownHistoryTable();
  const table = document.createElement("table");
  table.className = "runs";
  const thead = document.createElement("thead");
  thead.innerHTML = '<tr><th>time</th><th>status</th><th>strategy</th><th>pass / executed</th><th>coverage</th><th>duration</th></tr>';
  const tbody = document.createElement("tbody");
  table.appendChild(thead);
  table.appendChild(tbody);
  historyTableEl = table;
  historyTbodyEl = tbody;
  historyPid = pid;
  return table;
}

// INNER <td>...</td> content for one history row -- the outer <tr> is owned by the table's
// persistent shell (via reconcileChildren below), created once per runId with its click listener
// wired at creation time instead of re-attached via querySelectorAll on every render.
function historyRowInner(item) {
  if (item.kind === "live") {
    const r = item.run || {};
    return '<td>' + fmtTime(item.updatedAt) + '</td>'
      + '<td>' + badge("running") + '</td>'
      + '<td>' + esc(r.strategy || "") + '</td>'
      + '<td>' + (r.total != null ? passTotal(r) : "–") + '</td>'
      + '<td>–</td>'
      + '<td>–</td>';
  }
  const r = item.r;
  return '<td>' + fmtTime(r.startedAt) + '</td>'
    + '<td>' + badge(r.status) + '</td>'
    + '<td>' + esc(r.strategy || "") + '</td>'
    + '<td>' + (r.total != null ? passTotal(r) : "–") + '</td>'
    + '<td>' + (r.coverageLines != null ? (Math.round(r.coverageLines * 10) / 10) + '%' : "–") + '</td>'
    + '<td>' + fmtDur(r.durationMs) + '</td>';
}

function createHistoryRowEl(pid) {
  return (item, key) => {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.addEventListener("click", () => go("/project/" + encodeURIComponent(pid) + "/run/" + encodeURIComponent(key)));
    return tr;
  };
}

function renderProject(pid) {
  viewingLiveRunId = null;
  teardownGrid(); // leaving the list route -- never leave the grid's SSE listeners live behind it
  const p = (snapshot.projects || []).find((x) => x.projectId === pid);
  const head = '<a class="back" href="#/">← projects</a><h2 class="mono">' + esc(pid) + '</h2>' + projectLine(p && p.path);
  if (!p) { closeLogStream(); teardownHistoryTable(); viewTop.innerHTML = head + '<div class="empty">Loading…</div>'; viewBottom.innerHTML = ""; return; }
  const runs = p.runs || [];
  const banner = statusBanner(pid);
  const running = p.run && p.run.state === "running";
  // The log panel persists once the project has ever run -- a run completing (or the next one
  // starting) no longer hides it; only manually collapsing the <details> does. It lives in
  // view-log-slot (see placeLogEl), a sibling of view-top/view-bottom that THIS function never
  // assigns .innerHTML to -- that's what makes an in-progress text selection/copy and scroll
  // position survive this function's own frequent SSE-driven rebuilds of everything around it.
  // The live-tests list moved to the run's own live-detail page (renderLiveRun) -- it's about "this
  // one running job," not the project's history.
  const everRan = running || runs.length > 0;
  // Running run gets its own row at the top of the history table (newest-first) so it's clickable
  // straight to its live detail view, even though it has no RunRecord yet (it's still in flight).
  const liveItem = (running && p.live && p.live.runId)
    ? { kind: "live", runId: p.live.runId, updatedAt: p.run.updatedAt, run: p.run }
    : null;
  viewTop.innerHTML = head + banner;
  if (everRan) placeLogEl(pid); else closeLogStream();
  if (!runs.length && !liveItem) {
    teardownHistoryTable();
    viewBottom.innerHTML = running ? "" : '<div class="empty">No runs yet — trigger one via run_tests.</div>';
    return;
  }
  const items = (liveItem ? [liveItem] : []).concat(runs.map((r) => ({ kind: "record", runId: r.runId, r })));
  const table = ensureHistoryTable(pid);
  if (viewBottom.firstChild !== table) { viewBottom.innerHTML = ""; viewBottom.appendChild(table); }
  reconcileChildren(historyTbodyEl, items, (it) => it.runId, historyRowInner, historyCache, createHistoryRowEl(pid));
}

// The console log section was originally added only to the project page, but a running test's
// log is just as useful (arguably more so) scoped to its own run -- reachable by clicking the
// "running" row renderProject() now prepends to the history table. That row's runId matches
// live.runId exactly while the run is in flight, which is how this is told apart from a normal
// completed-run lookup below. The live per-test status list lives here too -- it's about this one
// running job, not the project's history (which is what renderProject shows).
// The coverage-measurement phase uses a silent reporter (AD-20) -- no console output, and the
// per-test list stops updating too (it's per-FILE, not per-case, during this phase) -- so without
// this, a large project's coverage pass reads as a hang even though heartbeats are keeping it
// alive underneath. phase.total is 0 during baseline measurement (brief) AND for the entire
// duration of a full-suite native coverage pass (Story 3.7 -- no per-file count exists there);
// show an indeterminate state rather than a misleading "0 / 0" either way. "in progress" (not
// "starting") since this can legitimately persist for minutes on a full-suite pass, not just
// the brief window before the first file-count is known.
function phaseProgressBlock(phase) {
  if (!phase) return "";
  const known = phase.total > 0;
  const pct = known ? Math.min(100, Math.round((phase.completed / phase.total) * 100)) : 6;
  return '<div class="phase-progress"><div class="label"><span>Measuring coverage</span><span>'
    + (known ? phase.completed + ' / ' + phase.total + ' files' : 'in progress…')
    + '</span></div><div class="bar"><div class="fill" style="width:' + pct + '%"></div></div></div>';
}

function renderLiveRun(pid, runId, proj, back) {
  const r = proj.run || {};
  const grid = '<div class="detail-grid">'
    + kv("status", badge("running"))
    + kv("pass / executed", r.total != null ? passTotal(r) : "–")
    + kv("duration", "running…") + '</div>';
  // reason (like strategy) is live from the moment the run starts (Story: monitoring UI
  // re-render fixes) -- shown here, next to the timestamp, matching how a completed run's detail
  // page pairs its own startedAt with sel.reason. The history table's row stays strategy-only for
  // both live and completed rows (a full reason sentence doesn't fit a table cell); this is where
  // the live run's reason is actually surfaced, not left as unrendered plumbing.
  viewTop.innerHTML = back
    + '<h2 class="mono">run ' + esc(String(runId).slice(0, 8)) + '…</h2>'
    + '<div class="ts">' + fmtTime(r.updatedAt) + ' · in progress'
    + (r.reason ? ' · ' + esc(r.reason) : '') + '</div>'
    + grid
    + phaseProgressBlock(proj.live && proj.live.phase);
  placeLogEl(pid);
  viewBottom.innerHTML = liveTestsBlock(proj.live, proj.path, liveTestsOpen);
  wireLiveTestsPanel();
}

async function renderRun(pid, runId) {
  // A run-detail view (live or completed) never shows the list grid or the project's history
  // table -- release both persistent shells regardless of which view we're coming from.
  teardownGrid();
  teardownHistoryTable();
  const proj = (snapshot.projects || []).find((x) => x.projectId === pid);
  const root = proj ? proj.path : "";
  const back = '<a class="back" href="#/project/' + encodeURIComponent(pid) + '">← runs</a>' + projectLine(root);
  const isLive = !!(proj && proj.run && proj.run.state === "running" && proj.live && proj.live.runId === runId);
  viewingLiveRunId = isLive ? runId : null;
  if (isLive) { renderLiveRun(pid, runId, proj, back); return; }
  closeLogStream(); // leaving any project's running view -- never leak an open follow connection
  viewBottom.innerHTML = ""; // this view puts everything in viewTop; drop any other view's leftovers
  viewTop.innerHTML = back + '<div class="empty">Loading…</div>';
  let rec;
  try { rec = await getJSON("/ui/api/projects/" + encodeURIComponent(pid) + "/runs/" + encodeURIComponent(runId)); }
  catch (e) { viewTop.innerHTML = back + '<div class="empty">Run not found (evicted from in-memory history?).</div>'; return; }
  const res = rec.result || {};
  const sel = res.selection || {};
  const grid = '<div class="detail-grid">'
    + kv("status", badge(rec.status))
    + kv("pass / executed", res.total != null ? passTotal(res) : "–")
    + kv("duration", fmtDur(rec.durationMs)) + '</div>';
  const files = (sel.files && sel.files.length)
    ? '<ul class="files">' + sel.files.map((f) => '<li>' + esc(relPath(f, root)) + '</li>').join("") + '</ul>'
    : '<div class="ts">' + (sel.strategy === "full" ? "full suite (all test files)" : "no specific files") + '</div>';
  // Selection confidence (Story 6.8): degraded means the run may not fully cover the changes.
  // A degraded run can still PASS, so it gets its own amber badge — never the red failure style.
  const conf = res.confidence;
  const confClass = conf && conf.level === "high" ? "high" : "degraded";
  const confBlock = !conf ? "" :
    '<div class="section-title">confidence</div>'
    + '<div class="ts"><span class="badge ' + confClass + '">' + esc(conf.level) + '</span>'
    + (conf.level === "degraded" ? " — run a full pass before calling the feature done" : "") + '</div>'
    + ((conf.reasons && conf.reasons.length)
        ? '<ul class="files">' + conf.reasons.map((r) => '<li>' + esc(r) + '</li>').join("") + '</ul>'
        : "");
  // Per-test detail (Story 6.1): list every case that ran, badged by status. Failures still show
  // their message/stack in the dedicated section below.
  const allTests = res.tests || [];
  const testStatusClass = (s) => (s === "passed" ? "ok" : s === "failed" ? "fail" : "skip");
  // Collapsed by default (no "open" attribute) — the tests list can be long and failures (below)
  // already surface what needs attention first.
  const testsBlock = !allTests.length ? "" :
    '<details><summary>tests (' + allTests.length + (res.testsTruncated ? "+, truncated" : "") + ')</summary>'
    + '<ul class="tests">' + allTests.map((t) =>
        '<li><span class="' + testStatusClass(t.status) + '">' + esc(t.status) + '</span> '
        + esc(t.name) + ' <span class="loc">' + esc(relPath(t.file, root)) + '</span></li>').join("") + '</ul>'
    + '</details>';
  // Coverage report (Story 6.10): a COMBINED whole-project picture (union of each test file's
  // latest measurement) with its own confidence — degraded when a changed source is unmeasured —
  // and per-file fresh/stale tags.
  const cov = res.coverage;
  const pctCell = (v) => (v == null ? "–" : (Math.round(v * 10) / 10) + "%");
  const covTag = (f) => (f.stale ? ' <span class="badge degraded">stale</span>'
    : f.fresh ? ' <span class="badge high">fresh</span>' : "");
  const covConf = cov && cov.confidence;
  const covConfLine = !covConf ? "" :
    '<div class="ts"><span class="badge ' + (covConf.level === "high" ? "high" : "degraded") + '">'
    + esc(covConf.level) + '</span>'
    + (covConf.level === "degraded" ? " — coverage numbers may be stale; run a full coverage pass" : "")
    + '</div>'
    + ((covConf.reasons && covConf.reasons.length)
        ? '<ul class="files">' + covConf.reasons.map((r) => '<li>' + esc(r) + '</li>').join("") + '</ul>'
        : "");
  // Threshold gate (AC4): met/failed is only asserted at high confidence; degraded => "run full".
  const gateLine = !cov || !cov.thresholds ? "" :
    '<div class="ts">gate: '
    + (cov.thresholdsMet === undefined
        ? '<span class="badge degraded">unconfirmed</span> — coverage may be stale; run a full coverage pass'
        : cov.thresholdsMet
          ? '<span class="badge high">met</span>'
          : '<span class="badge degraded">failed</span>')
    + ' <span class="loc">(thresholds: '
    + ["statements", "branches", "functions", "lines"]
        .filter((m) => cov.thresholds[m] != null)
        .map((m) => m + " " + cov.thresholds[m] + "%")
        .join(", ")
    + ')</span></div>';
  const covBlock = !cov ? "" :
    '<div class="section-title">coverage' + (cov.combined ? " (combined)" : "") + '</div>'
    + '<div class="detail-grid">'
    + kv("statements", pctCell(cov.total.statements)) + kv("branches", pctCell(cov.total.branches))
    + kv("functions", pctCell(cov.total.functions)) + kv("lines", pctCell(cov.total.lines))
    + '</div>'
    + gateLine
    + covConfLine
    + ((cov.files && cov.files.length)
        ? '<table class="runs"><thead><tr><th>file</th><th>stmts</th><th>branch</th><th>funcs</th><th>lines</th></tr></thead><tbody>'
          + cov.files.map((f) =>
              '<tr><td>' + esc(relPath(f.file, root)) + covTag(f) + '</td><td>' + pctCell(f.statements) + '</td><td>'
              + pctCell(f.branches) + '</td><td>' + pctCell(f.functions) + '</td><td>'
              + pctCell(f.lines) + '</td></tr>').join("")
          + '</tbody></table>'
        : "");
  const fails = (rec.failures && rec.failures.length)
    ? '<div class="section-title">failures</div>' + rec.failures.map((f) =>
        '<div class="fail-item"><div class="name">' + esc(f.name) + '</div>'
        + '<div class="loc">' + esc(relPath(f.file, root)) + '</div>'
        + (f.message ? '<pre>' + esc(f.message) + '</pre>' : "")
        + (f.stack ? '<pre>' + esc(f.stack) + '</pre>' : "") + '</div>').join("")
    : (rec.status === "error" ? '<div class="section-title">error</div><pre>' + esc(rec.error || "") + '</pre>' : "");
  // Failures render right after the status grid — the thing you came to look at — ahead of
  // confidence/coverage. Selection and Tests are collapsed by default (both can be long, and
  // are lower-signal than failures/confidence/coverage at a glance).
  viewTop.innerHTML = back
    + '<h2 class="mono">run ' + esc(String(runId).slice(0, 8)) + '…</h2>'
    + '<div class="ts">' + fmtTime(rec.startedAt) + ' · ' + esc(sel.reason || "") + '</div>'
    + grid
    + fails
    + confBlock
    + covBlock
    + '<details><summary>selection (' + esc(sel.strategy || "?") + ')</summary>' + files + '</details>'
    + testsBlock;
}

// The data a given route's render actually depends on -- used by the SSE handler below to skip a
// redundant render() entirely when a push carries nothing relevant to what's currently on screen.
// A "project" route (project view, or either run-detail view) depends on that one project's whole
// entry (its run/live/runs all ride along); the list route depends on the full project array.
function relevantRouteData(p) {
  if (p[0] === "project") {
    const pid = decodeURIComponent(p[1]);
    return (snapshot.projects || []).find((x) => x.projectId === pid);
  }
  return snapshot.projects;
}

// Last route+data render() actually ran with -- a cheap JSON-string comparison (not DOM diffing)
// lets the SSE handler tell "nothing relevant changed" apart from "something did" without ever
// touching viewTop/viewBottom for the former. Kept in sync at the top of render() itself, so it's
// correct whether render() was reached via the SSE short-circuit below, a hashchange navigation,
// or the initial page load -- a mismatch (e.g. right after navigating) is the safe default and
// simply costs one extra render, never a missed one.
let lastRouteKey = null;
let lastRouteDataJSON = null;

function render() {
  const p = routeParts();
  lastRouteKey = p.join("/");
  lastRouteDataJSON = JSON.stringify(relevantRouteData(p));
  if (p[0] === "project" && p[2] === "run") return renderRun(decodeURIComponent(p[1]), decodeURIComponent(p[3]));
  if (p[0] === "project") return renderProject(decodeURIComponent(p[1]));
  return renderList();
}

window.addEventListener("hashchange", render);

function connect() {
  const es = new EventSource("/ui/events");
  es.onopen = () => live.classList.add("live");
  es.onmessage = (e) => {
    try { snapshot = JSON.parse(e.data); } catch (_) { return; }
    // Unconditional, regardless of the route short-circuit below -- the clock must keep ticking
    // even on a push whose route-relevant data happens to be unchanged (found via adversarial
    // review: it used to live inside renderList(), so skipping render() on such a push silently
    // froze it even though the server kept sending a fresh serverTime on every message).
    document.getElementById("clock").textContent = fmtTime(snapshot.serverTime);
    const p = routeParts();
    // Every route re-renders from the freshly-pushed snapshot except a run detail, which is
    // immutable once recorded (its own record never changes after the run completes) -- UNLESS
    // it's the run currently in flight (viewingLiveRunId), which needs live re-renders same as
    // the project page. render() re-derives isLive from this fresh snapshot, so the one push where
    // a live run just finished still falls through to fetching its now-final RunRecord instead of
    // being stuck on the last "running…" frame.
    if (p[0] === "project" && p[2] === "run" && decodeURIComponent(p[3]) !== viewingLiveRunId) return;
    // Route-level short-circuit: this push may be for a different project's card/row entirely (the
    // SSE stream fans out every test-progress event, across every project, to every tab) -- when
    // this route's own relevant data is byte-for-byte unchanged, skip render() (and therefore every
    // DOM touch under viewTop/viewBottom) entirely.
    const routeKey = p.join("/");
    if (routeKey === lastRouteKey && JSON.stringify(relevantRouteData(p)) === lastRouteDataJSON) return;
    render();
  };
  es.onerror = () => { live.classList.remove("live"); };
}
connect();
render();
</script>
</body>
</html>`;
