import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useReducer } from "react";
import type { AgentSession } from "#/../shared/terminal";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { Badge } from "#/components/ui/badge";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "#/components/ui/hover-card";
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
 * The Codex account's usage above Settings in the fixed rail footer — its
 * a progress ring, the 5h percentage and plan; hover shows every live window
 * and its reset time.
 *
 * ⚠️ Only as fresh as the newest Codex turn on this machine: nothing here
 * asks OpenAI. A window past its reset hides its number, which no longer
 * says anything — and with none left the bar goes (FE-41/D3). Re-drawn when
 * the next window resets, so a stale number goes on time with no new turn.
 *
 * The badge can also be focused to read the details without hovering.
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
  const shortWindow = windows.find((window) => window.label === "5h");
  const used = shortWindow
    ? Math.max(0, Math.min(100, shortWindow.usedPercent))
    : null;
  const plan = quota.plan ? titleCase(quota.plan) : "Codex";
  const asOf = `As of ${clockTime(Date.parse(quota.at), now)}, the last Codex turn`;
  return (
    <div className="flex h-[30px] items-center px-2">
      <HoverCard>
        <HoverCardTrigger
          delay={150}
          render={
            <Badge
              variant="secondary"
              render={<button type="button" />}
              className="h-6 w-full justify-start gap-1.5"
            />
          }
          data-testid="codex-quota"
          aria-label={`Codex ${plan}, 5h usage ${used === null ? "unavailable" : `${Math.round(used)}%`}`}
        >
          <TerminalKindIcon kind="codex" className="size-3 shrink-0" />
          <span className="tabular-nums">
            {used === null ? "—" : `${Math.round(used)}%`}
          </span>
          <span>{plan}</span>
          <span
            className={cn(
              "ml-auto flex size-4 shrink-0",
              used !== null && used >= NEARLY_SPENT
                ? "text-tone-amber"
                : "text-muted-foreground",
            )}
          >
            <svg
              viewBox="0 0 20 20"
              className="size-4 -rotate-90"
              aria-hidden="true"
            >
              <circle
                cx="10"
                cy="10"
                r="7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className="opacity-20"
              />
              <circle
                cx="10"
                cy="10"
                r="7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                pathLength="100"
                strokeDasharray={`${used ?? 0} 100`}
                strokeLinecap={used ? "round" : "butt"}
              />
            </svg>
          </span>
        </HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="start"
          className="flex flex-col gap-3"
          aria-label="Codex usage details"
          data-testid="codex-quota-details"
        >
          <span className="font-medium">
            Codex {plan === "Codex" ? "usage" : plan}
          </span>
          {windows.map((window) => (
            <div key={window.label} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <span>
                  {window.label === "5h"
                    ? "5-hour usage"
                    : window.label === "week"
                      ? "Weekly usage"
                      : `${window.label} usage`}
                </span>
                <span
                  className={cn(
                    "tabular-nums",
                    window.usedPercent >= NEARLY_SPENT && "text-tone-amber",
                  )}
                >
                  {Math.round(window.usedPercent)}% used
                </span>
              </div>
              <span className="text-muted-foreground">
                {window.label} resets {clockTime(window.resetsAt, now)}
              </span>
            </div>
          ))}
          {!shortWindow && (
            <span className="text-muted-foreground">
              5-hour usage is awaiting an update.
            </span>
          )}
          <span className="text-muted-foreground border-t pt-2">{asOf}</span>
        </HoverCardContent>
      </HoverCard>
    </div>
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
