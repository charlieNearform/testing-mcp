import { Command } from "commander";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
} from "../daemon/index.js";

const program = new Command();
program.name("test-mcp").description("MCP test orchestration daemon").version("0.0.0");

program
  .command("init")
  .description("Initialize .test-mcp in a consumer project (Story 1.3)")
  .action(() => {
    console.log("test-mcp init: already initialized (this repo IS the package)");
  });

program
  .command("register")
  .description("Register project with daemon (Story 1.3)")
  .action(() => {
    console.log("test-mcp register: not implemented (Story 1.3)");
    process.exit(1);
  });

program
  .command("start")
  .description("Start singleton daemon (Story 1.1)")
  .action(async () => {
    try {
      const h = await startDaemon();
      if (h.alreadyRunning) {
        console.log(`test-mcp daemon already running (pid ${h.pid}, port ${h.port})`);
        process.exit(0);
      }
      console.log(`test-mcp daemon started (pid ${h.pid}, port ${h.port})`);
      const shutdown = async () => {
        await h.close();
        process.exit(0);
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    } catch (err) {
      console.error(`test-mcp start: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("stop")
  .description("Stop daemon (Story 1.1)")
  .action(async () => {
    try {
      const r = await stopDaemon();
      if (r.stopped) {
        console.log(`test-mcp daemon stopped (pid ${r.pid})`);
        process.exit(0);
      }
      if (r.reason === "timeout") {
        console.error(`test-mcp stop: daemon (pid ${r.pid}) did not shut down in time`);
        process.exit(1);
      }
      console.log("test-mcp daemon not running");
      process.exit(0);
    } catch (err) {
      console.error(`test-mcp stop: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Daemon status (Story 1.1)")
  .action(async () => {
    try {
      const s = await getDaemonStatus();
      console.log(
        s.running
          ? `test-mcp daemon: running (pid ${s.pid}, port ${s.port}, registered projects: ${s.registeredProjects.length})`
          : "test-mcp daemon: stopped"
      );
      process.exit(0);
    } catch (err) {
      console.error(`test-mcp status: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// Default action: show help when no command provided
if (!process.argv.slice(2).length) {
  program.help();
}

program.parse();
