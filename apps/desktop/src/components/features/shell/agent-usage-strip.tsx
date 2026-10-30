import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocation, useParams, useSearch } from "@tanstack/react-router";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
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
import { UsageBar } from "#/components/shared/terminal/usage-bar";
import { Button } from "#/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { useClock } from "#/hooks/use-clock";
import {
  clamp,
  claudeView,
  codexView,
  NEARLY_SPENT,
  opencodeView,
  resetClock,
  resetDuration,
  resetText,
  titleCase,
  type UsageAgent,
  type UsageView,
  updatedText,
  usageAgent,
} from "#/lib/agent-usage";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useTerminal } from "#/stores/terminal";

/** What the strip calls each agent, where room is short. */
const SHORT: Record<UsageAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

/** Coming back to the window refreshes at most this often. */
const FOCUS_REFRESH_MS = 60_000;

/** When the window's focus last asked for a refresh, shared by every strip. */
let focusRefreshed = 0;

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
  const { agent: subAgent } = useSearch({ strict: false });
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
 *   from this machine. OpenCode's are OpenCode Go's 5-hour, weekly and
 *   monthly limits, read with Codex's (FE-104/D10); without a Go
 *   subscription there is nothing to show. An error keeps the last snapshot
 *   and says why it is old.
 */
export function AgentUsageStrip({ workspace }: { workspace: string }) {
  const agent = useUsageAgent(workspace);
  const claudeUsage = useAgentSessions((state) => state.claudeUsage);
  const codexQuota = useAgentSessions((state) => state.codexQuota);
  const opencodeUsage = useAgentSessions((state) => state.opencodeUsage);
  const claudeRefreshing = useAgentSessions((state) => state.claudeRefreshing);
  const refreshClaude = useAgentSessions((state) => state.refreshClaudeUsage);
  const loadCodexUsage = useAgentSessions((state) => state.loadCodexUsage);
  const refreshCodex = useAgentSessions((state) => state.refreshCodexUsage);
  const consumeCodexReset = useAgentSessions(
    (state) => state.consumeCodexReset,
  );
  // Codex's and OpenCode's ⟳ are this strip's own; Claude's is the store's.
  const [localRefreshing, setLocalRefreshing] = useState(false);
  const now = useClock();

  const refreshing = agent === "claude" ? claudeRefreshing : localRefreshing;
  const refresh = async () => {
    if (agent === "claude") return refreshClaude();
    if (!agent) return;
    setLocalRefreshing(true);
    try {
      if (agent === "codex") await refreshCodex(workspace, true);
      // OpenCode's limits are read with Codex's usage, from OpenCode Go.
      else await loadCodexUsage(workspace);
    } finally {
      setLocalRefreshing(false);
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
        : agent === "opencode"
          ? opencodeView(opencodeUsage, now)
          : null;
  if (!view) return null;

  const windows = (
    [
      ["5h", view.fiveHour],
      ["weekly", view.weekly],
      ["monthly", view.monthly],
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
  const short = SHORT[view.agent];
  // The session's window, or the next one when the source has no 5-hour.
  const session = windows[0]?.window ?? null;
  const left =
    session?.resetsAt == null ? null : resetClock(session.resetsAt, now);

  // The strip shows the session alone, since the terminal bar is narrow. The
  // weekly limit, the plan and ⟳ are one click away, in the popover.
  return (
    <Popover
      onOpenChange={(open) => {
        // Codex is asked again on opening, at most once a minute; OpenCode's
        // limits are read again with it.
        if (open && view.agent === "codex") void refreshCodex(workspace, false);
        if (open && view.agent === "opencode") void loadCodexUsage(workspace);
      }}
    >
      <PopoverTrigger
        render={<button type="button" />}
        data-testid={`${view.agent}-quota`}
        aria-label={`${short} usage: ${summary}`}
        title={
          view.error ??
          (session
            ? `${short} usage\n${resetText(session, now)}`
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
            {session.resetsAt != null && left !== null && (
              <ResetLabel at={session.resetsAt} now={now} clock={left} />
            )}
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
  const hasWindows = Boolean(view.fiveHour || view.weekly || view.monthly);
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
        {/* OpenCode Go also limits a month (FE-104/D10). */}
        {view.agent === "opencode" && (
          <UsageBar
            name={view.name}
            label="Monthly"
            region="Monthly limit"
            window={view.monthly}
            now={now}
          />
        )}
      </div>
      {view.resets && (
        <CodexResets resets={view.resets} now={now} onUse={onUseReset} />
      )}
      <p
        className="text-muted-foreground px-1 pb-0.5 text-[11px] leading-4"
        data-testid={`${view.agent}-usage-updated`}
      >
        {updatedText(view.at, now)}
        {view.stale && hasWindows ? " (last known)" : ""}
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

/** How long each of a reset's two readings stands before the other. */
const RESET_FLIP_MS = 5_000;

/**
 * One motion for the flip: the readings slide and the line's width eases
 * with the same duration and curve, so they move as one.
 */
const FLIP_MOTION = "duration-[450ms] ease-[cubic-bezier(0.22,1,0.36,1)]";

/**
 * "resets at 9:48 PM", then every five seconds "resets in 1h 23m", and back:
 * when it is and how long until, in turn.
 *
 * On a flip the old reading slides up and out as the new one slides up into
 * the line, and the line's width eases to the new reading's rather than
 * jumping; nothing shows past that width, so a flip never widens the
 * window. With reduced motion the reading is swapped in place.
 *
 * Within the hour both say the same, so only "in 42 minutes" stands.
 */
function ResetLabel({
  at,
  now,
  clock,
}: {
  at: number;
  now: number;
  /** {@link resetClock}'s reading: "at 9:48 PM", "in 42 minutes". */
  clock: string;
}) {
  const flips = at - now >= 60 * 60_000;
  const [until, setUntil] = useState(false);
  useEffect(() => {
    if (!flips) {
      setUntil(false);
      return;
    }
    const timer = setInterval(() => setUntil((value) => !value), RESET_FLIP_MS);
    return () => clearInterval(timer);
  }, [flips]);
  const mode = until && flips ? "until" : "clock";
  const text = mode === "until" ? `in ${resetDuration(at - now)}` : clock;

  // A new mode is a flip, animated; the same mode's minute ticking over
  // ("1h 23m" to "1h 22m") is only a new text.
  const [shown, setShown] = useState({
    mode,
    flips: 0,
    prev: null as string | null,
  });
  const last = useRef({ mode, text });
  useEffect(() => {
    // Read now: the updater runs after `last` holds the new reading.
    const prev = last.current;
    if (prev.mode !== mode)
      setShown((current) => ({
        mode,
        flips: current.flips + 1,
        prev: prev.text,
      }));
    last.current = { mode, text };
  }, [mode, text]);

  // The reading's own width, measured off-line, so the line can ease to it.
  const measure = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  // Watched, not read once: a new reading, or the font arriving, resizes it.
  useLayoutEffect(() => {
    const node = measure.current;
    if (!node) return;
    const update = () => {
      const next = node.getBoundingClientRect().width;
      if (next) setWidth(Math.ceil(next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <span className="inline-flex items-baseline opacity-70">
      resets&nbsp;
      <span
        className={cn(
          // Clipped on both axes: top and bottom for the slide, and the
          // sides because the strip sits at the window's right edge. A
          // reading wider than the easing width (the old one leaving, the
          // new one arriving) spilled past it and gave the whole window a
          // horizontal scrollbar on every flip; now it is revealed as the
          // width eases instead.
          "relative inline-block overflow-clip whitespace-nowrap transition-[width] motion-reduce:transition-none",
          FLIP_MOTION,
        )}
        style={width ? { width } : undefined}
      >
        <span
          ref={measure}
          aria-hidden="true"
          className="invisible absolute top-0 left-0"
        >
          {text}
        </span>
        {shown.prev !== null && (
          <span
            key={`out-${shown.flips}`}
            aria-hidden="true"
            className={cn(
              "animate-out fade-out-0 slide-out-to-top-full absolute top-0 left-0 [--tw-animation-fill-mode:forwards] motion-reduce:hidden",
              FLIP_MOTION,
            )}
          >
            {shown.prev}
          </span>
        )}
        <span
          key={`in-${shown.flips}`}
          className={cn(
            "inline-block",
            shown.flips > 0 &&
              "animate-in fade-in-0 slide-in-from-bottom-full motion-reduce:animate-none",
            FLIP_MOTION,
          )}
        >
          {text}
        </span>
      </span>
    </span>
  );
}
