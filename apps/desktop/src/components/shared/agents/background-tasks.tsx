import {
  Alert02Icon,
  ArrowRight01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  ComputerTerminal01Icon,
  HelpCircleIcon,
  Radar01Icon,
  Robot02Icon,
  StopIcon,
  TaskDaily01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type {
  AgentSession,
  BackgroundTask,
  BackgroundTaskKind,
} from "#/../shared/terminal";
import { useBackgroundTasks } from "#/components/shared/agents/use-background-tasks";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { WorkingMark } from "#/components/shared/terminal/working-mark";
import { Alert, AlertDescription } from "#/components/ui/alert";
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
import { cn } from "#/lib/utils";

/**
 * Whether the app can stop `task`.
 *
 * A running shell, or a running monitor whose one process was found
 * (FE-56/D1). Never an agent.
 */
export function canStop(task: BackgroundTask): boolean {
  return (
    task.status === "running" &&
    (task.kind === "shell" || (task.kind === "monitor" && task.pid !== null))
  );
}

/** `pid 59852`, for a running task whose process is known. */
export function pidText(task: BackgroundTask): string | null {
  return task.status === "running" && task.pid !== null
    ? `pid ${task.pid}`
    : null;
}

/** One confirmation flow shared by all three Stop entry points. */
export function useStopBackgroundTask(
  workspace: string | null,
  conversation: string,
) {
  const [confirming, setConfirming] = useState<BackgroundTask | null>(null);
  const [pending, setPending] = useState(false);
  const pendingIdentity = useRef<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const identity = `${workspace}:${conversation}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new conversation resets its confirmation and feedback
  useEffect(() => {
    setConfirming(null);
    setNotice(null);
    setPending(false);
    pendingIdentity.current = null;
  }, [identity]);
  const stop = async () => {
    const startedFor = identity;
    if (
      !workspace ||
      !confirming ||
      !window.desktop ||
      pendingIdentity.current === identity
    )
      return;
    pendingIdentity.current = identity;
    setPending(true);
    try {
      const result = await window.desktop.terminal.agentStopTask(
        workspace,
        conversation,
        confirming.id,
      );
      if (currentIdentity.current !== startedFor) return;
      if (result.stopped === 0) setNotice("That task was no longer running");
    } catch (error) {
      if (currentIdentity.current !== startedFor) return;
      setNotice(ipcMessage(error, "Could not stop this task."));
    } finally {
      if (currentIdentity.current === startedFor) {
        pendingIdentity.current = null;
        setRevision((value) => value + 1);
        setPending(false);
        setConfirming(null);
      }
    }
  };
  return {
    revision,
    requestStop: (task: BackgroundTask) => {
      if (!pending && canStop(task)) {
        setNotice(null);
        setConfirming(task);
      }
    },
    feedback: (
      <>
        <AlertDialog
          open={confirming !== null}
          onOpenChange={(open) => {
            if (!open && !pending) setConfirming(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Stop{" "}
                {confirming?.description ||
                  confirming?.command ||
                  `this background ${confirming?.kind ?? "task"}`}
                ?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Its running processes will be stopped
                {confirming?.pid != null
                  ? ` (process group ${confirming.pid})`
                  : ""}
                .
              </AlertDialogDescription>
            </AlertDialogHeader>
            <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs">
              <code>{confirming?.command ?? confirming?.description}</code>
            </pre>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>
                Keep it running
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={pending}
                onClick={() => void stop()}
              >
                Stop
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {notice && (
          <Alert className="mx-2 my-1 w-auto">
            <AlertDescription>{notice}</AlertDescription>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setNotice(null)}
              aria-label="Dismiss notification"
            >
              Dismiss
            </Button>
          </Alert>
        )}
      </>
    ),
  };
}

/** Each kind's icon, wherever a task is listed. */
export const TASK_KIND_ICONS: Record<BackgroundTaskKind, IconSvgElement> = {
  shell: ComputerTerminal01Icon,
  agent: Robot02Icon,
  monitor: Radar01Icon,
};

const KIND_NOUNS: Record<BackgroundTaskKind, [string, string]> = {
  shell: ["shell", "shells"],
  agent: ["agent", "agents"],
  monitor: ["monitor", "monitors"],
};

/** `1 shell, 5 agents`: the running ones, by kind, in that order. */
function runningText(tasks: BackgroundTask[]): string {
  return (["shell", "agent", "monitor"] as const)
    .map((kind) => {
      const count = tasks.filter(
        (task) => task.kind === kind && task.status === "running",
      ).length;
      const [one, many] = KIND_NOUNS[kind];
      return count === 0 ? null : `${count} ${count === 1 ? one : many}`;
    })
    .filter(Boolean)
    .join(", ");
}

/** How a finished task ended, as a mark and a colour. */
const STATUS_LOOK: Partial<
  Record<BackgroundTask["status"], { icon: IconSvgElement; tone: string }>
> = {
  completed: { icon: CheckmarkCircle02Icon, tone: "text-tone-emerald" },
  failed: { icon: Alert02Icon, tone: "text-destructive" },
  killed: { icon: CancelCircleIcon, tone: "text-tone-amber" },
  lost: { icon: HelpCircleIcon, tone: "text-muted-foreground" },
};

/** Where a finished task ended, as a person reads it: `failed, exit 1`. */
export function taskStatusText(task: BackgroundTask): string {
  if (task.status === "lost") return "lost";
  return task.exitCode !== null && task.status !== "running"
    ? `${task.status}, exit ${task.exitCode}`
    : task.status;
}

/** The cue to read a conversation's tasks again: its listing moved on. */
export function backgroundCue(session: AgentSession | undefined): string {
  return session
    ? `${session.updatedAt}:${session.background.running}:${session.background.total}`
    : "";
}

/**
 * One task in the popover.
 *
 * A shell or monitor opens its own page; an agent opens its transcript in the
 * sub-agent viewer.
 */
function TaskRow({
  task,
  now,
  onOpen,
  onStop,
}: {
  task: BackgroundTask;
  now: number;
  onOpen: (task: BackgroundTask) => void;
  onStop?: (task: BackgroundTask) => void;
}) {
  const running = task.status === "running";
  const opens = task.kind !== "agent" || task.subagentId !== null;
  const status = taskStatusText(task);
  const pid = pidText(task);
  return (
    <div className="group/task flex min-w-0 items-center">
      <button
        type="button"
        disabled={!opens}
        onClick={() => onOpen(task)}
        aria-label={`${task.description || task.command || task.id}, ${task.kind}, ${status}`}
        title={`${task.command ?? task.description}\n${status}${pid ? ` (${pid})` : ""}, started ${relativeTime(task.startedAt, now)}${task.summary ? `\n${task.summary}` : ""}`}
        className={cn(
          "hover:bg-foreground/[0.04] focus-visible:ring-accent-brand flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-[13px] outline-none focus-visible:ring-2 disabled:pointer-events-none",
          task.status === "lost" && "opacity-50",
        )}
      >
        {/* Its kind stays on the left; running spins on the right. */}
        <HugeiconsIcon
          icon={TASK_KIND_ICONS[task.kind]}
          className="text-muted-foreground size-3 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            !running && "text-muted-foreground",
          )}
        >
          {task.description || task.command || task.id}
        </span>
        {!running && (
          // A coloured mark level with the word, so how it ended reads at a
          // glance.
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 text-[11px] tabular-nums",
              STATUS_LOOK[task.status]?.tone ?? "text-muted-foreground",
            )}
          >
            <HugeiconsIcon
              icon={STATUS_LOOK[task.status]?.icon ?? HelpCircleIcon}
              className="size-3 shrink-0"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            {status}
          </span>
        )}
        {running && <WorkingMark />}
        {pid && (
          <span className="text-muted-foreground/70 shrink-0 font-mono text-[11px] tabular-nums">
            {pid}
          </span>
        )}
        <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
          {shortAge(task.endedAt ?? task.startedAt, now)}
        </span>
      </button>
      {canStop(task) && onStop && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Stop ${task.description || task.command || task.id}`}
          className="shrink-0 opacity-0 group-hover/task:opacity-100 group-focus-within/task:opacity-100"
          onClick={() => onStop(task)}
        >
          <HugeiconsIcon icon={StopIcon} strokeWidth={1.8} />
        </Button>
      )}
    </div>
  );
}

/**
 * The agent view's background tasks: a chip and a popover (FE-42/D1).
 *
 * The chip counts the running ones by kind (`1 shell, 5 agents`, or `3 tasks`
 * muted once none runs). The popover lists them, running first, the finished
 * folded (FE-42/D2). Hidden while the conversation has none, since most never
 * start one. Claude only: Codex's listing always counts 0.
 */
export function BackgroundTasksButton({
  slug,
  workspace,
  session,
}: {
  slug: string;
  workspace: string;
  session: AgentSession;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  /**
   * The user's fold choice for the Finished group.
   *
   * Null follows the default (FE-42/D2): folded unless nothing runs.
   */
  const [finishedChoice, setFinishedChoice] = useState<boolean | null>(null);
  const stopping = useStopBackgroundTask(workspace, session.id);
  const any = session.agent === "claude" && session.background.total > 0;
  const { tasks, error } = useBackgroundTasks(
    workspace,
    session.id,
    `${backgroundCue(session)}:${stopping.revision}`,
    any,
  );
  if (!any) return null;

  const list = tasks ?? [];
  const running = list.filter((task) => task.status === "running");
  const finished = list.filter((task) => task.status !== "running");
  const label =
    running.length > 0
      ? runningText(list)
      : `${list.length || session.background.total} task${(list.length || session.background.total) === 1 ? "" : "s"}`;
  const finishedOpen = finishedChoice ?? running.length === 0;
  const now = Date.now();

  const openTask = (task: BackgroundTask) => {
    setOpen(false);
    if (task.kind === "agent") {
      if (!task.subagentId) return;
      void navigate({
        to: "/w/$slug/agents/sub/$conversation/$sub",
        params: { slug, conversation: session.id, sub: task.subagentId },
        search: { agent: "claude" },
      });
      return;
    }
    void navigate({
      to: "/w/$slug/agents/task/$conversation/$task",
      params: { slug, conversation: session.id, task: task.id },
    });
  };

  return (
    <>
      {stopping.feedback}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              size="sm"
              variant="secondary"
              data-testid="background-tasks"
              aria-label={`Background tasks: ${label}`}
            />
          }
        >
          {/* Running: the usual spinner, in the icon's place. */}
          {running.length > 0 ? (
            <WorkingMark />
          ) : (
            <HugeiconsIcon
              icon={TaskDaily01Icon}
              strokeWidth={1.8}
              data-icon="inline-start"
              aria-hidden="true"
            />
          )}
          <span
            className={cn(
              "tabular-nums",
              running.length === 0 && "text-muted-foreground",
            )}
          >
            {label}
          </span>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[26rem] gap-2 p-1.5">
          <div className="flex items-baseline gap-2 px-1.5 pt-1">
            <span className="text-[13px] font-medium">Background tasks</span>
            <span className="text-muted-foreground tabular-nums">
              {list.length}
            </span>
          </div>
          {error && !tasks ? (
            <p role="alert" className="text-destructive px-1.5 text-xs">
              {error}
            </p>
          ) : !tasks ? (
            <ListSkeleton
              label="Reading its transcript"
              rows={3}
              className="px-0"
            />
          ) : list.length === 0 ? (
            <Empty className="py-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon
                    icon={ComputerTerminal01Icon}
                    strokeWidth={1.8}
                  />
                </EmptyMedia>
                <EmptyTitle>No background tasks</EmptyTitle>
                <EmptyDescription>
                  This conversation started nothing in the background.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex max-h-80 min-h-0 flex-col overflow-y-auto">
              {running.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  now={now}
                  onOpen={openTask}
                  onStop={(task) => {
                    setOpen(false);
                    stopping.requestStop(task);
                  }}
                />
              ))}
              {finished.length > 0 && (
                <>
                  <button
                    type="button"
                    aria-expanded={finishedOpen}
                    onClick={() => setFinishedChoice(!finishedOpen)}
                    className="text-muted-foreground hover:text-foreground flex h-7 shrink-0 items-center gap-1.5 px-1.5 text-left text-xs transition-colors"
                  >
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      className={cn(
                        "size-3 transition-transform motion-reduce:transition-none",
                        finishedOpen && "rotate-90",
                      )}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    Finished ({finished.length})
                  </button>
                  {finishedOpen &&
                    finished.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        now={now}
                        onOpen={openTask}
                      />
                    ))}
                </>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}
