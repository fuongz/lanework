// The Instructions screen's words and its links, kept framework-free.
import {
  type ClaudeInstructionMode,
  findImports,
  type InstructionAgent,
  type InstructionImport,
  type InstructionList,
  type InstructionNode,
  type InstructionScope,
} from "../../shared/instructions";

export const AGENT_LABELS: Record<InstructionAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

export const SCOPE_LABELS: Record<InstructionScope, string> = {
  managed: "Managed",
  user: "User",
  parent: "Parent folder",
  project: "Project",
  local: "Local",
  rules: "Rules",
  import: "Import",
  nested: "Subfolder",
};

export const MODE_LABELS: Record<ClaudeInstructionMode, string> = {
  "claude-md-or-agents-md": "CLAUDE.md, or AGENTS.md without one",
  "claude-md-and-agents-md": "CLAUDE.md and AGENTS.md",
  "claude-md": "CLAUDE.md only",
  "managed-only": "Managed instructions only",
};

/** Every place a file is read, as its agent and scope, for its header. */
export function appearances(
  list: InstructionList,
  id: string,
): { agent: InstructionAgent | "nested"; node: InstructionNode }[] {
  const found: { agent: InstructionAgent | "nested"; node: InstructionNode }[] =
    [];
  const walk = (
    agent: InstructionAgent | "nested",
    nodes: InstructionNode[],
  ) => {
    for (const node of nodes) {
      if (node.file === id) found.push({ agent, node });
      walk(agent, node.children);
    }
  };
  walk("claude", list.claude);
  walk("codex", list.codex);
  walk("opencode", list.opencode);
  walk("nested", list.nested);
  return found;
}

/** The href an import link carries, so the link renderer can tell it apart. */
const IMPORT_HREF = /^#lanework-import-(\d+)$/;

/**
 * Writes every `@path` import in `body` as a Markdown link, for
 * `MarkdownBody` to draw.
 *
 * The imports are the ones `findImports` finds in main, in the same order, so
 * link N is `imports[N]`. Only imports change: code, and every other
 * `[text](href)` in the file, reach the parser as written.
 */
export function linkImports(body: string): string {
  let out = "";
  let at = 0;
  findImports(body).forEach((match, index) => {
    const written = body.slice(match.start, match.end);
    // A `]` would end the link's text early: such an import stays text.
    if (written.includes("]")) return;
    out += `${body.slice(at, match.start)}[${written}](#lanework-import-${index})`;
    at = match.end;
  });
  return out + body.slice(at);
}

/** The import an `#lanework-import-N` link stands for, or null. */
export function importOf(
  href: string,
  imports: InstructionImport[],
): InstructionImport | null {
  const index = IMPORT_HREF.exec(href)?.[1];
  return index === undefined ? null : (imports[Number(index)] ?? null);
}

/** A folder of the subfolder group: its folders, then its files. */
export interface NestedFolder {
  /** What its row says: one segment, or a chain of them (`apps/desktop`). */
  name: string;
  /** From the project's folder; `""` for the root. */
  path: string;
  folders: NestedFolder[];
  files: InstructionNode[];
}

/**
 * The files in subfolders as a tree of folders (FE-44/D3), by each file's
 * path from the project. A folder holding one folder and nothing else folds
 * into it, so `apps/desktop` is one row rather than two.
 */
export function nestedFolders(list: InstructionList): NestedFolder {
  const root: NestedFolder = { name: "", path: "", folders: [], files: [] };
  for (const node of list.nested) {
    const file = list.files[node.file];
    if (!file) continue;
    const segments = file.name.split("/").slice(0, -1);
    let folder = root;
    for (const segment of segments) {
      const path = folder.path ? `${folder.path}/${segment}` : segment;
      let next = folder.folders.find((child) => child.path === path);
      if (!next) {
        next = { name: segment, path, folders: [], files: [] };
        folder.folders.push(next);
      }
      folder = next;
    }
    folder.files.push(node);
  }
  const fold = (folder: NestedFolder): NestedFolder => {
    let current = folder;
    while (current.files.length === 0 && current.folders.length === 1) {
      const [only] = current.folders as [NestedFolder];
      current = { ...only, name: `${current.name}/${only.name}` };
    }
    return { ...current, folders: current.folders.map(fold) };
  };
  return { ...root, folders: root.folders.map(fold) };
}
