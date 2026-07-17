// A fake orchestrator worker for concurrency tests. On "run" it signals that it has
// started (by creating <TEST_MCP_STATE_DIR>/started) and then blocks until the test
// creates <TEST_MCP_STATE_DIR>/release, at which point it returns a trivial success.
// If <TEST_MCP_STATE_DIR>/crash appears instead, it SIGKILLs itself -- simulating an
// OS OOM-kill so tests can assert on the orchestrator's exit(code, signal) handling.
//
// Story 8.x sentinel files (each is a one-shot trigger: written by the test, consumed and
// deleted by this fixture on its next poll tick, so a test can write the same filename again
// later to send another message of that type):
//   send-config       -- content is the numeric testTimeoutMs -> sends a `config` message
//   send-case-start   -- content is JSON {file, name} -> sends a `case-start` message
//   send-case-result  -- content is JSON {file, name, status} -> sends a `case-result` message
//   send-stdout       -- content is written verbatim (plus a newline) to this process's stdout
//   send-stderr       -- content is written verbatim (plus a newline) to this process's stderr
import fs from "node:fs";
import path from "node:path";

const stateDir = process.env.TEST_MCP_STATE_DIR;

function consumeTrigger(filePath, onContent) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  fs.rmSync(filePath, { force: true });
  try {
    onContent(content);
  } catch (e) {
    // A test writing a new value mid-read is a caller bug, not something that should crash this
    // fixture process (which would surface as a confusing "worker exited" failure instead).
    process.stderr.write(`blocking-worker fixture: ignoring bad trigger content: ${e}\n`);
  }
}

process.on("message", (msg) => {
  if (msg && msg.type === "run") {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "started"), msg.runId);
    const releasePath = path.join(stateDir, "release");
    const crashPath = path.join(stateDir, "crash");
    const sendConfigPath = path.join(stateDir, "send-config");
    const sendCaseStartPath = path.join(stateDir, "send-case-start");
    const sendCaseResultPath = path.join(stateDir, "send-case-result");
    const sendStdoutPath = path.join(stateDir, "send-stdout");
    const sendStderrPath = path.join(stateDir, "send-stderr");
    const timer = setInterval(() => {
      if (fs.existsSync(crashPath)) {
        clearInterval(timer);
        process.kill(process.pid, "SIGKILL");
        return;
      }
      consumeTrigger(sendConfigPath, (content) => {
        process.send({ type: "config", runId: msg.runId, testTimeoutMs: Number(content) });
      });
      consumeTrigger(sendCaseStartPath, (content) => {
        const { file, name } = JSON.parse(content);
        process.send({ type: "case-start", runId: msg.runId, file, name });
      });
      consumeTrigger(sendCaseResultPath, (content) => {
        const { file, name, status } = JSON.parse(content);
        process.send({ type: "case-result", runId: msg.runId, file, name, status });
      });
      consumeTrigger(sendStdoutPath, (content) => {
        process.stdout.write(content + "\n");
      });
      consumeTrigger(sendStderrPath, (content) => {
        process.stderr.write(content + "\n");
      });
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
    }, 4);
  } else if (msg && msg.type === "shutdown") {
    process.exit(0);
  }
});

process.send({ type: "ready" });
