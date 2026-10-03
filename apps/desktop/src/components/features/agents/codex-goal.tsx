import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Coins01Icon,
  PauseIcon,
  PlayCircleIcon,
  Target02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { CodexGoal, CodexGoalStatus } from "#/../shared/terminal";
import type { Fact } from "#/components/shared/agents/facts";
import { GOAL_STATUS_LABELS, goalTokens } from "#/lib/codex-usage";

const STATUS_LOOK: Record<
  CodexGoalStatus,
  { icon: IconSvgElement; className?: string }
> = {
  active: { icon: PlayCircleIcon, className: "text-foreground" },
  paused: { icon: PauseIcon },
  blocked: { icon: Alert02Icon, className: "text-tone-rose" },
  usage_limited: { icon: Alert02Icon, className: "text-tone-amber" },
  budget_limited: { icon: Alert02Icon, className: "text-tone-amber" },
  complete: { icon: CheckmarkCircle02Icon, className: "text-tone-emerald" },
};

/** `33m 35s`, `2h 4m`: how long Codex has spent on it. */
function spent(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A Codex goal as facts (FE-41/D4): its objective, its status, and the
 * tokens it used against its budget — how long it ran is in that one's
 * tooltip. They join the conversation's facts row (FE-38).
 */
export function goalFacts(goal: CodexGoal): Fact[] {
  const objective = goal.objective.replace(/\s+/g, " ");
  const look = STATUS_LOOK[goal.status];
  const used = goal.tokensUsed.toLocaleString();
  return [
    {
      key: "goal",
      label: "Goal",
      icon: Target02Icon,
      text: objective,
      title: `Goal: ${objective}`,
    },
    {
      key: "goal-status",
      label: "Goal status",
      icon: look.icon,
      text: GOAL_STATUS_LABELS[goal.status],
      className: look.className,
    },
    {
      key: "goal-tokens",
      label: "Goal tokens",
      icon: Coins01Icon,
      text: goalTokens(goal),
      title: `${
        goal.tokenBudget === null
          ? `${used} tokens used, no budget`
          : `${used} of ${goal.tokenBudget.toLocaleString()} tokens used`
      }, in ${spent(goal.timeUsedSeconds)}`,
    },
  ];
}
