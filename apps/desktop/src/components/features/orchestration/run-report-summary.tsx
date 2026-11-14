import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef } from "react";
import type {
  LeadGuardEvent,
  OrchestrationTask,
  RunReport,
} from "#/../shared/orchestration";
import { cn } from "#/lib/utils";

type Group = {
  key: "done" | "failed" | "needsYou";
  label: string;
  icon: typeof CheckmarkCircle02Icon;
  tone: string;
  ids: string[];
};

/**
 * The top of a finished or stopped run (FE-136/D4): what is Done, what
 * Failed, what Needs you. A task's name jumps to its row below. Groups with
 * no task are left out. Showing it marks the report seen, once.
 */
export function RunReportSummary({
  project,
  runId,
  report,
  leadGuard,
  tasks,
  onJump,
}: {
  project: string;
  runId: string;
  report: RunReport;
  leadGuard: LeadGuardEvent | null | undefined;
  tasks: OrchestrationTask[];
  /** Scroll to, and focus, the task's row. */
  onJump: (task: OrchestrationTask) => void;
}) {
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (report.seen || marked.current === runId) return;
    marked.current = runId;
    void window.desktop?.attention
      .markReportSeen(project, runId)
      .catch(() => {});
  }, [project, runId, report.seen]);

  const groups: Group[] = [
    {
      key: "done",
      label: "Done",
      icon: CheckmarkCircle02Icon,
      tone: "text-tone-emerald",
      ids: report.done,
    },
    {
      key: "failed",
      label: "Failed",
      icon: Alert02Icon,
      tone: "text-destructive",
      ids: report.failed,
    },
    {
      key: "needsYou",
      label: "Needs you",
      icon: UserIcon,
      tone: "text-tone-amber",
      ids: report.needsYou,
    },
  ];
  const shown = groups
    .map((group) => ({
      ...group,
      tasks: group.ids
        .map((id) => tasks.find((task) => task.id === id))
        .filter((task): task is OrchestrationTask => task !== undefined),
    }))
    .filter((group) => group.tasks.length > 0);

  // A run that only went well says so in its progress line and its ticked
  // rows; a summary of Done alone would list the same tasks twice.
  const problems = shown.some((group) => group.key !== "done");
  if (!problems && !leadGuard) return null;
  return (
    <section
      aria-label="Run summary"
      className="border-border flex min-w-0 flex-col gap-2 border-t px-3 py-2.5"
    >
      {leadGuard && (
        <p className="text-tone-amber min-w-0 text-[12px] break-words">
          {leadGuard.paused
            ? "The lead wrote a file itself and the run paused: "
            : "The lead wrote a file itself instead of delegating it: "}
          <span className="font-mono select-text">{leadGuard.path}</span>
        </p>
      )}
      {shown.map((group) => (
        <div key={group.key} className="flex min-w-0 flex-col gap-1">
          <h3
            className={cn(
              "flex items-center gap-1.5 text-[12px] font-medium",
              group.tone,
            )}
          >
            <HugeiconsIcon
              icon={group.icon}
              strokeWidth={1.8}
              aria-hidden="true"
              className="size-3.5 shrink-0"
            />
            {group.label}
            <span className="text-muted-foreground tabular-nums">
              {group.tasks.length}
            </span>
          </h3>
          <ul className="flex min-w-0 flex-col gap-0.5 pl-5">
            {group.tasks.map((task) => (
              <li key={task.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onJump(task)}
                  title={`Go to ${task.title}`}
                  className="hover:text-foreground text-muted-foreground max-w-full truncate text-left text-[12px] underline-offset-2 hover:underline"
                >
                  {task.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
