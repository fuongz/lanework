import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { AgentSession, BackgroundTask } from "#/../shared/terminal";
import {
  backgroundCue,
  TASK_KIND_ICONS,
  taskLabel,
  taskStatusText,
  workflowCounts,
} from "#/components/shared/agents/background-tasks";
import { useBackgroundTasks } from "#/components/shared/agents/use-background-tasks";
import { cn } from "#/lib/utils";
import { subagentKey, useAgentSessions } from "#/stores/agent-sessions";

interface CapsuleRow {
  key: string;
  label: string;
  /** The right-hand value: a kind, a status. */
  value: string;
  running: boolean;
  icon?: ReactNode;
  onOpen?: () => void;
}

/** Still going: a ring turning round how many are. Done: a tick. */
function CapsuleMark({ running }: { running: number }) {
  if (running === 0)
    return (
      <span
        aria-hidden="true"
        className="bg-tone-emerald text-background grid size-5 shrink-0 place-items-center rounded-full"
      >
        <HugeiconsIcon icon={Tick02Icon} className="size-3" strokeWidth={3} />
      </span>
    );
  return (
    <span
      aria-hidden="true"
      className="relative grid size-5 shrink-0 place-items-center"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="absolute inset-0 size-5 animate-spin [animation-duration:1.4s] motion-reduce:animate-none"
      >
        <circle
          cx="10"
          cy="10"
          r="8.5"
          fill="none"
          strokeWidth="1.5"
          className="stroke-foreground/15"
        />
        <circle
          cx="10"
          cy="10"
          r="8.5"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="14 60"
          className="stroke-foreground"
        />
      </svg>
      <span className="text-[10px] font-semibold tabular-nums">{running}</span>
    </span>
  );
}

/**
 * One group of jobs: a mark, its name, a count, Completed once none runs, and
 * its rows under a fold.
 */
function Capsule({
  title,
  meta,
  rows,
  running: going,
  ended = "Completed",
}: {
  title: string;
  meta: string;
  rows: CapsuleRow[];
  /** How many are going, when the rows alone do not say; else theirs. */
  running?: number;
  /** What it says once none runs: a workflow's own end. */
  ended?: string;
}) {
  const running = going ?? rows.filter((row) => row.running).length;
  const [choice, setChoice] = useState<boolean | null>(null);
  // Open while one runs, unless the reader said otherwise.
  const open = choice ?? running > 0;
  return (
    <section
      aria-label={title}
      className="bg-card border-border rounded-xl border shadow-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setChoice(!open)}
        className="flex h-10 w-full min-w-0 items-center gap-2.5 px-3 text-left"
      >
        <CapsuleMark running={running} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {title}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {meta}
        </span>
        {running === 0 && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              ended === "Completed"
                ? "bg-tone-emerald/12 text-tone-emerald"
                : "bg-foreground/[0.06] text-muted-foreground",
            )}
          >
            {ended}
          </span>
        )}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className={cn(
            "text-muted-foreground size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul className="border-foreground/10 ms-[21px] me-3 mb-2.5 flex flex-col border-l ps-3">
          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                disabled={!row.onOpen}
                onClick={row.onOpen}
                className="hover:bg-foreground/[0.04] flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-[13px] disabled:pointer-events-none"
              >
                {row.icon}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    row.running ? "text-shimmer" : "text-muted-foreground",
                  )}
                >
                  {row.label}
                </span>
                <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                  {row.value}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What the conversation has going besides its own turn, as capsules above the
 * composer.
 *
 * Its sub-agents, background shells and monitors, and each workflow run with
 * its agents (FE-01/D3): the ones still running, and those of the current
 * prompt once done. Hidden when there are none.
 */
export function JobCapsules({
  slug,
  project,
  session,
  since,
}: {
  slug: string;
  project: string;
  session: AgentSession | undefined;
  /** When the last prompt was sent, ISO: older finished jobs are not shown. */
  since: string | null;
}) {
  const navigate = useNavigate();
  const live = useAgentSessions((state) => state.live);
  const any = (session?.background.total ?? 0) > 0;
  const { tasks } = useBackgroundTasks(
    project,
    session?.id ?? null,
    backgroundCue(session),
    any,
  );
  if (!session) return null;
  const recent = (at: string) => since !== null && at >= since;

  const subagents = session.subagents
    .map((sub) => ({
      sub,
      working: live[subagentKey(session, sub)] ?? sub.working,
    }))
    .filter((entry) => entry.working || recent(entry.sub.updatedAt))
    .sort(
      (a, b) =>
        Number(b.working) - Number(a.working) ||
        b.sub.updatedAt.localeCompare(a.sub.updatedAt),
    );
  const shown = (tasks ?? []).filter(
    (task) => task.status === "running" || recent(task.startedAt),
  );
  // NOTE: An agent task is a sub-agent already listed above, and a workflow
  // has a capsule of its own, so shells and monitors only.
  const jobs = shown.filter(
    (task) => task.kind === "shell" || task.kind === "monitor",
  );
  const workflows = shown.filter((task) => task.workflow !== null);

  if (subagents.length === 0 && jobs.length === 0 && workflows.length === 0)
    return null;

  const openTask = (task: BackgroundTask) =>
    void navigate({
      to: "/w/$slug/agents/task/$conversation/$task",
      params: { slug, conversation: session.id, task: task.id },
    });

  const going = subagents.filter((entry) => entry.working).length;
  const runningJobs = jobs.filter((task) => task.status === "running").length;
  return (
    <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
      {subagents.length > 0 && (
        <Capsule
          title="Sub-agents"
          meta={
            going > 0
              ? `${going} of ${subagents.length} working`
              : `${subagents.length} agent${subagents.length === 1 ? "" : "s"}`
          }
          rows={subagents.map(({ sub, working }) => ({
            key: sub.id,
            label: sub.title,
            value: working ? "working" : (sub.type ?? "done"),
            running: working,
            onOpen: () =>
              void navigate({
                to: "/w/$slug/agents/sub/$conversation/$sub",
                params: { slug, conversation: session.id, sub: sub.id },
                search: { agent: session.agent },
              }),
          }))}
        />
      )}
      {workflows.map((task) => {
        const workflow = task.workflow;
        if (!workflow) return null;
        const counts = workflowCounts(workflow);
        const running = task.status === "running";
        return (
          <Capsule
            key={task.id}
            title={taskLabel(task)}
            meta={
              running && counts.working > 0
                ? `${counts.working} of ${counts.total} working`
                : `${counts.total} agent${counts.total === 1 ? "" : "s"}`
            }
            // Between two phases no agent works, yet the run goes on.
            running={running ? Math.max(1, counts.working) : 0}
            ended={
              task.status === "completed"
                ? "Completed"
                : taskStatusText(task).replace(/^./, (first) =>
                    first.toUpperCase(),
                  )
            }
            rows={workflow.phases.flatMap((phase) =>
              phase.agents.map((agent) => ({
                key: agent.id,
                label: agent.label,
                value: agent.working ? "working" : (phase.name ?? "done"),
                running: agent.working,
                onOpen: () =>
                  void navigate({
                    to: "/w/$slug/agents/sub/$conversation/$sub",
                    params: { slug, conversation: session.id, sub: agent.id },
                    search: { agent: "claude", run: workflow.runId },
                  }),
              })),
            )}
          />
        );
      })}
      {jobs.length > 0 && (
        <Capsule
          title="Background jobs"
          meta={
            runningJobs > 0
              ? `${runningJobs} running`
              : `${jobs.length} job${jobs.length === 1 ? "" : "s"}`
          }
          rows={jobs.map((task) => ({
            key: task.id,
            label: task.description || task.command || task.id,
            value: taskStatusText(task),
            running: task.status === "running",
            icon: (
              <HugeiconsIcon
                icon={TASK_KIND_ICONS[task.kind]}
                className="text-muted-foreground size-3 shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            ),
            onOpen: () => openTask(task),
          }))}
        />
      )}
    </div>
  );
}
