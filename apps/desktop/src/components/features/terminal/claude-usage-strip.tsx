import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useReducer } from "react";
import type {
  ClaudeQuotaWindow,
  ClaudeUsage,
  ClaudeUsageError,
} from "#/../shared/terminal";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { Button } from "#/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";

/** How often the ages and countdowns are drawn again. */
const CLOCK_MS = 30_000;
/** Coming back to the window refreshes at most this often (FE-53). */
const FOCUS_REFRESH_MS = 60_000;
/** A window this full reads in the warning tone. */
const NEARLY_SPENT = 90;

/** When the window's focus last asked for a refresh — one for every strip. */
let focusRefreshed = 0;

const ERROR_TEXT: Record<ClaudeUsageError, string> = {
  expired: "Your Claude sign-in has expired. Sign in to Claude again.",
  unavailable: "No Claude sign-in found on this machine.",
  failed: "Couldn’t refresh Claude usage.",
};

const clamp = (percent: number) => Math.max(0, Math.min(100, percent));

/** "now", "42m", "3h 5m", "4d 6h" — how long until `ms` from now. */
export function resetDuration(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
  }
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

function resetText(window: ClaudeQuotaWindow, now: number): string {
  if (window.resetsAt === null) return "Reset time unknown";
  const duration = resetDuration(window.resetsAt - now);
  return duration === "now" ? "Resets now" : `Resets in ${duration}`;
}

/** "Updated just now", "Updated 5m ago", "Updated 3h ago", "Updated 2d ago". */
export function updatedText(at: string | null, now: number): string {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return "Not updated yet";
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes === 0) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

function planText(usage: ClaudeUsage): string | null {
  const mode = usage.authMode?.toLowerCase() ?? "";
  if (mode.includes("api")) return "API key — subscription usage unavailable";
  if (["third_party", "bedrock", "vertex", "foundry"].includes(mode))
    return "Cloud provider — subscription usage unavailable";
  if (!usage.plan) return null;
  return `${usage.plan.charAt(0).toUpperCase()}${usage.plan.slice(1)} plan`;
}

function barTone(used: number) {
  return used >= NEARLY_SPENT ? "bg-tone-amber" : "bg-foreground/55";
}

/** Draw again every so often, so ages and countdowns move on their own. */
function useClock() {
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    const timer = setInterval(redraw, CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return Date.now();
}

/**
 * Claude's account usage on the right of the terminal bar (FE-53), like
 * monocode's footer: the Claude mark, a small 5-hour bar, each window's
 * percentage and time to reset, and ⟳. Clicking it opens the 5-hour and
 * weekly cards.
 *
 * ⚠️ There whenever main has something to say — usage, a plan or an error
 * the user can act on — whether or not a Claude conversation is running: the
 * numbers come from the account, not from a session. `unavailable` alone (no
 * Claude sign-in on this machine) is nothing to say, so it stays hidden.
 *
 * ⚠️ An error keeps the last snapshot on screen and says why it is old.
 */
export function ClaudeUsageStrip() {
  const usage = useAgentSessions((state) => state.claudeUsage);
  const refreshing = useAgentSessions((state) => state.claudeRefreshing);
  const refresh = useAgentSessions((state) => state.refreshClaudeUsage);
  const now = useClock();

  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - focusRefreshed < FOCUS_REFRESH_MS) return;
      focusRefreshed = Date.now();
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  if (
    !usage ||
    (!usage.primary &&
      !usage.secondary &&
      !usage.plan &&
      (!usage.error || usage.error === "unavailable"))
  )
    return null;

  const windows = (
    [
      ["5h", usage.primary],
      ["weekly", usage.secondary],
    ] as const
  ).flatMap(([label, window]) => (window ? [{ label, window }] : []));
  const fiveHour = usage.primary ? clamp(usage.primary.usedPercent) : null;
  const name = windows.length
    ? windows
        .map(
          ({ label, window }) =>
            `${label} ${Math.round(clamp(window.usedPercent))}% used`,
        )
        .join(", ")
    : usage.error === "expired"
      ? "sign-in expired"
      : "unavailable";

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Popover>
        <PopoverTrigger
          render={<button type="button" />}
          data-testid="claude-quota"
          aria-label={`Claude usage: ${name}`}
          title={usage.error ? ERROR_TEXT[usage.error] : "Claude usage"}
          className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground aria-expanded:bg-foreground/[0.04] aria-expanded:text-foreground flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs whitespace-nowrap transition-colors"
        >
          <TerminalKindIcon kind="claude" className="size-3 shrink-0" />
          {windows.length === 0 ? (
            <span className="opacity-70">
              {usage.error === "expired" ? "expired" : "—"}
            </span>
          ) : (
            <>
              {fiveHour !== null && (
                <span
                  className="bg-foreground/10 h-1 w-8 shrink-0 overflow-hidden rounded-full"
                  data-testid="claude-quota-bar"
                  aria-hidden="true"
                >
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      barTone(fiveHour),
                    )}
                    style={{ width: `${fiveHour}%` }}
                  />
                </span>
              )}
              <span className="flex items-center gap-1 tabular-nums">
                {windows.map(({ label, window }, index) => (
                  <span key={label} className="flex items-center gap-1">
                    {index > 0 && (
                      <span className="opacity-50" aria-hidden="true">
                        ·
                      </span>
                    )}
                    <span
                      className={cn(
                        window.usedPercent >= NEARLY_SPENT && "text-tone-amber",
                      )}
                    >
                      {`${Math.round(clamp(window.usedPercent))}% ${
                        window.resetsAt === null
                          ? label
                          : resetDuration(window.resetsAt - now)
                      }`}
                    </span>
                  </span>
                ))}
              </span>
            </>
          )}
          {usage.error && (
            <span
              className="bg-tone-amber size-1.5 shrink-0 rounded-full"
              aria-hidden="true"
            />
          )}
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={6}
          className="w-75 gap-2.5 p-2"
          aria-label="Claude usage details"
          data-testid="claude-quota-details"
        >
          <UsageDetails usage={usage} now={now} />
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground"
        aria-label="Refresh Claude usage"
        title="Refresh Claude usage"
        data-testid="claude-usage-refresh"
        aria-busy={refreshing}
        disabled={refreshing}
        onClick={() => void refresh()}
      >
        <HugeiconsIcon
          icon={Refresh01Icon}
          className={cn(
            "size-3",
            refreshing && "animate-spin motion-reduce:animate-none",
          )}
          strokeWidth={2}
        />
      </Button>
    </div>
  );
}

function UsageDetails({ usage, now }: { usage: ClaudeUsage; now: number }) {
  const plan = planText(usage);
  const hasWindows = Boolean(usage.primary || usage.secondary);
  return (
    <>
      <div className="flex items-start gap-2.5 px-1 pt-0.5">
        <span className="bg-muted grid size-7 shrink-0 place-items-center rounded-lg">
          <TerminalKindIcon kind="claude" className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-[13px] leading-4 font-medium">
            Claude Code usage
          </h2>
          <p
            className="text-muted-foreground text-[11px] leading-4"
            data-testid="claude-usage-updated"
          >
            {updatedText(usage.at, now)}
            {usage.stale && hasWindows ? " · last known" : ""}
          </p>
          {plan && (
            <p
              className="text-muted-foreground truncate text-[11px] leading-4"
              data-testid="claude-usage-plan"
            >
              {plan}
            </p>
          )}
        </div>
      </div>
      <LimitCard title="5-hour limit" window={usage.primary} now={now} />
      <LimitCard title="Weekly limit" window={usage.secondary} now={now} />
      {usage.error && (
        <p
          role="alert"
          className="text-tone-amber px-1 text-[11px] leading-4"
          data-testid="claude-usage-error"
        >
          {ERROR_TEXT[usage.error]}
          {hasWindows ? " Showing the last known usage." : ""}
        </p>
      )}
    </>
  );
}

function LimitCard({
  title,
  window,
  now,
}: {
  title: string;
  window: ClaudeQuotaWindow | null;
  now: number;
}) {
  const used = window ? clamp(window.usedPercent) : null;
  return (
    <section
      aria-label={title}
      className="bg-muted/50 ring-foreground/[0.06] rounded-lg px-3 py-2.5 ring-1 ring-inset"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-muted-foreground text-[11px] font-medium">
          {title}
        </h3>
        <span
          className={cn(
            "shrink-0 text-[11px] font-medium tabular-nums",
            used !== null && used >= NEARLY_SPENT && "text-tone-amber",
          )}
        >
          {used === null ? "—" : `${Math.round(used)}% used`}
        </span>
      </div>
      <div
        className="bg-foreground/10 mt-2 h-1.5 overflow-hidden rounded-full"
        role="progressbar"
        aria-label={`${title} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used === null ? undefined : Math.round(used)}
      >
        {used !== null && (
          <span
            className={cn("block h-full rounded-full", barTone(used))}
            style={{ width: `${used}%` }}
          />
        )}
      </div>
      <div className="text-muted-foreground mt-1.5 flex items-center justify-between gap-3 text-[10px] leading-4">
        {window && used !== null ? (
          <>
            <span className="tabular-nums">{`${Math.round(100 - used)}% remaining`}</span>
            <span
              className="truncate text-right tabular-nums"
              title={
                window.resetsAt === null
                  ? undefined
                  : new Date(window.resetsAt).toLocaleString()
              }
            >
              {resetText(window, now)}
            </span>
          </>
        ) : (
          <span>No usage data yet</span>
        )}
      </div>
    </section>
  );
}
