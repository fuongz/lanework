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
 * The working tree's changes, one row per file, grouped by folder.
 *
 * ⚠️ Grouped by DIRECTORY, not drawn as a tree. A change list is short and
 * wide-pathed; one row per folder that holds changes reads like the list in any
 * git client, where a nested tree would spend three rows of indentation to say
 * `apps/desktop/src`.
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
  indent,
  onRestore,
}: {
  file: WorktreeFile;
  indent: boolean;
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
        className={`focus-visible:ring-accent-brand flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left text-[13px] outline-none focus-visible:ring-2 ${indent ? "pl-7" : "pl-2"}`}
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
  const groups = useMemo(() => {
    const map = new Map<string, WorktreeFile[]>();
    for (const file of files) {
      const { dir } = splitPath(file.path);
      const key = dir.replace(/\/$/, "");
      map.set(key, [...(map.get(key) ?? []), file]);
    }
    return [...map].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);

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
        groups.map(([dir, members]) => (
          <div key={dir} className="flex flex-col">
            {dir && (
              <div className="hover:bg-foreground/[0.04] flex h-7 min-w-0 items-center gap-2 rounded-md pr-2">
                <button
                  type="button"
                  aria-expanded={!shut.has(dir)}
                  aria-label={`${shut.has(dir) ? "Expand" : "Collapse"} ${dir}`}
                  onClick={() => toggle(dir)}
                  className="focus-visible:ring-accent-brand flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1 text-left outline-none focus-visible:ring-2"
                >
                  <HugeiconsIcon
                    icon={shut.has(dir) ? ArrowRight01Icon : ArrowDown01Icon}
                    className="text-muted-foreground size-3 shrink-0"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  <HugeiconsIcon
                    icon={shut.has(dir) ? Folder01Icon : FolderOpenIcon}
                    className="text-muted-foreground size-4 shrink-0"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  {/* ⚠️ Truncated from the START, like the diff header: the end
                      of a directory is the part that says where you are. */}
                  <span
                    className="text-muted-foreground min-w-0 flex-1 truncate text-left text-[13px] [direction:rtl]"
                    title={dir}
                  >
                    <bdi>{dir}</bdi>
                  </span>
                  {shut.has(dir) && (
                    <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                      {members.length}
                    </span>
                  )}
                </button>
                <StageBox files={members} label={dir} />
              </div>
            )}
            {!shut.has(dir) &&
              members.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  indent={dir !== ""}
                  onRestore={onRestore}
                />
              ))}
          </div>
        ))}
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
