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
import { useMemo, useState } from "react";
import { SegmentedControl } from "#/components/shared/common/segmented-control";
import { splitPath } from "#/components/shared/diff/diff-file-header";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import {
  buildTree,
  type Folder,
  INDENT,
  MARK,
  TWISTIE,
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
import { type DiffStyle, stagedTally, useWorktree } from "#/stores/worktree";
import type { WorktreeFile } from "../../../../shared/worktree";
import { ChangeAgents } from "./change-agents";

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
      {/* Beside the row's button, not in it: each mark is a button (FE-39/D2). */}
      <ChangeAgents path={file.path} />
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

/**
 * The screen's header, in the window's title bar (FE-58): its name, what the
 * working tree adds and removes, and Refresh.
 *
 * ⚠️ Drawn by `ChangesLayout`, not by the list: the list is only there while
 * something changed, and the screen still needs its name — and Refresh — when
 * nothing has.
 */
export function ChangesTitlebar({ files }: { files: WorktreeFile[] }) {
  const refresh = useWorktree((state) => state.refresh);
  const loading = useWorktree((state) => state.loading);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const stage = useWorktree((state) => state.stage);
  const unstage = useWorktree((state) => state.unstage);
  const busy = useWorktree((state) => state.busy);
  const allStaged = files.length > 0 && stagedTally(files) === "full";

  return (
    <WindowTitlebar>
      <h1 className={WINDOW_TITLE}>Changes</h1>
      <Counts additions={additions} deletions={deletions} />
      {files.length > 0 ? (
        <ChangesDiffControls files={files} />
      ) : (
        <span className="ml-auto" />
      )}
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
    </WindowTitlebar>
  );
}

export function ChangesList({ files }: { files: WorktreeFile[] }) {
  const [restoring, setRestoring] = useState<WorktreeFile[] | null>(null);

  const tracked = files.filter((file) => file.status !== "untracked");
  const untracked = files.filter((file) => file.status === "untracked");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The screen's name, counts, the diff's controls, Stage All and
          Refresh are all in the title bar — see `ChangesTitlebar`. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-2 pb-2">
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

/**
 * How the diff beside the list is drawn and walked: Split/Unified, the
 * previous and next file, and staging the one in view. Drawn in the window's
 * title bar (FE-58) by `ChangesTitlebar`; the screen's +/− is already beside
 * its name there, so the diff carries no strip of its own.
 *
 * ⚠️ Unified by default, with Split one click away — the owner's call, over
 * FE-22/D4's Split. The choice is remembered per viewer (`readStyle`).
 */
export function ChangesDiffControls({ files }: { files: WorktreeFile[] }) {
  const diffStyle = useWorktree((state) => state.diffStyle);
  const setDiffStyle = useWorktree((state) => state.setDiffStyle);
  const focus = useWorktree((state) => state.focus);
  const focusFile = useWorktree((state) => state.focusFile);
  const stage = useWorktree((state) => state.stage);
  const unstage = useWorktree((state) => state.unstage);
  const busy = useWorktree((state) => state.busy);

  const current = focus
    ? files.find((file) => file.path === focus.path)
    : undefined;
  const index = current ? files.indexOf(current) : -1;
  const step = (delta: number) => {
    if (!files.length) return;
    const next = files[(index + delta + files.length) % files.length];
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
      <span className="ml-auto" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous file"
        title="Previous file"
        disabled={files.length < 2}
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
        disabled={files.length < 2}
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
