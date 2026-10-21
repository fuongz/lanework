// The local board: one SQLite file, `~/.lanew/data.sqlite`, that the main
// process, the offline MCP server and the checkpoint hook all open.
//
// NOTE: No Electron here, ever: the MCP and hook entries import this module
// and run under plain Node. `../main/paths` and
// `../main/workspaces/review-defaults` are the only app files it reads, and
// both are Electron-free.

export { openDatabase } from "./driver";
export { normalizeRepo } from "./ids";
export { migrate, SCHEMA_VERSION, userVersion } from "./schema";
export {
  LocalStore,
  localStorePath,
  type OpenOptions,
  openLocalStore,
} from "./store";
export * from "./types";
