// What the rail and the agent view say about Codex's usage and goals (FE-41),
// with no React in sight: which windows still mean something, what each is
// called, and how a goal's state reads.
import type {
  CodexGoal,
  CodexGoalStatus,
  CodexQuota,
} from "../../shared/terminal";

/** One window the bar shows. */
export interface QuotaWindow {
  /** `5h`, `week`. */
  label: string;
  usedPercent: number;
  resetsAt: number;
}

/** A window's name by its length: `5h`, `day`, `week`, `30m`. */
export function windowLabel(minutes: number): string {
  if (minutes === 10_080) return "week";
  if (minutes === 1_440) return "day";
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * The windows whose numbers still mean something at `now` (FE-41/D3): short
 * first. One past its reset has started over since the turn that reported
 * it, so its number is hidden rather than shown wrong.
 */
export function quotaWindows(quota: CodexQuota, now: number): QuotaWindow[] {
  return [quota.primary, quota.secondary].flatMap((window) =>
    window && window.resetsAt > now
      ? [
          {
            label: windowLabel(window.windowMinutes),
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt,
          },
        ]
      : [],
  );
}

/**
 * A moment as a clock reads it, against `now`: `14:30` today, `Sat 09:10`
 * within the week, `May 12, 09:49` before that.
 */
export function clockTime(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  if (Math.abs(at - now) < 6 * 86_400_000)
    return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** A goal's state in words, short enough for a rail badge. */
export const GOAL_STATUS_LABELS: Record<CodexGoalStatus, string> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usage_limited: "usage limit",
  budget_limited: "over budget",
  complete: "complete",
};

/**
 * Whether a goal stopped short and waits on somebody (FE-41/D4): those
 * states alone get a badge on the conversation's rail row.
 */
export function goalStuck(goal: Pick<CodexGoal, "status">): boolean {
  return (
    goal.status === "blocked" ||
    goal.status === "usage_limited" ||
    goal.status === "budget_limited"
  );
}

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** `363.1K / 500K tokens`, or `363.1K tokens` with no budget. */
export function goalTokens(
  goal: Pick<CodexGoal, "tokensUsed" | "tokenBudget">,
): string {
  const used = compact.format(goal.tokensUsed);
  return goal.tokenBudget === null
    ? `${used} tokens`
    : `${used} / ${compact.format(goal.tokenBudget)} tokens`;
}
