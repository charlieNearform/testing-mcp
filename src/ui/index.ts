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
  tests: Array<{ file: string; name: string; status: string }>;
  testsTruncated: boolean;
  testsShown: number;
  logTail: Array<{ stream: string; text: string; at: string }>;
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
        tests: live.tests.slice(-MAX_SNAPSHOT_TESTS),
        testsTruncated: live.testsTruncated,
        testsShown: Math.min(live.tests.length, MAX_SNAPSHOT_TESTS),
        logTail: live.log.slice(-MAX_SNAPSHOT_LOG_LINES),
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
      lastSeenRunId = current?.runId;
      const idx = !isNewRun && lastSeenLine ? currentLog.indexOf(lastSeenLine) : -1;
      const newLines = idx === -1 ? currentLog : currentLog.slice(idx + 1);
      if (!newLines.length) return;
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
  .kv { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
  .kv .k { color:var(--muted); font-size:11px; } .kv .v { font-size:15px; margin-top:2px; }
  .section-title { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; margin:22px 0 8px; }
  details > summary { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; margin:22px 0 8px; cursor:pointer; }
  ul.files { list-style:none; padding:0; margin:8px 0; }
  ul.files li { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; padding:3px 0; }
  .fail-item { background:var(--card); border:1px solid var(--border); border-left:3px solid var(--fail); border-radius:6px; padding:10px 12px; margin:8px 0; }
  .fail-item .name { font-weight:600; } .fail-item .loc { color:var(--muted); font-size:12px; margin-top:2px; }
  pre { background:#0d1117; border:1px solid var(--border); border-radius:6px; padding:10px; overflow-x:auto; font-size:12px; margin:8px 0 0; }
  #log-pre { max-height:320px; overflow-y:auto; white-space:pre-wrap; word-break:break-all; }
  .log-summary { display:flex; align-items:center; justify-content:space-between; }
  .log-summary label { font-weight:normal; text-transform:none; letter-spacing:0; cursor:pointer; }
</style>
</head>
<body>
<header><span class="dot" id="live"></span><h1>test-mcp</h1><span id="clock" style="color:var(--muted);font-size:12px;"></span></header>
<main id="app"><div class="empty">Connecting…</div></main>
<script>
const app = document.getElementById("app");
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

function card(p) {
  const r = p.run || {};
  const counts = (r.total != null) ? '<div class="counts">' + passTotal(r)
    + '<span class="ts">' + (p.totalTests || 0) + ' total tests</span></div>' : "";
  const summary = r.summary ? '<div class="summary ' + (r.failed ? 'fail' : '') + '">' + esc(r.summary) + '</div>' : "";
  const n = p.runCount || 0;
  const runs = '<div class="ts">' + n + ' run' + (n === 1 ? '' : 's') + ' · click for history</div>';
  return '<a class="card" href="#/project/' + encodeURIComponent(p.projectId) + '">'
    + '<h2>' + esc(p.projectId) + '</h2>' + projectLine(p.path)
    + badge(r.state) + counts + summary + runs + '</a>';
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

function renderList() {
  closeLogStream(); // leaving any project's running view -- never leak an open follow connection
  document.getElementById("clock").textContent = fmtTime(snapshot.serverTime);
  const ps = snapshot.projects || [];
  app.innerHTML = ps.length
    ? '<div class="grid">' + ps.map(card).join("") + '</div>'
    : '<div class="empty">No projects registered.</div>';
}

// Sourced from the SSE-pushed snapshot (like statusBanner) rather than a one-shot fetch, so the
// history table lands new rows live instead of only refreshing on the next manual navigation.
// Live per-test list (Story 8.7), grouped by file, shown only for a state:"running" project.
function liveTestsBlock(live, root) {
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
  return '<div class="section-title">live tests</div>' + rows + truncNote;
}

// Console log panel with a "follow" toggle (Story 8.7). Module-level UI state (not persisted --
// resets on reload), matching the existing no-framework/inline-JS simplicity of this page.
let followLog = true;
let logEventSource = null;
let logStreamProjectId = null;

function closeLogStream() {
  if (logEventSource) { logEventSource.close(); logEventSource = null; }
  logStreamProjectId = null;
}

function renderLogLines(lines, replace) {
  const pre = document.getElementById("log-pre");
  if (!pre || !lines.length) return;
  const html = lines.map((l) => '<span class="' + (l.stream === "stderr" ? "fail" : "") + '">' + esc(l.text) + '</span>').join("\\n");
  pre.innerHTML = replace ? html : (pre.innerHTML ? pre.innerHTML + "\\n" + html : html);
  if (followLog) pre.scrollTop = pre.scrollHeight;
}

// renderProject() rebuilds the whole DOM (including a fresh, empty log-pre element) on every SSE
// snapshot push, which can fire on every single test event -- so this always re-seeds the fresh
// node with the full current ring (replace=true, no duplication within one seed). It only opens
// a NEW EventSource when the project actually changes; reusing the existing one avoids tearing
// down and reconnecting on every re-render, which previously caused the same lines to be
// re-seeded AND re-appended by the freshly (re)connected stream's own first push (found via
// smoke-testing against a real project -- duplicate lines were visible in the log panel).
function connectLog(pid) {
  getJSON("/ui/api/projects/" + encodeURIComponent(pid) + "/log")
    .then((data) => renderLogLines(data.log || [], true))
    .catch(() => {});
  if (logStreamProjectId === pid) return;
  closeLogStream();
  logStreamProjectId = pid;
  logEventSource = new EventSource("/ui/api/projects/" + encodeURIComponent(pid) + "/log/events");
  logEventSource.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      renderLogLines(payload.log || [], !!payload.replace);
    } catch (_) { /* ignore */ }
  };
}

function logBlock() {
  return '<details open><summary class="log-summary"><span>console log</span>'
    + '<label><input type="checkbox" id="follow-log" ' + (followLog ? "checked" : "") + '> follow</label></summary>'
    + '<pre id="log-pre"></pre></details>';
}

function wireLogPanel(pid) {
  connectLog(pid);
  const checkbox = document.getElementById("follow-log");
  if (checkbox) checkbox.addEventListener("change", (e) => { followLog = e.target.checked; });
}

function renderProject(pid) {
  const p = (snapshot.projects || []).find((x) => x.projectId === pid);
  const head = '<a class="back" href="#/">← projects</a><h2 class="mono">' + esc(pid) + '</h2>' + projectLine(p && p.path);
  if (!p) { closeLogStream(); app.innerHTML = head + '<div class="empty">Loading…</div>'; return; }
  const runs = p.runs || [];
  const banner = statusBanner(pid);
  const running = p.run && p.run.state === "running";
  const liveBlock = running ? liveTestsBlock(p.live, p.path) + logBlock() : "";
  if (!runs.length) {
    app.innerHTML = head + banner + liveBlock + (running ? "" : '<div class="empty">No runs yet — trigger one via run_tests.</div>');
    if (running) wireLogPanel(pid); else closeLogStream();
    return;
  }
  const rows = runs.map((r) =>
    '<tr class="row" data-run="' + esc(r.runId) + '">'
    + '<td>' + fmtTime(r.startedAt) + '</td>'
    + '<td>' + badge(r.status) + '</td>'
    + '<td>' + esc(r.strategy || "") + '</td>'
    + '<td>' + (r.total != null ? passTotal(r) : "–") + '</td>'
    + '<td>' + (r.coverageLines != null ? (Math.round(r.coverageLines * 10) / 10) + '%' : "–") + '</td>'
    + '<td>' + fmtDur(r.durationMs) + '</td></tr>').join("");
  app.innerHTML = head + banner + liveBlock
    + '<table class="runs"><thead><tr><th>time</th><th>status</th><th>strategy</th><th>pass / executed</th><th>coverage</th><th>duration</th></tr></thead><tbody>' + rows + '</tbody></table>';
  if (running) wireLogPanel(pid); else closeLogStream();
  app.querySelectorAll("tr.row").forEach((el) => {
    el.addEventListener("click", () => go("/project/" + encodeURIComponent(pid) + "/run/" + encodeURIComponent(el.getAttribute("data-run"))));
  });
}

async function renderRun(pid, runId) {
  closeLogStream(); // leaving any project's running view -- never leak an open follow connection
  const proj = (snapshot.projects || []).find((x) => x.projectId === pid);
  const root = proj ? proj.path : "";
  const back = '<a class="back" href="#/project/' + encodeURIComponent(pid) + '">← runs</a>' + projectLine(root);
  app.innerHTML = back + '<div class="empty">Loading…</div>';
  let rec;
  try { rec = await getJSON("/ui/api/projects/" + encodeURIComponent(pid) + "/runs/" + encodeURIComponent(runId)); }
  catch (e) { app.innerHTML = back + '<div class="empty">Run not found (evicted from in-memory history?).</div>'; return; }
  const res = rec.result || {};
  const sel = res.selection || {};
  const kv = (k, v) => '<div class="kv"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
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
  app.innerHTML = back
    + '<h2 class="mono">run ' + esc(String(runId).slice(0, 8)) + '…</h2>'
    + '<div class="ts">' + fmtTime(rec.startedAt) + ' · ' + esc(sel.reason || "") + '</div>'
    + grid
    + fails
    + confBlock
    + covBlock
    + '<details><summary>selection (' + esc(sel.strategy || "?") + ')</summary>' + files + '</details>'
    + testsBlock;
}

function render() {
  const p = routeParts();
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
    const p = routeParts();
    // Every route re-renders from the freshly-pushed snapshot except a run detail, which is
    // immutable once recorded (its own record never changes after the run completes).
    if (p[0] === "project" && p[2] === "run") return;
    render();
  };
  es.onerror = () => { live.classList.remove("live"); };
}
connect();
render();
</script>
</body>
</html>`;
