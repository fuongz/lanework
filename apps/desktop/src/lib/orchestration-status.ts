// How a worker's status reads wherever it is drawn (FE-87): its label and its
// colour, the same in the lead's run panel and in the rail.
import type {
  OrchestrationRun,
  OrchestrationTask,
  TaskStatus,
} from "#/../shared/orchestration";

export const TASK_LABELS: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Working",
  cancelling: "Stopping",
  // Finished by its worker, not yet taken by the lead: under review. Once
  // the lead accepts it, it is Done (see `taskLabel`).
  completed: "Review",
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

/**
 * A task's label. Its worker finished: Review, while the lead reviews it;
 * Done once the lead accepted it. Working > Review > Done.
 */
export const taskLabel = (task: OrchestrationTask): string =>
  task.status === "completed" && task.accepted
    ? "Done"
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

/** What each label means, for its tooltip. */
export const taskHint = (task: OrchestrationTask): string =>
  task.status === "completed"
    ? task.accepted
      ? "Done: the lead reviewed the result and took it"
      : "Review: the worker finished; the lead reviews it"
    : taskLabel(task);

/**
 * A run's one status, from its tasks (the pill at the top of its card):
 * what the reader most needs to know about the whole of it, in this order.
 *
 * Stopped or paused by someone; a task failed; a task waits on someone (the
 * lead or you); a worker is at it; every task is done; nothing started yet.
 */
export function runOverall(run: OrchestrationRun): {
  label: string;
  tone: TaskToneName;
  /** Still moving: its dot pulses. */
  live: boolean;
} {
  const tones = run.tasks.map(taskToneName);
  if (run.status === "stopped")
    return { label: "Stopped", tone: "neutral", live: false };
  if (run.status === "paused")
    return { label: "Paused", tone: "neutral", live: false };
  if (run.tasks.some((task) => task.status === "failed"))
    return { label: "Failed", tone: "rose", live: false };
  if (tones.includes("amber"))
    return { label: "Needs you", tone: "amber", live: true };
  if (tones.includes("sky"))
    return { label: "In progress", tone: "sky", live: true };
  if (run.tasks.length > 0 && tones.every((tone) => tone === "emerald"))
    return {
      label: run.tasks.every((task) => task.accepted) ? "Done" : "In review",
      tone: "emerald",
      live: false,
    };
  if (run.status === "finished")
    return { label: "Finished", tone: "neutral", live: false };
  return { label: "Queued", tone: "neutral", live: run.status === "active" };
}
