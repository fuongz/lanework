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

const TONES: Record<TaskStatus, string> = {
  queued: "text-tone-violet",
  running: "text-tone-sky",
  cancelling: "text-tone-sky",
  completed: "text-tone-emerald",
  failed: "text-tone-rose",
  blocked: "text-tone-amber",
  interrupted: "text-tone-amber",
  cancelled: "text-muted-foreground",
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

/** A task's colour class, for its mark and its label alike. */
export const taskTone = (task: OrchestrationTask): string =>
  task.status === "completed" && task.accepted
    ? "text-tone-teal"
    : TONES[shownStatus(task)];
