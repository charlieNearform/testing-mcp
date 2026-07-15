import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectRegistry } from "../registry/project-registry.js";
import type { Orchestrator, RunRecord } from "../orchestrator/index.js";

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

interface ProjectView {
  projectId: string;
  path: string;
  registryStatus: string;
  runCount: number;
  run: {
    state: string;
    progress?: { completed: number; total: number };
    summary?: string;
    success?: boolean;
    total?: number;
    passed?: number;
    failed?: number;
    updatedAt?: string;
  };
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
      return {
        projectId: p.projectId,
        path: p.path,
        registryStatus: p.status,
        runCount: deps.orchestrator?.getRunHistory(p.projectId).length ?? 0,
        run: {
          state: run.state,
          progress: run.progress,
          summary: r?.summary,
          success: r?.success,
          total: r?.total,
          passed: r?.passed,
          failed: r?.failed,
          updatedAt: run.updatedAt,
        },
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
  .counts { margin-top:10px; display:flex; gap:14px; font-size:13px; }
  .counts b.ok{ color:var(--ok); } .counts b.fail{ color:var(--fail); } .counts b.skip{ color:var(--muted); }
  .empty { color:var(--muted); padding:40px; text-align:center; }
  .ts { color:var(--muted); font-size:11px; margin-top:10px; }
  .back { color:var(--muted); font-size:13px; display:inline-block; margin-bottom:16px; }
  .back:hover { color:var(--text); }
  h2.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:15px; margin:0 0 4px; }
  .ok { color:var(--ok); } .fail { color:var(--fail); } .skip { color:var(--muted); }
  .banner { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:12px 14px; margin-bottom:16px;
    background:var(--card); border:1px solid var(--border); border-radius:8px; }
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
  ul.files { list-style:none; padding:0; margin:8px 0; }
  ul.files li { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; padding:3px 0; }
  .fail-item { background:var(--card); border:1px solid var(--border); border-left:3px solid var(--fail); border-radius:6px; padding:10px 12px; margin:8px 0; }
  .fail-item .name { font-weight:600; } .fail-item .loc { color:var(--muted); font-size:12px; margin-top:2px; }
  pre { background:#0d1117; border:1px solid var(--border); border-radius:6px; padding:10px; overflow-x:auto; font-size:12px; margin:8px 0 0; }
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

function card(p) {
  const r = p.run || {};
  const counts = (r.total != null) ? '<div class="counts"><span>total <b>' + r.total + '</b></span>'
    + '<span>pass <b class="ok">' + (r.passed || 0) + '</b></span>'
    + '<span>fail <b class="fail">' + (r.failed || 0) + '</b></span></div>' : "";
  const summary = r.summary ? '<div class="summary ' + (r.failed ? 'fail' : '') + '">' + esc(r.summary) + '</div>' : "";
  const n = p.runCount || 0;
  const runs = '<div class="ts">' + n + ' run' + (n === 1 ? '' : 's') + ' · click for history</div>';
  return '<a class="card" href="#/project/' + encodeURIComponent(p.projectId) + '">'
    + '<h2>' + esc(p.projectId) + '</h2><div class="path">' + esc(p.path) + '</div>'
    + badge(r.state) + counts + summary + runs + '</a>';
}

// Pinned live status banner for the project history view (Story 6.1, AC5) — the same state the
// root card shows, sourced from the SSE-updated snapshot.projects so it ticks live for free.
function statusBanner(pid) {
  const p = (snapshot.projects || []).find((x) => x.projectId === pid);
  if (!p) return "";
  const r = p.run || {};
  const counts = (r.total != null) ? '<div class="counts"><span>total <b>' + r.total + '</b></span>'
    + '<span>pass <b class="ok">' + (r.passed || 0) + '</b></span>'
    + '<span>fail <b class="fail">' + (r.failed || 0) + '</b></span></div>' : "";
  const summary = r.summary ? '<div class="summary ' + (r.failed ? 'fail' : '') + '">' + esc(r.summary) + '</div>' : "";
  return '<div class="banner">' + badge(r.state) + counts + summary + '</div>';
}

function renderList() {
  document.getElementById("clock").textContent = fmtTime(snapshot.serverTime);
  const ps = snapshot.projects || [];
  app.innerHTML = ps.length
    ? '<div class="grid">' + ps.map(card).join("") + '</div>'
    : '<div class="empty">No projects registered.</div>';
}

async function renderProject(pid) {
  const head = '<a class="back" href="#/">← projects</a><h2 class="mono">' + esc(pid) + '</h2>';
  app.innerHTML = head + '<div class="empty">Loading…</div>';
  let data;
  try { data = await getJSON("/ui/api/projects/" + encodeURIComponent(pid) + "/runs"); }
  catch (e) { app.innerHTML = head + '<div class="empty">Failed to load runs.</div>'; return; }
  const runs = data.runs || [];
  const banner = statusBanner(pid);
  if (!runs.length) { app.innerHTML = head + banner + '<div class="empty">No runs yet — trigger one via run_tests.</div>'; return; }
  const rows = runs.map((r) =>
    '<tr class="row" data-run="' + esc(r.runId) + '">'
    + '<td>' + fmtTime(r.startedAt) + '</td>'
    + '<td>' + badge(r.status) + '</td>'
    + '<td>' + esc(r.strategy || "") + '</td>'
    + '<td><b class="ok">' + (r.passed != null ? r.passed : "–") + '</b> / <b class="fail">' + (r.failed != null ? r.failed : "–") + '</b> of ' + (r.total != null ? r.total : "–") + '</td>'
    + '<td>' + (r.coverageLines != null ? (Math.round(r.coverageLines * 10) / 10) + '%' : "–") + '</td>'
    + '<td>' + fmtDur(r.durationMs) + '</td></tr>').join("");
  app.innerHTML = head + banner + '<table class="runs"><thead><tr><th>time</th><th>status</th><th>strategy</th><th>pass / fail</th><th>coverage</th><th>duration</th></tr></thead><tbody>' + rows + '</tbody></table>';
  app.querySelectorAll("tr.row").forEach((el) => {
    el.addEventListener("click", () => go("/project/" + encodeURIComponent(pid) + "/run/" + encodeURIComponent(el.getAttribute("data-run"))));
  });
}

async function renderRun(pid, runId) {
  const back = '<a class="back" href="#/project/' + encodeURIComponent(pid) + '">← runs</a>';
  app.innerHTML = back + '<div class="empty">Loading…</div>';
  let rec;
  try { rec = await getJSON("/ui/api/projects/" + encodeURIComponent(pid) + "/runs/" + encodeURIComponent(runId)); }
  catch (e) { app.innerHTML = back + '<div class="empty">Run not found (evicted from in-memory history?).</div>'; return; }
  const res = rec.result || {};
  const sel = res.selection || {};
  const kv = (k, v) => '<div class="kv"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  const resultCell = res.success == null ? "–" : (res.success ? '<span class="ok">pass</span>' : '<span class="fail">fail</span>');
  const grid = '<div class="detail-grid">'
    + kv("status", badge(rec.status)) + kv("result", resultCell)
    + kv("tests", res.total != null ? res.total : "–")
    + kv("passed", '<span class="ok">' + (res.passed != null ? res.passed : "–") + '</span>')
    + kv("failed", '<span class="fail">' + (res.failed != null ? res.failed : "–") + '</span>')
    + kv("duration", fmtDur(rec.durationMs)) + '</div>';
  const files = (sel.files && sel.files.length)
    ? '<ul class="files">' + sel.files.map((f) => '<li>' + esc(f) + '</li>').join("") + '</ul>'
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
  const testsBlock = !allTests.length ? "" :
    '<div class="section-title">tests (' + allTests.length + (res.testsTruncated ? "+, truncated" : "") + ')</div>'
    + '<ul class="tests">' + allTests.map((t) =>
        '<li><span class="' + testStatusClass(t.status) + '">' + esc(t.status) + '</span> '
        + esc(t.name) + ' <span class="loc">' + esc(t.file || "") + '</span></li>').join("") + '</ul>';
  // Coverage report (Story 6.3): overall % as stat tiles + a per-file table. Only present on
  // coverage runs.
  const cov = res.coverage;
  const pctCell = (v) => (v == null ? "–" : (Math.round(v * 10) / 10) + "%");
  const covBlock = !cov ? "" :
    '<div class="section-title">coverage</div>'
    + '<div class="detail-grid">'
    + kv("statements", pctCell(cov.total.statements)) + kv("branches", pctCell(cov.total.branches))
    + kv("functions", pctCell(cov.total.functions)) + kv("lines", pctCell(cov.total.lines))
    + '</div>'
    + ((cov.files && cov.files.length)
        ? '<table class="runs"><thead><tr><th>file</th><th>stmts</th><th>branch</th><th>funcs</th><th>lines</th></tr></thead><tbody>'
          + cov.files.map((f) =>
              '<tr><td>' + esc(f.file) + '</td><td>' + pctCell(f.statements) + '</td><td>'
              + pctCell(f.branches) + '</td><td>' + pctCell(f.functions) + '</td><td>'
              + pctCell(f.lines) + '</td></tr>').join("")
          + '</tbody></table>'
        : "");
  const fails = (rec.failures && rec.failures.length)
    ? '<div class="section-title">failures</div>' + rec.failures.map((f) =>
        '<div class="fail-item"><div class="name">' + esc(f.name) + '</div>'
        + '<div class="loc">' + esc(f.file || "") + '</div>'
        + (f.message ? '<pre>' + esc(f.message) + '</pre>' : "")
        + (f.stack ? '<pre>' + esc(f.stack) + '</pre>' : "") + '</div>').join("")
    : (rec.status === "error" ? '<div class="section-title">error</div><pre>' + esc(rec.error || "") + '</pre>' : "");
  app.innerHTML = back
    + '<h2 class="mono">run ' + esc(String(runId).slice(0, 8)) + '…</h2>'
    + '<div class="ts">' + fmtTime(rec.startedAt) + ' · ' + esc(sel.reason || "") + '</div>'
    + grid
    + '<div class="section-title">selection (' + esc(sel.strategy || "?") + ')</div>' + files
    + confBlock
    + covBlock
    + testsBlock
    + fails;
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
    // Live-refresh the list and the project history view; a run detail is immutable.
    if (p.length === 0) renderList();
    else if (p[0] === "project" && p.length === 1) render();
  };
  es.onerror = () => { live.classList.remove("live"); };
}
connect();
render();
</script>
</body>
</html>`;
