import { Command } from "commander";

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
  .action(() => {
    console.log("test-mcp start: not implemented (Story 1.1)");
    process.exit(1);
  });

program
  .command("stop")
  .description("Stop daemon (Story 1.1)")
  .action(() => {
    console.log("test-mcp stop: not implemented (Story 1.1)");
    process.exit(1);
  });

program
  .command("status")
  .description("Daemon status (Story 1.1)")
  .action(() => {
    console.log("test-mcp status: not implemented (Story 1.1)");
    process.exit(1);
  });

// Default action: show help when no command provided
if (!process.argv.slice(2).length) {
  program.help();
}

program.parse();
