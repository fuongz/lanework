import {
  Alert02Icon,
  ArrowRight01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  ComputerTerminal01Icon,
  HelpCircleIcon,
  Radar01Icon,
  Robot02Icon,
  TaskDaily01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type {
  AgentSession,
  BackgroundTask,
  BackgroundTaskKind,
} from "#/../shared/terminal";
import { useBackgroundTasks } from "#/components/shared/agents/use-background-tasks";
import { WorkingMark } from "#/components/shared/terminal/working-mark";
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
import { cn } from "#/lib/utils";

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
 * One task in the popover (FE-42/D2): a shell or monitor opens its own page;
 * an agent opens its transcript in the sub-agent viewer.
 */
function TaskRow({
  task,
  now,
  onOpen,
}: {
  task: BackgroundTask;
  now: number;
  onOpen: (task: BackgroundTask) => void;
}) {
  const running = task.status === "running";
  const opens = task.kind !== "agent" || task.subagentId !== null;
  const status = taskStatusText(task);
  return (
    <button
      type="button"
      disabled={!opens}
      onClick={() => onOpen(task)}
      aria-label={`${task.description || task.command || task.id}, ${task.kind}, ${status}`}
      title={`${task.command ?? task.description}\n${status}, started ${relativeTime(task.startedAt, now)}${task.summary ? `\n${task.summary}` : ""}`}
      className={cn(
        "hover:bg-foreground/[0.04] focus-visible:ring-accent-brand flex h-7 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-1.5 text-left text-[13px] outline-none focus-visible:ring-2 disabled:pointer-events-none",
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
        // A coloured mark beside the word, level with it: how it ended reads
        // at a glance.
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
      <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
        {shortAge(task.endedAt ?? task.startedAt, now)}
      </span>
    </button>
  );
}

/**
 * The agent view's background tasks (FE-42/D1): a chip counting the running
 * ones by kind — `1 shell, 5 agents`, or `3 tasks` muted once none runs —
 * and a popover listing them, running first, the finished folded (D2).
 *
 * ⚠️ Hidden while the conversation has none: most never start one. Claude
 * only — Codex's listing always counts 0.
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
  /** The Finished group, folded (D2) — unless the user said, or nothing runs. */
  const [finishedChoice, setFinishedChoice] = useState<boolean | null>(null);
  const any = session.agent === "claude" && session.background.total > 0;
  const { tasks, error } = useBackgroundTasks(
    workspace,
    session.id,
    backgroundCue(session),
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
        {/* Running: the spinner every running thing has, in the icon's place. */}
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
                {tasks
                  ? "This conversation started nothing in the background."
                  : "Reading its transcript…"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex max-h-80 min-h-0 flex-col overflow-y-auto">
            {running.map((task) => (
              <TaskRow key={task.id} task={task} now={now} onOpen={openTask} />
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
  );
}
