// The Instructions screen's words and its links (FE-37), kept framework-free.
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

/** `2.3 KB`: a size a person reads at a glance. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Every place a file is read, as `agent · scope`, for its header. */
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
  walk("nested", list.nested);
  return found;
}

/** The href an import link carries, so the link renderer can tell it apart. */
const IMPORT_HREF = /^#lanework-import-(\d+)$/;

/**
 * `body` with every `@path` import written as a Markdown link to itself
 * (FE-37), for `MarkdownBody` to draw: the same imports `findImports` finds
 * in main, in the same order, so link N is `imports[N]`.
 *
 * ⚠️ Only imports change: code, and every other `[text](href)` in the file,
 * reach the parser exactly as written.
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
