#!/usr/bin/env node
// PreToolUse(Bash) guard: block bare `python`/`python3`; require `uv run python`.
// Claude Code passes the tool call as JSON on stdin. Exit 2 rejects the command and
// feeds stderr back to the agent so it retries correctly.

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = JSON.parse(raw)?.tool_input?.command ?? "";
  } catch {
    process.exit(0); // can't parse -> don't block
  }

  // Split into individual commands (handles ; | || && & and newlines).
  const segments = cmd.split(/\n|;|\|\||&&|\||&/);

  // A segment invokes Python directly if, after optional `sudo`/`env VAR=…` prefixes,
  // its executable is python/python2/python3[.x] — unless it's `uv run …`.
  const invokesBarePython = (seg) =>
    /^\s*(sudo\s+)?(env\s+[^\s=]+=\S+\s+)*python(2|3(\.\d+)?)?\b/.test(seg) &&
    !/^\s*uv\s+run\b/.test(seg);

  if (segments.some(invokesBarePython)) {
    process.stderr.write(
      "Blocked: run Python through uv. Use `uv run python <script>` (or `uv run <tool>`), " +
        "never bare `python`/`python3`. See CLAUDE.md.\n",
    );
    process.exit(2);
  }
  process.exit(0);
});
