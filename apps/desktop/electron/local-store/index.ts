// The local board (FE-52): one SQLite file, `~/.lanew/data.sqlite`, that the
// main process, the offline MCP server and the checkpoint hook all open.
//
// ⚠️ No Electron here, ever — the MCP and hook entries import this module and
// run under plain Node. `../main/paths` and `../main/workspaces/review-defaults`
// are the only app files it reads, and both are Electron-free.

export {
  buildDispatch,
  latestCheckpoint,
  streamWaves,
  toCard,
  toCardDetail,
} from "./cards";
export type { SqlDatabase, SqlStatement, SqlValue } from "./driver";
export { openDatabase, sqliteDriverName } from "./driver";
export { formatTaskId, normalizeRepo, slugify, uuidv7 } from "./ids";
export { migrate, SCHEMA_VERSION, userVersion } from "./schema";
export {
  DATA_FILE_NAME,
  defaultBoardConfig,
  LocalStore,
  localStorePath,
  type OpenOptions,
  openLocalStore,
} from "./store";
export * from "./types";
