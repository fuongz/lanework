// The offline Lanework MCP server. Run it with `runLocalMcpServer()`. `main.ts`
// is the bundle entry (`dist/electron/mcp-local/server.cjs`), and the plugin's
// `lanework mcp` calls the same function.
//
// NOTE: No Electron here. It runs under plain Node: the app's, with
// `ELECTRON_RUN_AS_NODE=1`, or the user's.
export { runLocalMcpServer } from "./server";
