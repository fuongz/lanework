import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AgentSession } from "#/../shared/terminal";
import { GOAL_STATUS_LABELS, goalStuck, goalTokens } from "#/lib/codex-usage";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";

/**
 * A Codex conversation's goal on its rail row, while it has stopped short
 * and waits on somebody — blocked, out of usage, over budget (FE-41/D4).
 * Nothing for any other state, or any other conversation.
 */
export function CodexGoalBadge({
  workspace,
  session,
  className,
}: {
  workspace: string;
  session: AgentSession;
  className?: string;
}) {
  const goal = useAgentSessions((state) =>
    session.agent === "codex"
      ? state.codexGoals[workspace]?.[session.id]
      : undefined,
  );
  if (!goal || !goalStuck(goal)) return null;
  const label = `Goal ${GOAL_STATUS_LABELS[goal.status]}`;
  // An icon, not a word: the rail is 240px and the title needs the room.
  return (
    <span
      role="img"
      data-testid="codex-goal-badge"
      aria-label={label}
      title={`${label}: ${goal.objective}\n${goalTokens(goal)}`}
      className={cn(
        "flex shrink-0",
        goal.status === "blocked" ? "text-tone-rose" : "text-tone-amber",
        className,
      )}
    >
      <HugeiconsIcon
        icon={Alert02Icon}
        className="size-3.5"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </span>
  );
}
