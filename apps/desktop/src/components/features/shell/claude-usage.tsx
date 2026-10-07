import { useEffect, useReducer } from "react";
import type { ClaudeQuotaWindow } from "#/../shared/terminal";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { badgeVariants } from "#/components/ui/badge";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "#/components/ui/hover-card";
import { clockTime } from "#/lib/codex-usage";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useTerminal } from "#/stores/terminal";

/** Keep an expired limit unknown until Claude supplies its next window. */
function live(window: ClaudeQuotaWindow | null, now: number) {
  return window && window.resetsAt !== null && window.resetsAt > now
    ? window
    : null;
}

export function ClaudeQuotaBar() {
  const usage = useAgentSessions((state) => state.claudeUsage);
  const agents = useTerminal((state) => state.agents);
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  const now = Date.now();
  const primary = live(usage?.primary ?? null, now);
  const secondary = live(usage?.secondary ?? null, now);
  const next = Math.min(
    ...[primary, secondary].flatMap((window) =>
      window?.resetsAt ? [window.resetsAt] : [],
    ),
  );
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(
      redraw,
      Math.min(2 ** 31 - 1, Math.max(0, next - Date.now()) + 1_000),
    );
    return () => clearTimeout(timer);
  }, [next]);
  if (!agents.includes("claude")) return null;
  const used = primary ? Math.max(0, Math.min(100, primary.usedPercent)) : null;
  const plan = usage?.plan
    ? `${usage.plan.charAt(0).toUpperCase()}${usage.plan.slice(1)}`
    : "Claude";
  const apiAuth = usage?.authMode?.toLowerCase().includes("api");
  const providerAuth = ["third_party", "bedrock", "vertex", "foundry"].includes(
    usage?.authMode ?? "",
  );
  return (
    <div className="flex h-[30px] items-center">
      <HoverCard>
        <HoverCardTrigger
          delay={150}
          render={<button type="button" />}
          className={cn(
            badgeVariants({ variant: "ghost" }),
            "h-6 w-full justify-start gap-1.5",
          )}
          data-testid="claude-quota"
          aria-label={`Claude ${plan}, 5h usage ${used === null ? "unavailable" : `${Math.round(used)}%`}`}
        >
          <TerminalKindIcon kind="claude" className="size-3 shrink-0" />
          {used !== null && (
            <span className="tabular-nums">{`${Math.round(used)}%`}</span>
          )}
          <span>{plan}</span>
          <span
            className={cn(
              "ml-auto flex size-4 shrink-0",
              used !== null && used >= 90
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
          aria-label="Claude usage details"
          data-testid="claude-quota-details"
        >
          <span className="font-medium">
            Claude {plan === "Claude" ? "usage" : plan}
          </span>
          {(
            [
              ["5-hour", primary],
              ["7-day", secondary],
            ] as const
          ).map(([label, quota]) => {
            return (
              <div key={label} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3">
                  <span>{label} usage</span>
                  <span
                    className={cn(
                      "tabular-nums",
                      quota && quota.usedPercent >= 90 && "text-tone-amber",
                    )}
                  >
                    {quota ? `${Math.round(quota.usedPercent)}% used` : "—"}
                  </span>
                </div>
                <span className="text-muted-foreground">
                  {quota?.resetsAt
                    ? `${label} resets ${clockTime(quota.resetsAt, now)}`
                    : `${label} usage is awaiting a new Claude turn.`}
                </span>
              </div>
            );
          })}
          {(apiAuth || providerAuth) && (
            <span className="text-muted-foreground">
              {apiAuth ? "API" : "Provider"} authentication: subscription usage
              is unavailable.
            </span>
          )}
          <span className="text-muted-foreground border-t pt-2">
            {usage?.at
              ? `As of ${clockTime(Date.parse(usage.at), now)}${usage.stale ? "; last known usage" : ""}`
              : "Start or resume Claude to update usage."}
          </span>
        </HoverCardContent>
      </HoverCard>
    </div>
  );
}
