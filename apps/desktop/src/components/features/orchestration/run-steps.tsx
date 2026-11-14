// The run panel's checklist parts: its tasks in dependency waves, and each
// task's status as one small square glyph, as a sub-issue list draws them.
import type { ReactNode } from "react";
import type { OrchestrationTask } from "#/../shared/orchestration";
import { shownStatus } from "#/lib/orchestration-status";
import { cn } from "#/lib/utils";

/**
 * The run's tasks split into dependency waves, each in the run's order. The
 * first wave holds every task with no dependency; a later one, the tasks
 * whose dependencies all sit in earlier waves.
 *
 * NOTE: A dependency the run does not hold counts as met, and a cycle is cut
 * where it closes: main refuses both, so neither may hide a task here.
 */
export function taskWaves(
  tasks: readonly OrchestrationTask[],
): OrchestrationTask[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const waveOf = (task: OrchestrationTask): number => {
    const known = depth.get(task.id);
    if (known !== undefined) return known;
    if (visiting.has(task.id)) return 0;
    visiting.add(task.id);
    let wave = 0;
    for (const id of task.dependsOn) {
      const dependency = byId.get(id);
      if (dependency) wave = Math.max(wave, waveOf(dependency) + 1);
    }
    visiting.delete(task.id);
    depth.set(task.id, wave);
    return wave;
  };
  const waves: OrchestrationTask[][] = [];
  for (const task of tasks) {
    const wave = waveOf(task);
    const group = waves[wave] ?? [];
    group.push(task);
    waves[wave] = group;
  }
  // A cut cycle may leave a wave empty: `filter` skips the hole.
  return waves.filter((wave) => wave.length > 0);
}

/** The square's look: an outline, or a fill with the glyph knocked out. */
type Shape = "outline" | "fill";

/**
 * A 16px rounded square in `tone`, with `children` drawn on a 16-unit grid.
 * The glyph strokes in the tone on an outline, in white on a fill.
 */
function Square({
  shape,
  tone,
  children,
}: {
  shape: Shape;
  tone: string;
  children?: ReactNode;
}) {
  const fill = shape === "fill";
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cn("size-4 shrink-0", tone)}
    >
      {fill ? (
        <rect width="16" height="16" rx="4.5" className="fill-current" />
      ) : (
        <rect
          x="0.75"
          y="0.75"
          width="14.5"
          height="14.5"
          rx="3.75"
          strokeWidth="1.5"
          className="stroke-current"
        />
      )}
      <g
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={
          fill ? "fill-white stroke-white" : "fill-current stroke-current"
        }
      >
        {children}
      </g>
    </svg>
  );
}

/** A tick. */
const TICK = <path d="M4.75 8.25 6.9 10.4l4.35-4.65" fill="none" />;
/** Two short vertical bars: the worker is at it. */
const BARS = <path d="M6.25 5.5v5M9.75 5.5v5" fill="none" />;
/** A question mark, its dot a filled circle. */
const QUESTION = (
  <>
    <path
      d="M6.4 6.3a1.65 1.65 0 1 1 2.35 1.5c-.5.24-.75.6-.75 1.1v.25"
      fill="none"
    />
    <circle cx="8" cy="11.15" r="0.85" stroke="none" />
  </>
);
/** An exclamation mark, its dot a filled circle. */
const ALERT = (
  <>
    <path d="M8 4.9v3.6" fill="none" />
    <circle cx="8" cy="11.1" r="0.85" stroke="none" />
  </>
);
/** A cross. */
const CROSS = <path d="m5.75 5.75 4.5 4.5m0-4.5-4.5 4.5" fill="none" />;
/** A small padlock: a filled body under an open stroke. */
const LOCK = (
  <>
    <path d="M6.5 7.5V6.6a1.5 1.5 0 0 1 3 0v.9" fill="none" strokeWidth="1.3" />
    <rect x="5.25" y="7.5" width="5.5" height="3.75" rx="0.9" stroke="none" />
  </>
);

/** The muted outline queued and paused tasks share. */
const MUTED = "text-muted-foreground/70";
/** Orange, for a worker at it: apart from the amber that asks for someone. */
const ORANGE = "text-orange-600 dark:text-orange-400";

/**
 * A worker's status as one rounded square the height of its title; the row
 * draws no other status:
 *
 * - Done or accepted: a green fill with a white tick (the label and the
 *   tooltip tell them apart).
 * - Working: an orange outline with two bars. Stopping: the same, in red.
 * - Waiting on the lead: an amber outline with a question mark.
 * - Queued, or waiting on a dependency: an empty muted outline; waiting for
 *   you to allow a wider scope: an amber outline with a padlock.
 * - Failed: a red fill with an exclamation mark. Blocked: a red outline with
 *   one. Interrupted: a muted outline with two bars. Cancelled: a muted
 *   outline with a cross.
 */
export function StepGlyph({ task }: { task: OrchestrationTask }) {
  const status = shownStatus(task);
  if (status === "completed")
    return (
      <Square shape="fill" tone="text-tone-emerald">
        {TICK}
      </Square>
    );
  if (task.needsInput)
    return (
      <Square shape="outline" tone="text-tone-amber">
        {QUESTION}
      </Square>
    );
  if (status === "running")
    return (
      <Square shape="outline" tone={ORANGE}>
        {BARS}
      </Square>
    );
  if (status === "cancelling")
    return (
      <Square shape="outline" tone="text-destructive">
        {BARS}
      </Square>
    );
  if (status === "queued")
    return task.scopeApproval?.length ? (
      <Square shape="outline" tone="text-tone-amber">
        {LOCK}
      </Square>
    ) : (
      <Square shape="outline" tone={MUTED} />
    );
  if (status === "failed")
    return (
      <Square shape="fill" tone="text-destructive">
        {ALERT}
      </Square>
    );
  if (status === "blocked")
    return (
      <Square shape="outline" tone="text-destructive">
        {ALERT}
      </Square>
    );
  if (status === "interrupted")
    return (
      <Square shape="outline" tone={MUTED}>
        {BARS}
      </Square>
    );
  return (
    <Square shape="outline" tone={MUTED}>
      {CROSS}
    </Square>
  );
}
