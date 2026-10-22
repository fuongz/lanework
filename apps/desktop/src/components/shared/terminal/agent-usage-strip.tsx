import { Clock01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocation, useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useEffect, useReducer, useState } from "react";
import type {
  ClaudeUsage,
  ClaudeUsageError,
  CodexQuota,
  CodexQuotaWindow,
  CodexResetCredit,
  CodexResetCredits,
  CodexResetOutcome,
} from "#/../shared/terminal";
import {
  HarnessAccountLine,
  useHarnessAccounts,
} from "#/components/shared/agents/harness-account";
import { useChatAgent } from "#/components/shared/conversation/chat-agent";
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
/** Coming back to the window refreshes at most this often. */
const FOCUS_REFRESH_MS = 60_000;
/** A window this full reads in the warning tone. */
const NEARLY_SPENT = 90;

/** When the window's focus last asked for a refresh, shared by every strip. */
let focusRefreshed = 0;

const ERROR_TEXT: Record<ClaudeUsageError, string> = {
  expired: "Your Claude sign-in has expired. Sign in to Claude again.",
  unavailable: "No Claude sign-in found on this machine.",
  failed: "Couldn’t refresh Claude usage.",
};

/** The agents whose account usage the strip can show. */
type UsageAgent = "claude" | "codex";

/** One limit as the strip draws it, whichever agent it came from. */
interface UsageWindow {
  usedPercent: number;
  /** Epoch ms; null when the source does not say. */
  resetsAt: number | null;
}

/** What the strip and its popover need, whichever agent it came from. */
export interface UsageView {
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
  /** Why there are no subscription limits: an API key, a cloud provider. */
  planNote: string | null;
  /** Codex's banked resets; null for Claude, or when unknown. */
  resets: CodexResetCredits | null;
}

const clamp = (percent: number) => Math.max(0, Math.min(100, percent));

const titleCase = (word: string) =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** How long `ms` is, as a countdown: "now", "42m", "3h 5m", "4d 6h". */
function resetDuration(ms: number): string {
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

/**
 * When a window resets, for "resets …".
 *
 * "at 8:30 PM" today, "Thu at 9:00 AM" on another day, "now" once it is past.
 * The time is in the system's own format, so a 24-hour Mac reads "at 20:30".
 */
function resetClock(at: number, now: number): string {
  if (at <= now) return "now";
  // Rounded to the minute: a reset at 20:29:59 reads as 20:30.
  const date = new Date(Math.round(at / 60_000) * 60_000);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (date.toDateString() === new Date(now).toDateString()) return `at ${time}`;
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
    date,
  );
  return `${day} at ${time}`;
}

/** How old the numbers are: "Updated just now", "Updated 5m ago", …. */
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

/** Why a Claude login has no subscription limits, or null when it has. */
function claudePlanNote(usage: ClaudeUsage): string | null {
  const mode = usage.authMode?.toLowerCase() ?? "";
  if (mode.includes("api")) return "API key — subscription usage unavailable";
  if (["third_party", "bedrock", "vertex", "foundry"].includes(mode))
    return "Cloud provider — subscription usage unavailable";
  return null;
}

/**
 * Claude's usage, or null when there is nothing to say.
 *
 * An `unavailable` error alone (no Claude sign-in on this machine) keeps the
 * strip hidden.
 */
export function claudeView(usage: ClaudeUsage | null): UsageView | null {
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
    plan: usage.plan ? titleCase(usage.plan) : null,
    planNote: claudePlanNote(usage),
    resets: null,
    error: usage.error ? ERROR_TEXT[usage.error] : null,
    empty: usage.error === "expired" ? "expired" : "—",
  };
}

/**
 * Codex's usage as its newest turn on this machine reported it, or null before
 * any turn did.
 *
 * A window past its reset has started over since, so its number is dropped
 * rather than shown wrong (FE-41/D3).
 */
export function codexView(
  quota: CodexQuota | null,
  now: number,
): UsageView | null {
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
    plan: quota.plan ? titleCase(quota.plan) : null,
    error: null,
    empty: "—",
    planNote: null,
    resets: quota.resetCredits ?? null,
  };
}

function barTone(used: number) {
  return used >= NEARLY_SPENT ? "bg-tone-amber" : "bg-foreground/55";
}

const usageAgent = (kind: string | undefined): UsageAgent | null =>
  kind === "claude" || kind === "codex" ? kind : null;

/**
 * Whose usage the strip shows.
 *
 * The agent on screen in the main view (a running agent, a sub-agent's
 * conversation, or a chat), else the agent in the terminal panel's active
 * tab. Null for a shell, or nothing (FE-54/D1b).
 *
 * NOTE: The chat pages (`agents/chat/…`) say whose they are through
 * {@link useChatAgent}: a conversation its CLI's, the new page the one its
 * picked model runs on. Skip them and a chat shows no usage at all unless the
 * terminal panel happens to have that agent's tab active.
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
  const chatAgent = useChatAgent();
  const tab = useTerminal((state) => {
    const id = state.active[workspace];
    return state.sessions[workspace]?.find((entry) => entry.id === id)?.kind;
  });
  if (terminalId) return usageAgent(viewed);
  if (sub) return usageAgent(subAgent);
  if (chat) return chatAgent;
  return usageAgent(tab);
}

/** Draw again every so often, so ages and countdowns move on their own. */
export function useClock() {
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    const timer = setInterval(redraw, CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return Date.now();
}

/**
 * The account usage of the agent on screen, on the right of the terminal bar.
 *
 * The agent's mark and its 5-hour session, "9% resets at 8:30 PM": how full,
 * and when it starts over. Clicking it opens the 5-hour and weekly cards, with
 * the plan and ⟳.
 *
 * - Follows the session on screen: a Claude agent or chat shows Claude's
 *   usage, a Codex agent Codex's. The main view's agent first, else the
 *   panel's active tab. A shell, or no agent at all, shows nothing
 *   (FE-54/D1b).
 * - Claude's numbers come from its account and ⟳ asks Anthropic again.
 *   Codex's are only as fresh as its newest turn here, and ⟳ reads them again
 *   from this machine. An error keeps the last snapshot and says why it is
 *   old.
 */
export function AgentUsageStrip({ workspace }: { workspace: string }) {
  const agent = useUsageAgent(workspace);
  const claudeUsage = useAgentSessions((state) => state.claudeUsage);
  const codexQuota = useAgentSessions((state) => state.codexQuota);
  const claudeRefreshing = useAgentSessions((state) => state.claudeRefreshing);
  const refreshClaude = useAgentSessions((state) => state.refreshClaudeUsage);
  const loadCodexUsage = useAgentSessions((state) => state.loadCodexUsage);
  const refreshCodex = useAgentSessions((state) => state.refreshCodexUsage);
  const consumeCodexReset = useAgentSessions(
    (state) => state.consumeCodexReset,
  );
  const [codexRefreshing, setCodexRefreshing] = useState(false);
  const now = useClock();

  const refreshing = agent === "codex" ? codexRefreshing : claudeRefreshing;
  const refresh = async () => {
    if (agent === "claude") return refreshClaude();
    if (agent !== "codex") return;
    setCodexRefreshing(true);
    try {
      await refreshCodex(workspace, true);
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
  // The session's window, or the weekly one when the source has no 5-hour.
  const session = windows[0]?.window ?? null;
  const left =
    session?.resetsAt == null ? null : resetClock(session.resetsAt, now);

  // The strip shows the session alone, since the terminal bar is narrow. The
  // weekly limit, the plan and ⟳ are one click away, in the popover.
  return (
    <Popover
      onOpenChange={(open) => {
        // Codex is asked again on opening, at most once a minute.
        if (open && view.agent === "codex") void refreshCodex(workspace, false);
      }}
    >
      <PopoverTrigger
        render={<button type="button" />}
        data-testid={`${view.agent}-quota`}
        aria-label={`${short} usage: ${summary}`}
        title={
          view.error ??
          (session
            ? `${short} usage · ${resetText(session, now)}`
            : `${short} usage`)
        }
        className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground aria-expanded:bg-foreground/[0.04] aria-expanded:text-foreground flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs whitespace-nowrap tabular-nums transition-colors"
      >
        <TerminalKindIcon kind={view.agent} className="size-3 shrink-0" />
        {session === null ? (
          <span className="opacity-70">{view.empty}</span>
        ) : (
          <>
            <span
              className={cn(
                session.usedPercent >= NEARLY_SPENT && "text-tone-amber",
              )}
            >
              {`${Math.round(clamp(session.usedPercent))}%`}
            </span>
            {left !== null && <span className="opacity-70">resets {left}</span>}
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
        <UsageDetails
          view={view}
          now={now}
          onUseReset={(creditId) => consumeCodexReset(workspace, creditId)}
          refresh={
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground shrink-0"
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
          }
        />
      </PopoverContent>
    </Popover>
  );
}

function UsageDetails({
  view,
  now,
  refresh,
  onUseReset,
}: {
  view: UsageView;
  now: number;
  /** ⟳, at the header's end. */
  refresh: ReactNode;
  /** Spend a banked reset; Codex only. */
  onUseReset: (creditId: string) => Promise<CodexResetOutcome>;
}) {
  const hasWindows = Boolean(view.fiveHour || view.weekly);
  // Read when the popover opens, and again on coming back to the window.
  const account = useHarnessAccounts()[view.agent];
  const signedIn = account?.signedIn ? account : null;
  const plan = signedIn?.plan ? titleCase(signedIn.plan) : view.plan;
  return (
    <>
      <div className="flex items-center gap-2.5 px-1 pt-0.5">
        <span className="bg-muted grid size-8 shrink-0 place-items-center rounded-lg">
          <TerminalKindIcon kind={view.agent} className="size-4" />
        </span>
        {/* Line 1: the agent and its plan. Line 2: the account (signed
            in, its organization, its email). The plan Settings › Agents
            read wins over the one the usage named. */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="shrink-0 text-[13px] leading-4 font-medium">
              {view.name}
            </h2>
            {plan && (
              <span
                data-testid={`${view.agent}-usage-plan`}
                className="bg-muted text-muted-foreground truncate rounded-md px-1.5 text-[11px] leading-4"
              >
                {plan}
              </span>
            )}
          </div>
          {signedIn ? (
            <HarnessAccountLine kind={view.agent} account={signedIn} />
          ) : (
            view.planNote && (
              <p className="text-muted-foreground truncate text-[11px] leading-4">
                {view.planNote}
              </p>
            )
          )}
        </div>
        {refresh}
      </div>
      {/* The same bars as Settings › Agents, one under the other: the
          popover is too narrow to put them side by side. */}
      <div className="flex flex-col gap-3 border-t px-1 pt-2.5">
        <UsageBar
          name={view.name}
          label="5h"
          region="5-hour limit"
          window={view.fiveHour}
          now={now}
        />
        <UsageBar
          name={view.name}
          label="Weekly"
          region="Weekly limit"
          window={view.weekly}
          now={now}
        />
      </div>
      {view.resets && (
        <CodexResets resets={view.resets} now={now} onUse={onUseReset} />
      )}
      <p
        className="text-muted-foreground px-1 pb-0.5 text-[11px] leading-4"
        data-testid={`${view.agent}-usage-updated`}
      >
        {updatedText(view.at, now)}
        {view.stale && hasWindows ? " · last known" : ""}
      </p>
      {view.error && (
        <p
          role="alert"
          className="text-tone-amber px-1 pb-0.5 text-[11px] leading-4"
          data-testid={`${view.agent}-usage-error`}
        >
          {view.error}
          {hasWindows ? " Showing the last known usage." : ""}
        </p>
      )}
    </>
  );
}

const OUTCOME_TEXT: Record<CodexResetOutcome, string> = {
  reset: "Codex usage was reset.",
  nothingToReset: "There was no usage to reset. The reset was not spent.",
  noCredit: "No banked resets are left.",
  alreadyRedeemed: "That reset was already used.",
};

const expiryFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Codex's banked "usage limit resets", as its own Usage window lists them: how
 * many, and each with its expiry and Use reset.
 *
 * Spending one cannot be undone, so Use reset asks first, in the row: "Spend
 * this reset now?", then Cancel or Confirm. Draws nothing with none left.
 */
function CodexResets({
  resets,
  now,
  onUse,
}: {
  resets: CodexResetCredits;
  now: number;
  onUse: (creditId: string) => Promise<CodexResetOutcome>;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [using, setUsing] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; ok: boolean } | null>(null);
  const listed = resets.credits.filter(
    (credit) => credit.status === "available" || credit.status === "unknown",
  );
  if (resets.availableCount <= 0 && !said) return null;

  const use = async (credit: CodexResetCredit) => {
    setConfirming(null);
    setUsing(credit.id);
    setSaid(null);
    try {
      const outcome = await onUse(credit.id);
      setSaid({ text: OUTCOME_TEXT[outcome], ok: outcome === "reset" });
    } catch (error) {
      setSaid({
        text:
          error instanceof Error && error.message
            ? error.message
            : "Codex could not use the reset.",
        ok: false,
      });
    } finally {
      setUsing(null);
    }
  };

  return (
    <section
      aria-label="Usage limit resets"
      data-testid="codex-usage-resets"
      className="flex flex-col gap-2 border-t px-1 pt-2.5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-foreground/80 text-[13px]">Usage limit resets</h3>
        {resets.availableCount > 0 && (
          <span className="bg-tone-emerald/15 text-tone-emerald shrink-0 rounded-full px-2 text-[11px] leading-5 font-medium tabular-nums">
            {resets.availableCount} available
          </span>
        )}
      </div>
      {said && (
        <p
          role="status"
          className={cn(
            "text-[11px] leading-4",
            said.ok ? "text-tone-emerald" : "text-tone-amber",
          )}
        >
          {said.text}
        </p>
      )}
      {listed.map((credit) => (
        <div
          key={credit.id}
          className="bg-muted/50 ring-foreground/[0.06] flex flex-col gap-2 rounded-lg px-2.5 py-2 ring-1 ring-inset"
        >
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[12px] leading-4 font-medium">
                {credit.title ?? "Usage limit reset"}
              </span>
              <span
                className="text-muted-foreground truncate text-[11px] leading-4 tabular-nums"
                title={credit.description ?? undefined}
              >
                {credit.expiresAt === null
                  ? "No expiry given"
                  : credit.expiresAt <= now
                    ? "Expired"
                    : `Expires ${expiryFormat.format(credit.expiresAt)}`}
              </span>
            </div>
            {using === credit.id ? (
              <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-[11px]">
                <HugeiconsIcon
                  icon={Refresh01Icon}
                  className="size-3 animate-spin motion-reduce:animate-none"
                  strokeWidth={2}
                  aria-hidden="true"
                />
                Applying…
              </span>
            ) : (
              confirming !== credit.id && (
                <Button
                  size="sm"
                  className="shrink-0"
                  disabled={using !== null}
                  onClick={() => setConfirming(credit.id)}
                >
                  Use reset
                </Button>
              )
            )}
          </div>
          {confirming === credit.id && (
            <div className="flex items-center justify-between gap-2 border-t pt-2">
              <span className="text-muted-foreground text-[11px] leading-4">
                Spend this reset now? It can’t be undone.
              </span>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void use(credit)}>
                  Confirm
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * One limit: its name, when it resets, how full it is, and the bar.
 *
 * Used in Settings › Agents and in the terminal bar's popover. A window with
 * no numbers says so rather than drawing an empty bar that reads as 0%.
 */
export function UsageBar({
  name,
  label,
  region,
  window,
  now,
}: {
  name: string;
  label: string;
  /** The region's accessible name: "5-hour limit". */
  region: string;
  window: UsageWindow | null;
  now: number;
}) {
  const used = window ? clamp(window.usedPercent) : null;
  const reset =
    window?.resetsAt == null ? null : resetDuration(window.resetsAt - now);
  return (
    <section aria-label={region} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span
          className="text-muted-foreground flex min-w-0 items-center gap-2 tabular-nums"
          title={
            window?.resetsAt == null
              ? undefined
              : `Resets ${new Date(window.resetsAt).toLocaleString()}`
          }
        >
          <span className="text-foreground/80 shrink-0">{label}</span>
          {used === null ? (
            <span className="truncate">No usage data yet</span>
          ) : (
            reset !== null && (
              <span className="flex min-w-0 items-center gap-1">
                <HugeiconsIcon
                  icon={Clock01Icon}
                  className="size-3 shrink-0"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="truncate">
                  {reset === "now" ? "Resets now" : `Resets in ${reset}`}
                </span>
              </span>
            )
          )}
        </span>
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            used !== null && used >= NEARLY_SPENT && "text-tone-amber",
          )}
        >
          {used === null ? "—" : `${Math.round(used)}%`}
        </span>
      </div>
      <div
        className="bg-foreground/10 h-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-label={`${name} ${label.toLowerCase()} usage limit used`}
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
    </section>
  );
}
