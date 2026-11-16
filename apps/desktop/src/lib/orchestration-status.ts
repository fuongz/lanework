// How a worker's status reads wherever it is drawn (FE-87): its label and its
// colour, the same in the lead's run panel and in the rail.
import type { OrchestrationTask, TaskStatus } from "#/../shared/orchestration";

export const TASK_LABELS: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Working",
  cancelling: "Stopping",
  completed: "Done",
  failed: "Failed",
  blocked: "Blocked",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

/**
 * The status a task is drawn with. A queued task whose dependency was
 * cancelled never starts by itself: it reads as blocked (FE-100/O5).
 */
export const shownStatus = (task: OrchestrationTask): TaskStatus =>
  task.status === "queued" && task.cancelledDependency
    ? "blocked"
    : task.status;

/** A task's label: accepted once the lead took its result. */
export const taskLabel = (task: OrchestrationTask): string =>
  task.status === "completed" && task.accepted
    ? "Accepted"
    : TASK_LABELS[shownStatus(task)];

/**
 * The one colour a task is drawn in, wherever it is drawn: its mark, its
 * badge, its segment of the run's bar, the rail and the run's summary.
 *
 * - neutral: not started, interrupted or cancelled; nothing went wrong.
 * - amber: someone has to answer (the lead, or you), or it is blocked.
 * - sky: a worker is at it.
 * - emerald: done; accepted is the same green, filled.
 * - rose: it failed, or is being stopped.
 */
export type TaskToneName = "neutral" | "amber" | "sky" | "emerald" | "rose";

export function taskToneName(task: OrchestrationTask): TaskToneName {
  const status = shownStatus(task);
  if (status === "completed") return "emerald";
  if (status === "failed" || status === "cancelling") return "rose";
  if (status === "blocked") return "amber";
  if (task.needsInput) return "amber";
  if (status === "queued" && task.scopeApproval?.length) return "amber";
  if (status === "running") return "sky";
  return "neutral";
}

/** Each tone as a text colour: a mark, a badge, a summary line. */
export const TONE_TEXT: Record<TaskToneName, string> = {
  neutral: "text-muted-foreground",
  amber: "text-tone-amber",
  sky: "text-tone-sky",
  emerald: "text-tone-emerald",
  rose: "text-tone-rose",
};

/** A task's colour class, for its mark and its label alike. */
export const taskTone = (task: OrchestrationTask): string =>
  TONE_TEXT[taskToneName(task)];

/**
 * What a task's badge says: its status, or, while someone has to answer,
 * who: the lead (Waiting) or you (Needs you).
 */
export const taskBadge = (task: OrchestrationTask): string =>
  task.needsInput && task.status === "running"
    ? "Waiting"
    : task.status === "queued" && task.scopeApproval?.length
      ? "Needs you"
      : taskLabel(task);

/** A task's segment of the run's progress bar (FE-137), as its colour. */
export const taskBar = (task: OrchestrationTask): string => {
  const tone = taskToneName(task);
  if (tone === "neutral")
    // Not started is the track itself; stopped without an error, a step
    // darker.
    return shownStatus(task) === "queued"
      ? "bg-foreground/10"
      : "bg-foreground/25";
  if (tone === "sky") return "bg-tone-sky motion-safe:animate-pulse";
  return {
    amber: "bg-tone-amber",
    emerald: "bg-tone-emerald",
    rose: "bg-tone-rose",
  }[tone];
};

/** What each label means, for its tooltip: Done and Accepted read alike. */
export const taskHint = (task: OrchestrationTask): string =>
  task.status === "completed"
    ? task.accepted
      ? "Accepted: the lead reviewed the result and took it"
      : "Done: the worker finished; the lead has not reviewed it yet"
    : taskLabel(task);
