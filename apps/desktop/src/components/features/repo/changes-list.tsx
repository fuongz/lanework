// The working tree's changes, one row per file, nested by folder.
//
// - A tree with single-child chains compacted, the way an editor's source
//   control view draws it. One row per changed directory would list
//   `crates/olm`, `crates/olm/src` and `crates/olm/tests` as unrelated
//   siblings; a plain tree spends three rows of indentation to say
//   `apps/desktop/src`. Folding the chains keeps the nesting and drops the
//   empty steps.
// - Plain React, not `@pierre/trees`. The pull request's tree is a web
//   component with its own shadow root, and every row here carries a
//   checkbox and a restore button that have to be real, focusable controls
//   in this document.
// - Windowed past a few hundred rows: only the rows in view (and a margin)
//   are drawn. Every row is 22px, so where each one sits is arithmetic. A
//   working tree with thousands of changes drew thousands of rows, each with
//   its own tooltip, checkbox and store subscriptions, and froze the app.
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Folder01Icon,
  FolderOpenIcon,
  RefreshIcon,
  StretchHorizontalIcon,
  StretchVerticalIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SegmentedControl } from "#/components/shared/common/segmented-control";
import { splitPath } from "#/components/shared/diff/diff-file-header";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import {
  buildTree,
  entryName,
  type Folder,
  INDENT,
  MARK,
  visibleRows,
} from "#/components/shared/repo/file-tree";
import { RestoreDialog } from "#/components/shared/repo/restore-dialog";
import { StageBox } from "#/components/shared/repo/stage-box";
import { Button } from "#/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { type DiffStyle, useWorktree } from "#/stores/worktree";
import { isFolderEntry, type WorktreeFile } from "../../../../shared/worktree";
import { ChangeAgents } from "./change-agents";

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

/** How many files a change list stands for: a folded folder is all of its. */
function fileCount(files: WorktreeFile[]): number {
  return files.reduce((sum, file) => sum + (file.contents ?? 1), 0);
}

function filesLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`;
}

/**
 * An untracked folder listed as one row (`node_modules/`), with its count.
 *
 * It has no diff to open and no Discard: deleting a folder of thousands of
 * files is not a one-click undo. Its box stages all of it, as `git add` would.
 */
function FolderEntryRow({ file, pad }: { file: WorktreeFile; pad: number }) {
  const mark = MARK[file.status];
  const count = file.contents === undefined ? null : filesLabel(file.contents);
  return (
    <div className="hover:bg-foreground/[0.04] flex h-[22px] min-w-0 items-center gap-1.5 rounded pr-1.5">
      <div
        title={
          count
            ? `${file.path}: ${count}, not listed one by one`
            : `${file.path}: not listed one by one`
        }
        style={{ paddingLeft: pad }}
        className="flex h-full min-w-0 flex-1 items-center gap-[5px] text-xs"
      >
        <HugeiconsIcon
          icon={Folder01Icon}
          className="text-muted-foreground size-3.5 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{entryName(file.path)}/</span>
        <span
          className={`shrink-0 font-mono text-[10px] font-semibold ${mark.tone}`}
          title={file.status}
        >
          {mark.letter}
        </span>
        <span className="ml-auto" />
        {count && (
          <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
            {count}
          </span>
        )}
      </div>
      <StageBox files={[file]} label={file.path} />
    </div>
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
    // NOTE: A row that is a button, with two controls beside it rather than
    // inside it. A checkbox nested in a button is not something assistive
    // tech can reach, and a click on it would also open the diff.
    <div
      data-active={active || undefined}
      className="group hover:bg-foreground/[0.04] data-active:bg-foreground/[0.06] flex h-[22px] min-w-0 items-center gap-1.5 rounded pr-1.5"
    >
      <button
        type="button"
        title={file.path}
        onClick={() => focusFile(file.path)}
        style={{ paddingLeft: pad }}
        className="focus-visible:ring-accent-brand flex h-full min-w-0 flex-1 items-center gap-[5px] rounded text-left text-xs outline-none focus-visible:ring-2"
      >
        <FileTypeIcon path={file.path} className="size-3.5 shrink-0" />
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
      {/* Beside the row's button, not in it: each mark is a button
          (FE-39/D2). */}
      <ChangeAgents path={file.path} />
      {/* A real tooltip, not `title`: the native one waits a second and a
          half, which on an icon-only destructive button is too long to learn
          what it does before clicking it. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Discard changes to ${file.path}`}
              onClick={() => onRestore(file)}
              className="hover:bg-foreground/[0.08] focus-visible:ring-accent-brand flex size-[18px] shrink-0 items-center justify-center rounded opacity-0 outline-none group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:ring-2"
            />
          }
        >
          <HugeiconsIcon
            icon={Undo02Icon}
            className="text-muted-foreground size-3"
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
    <div className="hover:bg-foreground/[0.04] flex h-[22px] min-w-0 items-center gap-1.5 rounded pr-1.5">
      <button
        type="button"
        aria-expanded={!shut}
        aria-label={`${shut ? "Expand" : "Collapse"} ${folder.path}`}
        onClick={onToggle}
        style={{ paddingLeft: pad }}
        className="focus-visible:ring-accent-brand flex h-full min-w-0 flex-1 items-center gap-[5px] rounded text-left outline-none focus-visible:ring-2"
      >
        {/* No chevron: open and closed folders already say it, and the
            folder's icon then lines up with its files' icons, as in
            Repository › Files (`COMPACT_TREE_STYLE`). */}
        <HugeiconsIcon
          icon={shut ? Folder01Icon : FolderOpenIcon}
          className="text-muted-foreground size-3.5 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {/* Truncated from the start, like the diff header: the end of a
            compacted chain is the part that says where you are. */}
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate text-left text-xs [direction:rtl]"
          title={folder.path}
        >
          <bdi>{folder.name}</bdi>
        </span>
        {shut && (
          <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
            {fileCount(folder.files).toLocaleString()}
          </span>
        )}
      </button>
      <StageBox files={folder.files} label={folder.path} />
    </div>
  );
}

/** One row of the list: a section's header, a folder, or a file. */
type ListRow =
  | { kind: "section"; title: string; files: WorktreeFile[]; open: boolean }
  | { kind: "folder"; section: string; folder: Folder; depth: number }
  | { kind: "file"; file: WorktreeFile; depth: number };

/** Every row's height, in pixels: the rows' `h-[22px]`. */
const ROW = 22;
/** The list's top padding (`py-1`), before the first row. */
const PAD = 4;
/** Rows drawn above and below the ones in view, so a fast scroll lands on drawn rows. */
const OVERSCAN = 20;
/** At or under this many rows the list draws them all. */
const WINDOW_FROM = 300;

/**
 * Which rows of `count` the scroller shows now, as `[start, end)`.
 *
 * Re-renders only when that range moves, not on every scroll event.
 */
function useWindow(
  scroller: RefObject<HTMLDivElement | null>,
  count: number,
): [number, number] {
  const [range, setRange] = useState<[number, number]>([0, 3 * OVERSCAN]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || count <= WINDOW_FROM) return;
    const read = () => {
      const first = Math.floor((element.scrollTop - PAD) / ROW);
      const shown = Math.ceil(element.clientHeight / ROW);
      const start = Math.max(0, first - OVERSCAN);
      const end = Math.min(count, first + shown + OVERSCAN);
      setRange((current) =>
        current[0] === start && current[1] === end ? current : [start, end],
      );
    };
    read();
    element.addEventListener("scroll", read, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", read);
      observer.disconnect();
    };
  }, [scroller, count]);
  return count <= WINDOW_FROM ? [0, count] : range;
}

function SectionRow({
  title,
  files,
  open,
  onToggle,
}: {
  title: string;
  files: WorktreeFile[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex h-[22px] items-center gap-1.5 pr-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-accent-brand flex min-w-0 flex-1 items-center gap-1.5 rounded pl-1.5 text-left text-[11px] font-medium outline-none focus-visible:ring-2"
      >
        <HugeiconsIcon
          icon={open ? ArrowDown01Icon : ArrowRight01Icon}
          className="size-3 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        {title}
        <span className="tabular-nums">
          {fileCount(files).toLocaleString()}
        </span>
      </button>
      <StageBox files={files} label={`all ${title.toLowerCase()} files`} />
    </div>
  );
}

/**
 * The Changes tab's controls, at the right end of the window's title bar
 * (FE-130/D11): how the diff is drawn and walked, and Refresh.
 *
 * Drawn by `GitLayout` while the Changes tab is shown, in every state, so
 * Refresh is there when nothing changed and while the repository is read.
 * Stage All is the select-all box at the top of the list now.
 */
export function ChangesActions({ files }: { files: WorktreeFile[] }) {
  const refresh = useWorktree((state) => state.refresh);
  const loading = useWorktree((state) => state.loading);

  return (
    <div className="ml-auto flex min-w-0 items-center gap-2">
      {files.length > 0 && <ChangesDiffControls files={files} />}
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
    </div>
  );
}

/**
 * The list's first row: every changed file at once (FE-130/D11).
 *
 * The box sits in the same column as each file's own, so it reads as the
 * box for all of them, the way GitHub Desktop has it.
 */
function ChangesHeader({ files }: { files: WorktreeFile[] }) {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const count = fileCount(files);
  const label =
    count === 1 ? "1 changed file" : `${count.toLocaleString()} changed files`;
  return (
    <div className="border-sidebar-border flex h-8 shrink-0 items-center gap-2 border-b pr-2.5 pl-3">
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {label}
      </span>
      <Counts additions={additions} deletions={deletions} />
      <StageBox files={files} label="all changed files" />
    </div>
  );
}

/** Add `key` to a set, or take it out, as a new set. */
function toggled(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function ChangesList({ files }: { files: WorktreeFile[] }) {
  const [restoring, setRestoring] = useState<WorktreeFile[] | null>(null);
  // Sections folded shut, by title, and folders folded shut, by section and
  // path. Open by default: a change list is read whole.
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [shut, setShut] = useState<Set<string>>(() => new Set());
  const scroller = useRef<HTMLDivElement>(null);

  const sections = useMemo(
    () =>
      [
        {
          title: "Tracked",
          files: files.filter((file) => file.status !== "untracked"),
        },
        {
          title: "Untracked",
          files: files.filter((file) => file.status === "untracked"),
        },
      ].map((section) => ({ ...section, tree: buildTree(section.files) })),
    [files],
  );

  const rows = useMemo(() => {
    const out: ListRow[] = [];
    for (const { title, files: inSection, tree } of sections) {
      if (!inSection.length) continue;
      const open = !closed.has(title);
      out.push({ kind: "section", title, files: inSection, open });
      if (!open) continue;
      const folded = new Set(
        [...shut]
          .filter((key) => key.startsWith(`${title}:`))
          .map((key) => key.slice(title.length + 1)),
      );
      for (const row of visibleRows(tree, folded))
        out.push(
          row.kind === "folder"
            ? {
                kind: "folder",
                section: title,
                folder: row.folder,
                depth: row.depth,
              }
            : { kind: "file", file: row.file, depth: row.depth },
        );
    }
    return out;
  }, [sections, closed, shut]);

  const [start, end] = useWindow(scroller, rows.length);
  const onRestore = (file: WorktreeFile) => setRestoring([file]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChangesHeader files={files} />
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        <div className="relative" style={{ height: rows.length * ROW }}>
          <div
            className="absolute inset-x-0 top-0 flex flex-col"
            style={{ transform: `translateY(${start * ROW}px)` }}
          >
            {rows.slice(start, end).map((row) => {
              if (row.kind === "section")
                return (
                  <SectionRow
                    key={`section:${row.title}`}
                    title={row.title}
                    files={row.files}
                    open={row.open}
                    onToggle={() =>
                      setClosed((current) => toggled(current, row.title))
                    }
                  />
                );
              const pad = 6 + row.depth * INDENT;
              if (row.kind === "folder") {
                const key = `${row.section}:${row.folder.path}`;
                return (
                  <FolderRow
                    key={`folder:${key}`}
                    folder={row.folder}
                    pad={pad}
                    shut={shut.has(key)}
                    onToggle={() => setShut((current) => toggled(current, key))}
                  />
                );
              }
              return isFolderEntry(row.file) ? (
                <FolderEntryRow key={row.file.path} file={row.file} pad={pad} />
              ) : (
                <FileRow
                  key={row.file.path}
                  file={row.file}
                  pad={pad}
                  onRestore={onRestore}
                />
              );
            })}
          </div>
        </div>
      </div>
      <RestoreDialog files={restoring} onClose={() => setRestoring(null)} />
    </div>
  );
}

/**
 * How the diff beside the list is drawn and walked.
 *
 * Split/Unified, the previous and next file, and staging the one in view.
 * Drawn in the window's title bar by {@link ChangesActions}; the +/− is in
 * the list's header row, so the diff carries no strip of its own.
 *
 * Unified by default, with Split one click away: the owner's call, over
 * FE-22/D4's Split. The choice is remembered per viewer (`readStyle`).
 */
function ChangesDiffControls({ files }: { files: WorktreeFile[] }) {
  const diffStyle = useWorktree((state) => state.diffStyle);
  const setDiffStyle = useWorktree((state) => state.setDiffStyle);
  const focus = useWorktree((state) => state.focus);
  const focusFile = useWorktree((state) => state.focusFile);
  const stage = useWorktree((state) => state.stage);
  const unstage = useWorktree((state) => state.unstage);
  const busy = useWorktree((state) => state.busy);

  // A folder listed as one row has no diff to step to.
  const diffed = useMemo(
    () => files.filter((file) => !isFolderEntry(file)),
    [files],
  );
  const current = focus
    ? diffed.find((file) => file.path === focus.path)
    : undefined;
  const index = current ? diffed.indexOf(current) : -1;
  const step = (delta: number) => {
    if (!diffed.length) return;
    const next = diffed[(index + delta + diffed.length) % diffed.length];
    if (next) focusFile(next.path);
  };

  return (
    <>
      <SegmentedControl<DiffStyle>
        label="Diff layout"
        value={diffStyle}
        options={[
          { value: "split", label: "Split", icon: StretchVerticalIcon },
          { value: "unified", label: "Unified", icon: StretchHorizontalIcon },
        ]}
        onChange={setDiffStyle}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous file"
        title="Previous file"
        disabled={diffed.length < 2}
        onClick={() => step(-1)}
      >
        <HugeiconsIcon
          icon={ArrowUp01Icon}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next file"
        title="Next file"
        disabled={diffed.length < 2}
        onClick={() => step(1)}
      >
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </Button>
      {current && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void (current.staged === "full"
              ? unstage([current.path])
              : stage([current.path]))
          }
        >
          {current.staged === "full" ? "Unstage" : "Stage"}
        </Button>
      )}
    </>
  );
}
