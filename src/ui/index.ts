import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectRegistry } from "../registry/project-registry.js";
import type { Orchestrator } from "../orchestrator/index.js";

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
  main { padding:24px; display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .card h2 { font-size:14px; margin:0 0 4px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .path { color:var(--muted); font-size:12px; word-break:break-all; margin-bottom:12px; }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600; }
  .badge.idle{ background:#21262d; color:var(--muted); }
  .badge.running{ background:rgba(210,153,34,.15); color:var(--run); }
  .badge.complete{ background:rgba(63,185,80,.15); color:var(--ok); }
  .badge.error{ background:rgba(248,81,73,.15); color:var(--fail); }
  .summary { margin-top:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .summary.fail { color:var(--fail); }
  .counts { margin-top:10px; display:flex; gap:14px; font-size:13px; }
  .counts b.ok{ color:var(--ok); } .counts b.fail{ color:var(--fail); } .counts b.skip{ color:var(--muted); }
  .bar { margin-top:10px; height:6px; border-radius:3px; background:#21262d; overflow:hidden; }
  .bar > i { display:block; height:100%; background:var(--run); transition:width .2s; }
  .empty { color:var(--muted); padding:40px; text-align:center; grid-column:1/-1; }
  .ts { color:var(--muted); font-size:11px; margin-top:10px; }
</style>
</head>
<body>
<header><span class="dot" id="live"></span><h1>test-mcp</h1><span id="clock" style="color:var(--muted);font-size:12px;"></span></header>
<main id="app"><div class="empty">Connecting…</div></main>
<script>
const app = document.getElementById("app");
const live = document.getElementById("live");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function card(p) {
  const r = p.run || {};
  const pct = r.progress && r.progress.total ? Math.round(100 * r.progress.completed / r.progress.total) : 0;
  const bar = r.state === "running" ? '<div class="bar"><i style="width:'+pct+'%"></i></div>' : "";
  const counts = (r.total != null) ? '<div class="counts"><span>total <b>'+r.total+'</b></span>'
    + '<span>pass <b class="ok">'+(r.passed||0)+'</b></span>'
    + '<span>fail <b class="fail">'+(r.failed||0)+'</b></span></div>' : "";
  const summary = r.summary ? '<div class="summary '+(r.failed?'fail':'')+'">'+esc(r.summary)+'</div>' : "";
  const ts = r.updatedAt ? '<div class="ts">updated '+new Date(r.updatedAt).toLocaleTimeString()+'</div>' : "";
  return '<div class="card"><h2>'+esc(p.projectId)+'</h2><div class="path">'+esc(p.path)+'</div>'
    + '<span class="badge '+esc(r.state||"idle")+'">'+esc(r.state||"idle")+'</span>'
    + bar + counts + summary + ts + '</div>';
}
function render(snap) {
  const ps = snap.projects || [];
  document.getElementById("clock").textContent = new Date(snap.serverTime).toLocaleTimeString();
  app.innerHTML = ps.length ? ps.map(card).join("") : '<div class="empty">No projects registered.</div>';
}
function connect() {
  const es = new EventSource("/ui/events");
  es.onopen = () => live.classList.add("live");
  es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch {} };
  es.onerror = () => { live.classList.remove("live"); /* EventSource auto-reconnects */ };
}
connect();
</script>
</body>
</html>`;
