import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Clock01Icon,
  File01Icon,
  Folder01Icon,
  FolderOpenIcon,
  GitCompareIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentFacts,
  AgentFiles,
  AgentFileTouch,
  TerminalAgent,
} from "#/../shared/terminal";
import { linesFact } from "#/components/shared/agents/conversation-facts";
import { splitPath } from "#/components/shared/diff/diff-file-header";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import {
  buildTree,
  type Folder,
  INDENT,
  MARK,
  TWISTIE,
  visibleRows,
} from "#/components/shared/repo/file-tree";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { relativeTime, shortAge } from "#/lib/board-view";
import { ipcMessage } from "#/lib/ipc-error";
import { useWorktree } from "#/stores/worktree";
import type { WorktreeFile } from "../../../../shared/worktree";

/** A stable empty, so the tree is not rebuilt on every render while loading. */
const NO_FILES: AgentFileTouch[] = [];

/** Said wherever the list is: what it cannot know. */
const SHELL_NOTE =
  "Only edits made with the agent's file tools are listed. Files it changed through the shell — sed, a script, a formatter — are not.";

function FolderRow({
  folder,
  pad,
  shut,
  onToggle,
}: {
  folder: Folder<AgentFileTouch>;
  pad: number;
  shut: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={!shut}
      aria-label={`${shut ? "Expand" : "Collapse"} ${folder.path}`}
      onClick={onToggle}
      style={{ paddingLeft: pad }}
      className="hover:bg-foreground/[0.04] focus-visible:ring-accent-brand flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md pr-2 text-left outline-none focus-visible:ring-2"
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
      {/* Truncated from the start, as Changes does: the end of a compacted
          chain is the part that says where you are. */}
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
  );
}

/**
 * One file the conversation edited: how often, how lately (FE-39/D1, D6).
 *
 * A file still changed in the working tree opens its diff in Changes. One
 * that is not (committed since, or put back) is dimmed and does nothing,
 * since Changes has nothing to show for it.
 */
function FileRow({
  touch,
  changed,
  pad,
  now,
  onOpen,
}: {
  touch: AgentFileTouch;
  changed: WorktreeFile | undefined;
  pad: number;
  now: number;
  onOpen: (file: WorktreeFile) => void;
}) {
  const { name } = splitPath(touch.path);
  const mark = changed ? MARK[changed.status] : null;
  const body = (
    <>
      <FileTypeIcon path={touch.path} className="size-4 shrink-0" />
      <span
        className={`min-w-0 truncate ${touch.op === "deleted" ? "line-through" : ""}`}
      >
        {name}
      </span>
      {mark && changed && (
        <span
          className={`shrink-0 font-mono text-[10px] font-semibold ${mark.tone}`}
          title={changed.status}
        >
          {mark.letter}
        </span>
      )}
      {touch.via && (
        <span className="text-muted-foreground shrink-0 truncate text-[11px]">
          via {touch.via.type ?? "sub-agent"}
        </span>
      )}
      <span className="ml-auto" />
      <span
        className="text-muted-foreground flex shrink-0 items-center gap-2 text-[11px] tabular-nums"
        title={`${touch.edits === 1 ? "1 edit" : `${touch.edits} edits`}, the last ${relativeTime(touch.lastAt, now)}`}
      >
        <span className="flex items-center gap-0.5">
          <HugeiconsIcon
            icon={PencilEdit02Icon}
            className="size-3"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          {touch.edits}
        </span>
        <span className="flex items-center gap-0.5">
          <HugeiconsIcon
            icon={Clock01Icon}
            className="size-3"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          {shortAge(touch.lastAt, now)}
        </span>
      </span>
    </>
  );
  const row =
    "flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-md pr-2 text-left text-[13px]";
  if (!changed)
    return (
      <div
        aria-disabled="true"
        title={`${touch.path} — no change to show: committed or put back since`}
        style={{ paddingLeft: pad }}
        className={`${row} opacity-50`}
      >
        {body}
      </div>
    );
  return (
    <button
      type="button"
      title={touch.path}
      aria-label={`Open the diff of ${touch.path}`}
      onClick={() => onOpen(changed)}
      style={{ paddingLeft: pad }}
      className={`${row} hover:bg-foreground/[0.04] focus-visible:ring-accent-brand outline-none focus-visible:ring-2`}
    >
      {body}
    </button>
  );
}

/** Line counts as `+81 −20`, coloured as the rail's Changes is. */
function LineCounts({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 tabular-nums">
      {added > 0 && (
        <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
      )}
      {removed > 0 && (
        <span className="text-rose-600 dark:text-rose-400">−{removed}</span>
      )}
    </span>
  );
}

/**
 * The agent view's "Changes" (FE-39/D1): the files this conversation edited,
 * nested by folder the way Changes is.
 *
 * Its sub-agents' files are listed with them, "via" their kind (FE-39/D5).
 * The list is read again on every turn that opens or closes and whenever it is
 * opened; main caches each transcript by size and mtime, so a re-read only
 * parses what the agent appended since.
 */
export function AgentFilesButton({
  slug,
  workspace,
  agent,
  id,
  working,
  facts,
}: {
  slug: string;
  workspace: string;
  agent: TerminalAgent;
  id: string;
  working: boolean;
  /** Its numbers: Claude's own count of the lines it wrote, shown inside. */
  facts?: AgentFacts | null;
}) {
  const navigate = useNavigate();
  const peek = useWorktree((state) => state.peek);
  const focusFile = useWorktree((state) => state.focusFile);
  // The working tree's changes, once this project's status has been read.
  const changes = useWorktree((state) =>
    state.slug === slug && state.state?.kind === "ready"
      ? state.state.files
      : null,
  );
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<AgentFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Folders folded shut, by path.
  const [shut, setShut] = useState<Set<string>>(() => new Set());
  const asked = useRef(0);

  const load = useCallback(async () => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const mine = ++asked.current;
    try {
      const next = await surface.agentFiles(workspace, agent, id);
      if (mine !== asked.current) return;
      setFound(next);
      setError(null);
    } catch (failure) {
      if (mine !== asked.current) return;
      setError(
        ipcMessage(failure, "The conversation's files could not be read."),
      );
    }
  }, [workspace, agent, id]);

  // Another conversation: nothing of the last one's stays on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new conversation
  useEffect(() => {
    setFound(null);
    setError(null);
    setShut(new Set());
  }, [workspace, agent, id]);

  // On a turn opening or closing too: one that closed may have edited more.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `working` is the cue
  useEffect(() => {
    void load();
  }, [load, working]);

  // The count on the button is git's: the working tree's status, read once
  // here. Changes keeps it current after that.
  useEffect(() => {
    void peek(slug);
  }, [peek, slug]);

  const byPath = useMemo(() => {
    const map = new Map<string, WorktreeFile>();
    for (const file of changes ?? []) {
      map.set(file.path, file);
      // A file the agent edited, then renamed, is the rename's.
      if (file.previousPath) map.set(file.previousPath, file);
    }
    return map;
  }, [changes]);
  const files = found?.files ?? NO_FILES;
  // What git still sees changed in the files it edited.
  let added = 0;
  let removed = 0;
  const counted = new Set<WorktreeFile>();
  for (const touch of files) {
    const file = byPath.get(touch.path);
    if (!file || counted.has(file)) continue;
    counted.add(file);
    added += file.additions;
    removed += file.deletions;
  }
  const lines = facts ? linesFact(facts) : null;
  const tree = useMemo(() => buildTree(files), [files]);
  const rows = useMemo(() => visibleRows(tree, shut), [tree, shut]);
  const flat = tree.every((node) => node.kind === "file");
  const now = Date.now();

  const toggle = (path: string) =>
    setShut((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // Its diff, scrolled to in Changes.
  const openDiff = (file: WorktreeFile) => {
    setOpen(false);
    focusFile(file.path);
    void navigate({ to: "/w/$slug/changes", params: { slug } });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        void load();
        // Which of them are still changed: the rail's status read.
        void peek(slug);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="secondary"
            data-testid="agent-changes"
            aria-label={`Changes: ${files.length} ${files.length === 1 ? "file" : "files"} edited${added || removed ? `, +${added} −${removed} in git` : ""}`}
            disabled={found === null && error === null}
          />
        }
      >
        <HugeiconsIcon
          icon={GitCompareIcon}
          strokeWidth={1.8}
          data-icon="inline-start"
          aria-hidden="true"
        />
        Changes
        <LineCounts added={added} removed={removed} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] gap-2 p-1.5">
        <div className="flex items-center gap-2 px-1.5 pt-1">
          <span className="text-[13px] font-medium">Files it edited</span>
          <span className="text-muted-foreground tabular-nums">
            {files.length}
          </span>
          {lines && (
            <span
              title={lines.title}
              className="text-muted-foreground ms-auto flex items-center gap-1 text-xs tabular-nums"
            >
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                className="size-3"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span className="sr-only">{lines.label}: </span>
              {lines.text}
            </span>
          )}
        </div>
        {error ? (
          <p role="alert" className="text-destructive px-1.5 text-xs">
            {error}
          </p>
        ) : files.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={File01Icon} strokeWidth={1.8} />
              </EmptyMedia>
              <EmptyTitle>No files edited</EmptyTitle>
              <EmptyDescription>{SHELL_NOTE}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="flex max-h-80 min-h-0 flex-col overflow-y-auto">
              {rows.map((row) =>
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
                    touch={row.file}
                    changed={byPath.get(row.file.path)}
                    pad={flat ? 8 : 4 + row.depth * INDENT + TWISTIE}
                    now={now}
                    onOpen={openDiff}
                  />
                ),
              )}
            </div>
            <p className="text-muted-foreground px-1.5 pb-1 text-[11px]/relaxed">
              {found?.partial &&
                "This conversation is longer than Lanework reads; edits before its newest part may be missing. "}
              {SHELL_NOTE}
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
