// The offline Lanework MCP server (FE-52/W3). Run it with `runLocalMcpServer()`;
// `main.ts` is the bundle entry (`dist/electron/mcp-local/server.cjs`) and the
// plugin's `lanework mcp` calls the same function.
//
// ⚠️ No Electron here: it runs under plain Node (the app's, with
// `ELECTRON_RUN_AS_NODE=1`, or the user's).
export {
  agentSlug,
  handleLine,
  INSTRUCTIONS,
  LocalMcpSession,
  type RunOptions,
  runLocalMcpServer,
  SERVER_NAME,
  toolList,
} from "./server";
export { decisionState, TOOLS } from "./tools";
