// The 5 lanework-kit tools (FE-152): searching this machine's files and agent
// transcripts. The `lwk` CLI and the lanework-kit MCP server run them on one
// core; the board MCP servers do not serve them. Offline only: the cloud
// cannot read this machine's disk.
//
// NOTE: Every path an answer carries is relative to the folder searched,
// `/`-separated. Ranges are `[start, end)` UTF-16 offsets.
import type { ToolContract, ToolParam } from "./schema";

export type KitToolName =
  | "find_files"
  | "search_text"
  | "search_structural"
  | "list_files"
  | "search_sessions";

/** Each kit tool's `limit`: what it is when omitted, and the most it may be. */
export const KIT_TOOL_LIMITS = {
  find_files: { default: 50, max: 200 },
  search_text: { default: 50, max: 200 },
  search_structural: { default: 50, max: 200 },
  list_files: { default: 1000, max: 50_000 },
  search_sessions: { default: 20, max: 50 },
} as const satisfies Record<KitToolName, { default: number; max: number }>;

/** Languages a structural pattern can be written in. */
export const STRUCTURAL_LANGS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "css",
  "html",
  "python",
  "rust",
  "go",
] as const;
export type StructuralLang = (typeof STRUCTURAL_LANGS)[number];

/** The agent harnesses whose transcripts `search_sessions` reads. */
export type SessionHarness = "claude" | "codex" | "opencode";

// ── Shared parameter shapes ─────────────────────────────────────────────────

const FOLDER: ToolParam = {
  type: "string",
  description:
    "The folder to search, an absolute path (e.g. the repo's root); the working directory when omitted",
};

function limit(tool: KitToolName, what: string): ToolParam {
  const { default: fallback, max } = KIT_TOOL_LIMITS[tool];
  return {
    type: "integer",
    minimum: 1,
    maximum: max,
    description: `${what} returned; default ${fallback}`,
  };
}

// ── The tools ───────────────────────────────────────────────────────────────

/** The kit tools, in the order `tools/list` advertises them. */
export const KIT_TOOLS: readonly ToolContract<KitToolName>[] = [
  {
    name: "find_files",
    description:
      "Fuzzy-find files by path in a folder, best match first. Respects .gitignore. Returns each file's path, score and the matched character ranges.",
    readOnly: true,
    properties: {
      query: {
        type: "string",
        description: "Part of a file name or path, e.g. `mcp tools`",
      },
      folder: FOLDER,
      limit: limit("find_files", "Files"),
    },
    required: ["query"],
  },
  {
    name: "search_text",
    description:
      "Search the contents of a folder's files with ripgrep. Respects .gitignore; skips hidden and binary files. Returns each matching file with its matching lines (1-based) and match ranges; `truncated` marks where the search stopped.",
    readOnly: true,
    properties: {
      query: {
        type: "string",
        description: "A literal string, or a regex when `regex` is true",
      },
      folder: FOLDER,
      regex: {
        type: "boolean",
        description: "Read `query` as a regex (ripgrep's syntax)",
      },
      case_sensitive: {
        type: "boolean",
        description: "Match case; ignored when omitted",
      },
      globs: {
        type: "string[]",
        description: "ripgrep globs limiting the files; a leading `!` excludes",
      },
      limit: limit("search_text", "Files"),
    },
    required: ["query"],
  },
  {
    name: "search_structural",
    description:
      "Search a folder's code by syntax with an ast-grep pattern, e.g. `console.log($A)`. Respects .gitignore. Returns each matching file with its matching lines and match ranges, as search_text does.",
    readOnly: true,
    properties: {
      pattern: {
        type: "string",
        description: "An ast-grep pattern; `$A` matches one node",
      },
      folder: FOLDER,
      lang: {
        type: "string",
        enum: STRUCTURAL_LANGS,
        description:
          "The pattern's language; each file's own, from its extension, when omitted",
      },
      limit: limit("search_structural", "Files"),
    },
    required: ["pattern"],
  },
  {
    name: "list_files",
    description:
      "Every file in a folder that ripgrep would search: .gitignore respected, hidden files skipped. Paths in no particular order; `truncated` when cut at the limit.",
    readOnly: true,
    properties: {
      folder: FOLDER,
      limit: limit("list_files", "Paths"),
    },
  },
  // FE-149: moved here from the offline board MCP. Text kept as it was.
  {
    name: "search_sessions",
    description:
      "Search this machine's Claude Code, Codex and OpenCode conversations for a phrase in what was said (prompts, answers, tool calls and output), newest first. Returns each session's harness, id, title, last write and up to 3 matching snippets.",
    readOnly: true,
    properties: {
      query: { type: "string", description: "A literal phrase, not a regex" },
      limit: limit("search_sessions", "Sessions"),
      folder: {
        type: "string",
        description:
          "Only sessions run in this folder (an absolute path, e.g. the repo's root); every folder's when omitted",
      },
    },
    required: ["query"],
  },
];

// ── The answers ─────────────────────────────────────────────────────────────

/** A file whose path matches a fuzzy query. */
export interface FileHit {
  /** Relative to the searched folder, `/`-separated. */
  path: string;
  /** Higher is a better match. Only comparable within one answer. */
  score: number;
  /** The matched characters as `[start, end)` UTF-16 offsets into `path`. */
  ranges?: [number, number][];
}

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
  harness: SessionHarness;
  sessionId: string;
  /** The session's title, or its first prompt. */
  title: string;
  /** When the session was last written, ISO 8601. */
  at: string;
  /** The transcript, relative to the harness's own folder. */
  file: string;
  lines: MatchLine[];
}

/** What each kit tool takes, as the MCP server and `lwk` both read it. */
export interface KitToolInputs {
  find_files: { query: string; folder?: string; limit?: number };
  search_text: {
    query: string;
    folder?: string;
    regex?: boolean;
    case_sensitive?: boolean;
    globs?: string[];
    limit?: number;
  };
  search_structural: {
    pattern: string;
    folder?: string;
    lang?: StructuralLang;
    limit?: number;
  };
  list_files: { folder?: string; limit?: number };
  search_sessions: { query: string; folder?: string; limit?: number };
}

/** What each kit tool answers, inside its text content, as JSON. */
export interface KitToolOutputs {
  find_files: { files: FileHit[] };
  search_text: { matches: FileMatch[] };
  search_structural: { matches: FileMatch[] };
  list_files: { files: string[]; truncated: boolean };
  search_sessions: { sessions: SessionMatch[] };
}
