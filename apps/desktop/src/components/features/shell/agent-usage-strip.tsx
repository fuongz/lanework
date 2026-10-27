import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocation, useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
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
  resetClock,
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
