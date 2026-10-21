// The Changes list's folder tree (0d310d6), shared with the agent view's Files
// list (FE-39/D1): the same nesting, compacted chains and marks in both.
import { splitPath } from "#/components/shared/diff/diff-file-header";
import type {
  WorktreeFile,
  WorktreeFileStatus,
} from "../../../../shared/worktree";

/** One letter per status, the way `git status -s` spells them. */
export const MARK: Record<
  WorktreeFileStatus,
  { letter: string; tone: string }
> = {
  added: { letter: "A", tone: "text-emerald-600 dark:text-emerald-400" },
  untracked: { letter: "U", tone: "text-emerald-600 dark:text-emerald-400" },
  modified: { letter: "M", tone: "text-amber-600 dark:text-amber-400" },
  deleted: { letter: "D", tone: "text-rose-600 dark:text-rose-400" },
  renamed: { letter: "R", tone: "text-violet-600 dark:text-violet-400" },
  conflicted: { letter: "!", tone: "text-rose-600 dark:text-rose-400" },
};

/**
 * A directory holding changes. `files` is every change beneath it, at any depth.
 * Generic over the file, so the agent view's Files list (FE-39/D1) is the same tree.
 */
export interface Folder<F extends { path: string } = WorktreeFile> {
  kind: "folder";
  /** The full path, which is also its key and its accessible name. */
  path: string;
  /** What the row shows: one segment, or a compacted chain like `apps/desktop`. */
  name: string;
  children: Node<F>[];
  files: F[];
}

export type Node<F extends { path: string } = WorktreeFile> =
  | Folder<F>
  | { kind: "file"; file: F };

/** Folders first, then files, each alphabetical — the order a file tree uses. */
function byKind<F extends { path: string }>(a: Node<F>, b: Node<F>): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  const left = a.kind === "folder" ? a.name : splitPath(a.file.path).name;
  const right = b.kind === "folder" ? b.name : splitPath(b.file.path).name;
  return left.localeCompare(right);
}

/** Folds a folder whose only child is another folder into one row. */
function compact<F extends { path: string }>(node: Node<F>): Node<F> {
  if (node.kind === "file") return node;
  let folder = node;
  while (folder.children.length === 1 && folder.children[0].kind === "folder") {
    const only: Folder<F> = folder.children[0];
    folder = { ...only, name: `${folder.name}/${only.name}` };
  }
  return { ...folder, children: folder.children.map(compact).sort(byKind) };
}

export function buildTree<F extends { path: string }>(files: F[]): Node<F>[] {
  const root: Folder<F> = {
    kind: "folder",
    path: "",
    name: "",
    children: [],
    files: [],
  };
  const folders = new Map<string, Folder<F>>();
  for (const file of files) {
    const segments = file.path.split("/");
    let parent = root;
    for (let depth = 1; depth < segments.length; depth++) {
      const path = segments.slice(0, depth).join("/");
      let folder = folders.get(path);
      if (!folder) {
        folder = {
          kind: "folder",
          path,
          name: segments[depth - 1],
          children: [],
          files: [],
        };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      folder.files.push(file);
      parent = folder;
    }
    parent.children.push({ kind: "file", file });
  }
  // ⚠️ The root's children are compacted one by one, never the root itself: a
  // repo whose every change sits under `apps/` would otherwise fold the whole
  // list into a single unnamed row.
  return root.children.map(compact).sort(byKind);
}

type Row<F extends { path: string } = WorktreeFile> =
  | { kind: "folder"; folder: Folder<F>; depth: number }
  | { kind: "file"; file: F; depth: number };

/** The rows a reader can see: a shut folder hides everything beneath it. */
export function visibleRows<F extends { path: string }>(
  nodes: Node<F>[],
  shut: Set<string>,
  depth = 0,
  rows: Row<F>[] = [],
): Row<F>[] {
  for (const node of nodes) {
    if (node.kind === "file") {
      rows.push({ kind: "file", file: node.file, depth });
      continue;
    }
    rows.push({ kind: "folder", folder: node, depth });
    if (!shut.has(node.path)) visibleRows(node.children, shut, depth + 1, rows);
  }
  return rows;
}

/** Pixels of indentation per level of nesting. */
export const INDENT = 12;
/** A folder's chevron and the gap after it — what a file leaves blank instead. */
export const TWISTIE = 18;
