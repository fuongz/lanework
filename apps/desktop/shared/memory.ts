// What Claude Code remembers about a project (FE-36): the notes it saved for
// itself in `~/.claude/projects/<repo>/memory/`, shown read-only.

/** The kinds of memory Claude files, and "other" for anything it did not. */
export type MemoryType =
  | "user"
  | "feedback"
  | "project"
  | "reference"
  | "other";

/** In the order the list groups them. */
export const MEMORY_TYPES: readonly MemoryType[] = [
  "user",
  "feedback",
  "project",
  "reference",
  "other",
];

export function memoryType(value: string | undefined): MemoryType {
  const type = value?.trim().toLowerCase() as MemoryType | undefined;
  return type && MEMORY_TYPES.includes(type) ? type : "other";
}

/** The index Claude loads at the start of every conversation. */
export const MEMORY_INDEX = "MEMORY.md";

/**
 * A memory's file name — the only thing the renderer may name one by.
 *
 * ⚠️ No separator, no leading dot and nothing but `.md`, so it can never be
 * `..`, a path or another kind of file. Main builds the path from it, inside
 * the project's memory folder, and checks where that path really leads.
 */
const MEMORY_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export function isMemoryFile(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 200 && MEMORY_FILE.test(value)
  );
}

export interface MemoryEntry {
  file: string;
  /**
   * Its frontmatter `name`, or the file's own without `.md` — what a
   * `[[name]]` link names it by.
   */
  name: string;
  /**
   * The words `MEMORY.md` links to it with, `[Title](file.md)`, when the
   * index has it: what a person reads it by (FE-36).
   */
  title: string | null;
  description: string | null;
  type: MemoryType;
  /** When it last changed: its frontmatter `modified`, or the file's mtime. */
  modified: string;
  /** The file's mtime and size: what tells a reader it was written again. */
  mtimeMs: number;
  size: number;
}

export interface MemoryList {
  /** The project's folder on this machine; null when it has none here. */
  folder: string | null;
  /** The memory folder Claude uses for it, for display; null without a folder. */
  dir: string | null;
  /** Empty when Claude has not saved anything for it yet. */
  entries: MemoryEntry[];
  /** More files than one listing takes. */
  truncated: boolean;
}

export interface MemoryFile {
  entry: MemoryEntry;
  /**
   * Its frontmatter as read: `key: value`, and a nested key as
   * `parent.child` (`metadata.type`).
   */
  meta: Record<string, string>;
  /** The file without its frontmatter. */
  body: string;
  /** The file as it is, frontmatter and all. */
  raw: string;
  /** Longer than one read takes: what is shown is its start. */
  truncated: boolean;
}

export const memoryChannels = {
  list: "memory:list",
  read: "memory:read",
  reveal: "memory:reveal",
  /** Main → renderer: a listed project's memory folder was written. */
  changed: "memory:changed",
} as const;

export interface MemoryChange {
  /** The project, as `list` was asked for it. */
  workspace: string;
}

/**
 * ⚠️ Read-only: nothing here writes a memory. Every call names a project and,
 * at most, a file NAME; main resolves the folder from its own folder links.
 */
export interface DesktopMemoryApi {
  /** The project's memories — and, from then on, `onChange` for it. */
  list: (workspace: string) => Promise<MemoryList>;
  read: (workspace: string, file: string) => Promise<MemoryFile>;
  /** Open the memory folder in Finder. */
  reveal: (workspace: string) => Promise<void>;
  onChange: (listener: (change: MemoryChange) => void) => () => void;
}
