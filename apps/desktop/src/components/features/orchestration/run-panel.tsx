import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  Clock01Icon,
  Delete02Icon,
  PauseIcon,
  PlayIcon,
  StopCircleIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { modelName } from "#/../shared/conversation";
import type {
  NeedsInput,
  OrchestrationRun,
  OrchestrationTask,
  RunLeftovers,
  RunStatus,
  TaskStatus,
} from "#/../shared/orchestration";
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
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { ipcMessage } from "#/lib/ipc-error";
import { shownStatus, taskLabel, taskTone } from "#/lib/orchestration-status";
import { cn } from "#/lib/utils";
import { useProposalEdits } from "./orchestration-panel.store";

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

function StatusMark({ task }: { task: OrchestrationTask }) {
  const status = shownStatus(task);
  if (status === "running" || status === "cancelling")
    return <OrbitSpinner className={cn("size-3.5 shrink-0", taskTone(task))} />;
  const icon =
    status === "completed"
      ? CheckmarkCircle02Icon
      : status === "failed" || status === "blocked"
        ? Alert02Icon
        : status === "cancelled"
          ? CancelCircleIcon
          : status === "interrupted"
            ? StopCircleIcon
            : status === "queued"
              ? Clock01Icon
              : CircleIcon;
  return (
    <HugeiconsIcon
      icon={icon}
      strokeWidth={1.8}
      aria-hidden="true"
      // Its status's colour, the same as its label's and the rail's.
      className={cn("size-3.5 shrink-0", taskTone(task))}
    />
  );
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
  const surface = window.desktop?.orchestration;

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
  // Done and Accepted read alike; the foot says how they differ once both
  // can be seen.
  const someDone = run.tasks.some((task) => task.status === "completed");

  return (
    <article
      aria-label={`Orchestration run: ${heading}`}
      className="bg-card border-border overflow-hidden rounded-xl border"
    >
      {/* Said aloud, never drawn: what went wrong since the last read. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <header className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h2
            ref={headingRef}
            // Not in the tab order: the focus is only moved here, from the
            // card an approval replaced.
            tabIndex={-1}
            className="focus-visible:ring-ring/30 flex min-w-0 items-center gap-2 rounded-sm text-[13px] font-medium outline-none focus-visible:ring-2"
          >
            <span className="truncate" title={heading}>
              {heading}
            </span>
            <Badge
              variant={run.status === "active" ? "secondary" : "outline"}
              className="shrink-0"
            >
              {RUN_LABELS[run.status]}
            </Badge>
          </h2>
          {/* Counts set apart by space, not a separator between them. */}
          <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
            <span>
              {accepted}/{run.tasks.length} accepted
            </span>
            <span>{running} running</span>
            <span>{run.maxWorkers} at once</span>
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
        {/* Only Pause or Resume up here: Stop is at the foot, away from it. */}
        {live && surface && (
          <div className="flex shrink-0 items-center gap-1">
            {run.status === "active" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void act(
                    "pause",
                    () => surface.pause(project, run.id),
                    "Could not pause the run.",
                  )
                }
              >
                <HugeiconsIcon
                  icon={PauseIcon}
                  strokeWidth={2}
                  data-icon="inline-start"
                  aria-hidden="true"
                />
                {busy === "pause" ? "Pausing…" : "Pause"}
              </Button>
            ) : (
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
                {busy === "resume" ? "Resuming…" : "Resume"}
              </Button>
            )}
          </div>
        )}
      </header>

      {run.reason && (
        <p className="text-muted-foreground border-border border-t px-3 py-2 text-[12px]">
          {run.reason}
        </p>
      )}

      {run.tasks.length > 0 && (
        <ul aria-label="Workers" className="border-border border-t py-1">
          {run.tasks.map((task) => {
            const cancellable = live && CANCELLABLE.includes(task.status);
            // The lead asked for more than the user approved (FE-89/D11).
            const wider =
              live && task.status === "queued" && task.scopeApproval?.length
                ? task.scopeApproval
                : null;
            const errorId = `${base}-${task.id}-error`;
            const needsId = `${base}-${task.id}-needs`;
            const waitId = `${base}-${task.id}-wait`;
            // Why it has not started (FE-100/O5); a wider scope says so
            // itself, below.
            const waitingFor =
              task.status === "queued" && !wider && task.waitingFor
                ? task.waitingFor
                : null;
            return (
              <li
                key={task.id}
                className="hover:bg-foreground/[0.03] flex min-w-0 flex-col gap-0.5 px-3 py-1.5"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <button
                    type="button"
                    disabled={!task.conversation}
                    // Its conversation in the main view, read-only; its title
                    // bar leads back here.
                    onClick={() => {
                      if (task.conversation)
                        void navigate({
                          to: "/w/$slug/agents/chat/$conversation",
                          params: { slug, conversation: task.conversation },
                        });
                    }}
                    aria-label={`Open ${task.title}'s conversation, ${taskLabel(task)}`}
                    aria-describedby={
                      [
                        waitingFor ? waitId : null,
                        task.needsInput ? needsId : null,
                        task.error ? errorId : null,
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    title={
                      task.conversation
                        ? `Open ${task.title}`
                        : `${task.title}: not started yet, no conversation`
                    }
                    className="flex min-w-0 flex-1 items-start gap-2 text-left disabled:cursor-default"
                  >
                    <span className="mt-0.5 flex">
                      <StatusMark task={task} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13px]">
                          {task.title}
                        </span>
                        {task.accepted && (
                          <Badge variant="outline" className="shrink-0">
                            Accepted
                          </Badge>
                        )}
                      </span>
                      <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px]">
                        <TerminalKindIcon
                          kind={task.agent}
                          className="size-3 shrink-0"
                        />
                        <span className="truncate">
                          {modelName(task.model) ?? task.model}
                        </span>
                        {task.tier && (
                          <Badge
                            variant="outline"
                            className="h-4 shrink-0 px-1.5"
                          >
                            {task.tier}
                          </Badge>
                        )}
                        <span
                          className={cn("shrink-0 font-medium", taskTone(task))}
                        >
                          {taskLabel(task)}
                        </span>
                      </span>
                    </span>
                  </button>
                  {wider && surface && (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Allow ${task.title} to write ${wider.join(", ")}`}
                      title="Allow these write scopes, then the worker starts"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          `scope:${task.id}`,
                          () => surface.approveScope(project, run.id, task.id),
                          "Could not approve the write scope.",
                        )
                      }
                    >
                      {busy === `scope:${task.id}` ? "Allowing…" : "Allow"}
                    </Button>
                  )}
                  {cancellable && surface && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Cancel ${task.title}`}
                      title="Cancel this worker"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          `cancel:${task.id}`,
                          () => surface.cancelTask(project, run.id, task.id),
                          "Could not cancel the worker.",
                        )
                      }
                    >
                      <HugeiconsIcon
                        icon={Cancel01Icon}
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </Button>
                  )}
                </div>
                {/* Out of the row's button, so the error can be expanded
                    and selected. */}
                {(task.needsInput || task.error || wider || waitingFor) && (
                  <div className="flex min-w-0 flex-col gap-0.5 pl-5.5">
                    {waitingFor && (
                      <p
                        id={waitId}
                        className={cn(
                          "line-clamp-2 text-[11px] break-words",
                          task.cancelledDependency
                            ? "text-tone-amber"
                            : "text-muted-foreground",
                        )}
                        title={waitingFor}
                      >
                        {waitingFor}
                      </p>
                    )}
                    {task.needsInput && (
                      <p
                        id={needsId}
                        className="text-tone-amber line-clamp-2 text-[11px]"
                      >
                        {needsInputText(task.needsInput)}
                      </p>
                    )}
                    {task.needsInput?.kind === "permission" &&
                      task.needsInput.input && (
                        <span
                          className="text-muted-foreground line-clamp-3 font-mono text-[11px] break-all whitespace-pre-wrap"
                          title={task.needsInput.input}
                        >
                          {task.needsInput.input}
                        </span>
                      )}
                    {wider && (
                      <span className="text-tone-amber text-[11px] break-words">
                        The lead wants it to write beyond what you approved:{" "}
                        <span className="font-mono">{wider.join(", ")}</span>
                      </span>
                    )}
                    {task.error && (
                      <WorkerError id={errorId} error={task.error} />
                    )}
                  </div>
                )}
              </li>
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

      {(someDone || ((live || cleanable) && surface)) && (
        <footer className="text-muted-foreground border-border flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-2 text-[11px]">
          {someDone && (
            <p className="min-w-0 flex-1">
              <span className="text-tone-emerald font-medium">Done</span>: the
              worker finished.{" "}
              <span className="text-tone-teal font-medium">Accepted</span>: the
              lead reviewed its result and took it.
            </p>
          )}
          {live && surface && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirmStop(true)}
              className="text-destructive hover:text-destructive ml-auto"
            >
              <HugeiconsIcon
                icon={StopIcon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden="true"
              />
              {busy === "stop" ? "Stopping…" : "Stop run"}
            </Button>
          )}
          {cleanable && surface && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirmClean(true)}
              title="Remove the checkouts, branches and refs this run left"
              className="ml-auto"
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden="true"
              />
              {busy === "clean" ? "Cleaning up…" : "Clean up leftovers"}
            </Button>
          )}
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
