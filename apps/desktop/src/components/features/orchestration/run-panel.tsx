import {
  Alert02Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  Clock01Icon,
  PauseIcon,
  PlayIcon,
  StopCircleIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { modelName } from "#/../shared/conversation";
import type {
  NeedsInput,
  OrchestrationRun,
  OrchestrationTask,
  RunStatus,
  TaskStatus,
} from "#/../shared/orchestration";
import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { ipcMessage } from "#/lib/ipc-error";
import { cn } from "#/lib/utils";
import { WorkerTranscript } from "./worker-transcript";

const RUN_LABELS: Record<RunStatus, string> = {
  active: "Running",
  paused: "Paused",
  stopped: "Stopped",
  finished: "Finished",
};

const TASK_LABELS: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  cancelling: "Cancelling",
  completed: "Done",
  failed: "Failed",
  blocked: "Blocked",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

/** A task the user may still cancel from the panel. */
const CANCELLABLE: readonly TaskStatus[] = [
  "queued",
  "running",
  "blocked",
  "interrupted",
];

function StatusMark({ task }: { task: OrchestrationTask }) {
  if (task.status === "running" || task.status === "cancelling")
    return <OrbitSpinner className="text-foreground size-3.5 shrink-0" />;
  const icon =
    task.status === "completed"
      ? CheckmarkCircle02Icon
      : task.status === "failed" || task.status === "blocked"
        ? Alert02Icon
        : task.status === "cancelled"
          ? CancelCircleIcon
          : task.status === "interrupted"
            ? StopCircleIcon
            : task.status === "queued"
              ? Clock01Icon
              : CircleIcon;
  return (
    <HugeiconsIcon
      icon={icon}
      strokeWidth={1.8}
      aria-hidden="true"
      className={cn(
        "size-3.5 shrink-0",
        task.status === "completed" && task.accepted && "text-tone-teal",
        (task.status === "failed" || task.status === "blocked") &&
          "text-destructive",
        (task.status === "queued" ||
          task.status === "cancelled" ||
          task.status === "interrupted") &&
          "text-muted-foreground",
      )}
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

/**
 * A run's workers (FE-87): each one's status, what it waits on, and the
 * controls the user has over the run. A worker opens its transcript,
 * read-only.
 */
export function RunPanel({
  slug,
  workspace,
  run,
  title,
  onRun,
}: {
  slug: string;
  workspace: string;
  run: OrchestrationRun;
  /** The approved proposal's title; null for a run no card points to. */
  title: string | null;
  onRun: (run: OrchestrationRun) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<OrchestrationTask | null>(null);

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

  const accepted = run.tasks.filter((task) => task.accepted).length;
  const running = run.tasks.filter((task) => task.status === "running").length;
  const waiting = run.tasks.filter((task) => task.needsInput).length;
  const live = run.status === "active" || run.status === "paused";
  // The task the dialog shows, as the run has it now.
  const shown = open
    ? (run.tasks.find((task) => task.id === open.id) ?? open)
    : null;

  return (
    <article
      aria-label={`Orchestration run — ${title ?? run.id}`}
      className="bg-card border-border overflow-hidden rounded-xl border"
    >
      <header className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
            <span className="truncate">{title ?? "Orchestration run"}</span>
            <Badge
              variant={run.status === "active" ? "secondary" : "outline"}
              className="shrink-0"
            >
              {RUN_LABELS[run.status]}
            </Badge>
          </h2>
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            {accepted}/{run.tasks.length} accepted · {running} running ·{" "}
            {run.maxWorkers} at once
            {waiting > 0 ? ` · ${waiting} waiting for the lead` : ""}
          </p>
        </div>
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
                    () => surface.pause(workspace, run.id),
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
                    () => surface.resume(workspace, run.id),
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
            <Button
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() =>
                void act(
                  "stop",
                  () => surface.stop(workspace, run.id),
                  "Could not stop the run.",
                )
              }
            >
              <HugeiconsIcon
                icon={StopIcon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden="true"
              />
              {busy === "stop" ? "Stopping…" : "Stop"}
            </Button>
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
            return (
              <li
                key={task.id}
                className="hover:bg-foreground/[0.03] flex min-w-0 items-start gap-2 px-3 py-1.5"
              >
                <button
                  type="button"
                  disabled={!task.conversation}
                  onClick={() => setOpen(task)}
                  aria-label={`Open ${task.title}'s transcript`}
                  title={
                    task.conversation
                      ? "Open its transcript"
                      : "Not started yet: no transcript"
                  }
                  className="flex min-w-0 flex-1 items-start gap-2 text-left disabled:cursor-default"
                >
                  <span className="mt-0.5 flex">
                    <StatusMark task={task} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[13px]">{task.title}</span>
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
                        {task.tier ? ` · ${task.tier}` : ""} ·{" "}
                        {TASK_LABELS[task.status]}
                      </span>
                    </span>
                    {task.needsInput && (
                      <span className="text-tone-amber line-clamp-2 text-[11px]">
                        {needsInputText(task.needsInput)}
                      </span>
                    )}
                    {task.error && (
                      <span className="text-destructive line-clamp-2 text-[11px]">
                        {task.error}
                      </span>
                    )}
                  </span>
                </button>
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
                        () => surface.cancelTask(workspace, run.id, task.id),
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

      <WorkerTranscript
        slug={slug}
        workspace={workspace}
        task={shown}
        onClose={() => setOpen(null)}
      />
    </article>
  );
}
