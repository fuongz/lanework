// Bundle entry: `dist/electron/mcp-local/server.cjs`. Agent configs launch it as
// `ELECTRON_RUN_AS_NODE=1 <app> server.cjs` (FE-52/W1 writes that entry); it
// serves MCP on stdio until the client closes stdin.
//
// ⚠️ stdout is the protocol. A failure to start is said on stderr, with a
// non-zero exit, so the client shows the server as failed rather than hung.
import { runLocalMcpServer } from "./server";

// ⚠️ No `process.exit()` on the way out: stdout to a pipe may still hold the
// last answer, and an exit would drop it. The loop drains and ends by itself.
runLocalMcpServer().catch((error: unknown) => {
  process.stderr.write(
    `lanework mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
