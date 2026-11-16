// The run panel's checklist parts: its tasks in dependency waves, and each
// task's status as one small square glyph, as a sub-issue list draws them.
import { EllipsisIcon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { OrchestrationTask } from "#/../shared/orchestration";
import { shownStatus, TONE_TEXT } from "#/lib/orchestration-status";
import { cn } from "#/lib/utils";

/**
 * The run's tasks split into dependency waves, each in the run's order. The
 * first wave holds every task with no dependency; a later one, the tasks
 * whose dependencies all sit in earlier waves.
 *
 * NOTE: A dependency the run does not hold counts as met, and a cycle is cut
 * where it closes: main refuses both, so neither may hide a task here.
 */
export function taskWaves<
  Task extends { id: string; dependsOn: readonly string[] },
>(tasks: readonly Task[]): Task[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const waveOf = (task: Task): number => {
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
  const waves: Task[][] = [];
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
  size = "size-4",
  children,
}: {
  shape: Shape;
  tone: string;
  /** Its box, e.g. `size-6` beside a two-line row. */
  size?: string;
  children?: ReactNode;
}) {
  const fill = shape === "fill";
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0", size, tone)}
    >
      {/* A circle, as the proposal card numbers its tasks. */}
      {fill ? (
        <circle cx="8" cy="8" r="8" className="fill-current" />
      ) : (
        <circle
          cx="8"
          cy="8"
          r="7.4"
          strokeWidth="1.1"
          className="stroke-current"
        />
      )}
      <g
        strokeWidth="1.3"
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

/** Working's blue, the same as its segment of the run's bar. */
const WORKING = TONE_TEXT.sky;

/**
 * A worker at it: a soft blue disc, ringed like the other marks, with a
 * small spinner turning at its centre. Two bars read as a pause button, so
 * they are left to Stopping and Interrupted. Still with reduced motion.
 */
function Working({ size = "size-4" }: { size?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-current/10 ring-1 ring-current/30",
        size,
        WORKING,
      )}
    >
      <HugeiconsIcon
        icon={Loading03Icon}
        className="size-[46%] animate-spin motion-reduce:animate-none"
        strokeWidth={2.2}
      />
    </span>
  );
}

/**
 * Not started yet: its place in the run as a number, in a soft ringed
 * circle, as the proposal card numbers its tasks.
 */
function Numbered({
  size = "size-4",
  number,
}: {
  size?: string;
  number: number;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-background text-muted-foreground ring-border grid shrink-0 place-items-center rounded-full text-[11px] font-medium tabular-nums ring-1",
        size,
      )}
    >
      {number}
    </span>
  );
}

/** The muted outline queued and paused tasks share. */
const MUTED = "text-muted-foreground/70";

/**
 * A worker's status as one rounded square the height of its title; the row
 * draws no other status:
 *
 * - Review (the worker finished): a green ring with an ellipsis. Done (the
 *   lead reviewed and accepted it):
 *   a green fill with a white tick.
 * - Working: a soft blue ringed disc with a spinner at its centre (still with
 *   reduced motion). Stopping: a rose outline with two bars.
 * - Waiting on the lead: an amber outline with a question mark.
 * - Queued, or waiting on a dependency: its number in a ringed circle (an
 *   empty muted outline without one); waiting for
 *   you to allow a wider scope: an amber outline with a padlock.
 * - Failed: a rose fill with an exclamation mark. Blocked: an amber outline
 *   with one. Interrupted: a muted outline with two bars. Cancelled: a muted
 *   outline with a cross.
 *
 * Every colour is the task's one tone (`taskToneName`), as its badge and
 * its segment of the bar use.
 */
export function StepGlyph({
  task,
  size,
  number,
}: {
  task: OrchestrationTask;
  /** Its box; `size-4` unless given. */
  size?: string;
  /** Its place in the run, shown while it waits to start. */
  number?: number;
}) {
  const status = shownStatus(task);
  // Review, the lead not done with it yet: a green ring and an ellipsis.
  // Done, accepted by the lead: a green fill with a tick.
  if (status === "completed")
    return task.accepted ? (
      <Square size={size} shape="fill" tone={TONE_TEXT.emerald}>
        {TICK}
      </Square>
    ) : (
      // Under review: a green ring holding an ellipsis, the lead not done.
      <span
        aria-hidden="true"
        className={cn(
          "grid shrink-0 place-items-center rounded-full ring-[1.5px] ring-current ring-inset",
          size ?? "size-4",
          TONE_TEXT.emerald,
        )}
      >
        <HugeiconsIcon
          icon={EllipsisIcon}
          className="size-[58%]"
          strokeWidth={2.4}
        />
      </span>
    );
  if (task.needsInput)
    return (
      <Square size={size} shape="outline" tone={TONE_TEXT.amber}>
        {QUESTION}
      </Square>
    );
  if (status === "running") return <Working size={size} />;
  if (status === "cancelling")
    return (
      <Square size={size} shape="outline" tone={TONE_TEXT.rose}>
        {BARS}
      </Square>
    );
  if (status === "queued")
    return task.scopeApproval?.length ? (
      <Square size={size} shape="outline" tone={TONE_TEXT.amber}>
        {LOCK}
      </Square>
    ) : number !== undefined ? (
      <Numbered size={size} number={number} />
    ) : (
      <Square size={size} shape="outline" tone={MUTED} />
    );
  if (status === "failed")
    return (
      <Square size={size} shape="fill" tone={TONE_TEXT.rose}>
        {ALERT}
      </Square>
    );
  if (status === "blocked")
    return (
      <Square size={size} shape="outline" tone={TONE_TEXT.amber}>
        {ALERT}
      </Square>
    );
  if (status === "interrupted")
    return (
      <Square size={size} shape="outline" tone={MUTED}>
        {BARS}
      </Square>
    );
  return (
    <Square size={size} shape="outline" tone={MUTED}>
      {CROSS}
    </Square>
  );
}
