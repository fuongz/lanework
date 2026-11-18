// Content search across a project's folder (⌘⇧F) and across the agents'
// transcripts (FE-149). Main runs the bundled ripgrep through
// `electron/main/fs-kit/`; the page gets matches, never a path it can open
// on its own. FE-151 adds fuzzy file finding (fff) and structural search
// (ast-grep), both run in main.

// The result shapes are the tool contract's (FE-152): the app, `lwk` and the
// lanework-kit MCP answer with the same types.
import type { FileHit, FileMatch, SessionMatch } from "@lanework/protocol";
import type { ConversationAgent } from "./conversation";

export type {
  FileHit,
  FileMatch,
  MatchLine,
  SessionMatch,
} from "@lanework/protocol";

export const fsSearchChannels = {
  /** Search a project folder's files. */
  text: "fsSearch:text",
  /** Search the agents' session transcripts. */
  sessions: "fsSearch:sessions",
  /** FE-151: fuzzy-find files by name in a project folder. */
  files: "fsSearch:files",
  /** FE-151: structural (ast-grep) search in a project folder. */
  structural: "fsSearch:structural",
} as const;

/** Languages a structural pattern can be written in (FE-151). */
export type StructuralLang =
  | "ts"
  | "tsx"
  | "js"
  | "jsx"
  | "json"
  | "css"
  | "html"
  | "python"
  | "rust"
  | "go";

export interface SearchStructuralOptions {
  /** The pattern's language; inferred from each file's extension when unset. */
  lang?: StructuralLang;
}

export interface SearchTextOptions {
  /** A regular expression (ripgrep's syntax) rather than a literal. */
  regex?: boolean;
  /** Case-sensitive; false (the default) ignores case. */
  caseSensitive?: boolean;
  /** ripgrep globs; a leading `!` excludes. */
  globs?: string[];
}

export interface SearchSessionsOptions {
  /** One project's sessions only; every project's when unset. */
  project?: string;
  /** These harnesses only; all of them when unset. */
  harnesses?: ConversationAgent[];
  regex?: boolean;
  caseSensitive?: boolean;
}

export interface DesktopFsSearchApi {
  /**
   * Search one of project `slug`'s folders, by its index among the project's
   * linked folders as `worktree.files` takes it (the primary one when null).
   */
  searchText: (
    slug: string,
    folder: number | null,
    query: string,
    opts?: SearchTextOptions,
  ) => Promise<FileMatch[]>;
  searchSessions: (
    query: string,
    opts?: SearchSessionsOptions,
  ) => Promise<SessionMatch[]>;
  /**
   * FE-151: fuzzy-find files by path in one of project `slug`'s folders
   * (folder as in {@link DesktopFsSearchApi.searchText}), best match first,
   * at most `limit` of them.
   */
  findFiles: (
    slug: string,
    folder: number | null,
    query: string,
    limit?: number,
  ) => Promise<FileHit[]>;
  /**
   * FE-151: structural search with an ast-grep `pattern` in one of project
   * `slug`'s folders. Each match's lines come back as in `searchText`.
   */
  searchStructural: (
    slug: string,
    folder: number | null,
    pattern: string,
    opts?: SearchStructuralOptions,
  ) => Promise<FileMatch[]>;
}
