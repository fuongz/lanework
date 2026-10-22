import {
  Alert02Icon,
  ArrowLeft01Icon,
  CheckmarkCircle02Icon,
  ComputerTerminal01Icon,
  Copy01Icon,
  HelpCircleIcon,
  Robot02Icon,
  StopCircleIcon,
  Tick02Icon,
  Timer02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type AgentSession,
  BACKGROUND_OUTPUT_MAX,
  type BackgroundTask,
  type BackgroundTaskStatus,
} from "#/../shared/terminal";
import {
  backgroundCue,
  canStop,
  pidText,
  TASK_KIND_ICONS,
  taskLabel,
  useStopBackgroundTask,
  WorkflowPhases,
  workflowCounts,
} from "#/components/shared/agents/background-tasks";
import {
  durationText,
  type Fact,
  Facts,
} from "#/components/shared/agents/facts";
import {
  useBackgroundTasks,
  useTaskOutput,
} from "#/components/shared/agents/use-background-tasks";
import { useCopy } from "#/components/shared/common/use-copy";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import { WorkingMark } from "#/components/shared/terminal/working-mark";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";

const ROUTE = "/_app/w/$slug/agents/task/$conversation/$task" as const;
/** Within this many pixels of the end counts as "at the bottom". */
const BOTTOM_SLACK = 24;

/** Each ended status's icon and tone, for the header. */
const ENDED: Record<
  Exclude<BackgroundTaskStatus, "running">,
  { icon: IconSvgElement; tone: string }
> = {
  completed: { icon: CheckmarkCircle02Icon, tone: "text-tone-emerald" },
  failed: { icon: Alert02Icon, tone: "text-destructive" },
  killed: { icon: StopCircleIcon, tone: "text-muted-foreground" },
  lost: { icon: HelpCircleIcon, tone: "text-muted-foreground" },
};

/** What `lost` means, said where it is shown. */
const LOST_NOTE =
  "Its conversation ended and no word of it ever came: the CLI that ran it is gone.";

/** Now, again every second while `ticking`, so a running task's age moves. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return ticking ? now : Date.now();
}

/**
 * A background shell, monitor or workflow of a Claude conversation,
 * read-only, full size in the main view (FE-42/D3).
 *
 * Shows what it runs, where it stands, and the end of its output, followed
 * live while it runs. A workflow shows its agents by phase instead, each
 * opening in the sub-agent viewer (FE-01/D3). A running one can be stopped after confirmation; the
 * header shows the pid of its process group. The header link opens its parent
 * conversation as the rail's row does: the tab running it, or else its chat.
 */
export function ShellTaskView() {
  const { slug, conversation, task } = useParams({ from: ROUTE });
  // NOTE: Keyed by which task: the route stays mounted from one to the next,
  // and the last one's scroll position is not this one's.
  return (
    <ShellTaskPage
      key={`${conversation}/${task}`}
      slug={slug}
      conversation={conversation}
      taskId={task}
    />
  );
}

function ShellTaskPage({
  slug,
  conversation,
  taskId,
}: {
  slug: string;
  conversation: string;
  taskId: string;
}) {
  const workspace = useWorkspaceKey(slug);
  const navigate = useNavigate();
  const parent: AgentSession | undefined = useAgentSessions((state) =>
    workspace
      ? state.byWorkspace[workspace]?.find(
          (entry) => entry.agent === "claude" && entry.id === conversation,
        )
      : undefined,
  );
  const liveTab = useAgentTerminals((state) => state.liveTab);
  const stopping = useStopBackgroundTask(workspace, conversation);
  const { tasks, error } = useBackgroundTasks(
    workspace,
    conversation,
    `${backgroundCue(parent)}:${stopping.revision}`,
  );
  const task: BackgroundTask | undefined = tasks?.find(
    (entry) => entry.id === taskId,
  );
  const running = task?.status === "running";
  // A workflow has no output: its agents are its record.
  const { output, error: outputError } = useTaskOutput(
    workspace,
    conversation,
    taskId,
    running,
    task !== undefined && task.kind !== "workflow",
  );
  const now = useNow(running);
  const [copied, copy] = useCopy();
  const pid = task ? pidText(task) : null;

  // Follows the end only while the reader is at the end: scrolled up to read
  // something, the next second's lines must not yank them back down.
  const scroller = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const text = output?.text ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is the cue to follow
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [text]);

  const openParent = () => {
    if (!workspace || !parent) return;
    void liveTab(workspace, parent).then((tab) => {
      if (tab)
        void navigate({
          to: "/w/$slug/agents/$terminalId",
          params: { slug, terminalId: tab.id },
        });
      else
        void navigate({
          to: "/w/$slug/agents/chat/$conversation",
          params: { slug, conversation: parent.id },
        });
    });
  };

  const title = task ? taskLabel(task) : "Background task";
  const counts = task?.workflow ? workflowCounts(task.workflow) : null;

  const facts: Fact[] = [];
  if (task) {
    const ended = task.status === "running" ? null : ENDED[task.status];
    facts.push(
      ended
        ? {
            key: "status",
            label: "Status",
            icon: ended.icon,
            text: task.status,
            className: ended.tone,
            title: task.status === "lost" ? LOST_NOTE : undefined,
          }
        : {
            key: "status",
            label: "Status",
            mark: <WorkingMark />,
            text: "running",
            className: "text-foreground",
          },
    );
    if (counts)
      facts.push({
        key: "agents",
        label: "Agents",
        icon: Robot02Icon,
        text:
          running && counts.working > 0
            ? `${counts.working} of ${counts.total} working`
            : `${counts.total} agent${counts.total === 1 ? "" : "s"}`,
      });
    if (task.exitCode !== null)
      facts.push({
        key: "exit",
        label: "Exit code",
        icon: ComputerTerminal01Icon,
        text: `exit ${task.exitCode}`,
        className: task.exitCode === 0 ? undefined : "text-destructive",
      });
    // A lost one has no end: how long it ran is not known.
    const end = task.endedAt
      ? Date.parse(task.endedAt)
      : task.status === "running"
        ? now
        : null;
    const took =
      end === null ? null : durationText(end - Date.parse(task.startedAt));
    if (took)
      facts.push({
        key: "took",
        label: running ? "Running for" : "Ran for",
        icon: Timer02Icon,
        text: took,
      });
  }

  const ended = task && task.status !== "running" ? ENDED[task.status] : null;

  return (
    <section
      aria-label={`Background task — ${title}`}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    >
      {stopping.feedback}
      {/* In the window's title bar, as the sub-agent viewer's is: the bar
          drags the window and clears its controls. */}
      <WindowTitlebar>
        {running ? (
          <span role="img" aria-label="Running" className="flex shrink-0">
            <WorkingMark />
          </span>
        ) : (
          <HugeiconsIcon
            icon={ended?.icon ?? TASK_KIND_ICONS[task?.kind ?? "shell"]}
            className={cn("size-[13px] shrink-0", ended?.tone)}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        )}
        {parent && (
          <>
            <button
              type="button"
              onClick={openParent}
              aria-label={`Open its conversation, “${parent.title}”, in Claude`}
              title={parent.title}
              className="text-muted-foreground hover:text-foreground flex min-w-0 max-w-[40%] shrink items-center gap-1 text-[13px] transition-colors"
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                className="size-3.5 shrink-0"
                strokeWidth={2}
                aria-hidden="true"
              />
              <span className="truncate">{parent.title}</span>
            </button>
            <span aria-hidden="true" className="text-muted-foreground/60">
              /
            </span>
          </>
        )}
        <h1
          className={`${WINDOW_TITLE} ${running ? "text-shimmer" : ""}`}
          title={title}
        >
          {title}
        </h1>
        {task && task.kind !== "shell" && (
          <Badge variant="secondary" className="h-5 shrink-0 px-1.5">
            {task.kind}
          </Badge>
        )}
        {pid && task?.pid != null && (
          // Its process, to find in `ps` or Activity Monitor (FE-56/D3).
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground shrink-0 font-mono tabular-nums"
            aria-label={copied === "pid" ? `Copied ${pid}` : `Copy ${pid}`}
            title="Copy the pid leading its process group"
            onClick={() => copy("pid", String(task.pid))}
          >
            {pid}
            <HugeiconsIcon
              icon={copied === "pid" ? Tick02Icon : Copy01Icon}
              strokeWidth={1.8}
              data-icon="inline-end"
              aria-hidden="true"
            />
          </Button>
        )}
        {task && canStop(task) && (
          <Button
            variant="outline"
            size="sm"
            className="ms-auto"
            onClick={() => stopping.requestStop(task)}
          >
            <HugeiconsIcon icon={StopCircleIcon} strokeWidth={1.8} />
            Stop
          </Button>
        )}
      </WindowTitlebar>
      {task && <Facts facts={facts} data-testid="task-meta" />}

      {!task ? (
        tasks !== null || error ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Empty className="py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
                </EmptyMedia>
                <EmptyTitle>Could not open this task</EmptyTitle>
                <EmptyDescription>
                  {error ?? "Its conversation no longer lists it."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : null
      ) : task.workflow ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          {task.description !== title && (
            <p className="text-muted-foreground text-[13px]">
              {task.description}
            </p>
          )}
          <section aria-label="Agents" className="flex flex-col gap-1">
            <h2 className="text-foreground text-[13px] font-medium">Agents</h2>
            <WorkflowPhases
              workflow={task.workflow}
              className="-mx-1.5"
              onOpen={(agent) =>
                void navigate({
                  to: "/w/$slug/agents/sub/$conversation/$sub",
                  params: { slug, conversation, sub: agent.id },
                  search: {
                    agent: "claude",
                    run: task.workflow?.runId,
                  },
                })
              }
            />
          </section>
          {/* Stopping, resuming or editing a run is the CLI's (FE-01/D7). */}
          <p className="text-muted-foreground text-xs">
            To control the run, use{" "}
            <code className="font-mono">/workflows</code> in Claude Code.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
          {task.command && (
            <section aria-label="Command" className="flex flex-col gap-2">
              <h2 className="text-foreground text-[13px] font-medium">
                Command
              </h2>
              {/* Wide or long, it scrolls inside its own box. */}
              <pre className="bg-foreground/[0.04] max-h-40 shrink-0 overflow-auto rounded-lg p-3 font-mono text-[11px] leading-relaxed">
                <code>{task.command}</code>
              </pre>
            </section>
          )}
          <section
            aria-label="Output"
            className="flex min-h-0 flex-1 flex-col gap-2"
          >
            <h2 className="text-foreground flex items-baseline gap-2 text-[13px] font-medium">
              Output
              {output?.truncated && (
                <span className="text-muted-foreground text-xs font-normal">
                  Showing last {BACKGROUND_OUTPUT_MAX / 1024} KB
                </span>
              )}
            </h2>
            {outputError && !output ? (
              <p role="alert" className="text-destructive text-xs">
                {outputError}
              </p>
            ) : output && (output.missing || output.text === "") ? (
              <Empty className="items-start p-0 py-2 text-left">
                <EmptyHeader className="items-start">
                  <EmptyDescription className="text-xs">
                    {output.missing
                      ? "No output file for it: the CLI never wrote one where it said, or has cleaned it up since."
                      : running
                        ? "Nothing written yet."
                        : "It wrote nothing."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              output && (
                <pre
                  ref={scroller}
                  data-testid="task-output"
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    pinned.current =
                      element.scrollHeight -
                        element.scrollTop -
                        element.clientHeight <
                      BOTTOM_SLACK;
                  }}
                  className="bg-foreground/[0.04] min-h-0 flex-1 overflow-auto rounded-lg p-3 font-mono text-[11px] leading-relaxed whitespace-pre"
                >
                  <code>{output.text}</code>
                </pre>
              )
            )}
          </section>
        </div>
      )}
    </section>
  );
}
