import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocation, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useReducer, useState } from "react";
import type {
  ClaudeUsage,
  ClaudeUsageError,
  CodexQuota,
  CodexQuotaWindow,
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
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useTerminal } from "#/stores/terminal";

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

/** The agents whose account usage the strip can show (FE-54). */
type UsageAgent = "claude" | "codex";

/** One limit as the strip draws it, whichever agent it came from. */
interface UsageWindow {
  usedPercent: number;
  /** Epoch ms; null when the source does not say. */
  resetsAt: number | null;
}

/** What the strip and its popover need, whichever agent it came from. */
interface UsageView {
  agent: UsageAgent;
  /** "Claude Code", "Codex". */
  name: string;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  /** When the numbers were true, ISO. */
  at: string | null;
  stale: boolean;
  plan: string | null;
  /** Why the newest read failed; the numbers shown are the last known. */
  error: string | null;
  /** The strip's short word when there are no numbers. */
  empty: string;
}

const clamp = (percent: number) => Math.max(0, Math.min(100, percent));

const titleCase = (word: string) =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

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

function resetText(window: UsageWindow, now: number): string {
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

function claudePlan(usage: ClaudeUsage): string | null {
  const mode = usage.authMode?.toLowerCase() ?? "";
  if (mode.includes("api")) return "API key — subscription usage unavailable";
  if (["third_party", "bedrock", "vertex", "foundry"].includes(mode))
    return "Cloud provider — subscription usage unavailable";
  return usage.plan ? `${titleCase(usage.plan)} plan` : null;
}

/**
 * Claude's usage, or null when there is nothing to say (FE-53): `unavailable`
 * alone — no Claude sign-in on this machine — keeps the strip hidden.
 */
function claudeView(usage: ClaudeUsage | null): UsageView | null {
  if (
    !usage ||
    (!usage.primary &&
      !usage.secondary &&
      !usage.plan &&
      (!usage.error || usage.error === "unavailable"))
  )
    return null;
  return {
    agent: "claude",
    name: "Claude Code",
    fiveHour: usage.primary,
    weekly: usage.secondary,
    at: usage.at,
    stale: usage.stale,
    plan: claudePlan(usage),
    error: usage.error ? ERROR_TEXT[usage.error] : null,
    empty: usage.error === "expired" ? "expired" : "—",
  };
}

/**
 * Codex's usage as its newest turn on this machine reported it (FE-41), or
 * null before any turn did. A window past its reset has started over since,
 * so its number is dropped rather than shown wrong (FE-41/D3).
 */
function codexView(quota: CodexQuota | null, now: number): UsageView | null {
  if (!quota) return null;
  const live = (window: CodexQuotaWindow | null) =>
    window && window.resetsAt > now ? window : null;
  return {
    agent: "codex",
    name: "Codex",
    fiveHour: live(quota.primary),
    weekly: live(quota.secondary),
    at: quota.at,
    stale: false,
    plan: quota.plan ? `${titleCase(quota.plan)} plan` : null,
    error: null,
    empty: "—",
  };
}

function barTone(used: number) {
  return used >= NEARLY_SPENT ? "bg-tone-amber" : "bg-foreground/55";
}

const usageAgent = (kind: string | undefined): UsageAgent | null =>
  kind === "claude" || kind === "codex" ? kind : null;

/**
 * Whose usage the strip shows (FE-54): the agent on screen in the main view —
 * a running agent, a sub-agent's conversation, or a Claude chat — else the
 * agent in the terminal panel's active tab. Null for a shell, or nothing (D1b).
 *
 * ⚠️ The chat pages (`agents/chat/…`, FE-62) are Claude's own: the chat
 * engine runs only Claude. Missed, a chat showed no usage at all unless the
 * terminal panel happened to have a Claude tab active.
 */
function useUsageAgent(workspace: string): UsageAgent | null {
  const chat = useLocation({
    select: (location) => location.pathname.includes("/agents/chat/"),
  });
  const { terminalId, sub } = useParams({ strict: false }) as {
    terminalId?: string;
    sub?: string;
  };
  const { agent: subAgent } = useSearch({ strict: false }) as {
    agent?: string;
  };
  const viewed = useAgentTerminals((state) =>
    terminalId
      ? state.sessions[workspace]?.find((entry) => entry.id === terminalId)
          ?.kind
      : undefined,
  );
  const tab = useTerminal((state) => {
    const id = state.active[workspace];
    return state.sessions[workspace]?.find((entry) => entry.id === id)?.kind;
  });
  if (terminalId) return usageAgent(viewed);
  if (sub) return usageAgent(subAgent);
  if (chat) return "claude";
  return usageAgent(tab);
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
 * The account usage of the agent in the active terminal tab, on the right of
 * the terminal bar (FE-53, FE-54), like monocode's footer: the agent's mark,
 * a small 5-hour bar, each window's percentage and time to reset, and ⟳.
 * Clicking it opens the 5-hour and weekly cards.
 *
 * ⚠️ Follows the session on screen: a Claude agent or chat shows Claude's
 * usage, a Codex agent Codex's — the main view's agent first, else the
 * panel's active tab. A shell, or no agent at all, shows nothing (FE-54/D1b).
 *
 * ⚠️ Claude's numbers come from its account and ⟳ asks Anthropic again;
 * Codex's are only as fresh as its newest turn here, and ⟳ reads them again
 * from this machine. An error keeps the last snapshot and says why it is old.
 */
export function AgentUsageStrip({ workspace }: { workspace: string }) {
  const agent = useUsageAgent(workspace);
  const claudeUsage = useAgentSessions((state) => state.claudeUsage);
  const codexQuota = useAgentSessions((state) => state.codexQuota);
  const claudeRefreshing = useAgentSessions((state) => state.claudeRefreshing);
  const refreshClaude = useAgentSessions((state) => state.refreshClaudeUsage);
  const loadCodexUsage = useAgentSessions((state) => state.loadCodexUsage);
  const [codexRefreshing, setCodexRefreshing] = useState(false);
  const now = useClock();

  const refreshing = agent === "codex" ? codexRefreshing : claudeRefreshing;
  const refresh = async () => {
    if (agent === "claude") return refreshClaude();
    if (agent !== "codex") return;
    setCodexRefreshing(true);
    try {
      await loadCodexUsage(workspace);
    } finally {
      setCodexRefreshing(false);
    }
  };

  useEffect(() => {
    if (!agent) return;
    const onFocus = () => {
      if (Date.now() - focusRefreshed < FOCUS_REFRESH_MS) return;
      focusRefreshed = Date.now();
      void (agent === "claude" ? refreshClaude() : loadCodexUsage(workspace));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [agent, workspace, refreshClaude, loadCodexUsage]);

  const view =
    agent === "claude"
      ? claudeView(claudeUsage)
      : agent === "codex"
        ? codexView(codexQuota, now)
        : null;
  if (!view) return null;

  const windows = (
    [
      ["5h", view.fiveHour],
      ["weekly", view.weekly],
    ] as const
  ).flatMap(([label, window]) => (window ? [{ label, window }] : []));
  const fiveHour = view.fiveHour ? clamp(view.fiveHour.usedPercent) : null;
  const summary = windows.length
    ? windows
        .map(
          ({ label, window }) =>
            `${label} ${Math.round(clamp(window.usedPercent))}% used`,
        )
        .join(", ")
    : view.empty === "expired"
      ? "sign-in expired"
      : "unavailable";
  const short = view.agent === "claude" ? "Claude" : "Codex";

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Popover>
        <PopoverTrigger
          render={<button type="button" />}
          data-testid={`${view.agent}-quota`}
          aria-label={`${short} usage: ${summary}`}
          title={view.error ?? `${short} usage`}
          className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground aria-expanded:bg-foreground/[0.04] aria-expanded:text-foreground flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs whitespace-nowrap transition-colors"
        >
          <TerminalKindIcon kind={view.agent} className="size-3 shrink-0" />
          {windows.length === 0 ? (
            <span className="opacity-70">{view.empty}</span>
          ) : (
            <>
              {fiveHour !== null && (
                <span
                  className="bg-foreground/10 h-1 w-8 shrink-0 overflow-hidden rounded-full"
                  data-testid={`${view.agent}-quota-bar`}
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
          {view.error && (
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
          aria-label={`${short} usage details`}
          data-testid={`${view.agent}-quota-details`}
        >
          <UsageDetails view={view} now={now} />
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground"
        aria-label={`Refresh ${short} usage`}
        title={`Refresh ${short} usage`}
        data-testid={`${view.agent}-usage-refresh`}
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

function UsageDetails({ view, now }: { view: UsageView; now: number }) {
  const hasWindows = Boolean(view.fiveHour || view.weekly);
  return (
    <>
      <div className="flex items-start gap-2.5 px-1 pt-0.5">
        <span className="bg-muted grid size-7 shrink-0 place-items-center rounded-lg">
          <TerminalKindIcon kind={view.agent} className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-[13px] leading-4 font-medium">
            {view.name} usage
          </h2>
          <p
            className="text-muted-foreground text-[11px] leading-4"
            data-testid={`${view.agent}-usage-updated`}
          >
            {updatedText(view.at, now)}
            {view.stale && hasWindows ? " · last known" : ""}
          </p>
          {view.plan && (
            <p
              className="text-muted-foreground truncate text-[11px] leading-4"
              data-testid={`${view.agent}-usage-plan`}
            >
              {view.plan}
            </p>
          )}
        </div>
      </div>
      <LimitCard title="5-hour limit" window={view.fiveHour} now={now} />
      <LimitCard title="Weekly limit" window={view.weekly} now={now} />
      {view.error && (
        <p
          role="alert"
          className="text-tone-amber px-1 text-[11px] leading-4"
          data-testid={`${view.agent}-usage-error`}
        >
          {view.error}
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
  window: UsageWindow | null;
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
