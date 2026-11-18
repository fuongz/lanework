// Bundle entry: `dist/electron/mcp-control/server.cjs`. A conversation the
// app starts gets it through `~/.lanew/bin/lanework-control-mcp`, as
// `ELECTRON_RUN_AS_NODE=1 <app> server.cjs`, attached by flags on that one
// process (never written to an agent's config). It serves MCP on stdio until
// the client closes stdin.
//
// NOTE: stdout is the protocol. A failure to start goes to stderr with a
// non-zero exit, so the client shows the server as failed rather than hung.
import { runControlMcpServer } from "./server";

// NOTE: No `process.exit()` on the way out. stdout to a pipe may still hold the
// last answer, and an exit would drop it. The loop drains and ends by itself.
runControlMcpServer().catch((error: unknown) => {
  process.stderr.write(
    `lanework-control mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
