// Content search across a project's folder (⌘⇧F) and across the agents'
// transcripts (FE-149). Main runs the bundled ripgrep through
// `electron/main/fs-kit/`; the page gets matches, never a path it can open
// on its own.
import type { ConversationAgent } from "./conversation";

export const fsSearchChannels = {
  /** Search a project folder's files. */
  text: "fsSearch:text",
  /** Search the agents' session transcripts. */
  sessions: "fsSearch:sessions",
} as const;

/** One matching line. */
export interface MatchLine {
  /** 1-based line number. */
  line: number;
  /** The line, without its newline. A very long line is cut to a window around its first match. */
  text: string;
  /** Each match as `[start, end)` UTF-16 offsets into `text`. */
  ranges: [number, number][];
}

/** A file with matches. */
export interface FileMatch {
  /** Relative to the searched folder, `/`-separated. */
  path: string;
  lines: MatchLine[];
  /**
   * The search stopped in or right after this file (a match or file limit, or
   * the timeout), so there may be more matches here or after it.
   */
  truncated: boolean;
}

/** A session transcript with matches. */
export interface SessionMatch {
  harness: ConversationAgent;
  sessionId: string;
  /** The session's title, or its first prompt. */
  title: string;
  /** When the session was last written, ISO 8601. */
  at: string;
  /** The transcript, relative to the harness's own folder. */
  file: string;
  lines: MatchLine[];
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
}
