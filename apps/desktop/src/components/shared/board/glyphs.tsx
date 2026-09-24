import {
  Archive02Icon,
  CheckmarkCircle02Icon,
  CircleIcon,
  DashedLineCircleIcon,
  Idea01Icon,
  Loading03Icon,
  MinusIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  BoardCard,
  BoardCategory,
  BoardColumn,
} from "#/../shared/workspaces";
import { checklistProgress } from "#/lib/board-view";
import { cn } from "#/lib/utils";

/**
 * A board tone as a text colour.
 *
 * ⚠️ A literal map, not `` `text-tone-${tone}` ``. Tailwind reads source text to
 * decide which classes to emit, so an interpolated name produces no CSS at all —
 * and the failure is a colourless icon rather than an error. The board's tone
 * vocabulary is closed, so writing it out costs nothing.
 */
const TONE_TEXT: Record<string, string> = {
  neutral: "text-tone-neutral",
  violet: "text-tone-violet",
  amber: "text-tone-amber",
  blue: "text-tone-blue",
  sky: "text-tone-sky",
  emerald: "text-tone-emerald",
  teal: "text-tone-teal",
  rose: "text-tone-rose",
};

export const toneText = (tone: string | undefined): string =>
  TONE_TEXT[tone ?? "neutral"] ?? TONE_TEXT.neutral;

/** The board names its lane icons; this is the only place that maps them. */
const LANE_ICON: Record<string, typeof CircleIcon> = {
  idea: Idea01Icon,
  "circle-dashed": DashedLineCircleIcon,
  progress: Loading03Icon,
  check: CheckmarkCircle02Icon,
  archive: Archive02Icon,
};

export function StatusIcon({
  column,
  className,
}: {
  column: BoardColumn | undefined;
  className?: string;
}) {
  return (
    <HugeiconsIcon
      icon={LANE_ICON[column?.icon ?? ""] ?? CircleIcon}
      // Decorative: the lane's NAME is always beside it, in the group header or
      // the properties rail. An `aria-label` here would make a screen reader
      // announce the status twice.
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", toneText(column?.tone), className)}
      strokeWidth={1.8}
    />
  );
}

const PRIORITY_TONE: Record<string, string> = {
  high: "rose",
  medium: "amber",
  low: "sky",
};

/**
 * Priority as three bars, not an arrow.
 *
 * ⚠️ Height carries the value, so it survives being read without colour —
 * which is the whole point, since the tones are 3:1 non-text contrast and
 * colour alone is never allowed to be the only cue.
 */
export function PriorityIcon({
  priority,
  className,
}: {
  priority: BoardCard["priority"];
  className?: string;
}) {
  if (priority === null)
    return (
      <HugeiconsIcon
        icon={MinusIcon}
        aria-hidden="true"
        className={cn("text-muted-foreground size-3.5 shrink-0", className)}
        strokeWidth={1.8}
      />
    );
  const filled = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-3.5 w-3.5 shrink-0 items-end justify-center gap-px",
        toneText(PRIORITY_TONE[priority]),
        className,
      )}
    >
      {[2, 3, 4].map((height, index) => (
        <span
          key={height}
          className="w-[3px] rounded-[1px] bg-current"
          style={{
            height: `${height * 2.5}px`,
            opacity: index < filled ? 1 : 0.25,
          }}
        />
      ))}
    </span>
  );
}

export function CategoryDot({
  category,
  className,
}: {
  category: BoardCategory | undefined;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full bg-current",
        toneText(category?.tone),
        className,
      )}
    />
  );
}

/**
 * `03/07`: a count of done out of total, always at least two digits a side.
 *
 * ⚠️ Padded so the column lines up (FE-13/D1). `5/5` beside `15/17` made every
 * row's right edge a different width, and the eye read the jitter before the
 * numbers. Past 99 the number is printed whole — a width jump there is rarer
 * than a truncated count is wrong.
 *
 * ⚠️ The DONE half is muted until it reaches the total, and the total never
 * is: the unfinished part is the half to look at, and a finished `07/07`
 * reads as one solid value at a glance.
 */
export function Fraction({
  done,
  total,
  title,
  className,
}: {
  done: number;
  total: number;
  title: string;
  className?: string;
}) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span
      className={cn("text-foreground shrink-0 text-xs tabular-nums", className)}
      title={title}
    >
      <span className={done < total ? "text-muted-foreground" : undefined}>
        {pad(done)}
      </span>
      /{pad(total)}
    </span>
  );
}

/**
 * `03/07`, or nothing at all.
 *
 * ⚠️ Renders NOTHING when the checklist is null, and that is not the same as
 * rendering `00/00`. A card read from a board list carries no checklist — saying
 * "0 of 0 done" about a card with seven decisions is a confident lie.
 */
export function ChecklistProgress({
  card,
  className,
}: {
  card: BoardCard;
  className?: string;
}) {
  const progress = checklistProgress(card);
  if (!progress || progress.total === 0) return null;
  return (
    <Fraction
      done={progress.done}
      total={progress.total}
      title={`${progress.done} of ${progress.total} checked`}
      className={className}
    />
  );
}
