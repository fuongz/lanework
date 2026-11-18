// The kit's tools (FE-152): find_files, search_text, search_structural,
// list_files and search_sessions, one function each, and `KIT_METHODS`, the
// one dispatch the app's socket, the lanework-kit MCP server and `lwk` share.
//
// Every tool takes `folder` (the caller's cwd when unset) and refuses one
// outside the caller's roots (`./scope.ts`). Each failure is a `KitError`
// with a code.
import { resolve } from "node:path";
import { KIT_TOOL_LIMITS } from "@lanework/contracts";
import type {
  FileHit,
  FileMatch,
  SessionMatch,
  StructuralLang,
} from "../../shared/fs-search";
import { findFiles as fffFind } from "../main/file-finder/finder";
import {
  listFiles as fsListFiles,
  searchText as rgSearch,
} from "../main/fs-kit";
import { searchSessions as searchTranscripts } from "../main/transcripts/search";
import { KitError, toKitError } from "./errors";
import { appNatives, type KitNatives } from "./natives";
import { realRoots, resolveFolder } from "./scope";
import { STRUCTURAL_LANGS, searchStructuralIn } from "./structural";

/** Who is calling, and what it may reach. */
export interface KitContext {
  /** Absolute; the folder a tool runs in when it names none. */
  cwd: string;
  /** Absolute folders a tool may run in or under; `[cwd]` when unset. */
  roots?: readonly string[];
  /** Aborts the call: the child processes are killed. */
  signal?: AbortSignal;
  /** Which natives to use; {@link appNatives} when unset. */
  natives?: KitNatives;
  /** The home folder the agents' transcripts are under; the user's when unset. */
  home?: string;
}

export interface FindFilesParams {
  query: string;
  folder?: string;
  limit?: number;
}

export interface SearchTextParams {
  query: string;
  folder?: string;
  regex?: boolean;
  case_sensitive?: boolean;
  globs?: string[];
  limit?: number;
}

export interface SearchStructuralParams {
  pattern: string;
  folder?: string;
  lang?: StructuralLang;
  limit?: number;
}

export interface ListFilesParams {
  folder?: string;
  limit?: number;
}

export interface SearchSessionsParams {
  query: string;
  folder?: string;
  limit?: number;
}

/** {@link listFiles}'s answer. */
export interface FileListing {
  /** Relative to the folder, `/`-separated, sorted. */
  files: string[];
  /** More files were there than `limit`, or the listing ran out of time. */
  truncated: boolean;
}

/** The longest query or pattern taken, in characters. */
export const QUERY_MAX = 1_000;
/** The most globs one search takes. */
export const GLOBS_MAX = 50;
/** The longest glob taken, in characters. */
export const GLOB_MAX = 500;
/** The longest folder path taken, in characters. */
const FOLDER_MAX = 4_096;

/** Each tool's `limit`: its default and its maximum. */
/**
 * Each tool's default and largest `limit`: the contract's
 * (`KIT_TOOL_LIMITS`, lanework-dev/contracts), so the MCP schema, `lwk` and the
 * socket never disagree.
 */
export const KIT_LIMITS = KIT_TOOL_LIMITS;

// ── Params ──────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

function objectOf(value: unknown): Raw {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new KitError("invalid", "The params must be an object.");
  return value as Raw;
}

function text(raw: Raw, key: string, max = QUERY_MAX): string {
  const value = raw[key];
  if (typeof value !== "string")
    throw new KitError("invalid", `${key} must be a string.`);
  if (value.length > max)
    throw new KitError("invalid", `${key} is too long (${max} at most).`);
  return value;
}

function optionalText(raw: Raw, key: string, max: number): string | undefined {
  if (raw[key] === undefined || raw[key] === null) return undefined;
  return text(raw, key, max);
}

function flag(raw: Raw, key: string): boolean | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean")
    throw new KitError("invalid", `${key} must be true or false.`);
  return value;
}

/** `limit`, defaulted, and refused outside `1..max`. */
function limitOf(value: unknown, limits: { default: number; max: number }) {
  if (value === undefined || value === null) return limits.default;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > limits.max
  )
    throw new KitError(
      "invalid",
      `limit must be a whole number from 1 to ${limits.max}.`,
    );
  return value;
}

function globsOf(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > GLOBS_MAX)
    throw new KitError(
      "invalid",
      `globs must be a list of ${GLOBS_MAX} at most.`,
    );
  for (const glob of value)
    if (typeof glob !== "string" || !glob || glob.length > GLOB_MAX)
      throw new KitError("invalid", "Each glob must be a non-empty string.");
  return value as string[];
}

function langOf(value: unknown): StructuralLang | undefined {
  if (value === undefined || value === null) return undefined;
  if (!(STRUCTURAL_LANGS as readonly unknown[]).includes(value))
    throw new KitError(
      "invalid",
      `lang must be one of ${STRUCTURAL_LANGS.join(", ")}.`,
    );
  return value as StructuralLang;
}

// ── Tools ───────────────────────────────────────────────────────────────────

/** Run `body`, every failure as a {@link KitError}. */
async function guarded<T>(ctx: KitContext, body: () => Promise<T>): Promise<T> {
  try {
    if (ctx.signal?.aborted)
      throw new KitError("aborted", "The call was aborted.");
    return await body();
  } catch (error) {
    throw toKitError(error, ctx.signal);
  }
}

/** The folder `folder` names for this caller, checked against its roots. */
function folderFor(folder: string | undefined, ctx: KitContext) {
  return resolveFolder(folder, ctx.cwd, ctx.roots ?? [ctx.cwd]);
}

/** How well `query` matches `path`: higher is better, null is no match. */
function fuzzyScore(path: string, query: string): number | null {
  if (!query) return 0;
  const hay = path.toLowerCase();
  const needle = query.toLowerCase();
  const base = hay.slice(hay.lastIndexOf("/") + 1);
  if (base.startsWith(needle)) return 1000 - hay.length;
  if (base.includes(needle)) return 800 - hay.length;
  const at = hay.indexOf(needle);
  if (at >= 0) return 600 - at - hay.length / 10;
  // Every character in order.
  let from = 0;
  let gaps = 0;
  for (const char of needle) {
    const found = hay.indexOf(char, from);
    if (found < 0) return null;
    gaps += found - from;
    from = found + 1;
  }
  return 300 - gaps - hay.length / 10;
}

/**
 * Files whose path fuzzily matches `query`, best first.
 *
 * fff's index when the natives allow it and it is ready (the app's is warm);
 * otherwise fs-kit's file list, ranked here.
 */
export function findFiles(
  params: FindFilesParams,
  ctx: KitContext,
): Promise<FileHit[]> {
  return guarded(ctx, async () => {
    const root = await folderFor(params.folder, ctx);
    const limit = Math.min(
      params.limit ?? KIT_LIMITS.find_files.default,
      KIT_LIMITS.find_files.max,
    );
    if ((ctx.natives ?? appNatives).fff) {
      const found = await fffFind(root, params.query, limit);
      if (found) return found;
    }
    const { files } = await fsListFiles(root, { signal: ctx.signal });
    const hits: FileHit[] = [];
    for (const path of files) {
      const score = fuzzyScore(path, params.query);
      if (score !== null) hits.push({ path, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  });
}

/** Lines matching `query` (a literal unless `regex`), one entry per file. */
export function searchText(
  params: SearchTextParams,
  ctx: KitContext,
): Promise<FileMatch[]> {
  return guarded(ctx, async () => {
    const root = await folderFor(params.folder, ctx);
    return rgSearch(root, params.query, {
      regex: params.regex,
      caseSensitive: params.case_sensitive,
      globs: params.globs,
      maxFiles: Math.min(
        params.limit ?? KIT_LIMITS.search_text.default,
        KIT_LIMITS.search_text.max,
      ),
      signal: ctx.signal,
    });
  });
}

/** Code matching the ast-grep `pattern`, one entry per file. */
export function searchStructural(
  params: SearchStructuralParams,
  ctx: KitContext,
): Promise<FileMatch[]> {
  return guarded(ctx, async () => {
    const root = await folderFor(params.folder, ctx);
    return searchStructuralIn(root, params.pattern, {
      lang: params.lang,
      maxFiles: params.limit ?? KIT_LIMITS.search_structural.default,
      natives: ctx.natives,
      signal: ctx.signal,
    });
  });
}

/** The folder's files, `.gitignore` respected, sorted. */
export function listFiles(
  params: ListFilesParams,
  ctx: KitContext,
): Promise<FileListing> {
  return guarded(ctx, async () => {
    const root = await folderFor(params.folder, ctx);
    const limit = Math.min(
      params.limit ?? KIT_LIMITS.list_files.default,
      KIT_LIMITS.list_files.max,
    );
    const listed = await fsListFiles(root, {
      maxFiles: limit,
      signal: ctx.signal,
    });
    return { files: listed.files.sort(), truncated: listed.truncated };
  });
}

/**
 * The agents' sessions that said `query`, newest first: those run in
 * `folder`, or in any of the caller's roots when unset.
 *
 * NOTE: A transcript keeps the folder as the CLI saw it, which may be a
 * symlink's path: both that and the real path are matched.
 */
export function searchSessions(
  params: SearchSessionsParams,
  ctx: KitContext,
): Promise<SessionMatch[]> {
  return guarded(ctx, async () => {
    const roots = ctx.roots ?? [ctx.cwd];
    let folders: string[];
    if (params.folder !== undefined) {
      const real = await folderFor(params.folder, ctx);
      folders = [resolve(ctx.cwd, params.folder), real];
    } else {
      // Refuses a root outside scope the same way a folder is refused.
      await folderFor(undefined, ctx);
      folders = [...roots, ...(await realRoots(roots))];
    }
    return searchTranscripts(params.query, {
      folders: [...new Set(folders)],
      limit: Math.min(
        params.limit ?? KIT_LIMITS.search_sessions.default,
        KIT_LIMITS.search_sessions.max,
      ),
      home: ctx.home,
      signal: ctx.signal,
    });
  });
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/** A kit tool, as the socket, the MCP server and `lwk` name it. */
export type KitMethod =
  | "find_files"
  | "search_text"
  | "search_structural"
  | "list_files"
  | "search_sessions";

/** A tool that checks its own params; every failure is a `KitError`. */
export type KitHandler = (params: unknown, ctx: KitContext) => Promise<unknown>;

/** Run `body` on params checked by `parse`, a bad one as `invalid`. */
function checked<T>(
  parse: (raw: Raw) => T,
  body: (params: T, ctx: KitContext) => Promise<unknown>,
): KitHandler {
  return async (params, ctx) => {
    let parsed: T;
    try {
      parsed = parse(objectOf(params));
    } catch (error) {
      throw toKitError(error);
    }
    return body(parsed, ctx);
  };
}

export const KIT_METHODS: Readonly<Record<KitMethod, KitHandler>> = {
  find_files: checked(
    (raw): FindFilesParams => ({
      query: text(raw, "query"),
      folder: optionalText(raw, "folder", FOLDER_MAX),
      limit: limitOf(raw.limit, KIT_LIMITS.find_files),
    }),
    findFiles,
  ),
  search_text: checked(
    (raw): SearchTextParams => ({
      query: text(raw, "query"),
      folder: optionalText(raw, "folder", FOLDER_MAX),
      regex: flag(raw, "regex"),
      case_sensitive: flag(raw, "case_sensitive"),
      globs: globsOf(raw.globs),
      limit: limitOf(raw.limit, KIT_LIMITS.search_text),
    }),
    searchText,
  ),
  search_structural: checked(
    (raw): SearchStructuralParams => ({
      pattern: text(raw, "pattern"),
      folder: optionalText(raw, "folder", FOLDER_MAX),
      lang: langOf(raw.lang),
      limit: limitOf(raw.limit, KIT_LIMITS.search_structural),
    }),
    searchStructural,
  ),
  list_files: checked(
    (raw): ListFilesParams => ({
      folder: optionalText(raw, "folder", FOLDER_MAX),
      limit: limitOf(raw.limit, KIT_LIMITS.list_files),
    }),
    listFiles,
  ),
  search_sessions: checked(
    (raw): SearchSessionsParams => ({
      query: text(raw, "query"),
      folder: optionalText(raw, "folder", FOLDER_MAX),
      limit: limitOf(raw.limit, KIT_LIMITS.search_sessions),
    }),
    searchSessions,
  ),
};

/** Whether `name` is a kit tool. */
export function isKitMethod(name: unknown): name is KitMethod {
  return typeof name === "string" && Object.hasOwn(KIT_METHODS, name);
}
