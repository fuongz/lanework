// How the rail and the agent view word Codex's goals, with no React.
// Codex's usage windows are worded by `lib/agent-usage.ts`.
import type { CodexGoal, CodexGoalStatus } from "../../shared/terminal";

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
