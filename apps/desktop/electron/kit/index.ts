// lanework-kit's core (FE-152): the coding-search tools the app's socket,
// the lanework-kit MCP server and `lwk` all run. No Electron import anywhere
// in here, nor any main-process module that has one.
export {
  type FileListing,
  type FindFilesParams,
  findFiles,
  isKitMethod,
  KIT_LIMITS,
  KIT_METHODS,
  type KitContext,
  type KitHandler,
  type KitMethod,
  type ListFilesParams,
  listFiles,
  type SearchSessionsParams,
  type SearchStructuralParams,
  type SearchTextParams,
  searchSessions,
  searchStructural,
  searchText,
} from "./core";
export { KitError, type KitErrorCode, toKitError } from "./errors";
export {
  appNatives,
  type KitNatives,
  nativesFrom,
  noNatives,
} from "./natives";
export { isWithin, realRoots, resolveFolder } from "./scope";
export {
  STRUCTURAL_LANGS,
  StructuralPatternError,
  type StructuralRunOptions,
  StructuralUnavailableError,
  searchStructuralIn,
} from "./structural";
