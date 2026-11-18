// Bundle entry: `dist/electron/mcp-kit/server.cjs`. Agent configs launch it
// through `~/.lanew/bin/lanework-kit-mcp`, as `ELECTRON_RUN_AS_NODE=1 <app>
// server.cjs`, in the agent's own folder. It serves MCP on stdio until the
// client closes stdin.
//
// NOTE: stdout is the protocol. A failure to start goes to stderr with a
// non-zero exit, so the client shows the server as failed rather than hung.
import { runKitMcpServer } from "./server";

// NOTE: No `process.exit()` on the way out. stdout to a pipe may still hold the
// last answer, and an exit would drop it. The loop drains and ends by itself.
runKitMcpServer().catch((error: unknown) => {
  process.stderr.write(
    `lanework-kit mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
