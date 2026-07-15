// A fake orchestrator worker for concurrency tests. On "run" it signals that it has
// started (by creating <TEST_MCP_STATE_DIR>/started) and then blocks until the test
// creates <TEST_MCP_STATE_DIR>/release, at which point it returns a trivial success.
import fs from "node:fs";
import path from "node:path";

const stateDir = process.env.TEST_MCP_STATE_DIR;

process.on("message", (msg) => {
  if (msg && msg.type === "run") {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "started"), msg.runId);
    const releasePath = path.join(stateDir, "release");
    const timer = setInterval(() => {
      if (fs.existsSync(releasePath)) {
        clearInterval(timer);
        process.send({
          type: "result",
          runId: msg.runId,
          result: {
            success: true,
            summary: "ok",
            duration: 1,
            total: 1,
            passed: 1,
            failed: 0,
            skipped: 0,
            failures: [],
            selection: { strategy: "full", reason: "ok", files: [] },
          },
        });
      }
    }, 10);
  } else if (msg && msg.type === "shutdown") {
    process.exit(0);
  }
});

process.send({ type: "ready" });
