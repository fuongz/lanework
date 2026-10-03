import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useReducer } from "react";
import type { AgentSession } from "#/../shared/terminal";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import {
  clockTime,
  GOAL_STATUS_LABELS,
  goalStuck,
  goalTokens,
  quotaWindows,
} from "#/lib/codex-usage";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useTerminal } from "#/stores/terminal";

/** A window this full reads in the warning tone. */
const NEARLY_SPENT = 90;
/** `setTimeout`'s longest wait; a week's window is well inside it. */
const LONGEST_WAIT = 2 ** 31 - 1;

/**
 * The Codex account's usage on the Agents group's header (FE-41/D1) — its
 * mark, then `5h 6% · week 1%` — and, on hover, when each window resets and
 * which turn said so.
 *
 * ⚠️ Only as fresh as the newest Codex turn on this machine: nothing here
 * asks OpenAI. A window past its reset hides its number, which no longer
 * says anything — and with none left the bar goes (FE-41/D3). Re-drawn when
 * the next window resets, so a stale number goes on time with no new turn.
 *
 * ⚠️ Not a control, as the card's agents mark is not: its words are in the
 * sr-only text for anybody who cannot hover.
 */
export function CodexQuotaBar() {
  const quota = useAgentSessions((state) => state.codexQuota);
  const agents = useTerminal((state) => state.agents);
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  const now = Date.now();
  const windows = quota ? quotaWindows(quota, now) : [];
  const next = Math.min(...windows.map((window) => window.resetsAt));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(
      redraw,
      Math.min(LONGEST_WAIT, Math.max(0, next - Date.now()) + 1_000),
    );
    return () => clearTimeout(timer);
  }, [next]);

  if (!quota || windows.length === 0 || !agents.includes("codex")) return null;
  const resets = windows.map(
    (window) => `${window.label} resets ${clockTime(window.resetsAt, now)}`,
  );
  const asOf = `As of ${clockTime(Date.parse(quota.at), now)}, the last Codex turn`;
  return (
    <Tooltip>
      {/* ⚠️ Codex's mark, not its name: the rail is too narrow for the
          word and both windows, and the week's number was the one cut. */}
      <TooltipTrigger
        render={<span />}
        data-testid="codex-quota"
        className="text-muted-foreground ml-auto flex min-w-0 items-center gap-1 text-[11px] tabular-nums"
      >
        <TerminalKindIcon kind="codex" className="size-3 shrink-0" />
        <span className="flex min-w-0 gap-1.5 truncate">
          <span className="sr-only">Codex </span>
          {windows.map((window, index) => (
            <span
              key={window.label}
              className={cn(
                window.usedPercent >= NEARLY_SPENT && "text-tone-amber",
              )}
            >
              {/* A gap on screen, a pause for a screen reader. */}
              {index > 0 && <span className="sr-only">, </span>}
              {window.label} {Math.round(window.usedPercent)}%
            </span>
          ))}
          <span className="sr-only">
            . {resets.join(", ")}. {asOf}.
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        {quota.plan && (
          <span className="font-medium">Codex {titleCase(quota.plan)}</span>
        )}
        {resets.map((line) => (
          <span key={line}>{line}</span>
        ))}
        <span className="opacity-70">{asOf}</span>
      </TooltipContent>
    </Tooltip>
  );
}

const titleCase = (word: string) =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

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
