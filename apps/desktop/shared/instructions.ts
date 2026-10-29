// What Claude Code, Codex and OpenCode are TOLD about a project: the CLAUDE.md
// and AGENTS.md files each reads, in the order it reads them, shown read-only.
// Memory is what Claude wrote down for itself; this is the other half.

export type InstructionAgent = "claude" | "codex" | "opencode";

/** Where a file sits in an agent's reading order: the label on its row. */
export type InstructionScope =
  | "managed"
  | "user"
  | "parent"
  | "project"
  | "local"
  | "rules"
  | "import"
  | "nested";

/**
 * Whether the agent has a file in context.
 *
 * From the start of every conversation (`launch`), only once it works in a
 * folder or on a matching file (`conditional`), or not at all (`skipped`).
 */
export type InstructionLoad = "launch" | "conditional" | "skipped";

/**
 * How Claude Code picks between CLAUDE.md and AGENTS.md.
 *
 * Its **Project instructions** setting
 * (`pluginConfigs["agents-md@builtin"]`).
 */
export type ClaudeInstructionMode =
  | "claude-md-or-agents-md"
  | "claude-md-and-agents-md"
  | "claude-md"
  | "managed-only";

export interface InstructionFile {
  /** What the renderer names the file by; never a path. */
  id: string;
  /** The absolute path, for display only. */
  path: string;
  /** Its path from the project's folder when it is inside it, else `path`. */
  name: string;
  /** In bytes; 0 when it is missing. */
  size: number;
  /** Its mtime, which tells a reader it was written again. 0 when missing. */
  mtimeMs: number;
  /** An import that names a file nobody has written. */
  missing: boolean;
  /** Only Markdown is shown; another file is listed by name (FE-37/D6). */
  markdown: boolean;
}

export interface InstructionNode {
  /** The {@link InstructionFile} it is, by id. */
  file: string;
  scope: InstructionScope;
  load: InstructionLoad;
  /** When it loads or why it does not, in a sentence; null when obvious. */
  note: string | null;
  /** In the nested group, who reads it (FE-37/D5); empty elsewhere. */
  agents: InstructionAgent[];
  /** What it imports with `@path`, in order (Claude only). */
  children: InstructionNode[];
}

export interface InstructionList {
  /** The project's folder on this machine; null when it has none here. */
  folder: string | null;
  files: Record<string, InstructionFile>;
  /** What Claude reads, in order (FE-37/D3). */
  claude: InstructionNode[];
  /** What Codex reads, in order. */
  codex: InstructionNode[];
  /** What OpenCode reads, in order (FE-104). */
  opencode: InstructionNode[];
  /** Files below the folder that load as an agent works there (FE-37/D5). */
  nested: InstructionNode[];
  /** More nested files than one scan takes. */
  nestedTruncated: boolean;
  claudeMode: ClaudeInstructionMode;
}

export interface InstructionImport {
  /** The `@path` as written, without the `@`. */
  path: string;
  /** The file it names, by id; null when it names none an agent reads. */
  file: string | null;
}

export interface InstructionContent {
  file: InstructionFile;
  /** What the agent reads of the file: a rule without its frontmatter. */
  body: string;
  /** The file as it is. */
  raw: string;
  /** Each `@path` in `body`, in the order {@link findImports} finds them. */
  imports: InstructionImport[];
  /** A rule's `paths`: it loads only on files that match them. */
  paths: string[];
  /** Longer than one read takes, so what is shown is its start. */
  truncated: boolean;
}

/** One file of an agent's whole reading, in order (FE-37/D4). */
export interface EffectiveSection {
  file: string;
  scope: InstructionScope;
  /**
   * Its text as the agent gets it; null for a file that is not shown
   * (FE-37/D6).
   */
  text: string | null;
  /** Cut: by the read limit, or by Codex's `project_doc_max_bytes`. */
  truncated: boolean;
}

export interface EffectiveInstructions {
  agent: InstructionAgent;
  files: Record<string, InstructionFile>;
  sections: EffectiveSection[];
}

/**
 * An id the renderer may name a file by: 16 hex characters, which main mints
 * from a path.
 *
 * Main only reads a file its own last listing named.
 */
const INSTRUCTION_ID = /^[0-9a-f]{16}$/;

export function isInstructionId(value: unknown): value is string {
  return typeof value === "string" && INSTRUCTION_ID.test(value);
}

export function isInstructionAgent(value: unknown): value is InstructionAgent {
  return value === "claude" || value === "codex" || value === "opencode";
}

interface ImportMatch {
  /** Where the `@` is in the text. */
  start: number;
  /** Just after the path. */
  end: number;
  /** The path, unescaped (`Design\ Docs` → `Design Docs`). */
  path: string;
}

/** A code fence, ``` or ~~~; Claude's import parsing skips fenced code. */
const FENCE = /^\s*(```|~~~)/;
/** `@path` after a space or at the start of a line; `\ ` keeps a space in it. */
const IMPORT = /(^|\s)@((?:\\ |[^\s])+)/g;
/** What ends a sentence rather than a path. */
const TRAILING = /[.,;:!?)\]}>'"]+$/;

/**
 * Every `@path` import in `text`, as Claude Code reads them.
 *
 * Outside code spans and fenced blocks, and never a quoted path.
 *
 * NOTE: Shared by main and the renderer. Main resolves these and the renderer
 * turns the same ones into links, so the two never disagree about which `@`
 * is which. A second copy on either side would drift.
 */
export function findImports(text: string): ImportMatch[] {
  const found: ImportMatch[] = [];
  let fence: string | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker === fence) fence = null;
    } else if (marker) fence = marker;
    else {
      // Code spans become spaces, so nothing inside one matches but the
      // offsets of everything after it still hold.
      const masked = line.replace(/`[^`]*`/g, (span) =>
        " ".repeat(span.length),
      );
      for (const match of masked.matchAll(IMPORT)) {
        const written = (match[2] ?? "").replace(TRAILING, "");
        if (!written || /^["'`]/.test(written)) continue;
        const start = offset + (match.index ?? 0) + (match[1]?.length ?? 0);
        found.push({
          start,
          end: start + 1 + written.length,
          path: written.replace(/\\ /g, " "),
        });
      }
    }
    offset += line.length + 1;
  }
  return found;
}

export const instructionChannels = {
  list: "instructions:list",
  read: "instructions:read",
  effective: "instructions:effective",
  reveal: "instructions:reveal",
  /** Main → renderer: a file in a listed project's reading changed. */
  changed: "instructions:changed",
} as const;

export interface InstructionChange {
  workspace: string;
}

/**
 * A project's instruction files, read-only.
 *
 * NOTE: Nothing here writes a file. Every call names a project and, at most,
 * an id from main's own listing of it.
 */
export interface DesktopInstructionsApi {
  /** The project's instruction files, and from then on `onChange` for it. */
  list: (workspace: string) => Promise<InstructionList>;
  read: (workspace: string, id: string) => Promise<InstructionContent>;
  effective: (
    workspace: string,
    agent: InstructionAgent,
  ) => Promise<EffectiveInstructions>;
  /** Show the file in Finder (FE-37/D8). */
  reveal: (workspace: string, id: string) => Promise<void>;
  onChange: (listener: (change: InstructionChange) => void) => () => void;
}
