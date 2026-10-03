import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Folder01Icon,
  FolderOpenIcon,
  RefreshIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import { splitPath } from "#/components/shared/diff/diff-file-header";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { RestoreDialog } from "#/components/shared/repo/restore-dialog";
import { StageBox } from "#/components/shared/repo/stage-box";
import { Button } from "#/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { stagedTally, useWorktree } from "#/stores/worktree";
import type {
  WorktreeFile,
  WorktreeFileStatus,
} from "../../../../shared/worktree";

/**
 * The working tree's changes, one row per file, nested by folder.
 *
 * ⚠️ A TREE with single-child chains compacted, the way an editor's source
 * control view draws it. One row per changed directory listed
 * `crates/olm`, `crates/olm/src` and `crates/olm/tests` as unrelated siblings;
 * a plain tree spends three rows of indentation to say `apps/desktop/src`.
 * Folding the chains keeps the nesting and drops the empty steps.
 *
 * ⚠️ Plain React, not `@pierre/trees`. The pull request's tree is a web
 * component with its own shadow root, and every row here carries a checkbox and
 * a restore button that have to be real, focusable controls in this document.
 */

/** One letter per status, the way `git status -s` spells them. */
const MARK: Record<WorktreeFileStatus, { letter: string; tone: string }> = {
  added: { letter: "A", tone: "text-emerald-600 dark:text-emerald-400" },
  untracked: { letter: "U", tone: "text-emerald-600 dark:text-emerald-400" },
  modified: { letter: "M", tone: "text-amber-600 dark:text-amber-400" },
  deleted: { letter: "D", tone: "text-rose-600 dark:text-rose-400" },
  renamed: { letter: "R", tone: "text-violet-600 dark:text-violet-400" },
  conflicted: { letter: "!", tone: "text-rose-600 dark:text-rose-400" },
};

/** A directory holding changes. `files` is every change beneath it, at any depth. */
interface Folder {
  kind: "folder";
  /** The full path, which is also its key and its accessible name. */
  path: string;
  /** What the row shows: one segment, or a compacted chain like `apps/desktop`. */
  name: string;
  children: Node[];
  files: WorktreeFile[];
}

type Node = Folder | { kind: "file"; file: WorktreeFile };

/** Folders first, then files, each alphabetical — the order a file tree uses. */
function byKind(a: Node, b: Node): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  const left = a.kind === "folder" ? a.name : splitPath(a.file.path).name;
  const right = b.kind === "folder" ? b.name : splitPath(b.file.path).name;
  return left.localeCompare(right);
}

/** Folds a folder whose only child is another folder into one row. */
function compact(node: Node): Node {
  if (node.kind === "file") return node;
  let folder = node;
  while (folder.children.length === 1 && folder.children[0].kind === "folder") {
    const only: Folder = folder.children[0];
    folder = { ...only, name: `${folder.name}/${only.name}` };
  }
  return { ...folder, children: folder.children.map(compact).sort(byKind) };
}

function buildTree(files: WorktreeFile[]): Node[] {
  const root: Folder = {
    kind: "folder",
    path: "",
    name: "",
    children: [],
    files: [],
  };
  const folders = new Map<string, Folder>();
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

type Row =
  | { kind: "folder"; folder: Folder; depth: number }
  | { kind: "file"; file: WorktreeFile; depth: number };

/** The rows a reader can see: a shut folder hides everything beneath it. */
function visibleRows(
  nodes: Node[],
  shut: Set<string>,
  depth = 0,
  rows: Row[] = [],
): Row[] {
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
const INDENT = 12;
/** A folder's chevron and the gap after it — what a file leaves blank instead. */
const TWISTIE = 18;

function Counts({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      {additions > 0 && (
        <span className="text-emerald-600 dark:text-emerald-400">
          +{additions}
        </span>
      )}
      {additions > 0 && deletions > 0 && " "}
      {deletions > 0 && (
        <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
      )}
    </span>
  );
}

function FileRow({
  file,
  pad,
  onRestore,
}: {
  file: WorktreeFile;
  /** Left padding in pixels, which is where the file sits in the tree. */
  pad: number;
  onRestore: (file: WorktreeFile) => void;
}) {
  const focus = useWorktree((state) => state.focus);
  const focusFile = useWorktree((state) => state.focusFile);
  const { name } = splitPath(file.path);
  const mark = MARK[file.status];
  const active = focus?.path === file.path;

  return (
    // ⚠️ A row that is a button, with two controls beside it rather than inside
    // it — a checkbox nested in a button is not a thing assistive tech can
    // reach, and a click on it would also open the diff.
    <div
      data-active={active || undefined}
      className="group hover:bg-foreground/[0.04] data-active:bg-foreground/[0.06] flex h-7 min-w-0 items-center gap-2 rounded-md pr-2"
    >
      <button
        type="button"
        title={file.path}
        onClick={() => focusFile(file.path)}
        style={{ paddingLeft: pad }}
        className="focus-visible:ring-accent-brand flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left text-[13px] outline-none focus-visible:ring-2"
      >
        <FileTypeIcon path={file.path} className="size-4 shrink-0" />
        <span
          className={`min-w-0 truncate ${file.status === "deleted" ? "text-muted-foreground line-through" : ""}`}
        >
          {name}
        </span>
        <span
          className={`shrink-0 font-mono text-[10px] font-semibold ${mark.tone}`}
          title={file.status}
        >
          {mark.letter}
        </span>
        <span className="ml-auto" />
        {file.binary ? (
          <span className="text-muted-foreground shrink-0 text-[11px]">
            binary
          </span>
        ) : (
          <Counts additions={file.additions} deletions={file.deletions} />
        )}
      </button>
      {/* ⚠️ A real tooltip, not `title`: the native one waits a second and a
          half, which on an icon-only destructive button is too long to learn
          what it does before clicking it. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Discard changes to ${file.path}`}
              onClick={() => onRestore(file)}
              className="hover:bg-foreground/[0.08] focus-visible:ring-accent-brand flex size-5 shrink-0 items-center justify-center rounded opacity-0 outline-none group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:ring-2"
            />
          }
        >
          <HugeiconsIcon
            icon={Undo02Icon}
            className="text-muted-foreground size-3.5"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </TooltipTrigger>
        <TooltipContent>Discard changes</TooltipContent>
      </Tooltip>
      <StageBox files={[file]} label={file.path} />
    </div>
  );
}

function FolderRow({
  folder,
  pad,
  shut,
  onToggle,
}: {
  folder: Folder;
  /** Left padding in pixels, which is where the folder sits in the tree. */
  pad: number;
  shut: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="hover:bg-foreground/[0.04] flex h-7 min-w-0 items-center gap-2 rounded-md pr-2">
      <button
        type="button"
        aria-expanded={!shut}
        aria-label={`${shut ? "Expand" : "Collapse"} ${folder.path}`}
        onClick={onToggle}
        style={{ paddingLeft: pad }}
        className="focus-visible:ring-accent-brand flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2"
      >
        <HugeiconsIcon
          icon={shut ? ArrowRight01Icon : ArrowDown01Icon}
          className="text-muted-foreground size-3 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <HugeiconsIcon
          icon={shut ? Folder01Icon : FolderOpenIcon}
          className="text-muted-foreground size-4 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {/* ⚠️ Truncated from the START, like the diff header: the end of a
            compacted chain is the part that says where you are. */}
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate text-left text-[13px] [direction:rtl]"
          title={folder.path}
        >
          <bdi>{folder.name}</bdi>
        </span>
        {shut && (
          <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
            {folder.files.length}
          </span>
        )}
      </button>
      <StageBox files={folder.files} label={folder.path} />
    </div>
  );
}

function Section({
  title,
  files,
  onRestore,
}: {
  title: string;
  files: WorktreeFile[];
  onRestore: (file: WorktreeFile) => void;
}) {
  const [open, setOpen] = useState(true);
  /** Folders folded shut, by path. Open by default: a change list is read whole. */
  const [shut, setShut] = useState<Set<string>>(() => new Set());
  const toggle = (dir: string) =>
    setShut((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  const tree = useMemo(() => buildTree(files), [files]);
  const rows = useMemo(() => visibleRows(tree, shut), [tree, shut]);
  // A list of files at the repo's root has no chevrons to line up with, so it
  // keeps its plain left edge instead of a blank twistie on every row.
  const flat = tree.every((node) => node.kind === "file");

  if (!files.length) return null;
  return (
    <section aria-label={title} className="flex flex-col">
      <div className="flex h-7 items-center gap-1.5 pr-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-accent-brand flex min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1 text-left text-xs font-medium outline-none focus-visible:ring-2"
        >
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            className="size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          {title}
          <span className="tabular-nums">{files.length}</span>
        </button>
        <StageBox files={files} label={`all ${title.toLowerCase()} files`} />
      </div>
      {open &&
        rows.map((row) =>
          row.kind === "folder" ? (
            <FolderRow
              key={`folder:${row.folder.path}`}
              folder={row.folder}
              pad={4 + row.depth * INDENT}
              shut={shut.has(row.folder.path)}
              onToggle={() => toggle(row.folder.path)}
            />
          ) : (
            <FileRow
              key={row.file.path}
              file={row.file}
              pad={flat ? 8 : 4 + row.depth * INDENT + TWISTIE}
              onRestore={onRestore}
            />
          ),
        )}
    </section>
  );
}

export function ChangesList({ files }: { files: WorktreeFile[] }) {
  const stage = useWorktree((state) => state.stage);
  const unstage = useWorktree((state) => state.unstage);
  const refresh = useWorktree((state) => state.refresh);
  const loading = useWorktree((state) => state.loading);
  const busy = useWorktree((state) => state.busy);
  const [restoring, setRestoring] = useState<WorktreeFile[] | null>(null);

  const tracked = files.filter((file) => file.status !== "untracked");
  const untracked = files.filter((file) => file.status === "untracked");
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const allStaged = stagedTally(files) === "full";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <span className="text-[13px] font-medium">Changes</span>
        <Counts additions={additions} deletions={deletions} />
        <span className="ml-auto" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh changes"
          title="Refresh"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            strokeWidth={1.8}
            aria-hidden="true"
            className={loading ? "animate-spin" : undefined}
          />
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null || files.length === 0}
          onClick={() => {
            const paths = files.map((file) => file.path);
            void (allStaged ? unstage(paths) : stage(paths));
          }}
        >
          {allStaged ? "Unstage All" : "Stage All"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        <Section
          title="Tracked"
          files={tracked}
          onRestore={(file) => setRestoring([file])}
        />
        <Section
          title="Untracked"
          files={untracked}
          onRestore={(file) => setRestoring([file])}
        />
      </div>
      <RestoreDialog files={restoring} onClose={() => setRestoring(null)} />
    </div>
  );
}
