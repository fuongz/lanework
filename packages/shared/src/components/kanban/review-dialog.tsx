import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "@tanstack/react-router";
import { MarkdownHooks, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeShiki from "@shikijs/rehype";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  LinkSquare01Icon,
  CircleIcon,
  Flag02Icon,
  UserGroupIcon,
  Calendar03Icon,
  CheckmarkSquare02Icon,
  CheckmarkCircle02Icon,
  Tag01Icon,
  RoboticIcon,
  PlayIcon,
  StopIcon,
  GitMergeIcon,
  Delete02Icon,
} from "@hugeicons/core-free-icons";
import { getCardContent, saveCardContent, deleteCard } from "@/server/reviews";
import { runAgentForCard, stopAgentForCard, mergeAgentForCard } from "@/lib/agent-client";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { estimateCost } from "@/lib/claude-pricing";
import { useBoardStore } from "@/stores/board-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { progressPercent, parseRadioGroups } from "@/lib/review-stats";
import { STATUS_META } from "@/lib/review-status";
import { formatDate, relativeAge } from "@/lib/format";
import { tagPill } from "@/lib/tag-color";
import { cn } from "@/lib/utils";
import type { ReviewCard, Priority } from "@/lib/github";

/**
 * Coordinates "pick one" task groups: registered rows in a group are mutually
 * exclusive, so selecting one clears the rest. Stable across renders (created
 * once per dialog) so it can live in the markdown components without churning
 * their identity.
 */
interface RadioCoordinator {
  register(groupId: string, line: number, set: (checked: boolean) => void): () => void;
  selectExclusive(groupId: string, line: number): void;
}

function createRadioCoordinator(): RadioCoordinator {
  const groups = new Map<string, Map<number, (checked: boolean) => void>>();
  return {
    register(groupId, line, set) {
      let g = groups.get(groupId);
      if (!g) {
        g = new Map();
        groups.set(groupId, g);
      }
      g.set(line, set);
      return () => {
        g?.delete(line);
      };
    },
    selectExclusive(groupId, line) {
      const g = groups.get(groupId);
      if (!g) return;
      for (const [other, set] of g) if (other !== line) set(false);
    },
  };
}

/**
 * Live, per-line checkbox state shared between the task rows and each
 * checklist's header. Each TaskItem writes its current state here (keyed by
 * source line); a checklist header reads back only the lines that belong to it,
 * so every list shows its own count. Created once per dialog (stable identity)
 * so the markdown components can close over it without re-running Shiki — reads
 * happen through `useSyncExternalStore` on a bumping version, not new props.
 */
interface TaskStateStore {
  set(line: number, checked: boolean): void;
  remove(line: number): void;
  isChecked(line: number): boolean;
  getVersion(): number;
  subscribe(onChange: () => void): () => void;
}

function createTaskStateStore(): TaskStateStore {
  const states = new Map<number, boolean>();
  let version = 0;
  const listeners = new Set<() => void>();
  const bump = () => {
    version++;
    for (const cb of listeners) cb();
  };
  return {
    set(line, checked) {
      if (states.get(line) === checked) return;
      states.set(line, checked);
      bump();
    },
    remove(line) {
      if (states.delete(line)) bump();
    },
    isChecked: (line) => states.get(line) ?? false,
    getVersion: () => version,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/**
 * One checklist's header count + progress ring, scoped to the task `lines` in
 * that list. Subscribes to the shared store (via its version), collapses each
 * "pick one" radio group to a single item, shows a filling ring while in
 * progress and a solid checkmark once every task is done.
 */
function ChecklistHeaderStats({
  store,
  lines,
  radioGroups,
}: {
  store: TaskStateStore;
  lines: number[];
  radioGroups: Record<number, string>;
}) {
  // Re-render whenever any checkbox toggles; the count is derived from the
  // store below, so the version is all we need to read.
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);

  let total = 0;
  let done = 0;
  const groupChosen = new Map<string, boolean>();
  for (const line of lines) {
    const gid = radioGroups[line];
    if (gid) {
      if (!groupChosen.has(gid)) {
        groupChosen.set(gid, false);
        total++;
      }
      if (store.isChecked(line)) groupChosen.set(gid, true);
    } else {
      total++;
      if (store.isChecked(line)) done++;
    }
  }
  for (const chosen of groupChosen.values()) if (chosen) done++;

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {total > 0 ? (
        done === total ? (
          <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-4 text-emerald-500 fill-emerald-100" />
        ) : (
          <CircleProgress value={(done / total) * 100} className="text-emerald-500" />
        )
      ) : null}
      <span className="tabular-nums">
        {done} of {total}
      </span>
    </span>
  );
}

/**
 * One GFM task rendered Notion-style: a checkbox + content row that owns its
 * own checked state, so toggling never re-renders the whole markdown tree (and
 * never re-runs the async Shiki pipeline). Changes are reported upward via
 * `onToggle` purely so the dialog can offer "Save changes" — the source of
 * truth for what gets written stays keyed by `line`.
 *
 * When `groupId` is set, the row belongs to a "pick one" group: it renders a
 * round (radio-style) box and, on selection, clears its siblings.
 */
function TaskItem({
  line,
  defaultChecked,
  groupId,
  coordinator,
  statsStore,
  onToggle,
  className,
  children,
}: {
  line: number;
  defaultChecked: boolean;
  groupId?: string;
  coordinator: RadioCoordinator;
  statsStore: TaskStateStore;
  onToggle: (line: number, checked: boolean) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const [checked, setChecked] = useState(defaultChecked);
  // Re-seed when the document reloads (e.g. after a save) so the row reflects
  // the new on-disk state instead of stale local state.
  useEffect(() => {
    setChecked(defaultChecked);
  }, [defaultChecked]);

  // Mirror this row's state into the shared store so its checklist header can
  // count it live; drop it when the row unmounts (e.g. document reload).
  useEffect(() => {
    statsStore.set(line, checked);
  }, [statsStore, line, checked]);
  useEffect(() => () => statsStore.remove(line), [statsStore, line]);

  const set = useCallback(
    (value: boolean) => {
      setChecked(value);
      onToggle(line, value);
    },
    [line, onToggle],
  );

  // Register in the radio group so a sibling's selection can clear this row.
  useEffect(() => {
    if (!groupId) return;
    return coordinator.register(groupId, line, set);
  }, [groupId, line, set, coordinator]);

  const handleChange = (value: boolean) => {
    set(value);
    // Selecting a "pick one" option deselects the others in its group.
    if (groupId && value) coordinator.selectExclusive(groupId, line);
  };

  return (
    // The whole row is the toggle target (the checkbox is presentational).
    <li
      role="button"
      tabIndex={0}
      aria-pressed={checked}
      onClick={() => handleChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleChange(!checked);
        }
      }}
      className={cn(
        className,
        "group/task flex list-none cursor-pointer items-start gap-3 rounded-lg px-2 py-2 transition-colors marker:content-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
        // Tighten the first paragraph so it lines up with the marker, and drop
        // the trailing margin so rows stay compact in loose lists.
        "[&>div>:first-child]:mt-0 [&>div>:last-child]:mb-0",
      )}
    >
      {/* Bigger checkbox with border + shadow. Round for "pick one" radio groups,
          square otherwise. Presentational — the row's onClick drives it. */}
      <Checkbox
        checked={checked}
        tabIndex={-1}
        className={cn(
          "pointer-events-none relative top-1 size-5 shrink-0 border shadow-sm data-checked:bg-primary [&_svg]:size-4",
          groupId && "rounded-full",
        )}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/**
 * Build markdown components that render GFM task lists as interactive,
 * Notion-style tasks. `initial` (parsed once per document) seeds each row;
 * `onToggle` reports edits up for the Save button. Both are stable across
 * toggles, so this object's identity doesn't change and Shiki isn't re-run.
 */
function makeMarkdownComponents(
  initial: Record<number, boolean>,
  radioGroups: Record<number, string>,
  coordinator: RadioCoordinator,
  onToggle: (line: number, checked: boolean) => void,
  statsStore: TaskStateStore,
): Components {
  return {
    // GFM task-list checkbox nodes carry NO source position, so we can't key
    // them here — they'd all collide on the same fallback key. The `li` handler
    // (which does have a position) renders the checkbox via TaskItem; suppress
    // the raw one. Non-checkbox inputs pass through.
    input({ type, ...props }) {
      if (type === "checkbox") return null;
      return <input type={type} {...props} />;
    },
    // Task lists render as a single bordered, shadowed card with a titled header.
    ul({ className, children, ...props }) {
      const isTaskList = className?.includes("contains-task-list");
      if (!isTaskList) {
        return (
          <ul className={className} {...props}>
            {children}
          </ul>
        );
      }
      // The task lines in THIS list — read off the TaskItem children the `li`
      // handler produced — so the header counts only its own items.
      const lines = Children.toArray(children)
        .filter(isValidElement)
        .map((el) => (el.props as { line?: number }).line)
        .filter((l): l is number => typeof l === "number");
      return (
        <div className="my-3 overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
            <span className="text-xs font-semibold flex items-center gap-1.5 uppercase tracking-wide text-muted-foreground">
              <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-4 text-muted-foreground" />
              Checklist
            </span>
            <ChecklistHeaderStats store={statsStore} lines={lines} radioGroups={radioGroups} />
          </div>
          <ul className={cn(className, "list-none p-1.5 mt-0!")} {...props}>
            {children}
          </ul>
        </div>
      );
    },
    li({ className, children, node, ...props }) {
      const isTask = className?.includes("task-list-item");
      if (!isTask) {
        return (
          <li className={className} {...props}>
            {children}
          </li>
        );
      }
      const line = node?.position?.start.line ?? 0;
      return (
        <TaskItem
          line={line}
          defaultChecked={initial[line] ?? false}
          groupId={radioGroups[line]}
          coordinator={coordinator}
          statsStore={statsStore}
          onToggle={onToggle}
          className={className}
        >
          {children}
        </TaskItem>
      );
    },
  };
}

/**
 * A small circular progress ring (0–100). Uses `currentColor`, so it inherits
 * the button's text color; the track is the same color faded out.
 */
function CircleProgress({ value, className }: { value: number; className?: string }) {
  const r = 8;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.min(100, Math.max(0, value)) / 100);
  return (
    <svg viewBox="0 0 20 20" className={cn("size-4 -rotate-90", className)} aria-hidden>
      {/* Faded track of the same color, so a small arc clearly reads as
          "barely started" on whatever background the ring sits on. */}
      <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" className="stroke-current/25" />
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-current transition-[stroke-dashoffset] duration-300"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
      />
    </svg>
  );
}

interface ReviewDialogProps {
  owner: string;
  repo: string;
  branch: string;
}

export function ReviewDialog({ owner, repo, branch }: ReviewDialogProps) {
  const router = useRouter();
  const activeCard = useBoardStore((s) => s.activeCard);
  const closeCard = useBoardStore((s) => s.closeCard);

  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Checkbox edits made in this dialog, keyed by source line (relative to the
  // rendered body). Cleared on load and after a successful save.
  const [edits, setEdits] = useState<Record<number, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function handleDelete() {
    if (!activeCard) return;
    setDeleting(true);
    try {
      await deleteCard({ data: { owner, repo, path: activeCard.path } });
      closeCard();
      await router.invalidate();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to delete.");
      setDeleting(false);
    }
  }

  // The body is what we actually hand to the renderer, so source-line numbers
  // (used as checkbox keys) must be computed against this same string.
  const body = content ? stripFrontmatter(content) : "";

  // The document's checkbox states as written on disk — seeds each row and is
  // the baseline we diff against to know whether there are unsaved changes.
  const initial = useMemo(() => parseTaskStates(body), [body]);

  // Task lines that belong to a "pick one" group (→ mutually exclusive radios).
  const radioGroups = useMemo(() => parseRadioGroups(body), [body]);

  // Created once so registered radio rows survive re-renders; stable identity
  // keeps it out of the markdownComponents dependency churn.
  const coordinator = useMemo(() => createRadioCoordinator(), []);

  // Live per-line checkbox state shared with each checklist's header. Stable
  // identity keeps it out of the markdownComponents deps (below) so ticking a
  // box doesn't re-run Shiki; the rows write into it and the headers read back.
  const statsStore = useMemo(() => createTaskStateStore(), []);

  // Stable across toggles → markdownComponents identity is stable → MarkdownHooks
  // doesn't re-run the async Shiki pipeline every time a box is ticked.
  const onToggle = useCallback((line: number, checked: boolean) => {
    setEdits((prev) => ({ ...prev, [line]: checked }));
  }, []);

  const markdownComponents = useMemo(
    () => makeMarkdownComponents(initial, radioGroups, coordinator, onToggle, statsStore),
    [initial, radioGroups, coordinator, onToggle, statsStore],
  );

  const dirty = useMemo(
    () => Object.entries(edits).some(([line, v]) => v !== (initial[Number(line)] ?? false)),
    [edits, initial],
  );

  // Live completion counts: every parsed task, with this dialog's unsaved
  // toggles applied over the on-disk baseline. Drives the Progress row in
  // realtime as boxes are ticked. Null until the document has tasks to count.
  const liveStats = useMemo(() => {
    const lines = Object.keys(initial).map(Number);
    if (lines.length === 0) return undefined;
    const valueOf = (line: number) => (line in edits ? edits[line] : initial[line]);
    let total = 0;
    let done = 0;
    // Each "pick one" group is a single decision: collapse its options to one
    // item, done once any option is selected.
    const groupChosen = new Map<string, boolean>();
    for (const line of lines) {
      const gid = radioGroups[line];
      if (gid) {
        if (!groupChosen.has(gid)) {
          groupChosen.set(gid, false);
          total++;
        }
        if (valueOf(line)) groupChosen.set(gid, true);
      } else {
        total++;
        if (valueOf(line)) done++;
      }
    }
    for (const chosen of groupChosen.values()) if (chosen) done++;
    return { total, done };
  }, [initial, edits, radioGroups]);

  const livePct =
    liveStats && liveStats.total > 0
      ? Math.round((liveStats.done / liveStats.total) * 100)
      : 0;

  async function handleSave() {
    if (!activeCard || content === null) return;
    setSaving(true);
    setSaveError(null);
    const next = applyTaskStates(content, body, edits);
    try {
      await saveCardContent({ data: { owner, repo, path: activeCard.path, content: next } });
      // Adopt the saved text as the new baseline: `initial` re-derives, rows
      // re-seed, and `dirty` falls back to false.
      setContent(next);
      setEdits({});
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!activeCard) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    setEdits({});
    setSaveError(null);
    getCardContent({ data: { owner, repo, path: activeCard.path, ref: branch } })
      .then((md) => {
        if (!cancelled) setContent(md);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load review.");
      });
    return () => {
      cancelled = true;
    };
  }, [activeCard, owner, repo, branch]);

  const githubUrl = activeCard
    ? `https://github.com/${owner}/${repo}/blob/${branch}/${activeCard.path}`
    : "#";

  return (
    <Dialog open={!!activeCard} onOpenChange={(open) => !open && closeCard()}>
      <DialogContent className="flex h-screen max-h-screen w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none">
        {/* Save edits to disk — local mode only (the cloud build has no write
            path). Sits just left of the dialog's close button. */}
        {__LANEWORK_LOCAL__ && dirty ? (
          <div className="absolute top-3 right-14 z-10 flex items-center gap-2">
            {saveError ? (
              <span className="text-xs text-destructive">{saveError}</span>
            ) : null}
            {/* Ring fills (and the count climbs) as boxes are ticked, right on
                the Save action. */}
            <Button onClick={handleSave} disabled={saving} size="lg" className="gap-2 shadow-sm">
              <CircleProgress value={livePct} />
              {saving
                ? "Saving…"
                : `Save changes${liveStats ? ` · ${liveStats.done}/${liveStats.total}` : ""}`}
            </Button>
          </div>
        ) : null}

        <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
          <div className="mx-auto w-full max-w-3xl">
            <DialogTitle className="pr-8 text-left text-lg">{activeCard?.title}</DialogTitle>
            <DialogDescription className="text-left">
              <a
                href={githubUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                {activeCard?.path}
                <HugeiconsIcon icon={LinkSquare01Icon} className="size-3" />
              </a>
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-5">
            {activeCard ? <MetaPanel card={activeCard} liveStats={liveStats} /> : null}

            {__LANEWORK_LOCAL__ && activeCard ? <AgentPanel card={activeCard} /> : null}

            <hr className="my-6 border-border" />

            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : content === null ? (
              <div className="space-y-3">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="mt-6 h-4 w-1/2" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : (
              <article className="prose prose-sm prose-neutral max-w-none dark:prose-invert prose-code:before:content-none prose-code:after:content-none">
                <MarkdownHooks
                  components={markdownComponents}
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[
                    [
                      rehypeShiki,
                      {
                        themes: { light: "github-light", dark: "github-dark" },
                      },
                    ],
                  ]}
                  fallback={
                    <div className="space-y-3">
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-5/6" />
                      <Skeleton className="h-4 w-2/3" />
                    </div>
                  }
                >
                  {body}
                </MarkdownHooks>
              </article>
            )}

            {/* Danger zone — delete the task file (local mode only). */}
            {__LANEWORK_LOCAL__ && activeCard ? (
              <div className="mt-8 flex items-center justify-between gap-3 border-t border-dashed pt-4">
                <span className="text-xs text-muted-foreground">
                  Permanently removes this review file from disk.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmOpen(true)}
                  disabled={deleting}
                  className="gap-1.5 text-destructive hover:text-destructive"
                >
                  <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                  {deleting ? "Deleting…" : "Delete task"}
                </Button>
                <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this task?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently removes{" "}
                        <span className="font-medium text-foreground">{activeCard.title}</span> from disk.
                        This can’t be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDelete}
                        className="bg-destructive text-white hover:bg-destructive/90"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const PRIORITY_STYLE: Record<Priority, string> = {
  high: "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  low: "bg-muted text-muted-foreground",
};

const STATE_BADGE: Record<string, string> = {
  running: "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
};

/**
 * Local-mode agent controls for a card: run a headless Claude Code agent on it,
 * watch its live state + log tail, then stop, discard, or merge its branch.
 * Polls `/_local/agent/status` while open. Rendered only when `__LANEWORK_LOCAL__`.
 */
function AgentPanel({ card }: { card: ReviewCard }) {
  const router = useRouter();
  const { status, refresh } = useAgentStatus(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const entry = status?.agents[card.path];
  const state = entry?.state;

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
      await refresh();
      await router.invalidate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const run = () => act("run", () => runAgentForCard(card.path));
  const merge = () => act("merge", () => mergeAgentForCard(card.path));
  // Stopping kills the agent + prunes its worktree; the card stays in its column.
  const stopClean = () => act("stop", () => stopAgentForCard(card.path));

  const disabled = busy !== null;

  return (
    <div className="mt-6 rounded-xl border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
          <HugeiconsIcon icon={RoboticIcon} className="size-4 text-violet-500" />
          Agent
        </span>
        {state ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium capitalize",
              STATE_BADGE[state] ?? "bg-muted text-muted-foreground",
            )}
          >
            {state === "running" ? (
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-70" />
                <span className="relative inline-flex size-1.5 rounded-full bg-current" />
              </span>
            ) : null}
            {state === "failed" && entry?.exitCode != null ? `failed · exit ${entry.exitCode}` : state}
          </span>
        ) : null}
        {status ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {status.active}/{status.max} running
          </span>
        ) : null}
      </div>

      {entry?.branch ? (
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          branch <span className="text-foreground">{entry.branch}</span>
        </p>
      ) : null}
      {entry?.usage?.length ? <AgentUsage usage={entry.usage} /> : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {!entry ? (
          <Button size="sm" onClick={run} disabled={disabled} className="gap-1.5">
            <HugeiconsIcon icon={PlayIcon} className="size-4" />
            {busy === "run" ? "Starting…" : "Run agent"}
          </Button>
        ) : null}
        {state === "running" ? (
          <Button size="sm" variant="outline" onClick={stopClean} disabled={disabled} className="gap-1.5">
            <HugeiconsIcon icon={StopIcon} className="size-4" />
            {busy === "stop" ? "Stopping…" : "Stop & clean"}
          </Button>
        ) : null}
        {state === "done" || state === "failed" ? (
          <>
            <Button size="sm" onClick={merge} disabled={disabled} className="gap-1.5">
              <HugeiconsIcon icon={GitMergeIcon} className="size-4" />
              {busy === "merge" ? "Merging…" : "Merge & clean"}
            </Button>
            <Button size="sm" variant="outline" onClick={stopClean} disabled={disabled} className="gap-1.5">
              <HugeiconsIcon icon={Delete02Icon} className="size-4" />
              {busy === "stop" ? "Discarding…" : "Discard"}
            </Button>
          </>
        ) : null}
      </div>

      {err ? <p className="mt-2 text-xs text-destructive">{err}</p> : null}

      {entry?.log?.length ? (
        <pre className="mt-3 max-h-44 overflow-auto rounded-lg bg-background/80 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {entry.log.slice(-30).join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

type AgentUsageModels = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}[];

/** Token in/out + estimated cost for an agent run (priced from its transcript). */
function AgentUsage({ usage }: { usage: AgentUsageModels }) {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const m of usage) {
    input += m.input + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h;
    output += m.output;
    cost += estimateCost(m.model, {
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite5m: m.cacheWrite5m,
      cacheWrite1h: m.cacheWrite1h,
    });
  }
  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);
  const dollars = cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="tabular-nums">{fmt(input)} in</span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">{fmt(output)} out</span>
      <span aria-hidden>·</span>
      <span className="font-medium text-foreground tabular-nums">~{dollars}</span>
    </p>
  );
}

function MetaPanel({
  card,
  liveStats,
}: {
  card: ReviewCard;
  // Live checkbox counts from the open document; falls back to the board-time
  // parse until the markdown has loaded.
  liveStats?: { total: number; done: number };
}) {
  const col = STATUS_META[card.column];
  const stats = liveStats ?? card.stats;
  const pct = progressPercent({ ...stats, notes: 0 });
  const age = relativeAge(card.date);

  return (
    <div className="flex flex-col">
      <Row icon={CircleIcon} label="Status">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
          <HugeiconsIcon icon={col.icon} className={cn("size-3.5", col.color)} />
          {col.label}
        </span>
      </Row>

      <Row icon={Flag02Icon} label="Priority">
        {card.priority ? (
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium capitalize",
              PRIORITY_STYLE[card.priority],
            )}
          >
            {card.priority}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Row>

      <Row icon={UserGroupIcon} label="Assignees">
        {card.assignees.length > 0 ? (
          card.assignees.map((login) => (
            <span
              key={login}
              className="inline-flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pr-2.5 pl-0.5 text-xs font-medium"
            >
              <img
                src={`https://github.com/${login}.png?size=40`}
                alt={login}
                className="size-5 rounded-full"
              />
              {login}
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        )}
      </Row>

      <Row icon={Calendar03Icon} label="Created">
        <span>
          {formatDate(card.date)}
          {age ? <span className="text-muted-foreground"> ({age})</span> : null}
        </span>
      </Row>

      <Row icon={CheckmarkSquare02Icon} label="Progress">
        {stats.total > 0 ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <span
                className={cn(
                  "block h-full rounded-full transition-all duration-300",
                  pct === 100 ? "bg-emerald-500" : "bg-primary",
                )}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="text-muted-foreground tabular-nums">
              {stats.done}/{stats.total} · {pct}%
            </span>
            {pct === 100 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                <HugeiconsIcon icon={CheckmarkSquare02Icon} className="size-3.5" />
                Ready
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Row>

      <Row icon={Tag01Icon} label="Tags">
        {card.tags.length > 0 ? (
          card.tags.map((tag) => (
            <span
              key={tag}
              className={cn("rounded-full px-2.5 py-1 text-xs font-medium", tagPill(tag))}
            >
              {tag}
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">No tags</span>
        )}
      </Row>
    </div>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: typeof Tag01Icon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 py-2">
      <div className="flex w-32 shrink-0 items-center gap-2 pt-1 text-sm text-muted-foreground">
        <HugeiconsIcon icon={icon} className="size-4" />
        {label}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">{children}</div>
    </div>
  );
}

/** Remove the leading YAML frontmatter block so it isn't rendered in the body. */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/**
 * Map each GFM task-list line (1-based, matching react-markdown's source
 * positions) to its initial checked state, so toggles start from the document.
 */
function parseTaskStates(body: string): Record<number, boolean> {
  const states: Record<number, boolean> = {};
  body.split("\n").forEach((rawLine, i) => {
    const match = rawLine.match(/^\s*[-*+]\s+\[([ xX])\]\s/);
    if (match) states[i + 1] = match[1].toLowerCase() === "x";
  });
  return states;
}

// `parseRadioGroups` lives in `@/lib/review-stats` so the board's stats parsing
// and this dialog collapse "pick one" groups identically.

/**
 * Write `edits` (keyed by body line) back into the full file `content`, flipping
 * each task's `[ ]`/`[x]` marker. Body line numbers are offset by the stripped
 * frontmatter so they land on the right line of the original file. Line endings
 * are preserved (we split/join on `\n`, leaving any `\r` untouched).
 */
function applyTaskStates(
  content: string,
  body: string,
  edits: Record<number, boolean>,
): string {
  const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const offset = fm ? (fm[0].match(/\n/g)?.length ?? 0) : 0;
  const lines = content.split("\n");
  for (const [key, value] of Object.entries(edits)) {
    const idx = Number(key) + offset - 1; // body line (1-based) → content index
    const line = lines[idx];
    if (line === undefined) continue;
    lines[idx] = line.replace(
      /^(\s*[-*+]\s+\[)[ xX](\])/,
      `$1${value ? "x" : " "}$2`,
    );
  }
  return lines.join("\n");
}
