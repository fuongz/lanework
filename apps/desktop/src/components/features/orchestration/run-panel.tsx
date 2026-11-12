import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  Clock01Icon,
  Delete02Icon,
  Folder01Icon,
  PauseIcon,
  PlayIcon,
  QuestionIcon,
  SquareLock02Icon,
  StopIcon,
  Target02Icon,
  Tick02Icon,
  TickDouble02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";
import { EFFORT_LABELS, modelName } from "#/../shared/conversation";
import type {
  NeedsInput,
  OrchestrationRun,
  OrchestrationTask,
  RunLeftovers,
  RunStatus,
  TaskStatus,
} from "#/../shared/orchestration";
import { durationText } from "#/components/shared/agents/facts";
import { FileBadge } from "#/components/shared/common/markdown-body";
import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "#/components/ui/button-group";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { ipcMessage } from "#/lib/ipc-error";
import {
  shownStatus,
  taskBar,
  taskHint,
  taskLabel,
} from "#/lib/orchestration-status";
import { cn } from "#/lib/utils";
import { useProposalEdits } from "./orchestration-panel.store";
import { RunReportSummary } from "./run-report-summary";

/**
 * A tooltip on `children` (FE-137): the app's own, never a bare `title`.
 * `children` becomes the trigger, so it keeps its own element and props.
 */
function Tip({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent className="max-w-sm">{label}</TooltipContent>
    </Tooltip>
  );
}

const RUN_LABELS: Record<RunStatus, string> = {
  active: "Running",
  paused: "Paused",
  stopped: "Stopped",
  finished: "Finished",
};

/** A task the user may still cancel from the panel. */
const CANCELLABLE: readonly TaskStatus[] = [
  "queued",
  "running",
  "blocked",
  "interrupted",
];

/** An error longer than this, or on several lines, folds behind "Show all". */
const ERROR_FOLD = 160;

/** Draw again every second while `on`, so the clocks move (FE-137). */
function useTicking(on: boolean): number {
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(redraw, 1000);
    return () => clearInterval(timer);
  }, [on]);
  return Date.now();
}

/**
 * How long the run has gone (FE-137): to now while it runs, else to when it
 * last changed (a paused run holds its clock, a settled one keeps its total).
 */
function runTime(run: OrchestrationRun, now: number): string | null {
  const end =
    run.status === "active"
      ? now
      : (run.report?.finishedAt ?? 0) || run.updatedAt;
  return durationText(end - run.createdAt);
}

/** How long a worker ran (FE-137); null before it started. */
function taskTime(
  task: OrchestrationTask,
  run: OrchestrationRun,
  now: number,
): string | null {
  if (!task.startedAt) return null;
  const end = task.endedAt ?? (run.status === "active" ? now : run.updatedAt);
  return durationText(end - task.startedAt);
}

/** What a worker waits on, in one line: the lead answers it, not the user. */
function needsInputText(needs: NeedsInput): string {
  if (needs.kind === "permission")
    return `Waiting for the lead to allow ${needs.tool}${needs.summary ? `: ${needs.summary}` : ""}`;
  const first = needs.questions[0];
  return `Waiting for the lead to answer${first ? `: ${first.question}` : ""}`;
}

/** What about a worker is worth saying aloud when it changes. */
function signal(task: OrchestrationTask): string {
  return `${task.status}:${task.needsInput?.requestId ?? ""}`;
}

/**
 * What changed for the worse since the last read, as one sentence for the
 * live region (FE-91): a worker failed, was blocked, or waits on the lead.
 */
function changes(
  before: Map<string, string>,
  run: OrchestrationRun,
  status: RunStatus | null,
): string {
  const lines: string[] = [];
  for (const task of run.tasks) {
    const was = before.get(task.id);
    if (was === signal(task)) continue;
    const wasStatus = was?.split(":")[0];
    if (task.status === "failed" && wasStatus !== "failed")
      lines.push(`${task.title} failed.`);
    else if (task.status === "blocked" && wasStatus !== "blocked")
      lines.push(`${task.title} is blocked.`);
    else if (task.needsInput && was !== signal(task))
      lines.push(`${task.title} is waiting for the lead.`);
  }
  if (status !== null && status !== run.status) {
    if (run.status === "stopped") lines.push("The run stopped.");
    else if (run.status === "finished") lines.push("The run finished.");
    else if (run.status === "paused") lines.push("The run paused.");
  }
  return lines.join(" ");
}

/** A worker's error: two lines, and the rest behind a toggle (FE-91). */
function WorkerError({ id, error }: { id: string; error: string }) {
  const [open, setOpen] = useState(false);
  const long = error.length > ERROR_FOLD || error.includes("\n");
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5">
      <p
        id={id}
        className={cn(
          "text-destructive min-w-0 text-[11px] break-words select-text",
          open ? "whitespace-pre-wrap" : "line-clamp-2",
        )}
      >
        {error}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px]"
        >
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            className="size-3"
            strokeWidth={2}
            aria-hidden="true"
          />
          {open ? "Show less" : "Show the whole error"}
        </button>
      )}
    </div>
  );
}

/** What a stopped run left behind, as the cleanup dialog lists it. */
function LeftoverList({ left }: { left: RunLeftovers }) {
  const empty =
    !left.worktrees.length && !left.branches.length && !left.refs.length;
  if (empty)
    return (
      <p className="text-muted-foreground text-[12px]">
        Nothing is left in git: no checkout, branch or ref.
      </p>
    );
  const groups: { label: string; items: { key: string; text: string }[] }[] = [
    {
      label: "Checkouts",
      items: left.worktrees.map((tree) => ({
        key: tree.path,
        text: tree.title ? `${tree.title}: ${tree.path}` : tree.path,
      })),
    },
    {
      label: "Branches",
      items: left.branches.map((branch) => ({ key: branch, text: branch })),
    },
    {
      label: "Lanework refs",
      items: left.refs.map((ref) => ({ key: ref, text: ref })),
    },
  ];
  return (
    <div className="flex max-h-64 min-w-0 flex-col gap-2.5 overflow-y-auto">
      {groups.map((group) =>
        group.items.length ? (
          <section key={group.label} className="flex min-w-0 flex-col gap-1">
            <h3 className="text-[12px] font-medium">
              {group.label}{" "}
              <span className="text-muted-foreground tabular-nums">
                {group.items.length}
              </span>
            </h3>
            <ul className="flex min-w-0 flex-col gap-0.5">
              {group.items.map((item) => (
                <li
                  key={item.key}
                  className="text-muted-foreground font-mono text-[11px] break-all select-text"
                >
                  {item.text}
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

/**
 * A run's workers (FE-87): each one's status, what it waits on, and the
 * controls the user has over the run. A worker opens its transcript,
 * read-only. A task the lead gave wider write scopes than the user approved
 * waits here for Allow, or the cancel button (FE-89/D11).
 *
 * Pause sits in the header; Stop, which cannot be undone, sits apart at the
 * foot and asks first (FE-91). A stopped run offers to remove the checkouts,
 * branches and refs it left, after listing them (FE-100/O2). A queued task
 * says what it waits on (FE-100/O5). A polite live region says when a worker
 * fails, is blocked, or waits on the lead.
 */
/** A round mark the height of the row's text, on a soft fill (FE-137). */
const ROUND = "grid size-4 shrink-0 place-items-center rounded-full";

/** A round mark with an icon in it. */
function IconMark({
  icon,
  className,
}: {
  icon: IconSvgElement;
  className: string;
}) {
  return (
    <span className={cn(ROUND, className)}>
      <HugeiconsIcon
        icon={icon}
        strokeWidth={2.5}
        className="size-2.5"
        aria-hidden="true"
      />
    </span>
  );
}

/**
 * A worker's status as one round mark the height of its title (FE-137); the
 * row draws no other status. Each is an icon on a soft fill of its colour:
 *
 * - Accepted: teal, a double tick. Done, not yet reviewed: emerald, a tick.
 * - Working: sky, a spinner. Stopping: rose, a spinner.
 * - Waiting on the lead: amber, a question mark.
 * - Queued: violet, a clock; waiting for you to allow a wider scope: amber,
 *   a lock.
 * - Failed: rose, a warning. Blocked: amber, a warning. Interrupted: amber,
 *   a pause. Cancelled: grey, a cross.
 */
function StepMark({ task }: { task: OrchestrationTask }) {
  const status = shownStatus(task);
  const mark = (() => {
    if (status === "completed")
      return task.accepted ? (
        <IconMark
          icon={TickDouble02Icon}
          className="bg-tone-teal/15 text-tone-teal"
        />
      ) : (
        <IconMark
          icon={Tick02Icon}
          className="bg-tone-emerald/15 text-tone-emerald"
        />
      );
    if (task.needsInput)
      return (
        <IconMark
          icon={QuestionIcon}
          className="bg-tone-amber/15 text-tone-amber"
        />
      );
    if (status === "running" || status === "cancelling")
      return (
        <span
          className={cn(
            ROUND,
            status === "running"
              ? "bg-tone-sky/15 text-tone-sky"
              : "bg-tone-rose/15 text-tone-rose",
          )}
        >
          <OrbitSpinner className="size-2.5" />
        </span>
      );
    if (status === "queued")
      return task.scopeApproval?.length ? (
        <IconMark
          icon={SquareLock02Icon}
          className="bg-tone-amber/15 text-tone-amber"
        />
      ) : (
        <IconMark
          icon={Clock01Icon}
          className="bg-tone-violet/15 text-tone-violet"
        />
      );
    if (status === "failed")
      return (
        <IconMark
          icon={Alert02Icon}
          className="bg-tone-rose/15 text-tone-rose"
        />
      );
    if (status === "blocked")
      return (
        <IconMark
          icon={Alert02Icon}
          className="bg-tone-amber/15 text-tone-amber"
        />
      );
    if (status === "interrupted")
      return (
        <IconMark
          icon={PauseIcon}
          className="bg-tone-amber/15 text-tone-amber"
        />
      );
    return (
      <IconMark
        icon={Cancel01Icon}
        className="bg-foreground/10 text-muted-foreground"
      />
    );
  })();
  return (
    <Tip label={taskHint(task)}>
      <span className="flex shrink-0">{mark}</span>
    </Tip>
  );
}

/** Whether a write scope names a folder: the checkout, or no extension. */
function isFolderScope(scope: string): boolean {
  if (scope === "." || scope.endsWith("/")) return true;
  const name = scope.split("/").pop() ?? scope;
  return !/\.[A-Za-z0-9]+$/.test(name);
}

/**
 * One write scope as the chat's badge (FE-137). A file is the chat's own
 * file badge: click opens it in Files, right-click offers Finder and its
 * paths. A folder gets a folder icon; click reveals it in Finder, and
 * right-click offers its paths.
 */
function ScopeBadge({ slug, scope }: { slug: string; scope: string }) {
  if (!isFolderScope(scope))
    return <FileBadge value={scope} path={scope} chat />;
  const shown =
    scope === "." ? "Whole checkout" : `${scope.replace(/\/+$/, "")}/`;
  const badge =
    "bg-foreground/[0.07] inline-flex max-w-full items-start gap-[0.3em] rounded-[0.85em] py-0.5 pr-1.5 pl-1 text-left align-middle font-mono text-[0.82em] leading-[1.25]";
  const body = (
    <>
      <HugeiconsIcon
        icon={Folder01Icon}
        strokeWidth={1.8}
        aria-hidden="true"
        className="text-muted-foreground mt-[0.125em] size-[1em] shrink-0"
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">{shown}</span>
    </>
  );
  const surface = window.desktop?.worktree;
  if (!surface || scope === ".") return <code className={badge}>{body}</code>;
  const path = scope.replace(/\/+$/, "");
  // NOTE: Straight to the worktree surface: the chat's file actions look a
  // path up as a file, and a folder is not one.
  const reveal = () =>
    void surface
      .reveal(slug, path)
      .catch((error: unknown) => console.warn(error));
  const copy = (text: Promise<string>) =>
    void text
      .then((value) => navigator.clipboard.writeText(value))
      .catch((error: unknown) => console.warn(error));
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            onClick={reveal}
            className={cn(
              badge,
              "hover:bg-foreground/[0.12] focus-visible:ring-ring/40 cursor-pointer transition-colors outline-none focus-visible:ring-2",
            )}
          >
            {body}
          </button>
        }
      />
      <ContextMenuContent>
        <ContextMenuItem onClick={reveal}>Reveal in Finder</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() =>
            copy(
              surface
                .dir(slug, path)
                .then(({ root }) => `${root.replace(/\/+$/, "")}/${path}`),
            )
          }
        >
          Copy Path
        </ContextMenuItem>
        <ContextMenuItem onClick={() => copy(Promise.resolve(path))}>
          Copy Relative Path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * One worker of the run (FE-137): a row that opens and folds, its status as
 * a pill, and its facts and actions below a guide line. A worker that runs,
 * waits on the lead or went wrong starts open.
 */
function WorkerRow({
  slug,
  id,
  task,
  time,
  wider,
  waitingFor,
  busy,
  onOpen,
  onCancel,
  onAllow,
}: {
  slug: string;
  id: string;
  task: OrchestrationTask;
  time: string | null;
  wider: string[] | null;
  waitingFor: string | null;
  busy: string | null;
  onOpen: (() => void) | null;
  onCancel: (() => void) | null;
  onAllow: (() => void) | null;
}) {
  const attention = Boolean(
    task.needsInput || task.error || wider || task.status === "running",
  );
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? attention;
  const bodyId = `${id}-body`;
  return (
    <li id={`${id}-row`} className="border-border border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setChosen(!open)}
        className="hover:bg-foreground/[0.03] flex w-full min-w-0 items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <StepMark task={task} />
        <span className="sr-only">{taskLabel(task)}: </span>
        <Tip label={task.title}>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {task.title}
          </span>
        </Tip>
        {time && (
          <span className="text-muted-foreground shrink-0 text-[12px] tabular-nums">
            {time}
          </span>
        )}
        {/* Model and effort as one badge, as the proposal card shows them. */}
        <Tip
          label={`${modelName(task.model) ?? task.model}${task.effort ? `, ${EFFORT_LABELS[task.effort]} effort` : ""}${task.tier ? `, ${task.tier} tier` : ""}`}
        >
          <span className="border-border text-foreground/80 hidden shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] sm:flex">
            <TerminalKindIcon kind={task.agent} className="size-3 shrink-0" />
            <span>{modelName(task.model) ?? task.model}</span>
            {(task.effort || task.tier) && (
              <span className="text-muted-foreground">
                {task.effort ? EFFORT_LABELS[task.effort] : task.tier}
              </span>
            )}
          </span>
        </Tip>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          aria-hidden="true"
          className={cn(
            "text-muted-foreground size-3.5 shrink-0 transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div
          id={bodyId}
          className="border-border mt-1 mr-3 mb-3 ml-[19px] flex min-w-0 flex-col gap-1.5 border-l pl-[18px] text-[12px]"
        >
          {/* The files and folders it may change, with no label (FE-137):
              the chat's own badges, click to open, right-click for more. */}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
            {task.files.length ? (
              task.files.map((file) => (
                <ScopeBadge key={file} slug={slug} scope={file} />
              ))
            ) : (
              <span className="text-muted-foreground">Read only</span>
            )}
          </div>
          {waitingFor && (
            <Tip label={waitingFor}>
              <p
                className={cn(
                  "line-clamp-2 text-[11px] break-words",
                  task.cancelledDependency
                    ? "text-tone-amber"
                    : "text-muted-foreground",
                )}
              >
                {waitingFor}
              </p>
            </Tip>
          )}
          {task.needsInput && (
            <p className="text-tone-amber line-clamp-2 text-[11px]">
              {needsInputText(task.needsInput)}
            </p>
          )}
          {task.needsInput?.kind === "permission" && task.needsInput.input && (
            <Tip label={task.needsInput.input}>
              <span className="text-muted-foreground line-clamp-3 font-mono text-[11px] break-all whitespace-pre-wrap">
                {task.needsInput.input}
              </span>
            </Tip>
          )}
          {wider && (
            <span className="text-tone-amber text-[11px] break-words">
              The lead wants it to write beyond what you approved:{" "}
              <span className="font-mono">{wider.join(", ")}</span>
            </span>
          )}
          {task.error && <WorkerError id={`${id}-error`} error={task.error} />}
          {(onOpen || onAllow || onCancel) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {onOpen && (
                <Button size="sm" variant="outline" onClick={onOpen}>
                  <HugeiconsIcon
                    icon={ArrowUpRight01Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  Open chat
                </Button>
              )}
              {onAllow && wider && (
                <Tip label="Allow these write scopes, then the worker starts">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Allow ${task.title} to write ${wider.join(", ")}`}
                    disabled={busy !== null}
                    onClick={onAllow}
                  >
                    {busy === `scope:${task.id}` ? "Allowing…" : "Allow"}
                  </Button>
                </Tip>
              )}
              {onCancel && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Cancel ${task.title}`}
                  disabled={busy !== null}
                  onClick={onCancel}
                  className="text-destructive hover:text-destructive"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  {busy === `cancel:${task.id}` ? "Cancelling…" : "Cancel"}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function RunPanel({
  slug,
  project,
  run,
  title,
  focusKey = null,
  onRun,
}: {
  slug: string;
  project: string;
  run: OrchestrationRun;
  /** The approved proposal's title; null for a run no card points to. */
  title: string | null;
  /** The proposal it came from: just approved, the panel takes the focus. */
  focusKey?: string | null;
  onRun: (run: OrchestrationRun) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmClean, setConfirmClean] = useState(false);
  /** What the stopped run left, read when the cleanup dialog opens. */
  const [left, setLeft] = useState<RunLeftovers | null>(null);
  const [leftError, setLeftError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const navigate = useNavigate();
  const base = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusRequested = useProposalEdits(
    (state) => focusKey !== null && state.focus === focusKey,
  );
  const setFocus = useProposalEdits((state) => state.setFocus);

  // The card it replaces had the focus (its Approve button): it lands here,
  // not on the page.
  useEffect(() => {
    if (!focusRequested) return;
    setFocus(null);
    headingRef.current?.focus();
  }, [focusRequested, setFocus]);

  // Each read compared with the last; the first one only sets the baseline,
  // so opening a run does not read out what was already so.
  const seen = useRef<{ tasks: Map<string, string>; status: RunStatus } | null>(
    null,
  );
  useEffect(() => {
    const before = seen.current;
    seen.current = {
      tasks: new Map(run.tasks.map((task) => [task.id, signal(task)])),
      status: run.status,
    };
    if (!before) return;
    const said = changes(before.tasks, run, before.status);
    if (said) setAnnouncement(said);
  }, [run]);

  const act = async (
    key: string,
    action: () => Promise<OrchestrationRun> | undefined,
    fallback: string,
  ) => {
    setBusy(key);
    setError(null);
    try {
      const next = await action();
      if (next) onRun(next);
    } catch (caught) {
      setError(ipcMessage(caught, fallback));
    } finally {
      setBusy(null);
    }
  };
  // Driven by another Lanework (FE-138): shown, never acted on from here.
  const surface = run.drivenBy ? undefined : window.desktop?.orchestration;

  // Read again each time the cleanup dialog opens: the list it confirms is
  // what is there now (FE-100/O2).
  useEffect(() => {
    if (!confirmClean || !surface) return;
    let gone = false;
    setLeft(null);
    setLeftError(null);
    surface
      .leftovers(project, run.id)
      .then((found) => {
        if (!gone) setLeft(found);
      })
      .catch((caught: unknown) => {
        if (!gone)
          setLeftError(ipcMessage(caught, "Could not read what is left."));
      });
    return () => {
      gone = true;
    };
  }, [confirmClean, surface, project, run.id]);

  const accepted = run.tasks.filter((task) => task.accepted).length;
  const running = run.tasks.filter((task) => task.status === "running").length;
  const waiting = run.tasks.filter((task) => task.needsInput).length;
  const yours = run.tasks.filter(
    (task) => task.status === "queued" && task.scopeApproval?.length,
  ).length;
  const queued = run.tasks.filter((task) => task.status === "queued").length;
  const live = run.status === "active" || run.status === "paused";
  // A stopped run keeps unreviewed checkouts; the user removes them here.
  const cleanable = run.status === "stopped" && !run.cleanedAt;
  // Read when the Stop dialog closes, after the stop's answer has landed.
  const liveRef = useRef(live);
  liveRef.current = live;
  const heading = title ?? "Orchestration run";
  const done = run.tasks.filter((task) => task.status === "completed").length;
  // Only a running run's clocks move; a paused or settled one holds still.
  const now = useTicking(run.status === "active");
  const total = runTime(run, now);

  return (
    <article
      aria-label={`Orchestration run: ${heading}`}
      // A soft lift off the chat, as the reference card has (FE-137).
      className="bg-card border-border overflow-hidden rounded-xl border shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-8px_rgb(0_0_0/0.12)]"
    >
      {/* Said aloud, never drawn: what went wrong since the last read. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <header className="flex min-w-0 items-center gap-2 px-3 pt-2.5 pb-1.5">
        {/* The run's mark: the title's height, muted (FE-137). */}
        <HugeiconsIcon
          icon={Target02Icon}
          strokeWidth={2}
          aria-hidden="true"
          className="text-muted-foreground size-[13px] shrink-0"
        />
        <Tip label={heading}>
          <h2
            ref={headingRef}
            // Not in the tab order: the focus is only moved here, from the
            // card an approval replaced.
            tabIndex={-1}
            className="focus-visible:ring-ring/30 min-w-0 flex-1 truncate rounded-sm text-[13px] font-medium outline-none focus-visible:ring-2"
          >
            {heading}
            <span className="sr-only">, {RUN_LABELS[run.status]}</span>
          </h2>
        </Tip>
        {/* Status and clock, then the one action the run allows now:
            Run while it is paused, Stop while it runs (FE-137). */}
        <ButtonGroup className="shrink-0">
          {run.reason ? (
            // Why it paused or stopped, kept off the card (FE-137).
            <Tip label={run.reason}>
              <ButtonGroupText
                aria-hidden="true"
                className="bg-muted text-muted-foreground h-6 gap-1.5 px-2 font-normal tabular-nums"
              >
                <span>{RUN_LABELS[run.status]}</span>
                {total && <span className="text-foreground/80">{total}</span>}
              </ButtonGroupText>
            </Tip>
          ) : (
            <ButtonGroupText
              aria-hidden="true"
              className="bg-muted text-muted-foreground h-6 gap-1.5 px-2 font-normal tabular-nums"
            >
              <span>{RUN_LABELS[run.status]}</span>
              {total && <span className="text-foreground/80">{total}</span>}
            </ButtonGroupText>
          )}
          {total && <span className="sr-only">Running time {total}</span>}
          {run.drivenBy && (
            <Tip
              label={`${run.drivenBy} drives this run. This window follows it live; pause, stop or review it there.`}
            >
              <ButtonGroupText className="text-muted-foreground h-6 px-2 font-normal">
                Running in {run.drivenBy}
              </ButtonGroupText>
            </Tip>
          )}
          {live && surface && run.status === "paused" && (
            <Tip label="Resume the run: interrupted workers continue">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void act(
                    "resume",
                    () => surface.resume(project, run.id),
                    "Could not resume the run.",
                  )
                }
              >
                <HugeiconsIcon
                  icon={PlayIcon}
                  strokeWidth={2}
                  data-icon="inline-start"
                  aria-hidden="true"
                />
                {busy === "resume" ? "Running…" : "Run"}
              </Button>
            </Tip>
          )}
          {live && surface && run.status === "active" && (
            <Tip label="Stop the run">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => setConfirmStop(true)}
                className="text-destructive hover:text-destructive"
              >
                <HugeiconsIcon
                  icon={StopIcon}
                  strokeWidth={2}
                  data-icon="inline-start"
                  aria-hidden="true"
                />
                {busy === "stop" ? "Stopping…" : "Stop"}
              </Button>
            </Tip>
          )}
        </ButtonGroup>
      </header>

      {run.tasks.length > 0 && (
        <div className="flex min-w-0 items-center gap-3 px-3 pb-2.5">
          {/* One segment per worker, in its status colour (FE-137). */}
          <div aria-hidden="true" className="flex h-1.5 min-w-0 flex-1 gap-0.5">
            {run.tasks.map((task) => (
              <Tip key={task.id} label={`${task.title}: ${taskLabel(task)}`}>
                <span
                  className={cn("h-full flex-1 rounded-full", taskBar(task))}
                />
              </Tip>
            ))}
          </div>
          {/* Counts set apart by space, not a separator between them. */}
          <p className="text-muted-foreground flex shrink-0 items-center gap-x-3 text-[11px] tabular-nums">
            <span>
              {done} of {run.tasks.length} done
              {accepted > 0 && accepted < done ? `, ${accepted} accepted` : ""}
            </span>
            {running > 0 && <span>{running} working</span>}
            {waiting > 0 && (
              <span className="text-tone-amber">
                {waiting} waiting for the lead
              </span>
            )}
            {yours > 0 && (
              <span className="text-tone-amber">{yours} waiting for you</span>
            )}
          </p>
        </div>
      )}

      {run.report && (
        <RunReportSummary
          project={project}
          runId={run.id}
          report={run.report}
          leadGuard={run.leadGuard}
          tasks={run.tasks}
          onJump={(task) => {
            const row = document.getElementById(`${base}-${task.id}-row`);
            row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
            row?.querySelector("button")?.focus({ preventScroll: true });
          }}
        />
      )}

      {run.tasks.length > 0 && (
        <ul aria-label="Workers" className="border-border border-t">
          {run.tasks.map((task) => {
            // The lead asked for more than the user approved (FE-89/D11).
            const wider =
              live && task.status === "queued" && task.scopeApproval?.length
                ? task.scopeApproval
                : null;
            // Why it has not started (FE-100/O5); a wider scope says so
            // itself, below.
            // A paused or stopped run says so in its header; the line would
            // only repeat it (FE-137).
            const waitingFor =
              run.status === "active" &&
              task.status === "queued" &&
              !wider &&
              task.waitingFor
                ? task.waitingFor
                : null;
            return (
              <WorkerRow
                key={task.id}
                slug={slug}
                id={`${base}-${task.id}`}
                task={task}
                time={taskTime(task, run, now)}
                wider={wider}
                waitingFor={waitingFor}
                busy={busy}
                onOpen={
                  task.conversation
                    ? () =>
                        void navigate({
                          to: "/w/$slug/agents/chat/$conversation",
                          params: {
                            slug,
                            conversation: task.conversation ?? "",
                          },
                        })
                    : null
                }
                onCancel={
                  live && surface && CANCELLABLE.includes(task.status)
                    ? () =>
                        void act(
                          `cancel:${task.id}`,
                          () => surface.cancelTask(project, run.id, task.id),
                          "Could not cancel the worker.",
                        )
                    : null
                }
                onAllow={
                  wider && surface
                    ? () =>
                        void act(
                          `scope:${task.id}`,
                          () => surface.approveScope(project, run.id, task.id),
                          "Could not approve the write scope.",
                        )
                    : null
                }
              />
            );
          })}
        </ul>
      )}

      {error && (
        <p
          role="alert"
          className="text-destructive border-border border-t px-3 py-2 text-[12px]"
        >
          {error}
        </p>
      )}

      {cleanable && surface && (
        <footer className="border-border flex min-w-0 items-center justify-end border-t px-3 py-1.5">
          <Tip label="Remove the checkouts, branches and refs this run left">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirmClean(true)}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden="true"
              />
              {busy === "clean" ? "Cleaning up…" : "Clean up leftovers"}
            </Button>
          </Tip>
        </footer>
      )}

      {surface && (
        <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
          <AlertDialogContent
            // Kept running: back to Stop run. Stopped: that button is gone,
            // so the title takes the focus rather than the page.
            finalFocus={() => (liveRef.current ? true : headingRef.current)}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Stop this run?</AlertDialogTitle>
              <AlertDialogDescription>
                {running > 0
                  ? `${running} running ${running === 1 ? "worker is" : "workers are"} cancelled`
                  : "No worker is running now"}
                {queued > 0
                  ? `, and ${queued} queued ${queued === 1 ? "worker never starts" : "workers never start"}.`
                  : "."}{" "}
                The lead's turn stops too. A stopped run cannot be resumed; to
                hold it for a while, pause it instead.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy === "stop"}>
                Keep running
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                // `border-0`: without it the popup shows through as a 1px
                // ring (see account-section.tsx).
                className="border-0"
                disabled={busy === "stop"}
                onClick={async () => {
                  await act(
                    "stop",
                    () => surface.stop(project, run.id),
                    "Could not stop the run.",
                  );
                  setConfirmStop(false);
                }}
              >
                {busy === "stop" ? "Stopping…" : "Stop run"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {surface && cleanable && (
        <AlertDialog open={confirmClean} onOpenChange={setConfirmClean}>
          <AlertDialogContent
            // Cleaned, that button is gone: the title takes the focus.
            finalFocus={() => headingRef.current}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Clean up this run?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes what the stopped run left in the project's git.
                Work in these checkouts that was never reviewed is lost. The
                workers' conversations stay readable.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {leftError ? (
              <p role="alert" className="text-destructive text-[12px]">
                {leftError}
              </p>
            ) : left ? (
              <LeftoverList left={left} />
            ) : (
              <ListSkeleton
                label="Reading what the run left"
                rows={3}
                className="rounded-lg"
              />
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy === "clean"}>
                Keep them
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                // `border-0`: see the Stop dialog above.
                className="border-0"
                disabled={busy === "clean" || left === null}
                onClick={async () => {
                  await act(
                    "clean",
                    () => surface.cleanUp(project, run.id),
                    "Could not clean up the run.",
                  );
                  setConfirmClean(false);
                }}
              >
                {busy === "clean" ? "Removing…" : "Remove all"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </article>
  );
}
