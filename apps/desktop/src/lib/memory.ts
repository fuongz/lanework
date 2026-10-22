// The Memory screen's words and its links, kept framework-free.
import {
  isMemoryFile,
  MEMORY_INDEX,
  type MemoryEntry,
  type MemoryType,
} from "../../shared/memory";
import type { LinkSpan } from "./markdown";

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  user: "User",
  feedback: "Feedback",
  project: "Project",
  reference: "Reference",
  other: "Other",
};

/** The index's row: what Claude reads first, under a name that says so. */
export const INDEX_NAME = "Index";

/** What a memory is shown as: the index's title for it, else its name. */
export function memoryLabel(entry: MemoryEntry): string {
  return entry.file === MEMORY_INDEX ? INDEX_NAME : (entry.title ?? entry.name);
}

/** `/Users/me/.claude/…` as `~/.claude/…`: the part a person reads by. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, "~");
}

/**
 * The memory that a link inside a memory names (FE-36/D7).
 *
 * A `[[name]]` matches a file, a frontmatter name or a title; a
 * `[text](file.md)` matches a file.
 *
 * @returns The file; `null` when the link names no memory yet; `undefined`
 *   when it is not a link to a memory at all.
 */
export function memoryTarget(
  span: LinkSpan,
  entries: MemoryEntry[],
): string | null | undefined {
  if (span.wiki) {
    const name = span.href.toLowerCase();
    const hit =
      entries.find(
        (entry) =>
          entry.file.toLowerCase() === `${name}.md` ||
          entry.file.toLowerCase() === name,
      ) ??
      entries.find((entry) => entry.name.toLowerCase() === name) ??
      entries.find((entry) => entry.title?.toLowerCase() === name);
    return hit ? hit.file : null;
  }
  const href = span.href.replace(/^\.\//, "");
  // A URL, a path, an anchor: not a memory — left as written.
  if (!isMemoryFile(href)) return undefined;
  return entries.find((entry) => entry.file === href)?.file ?? null;
}
