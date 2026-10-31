// Lanework's own record of agent conversations (FE-112): one SQLite file,
// `~/.lanew/lw.db`, that the rail lists from and a Pull fills from the CLIs'
// own files.
//
// NOTE: No Electron here, as in `local-store/`: main opens it, and a spec
// drives it under plain Node or Bun against a temporary file.

export { userVersion } from "../local-store/schema";
export { migrate, SCHEMA_VERSION } from "./schema";
export {
  type OpenOptions,
  openSessionStore,
  parseSessionKey,
  SessionStore,
  sessionKey,
} from "./store";
export * from "./types";
