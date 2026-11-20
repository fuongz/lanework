import { DashboardSpeed01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  AGENT_LABELS,
  allModels,
  type ConversationAgent,
  limitOver,
  OPENCODE_MODEL_ID,
  type UsageLimit,
  type UsageLimitsState,
} from "#/../shared/conversation";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

/**
 * The CLI the next message hands a thread off to: `model`'s, when that is
 * not `agent`, else null.
 *
 * NOTE: Only a model a list names (or OpenCode's `provider/model` shape)
 * counts. `agentOfModel` falls back to Claude for an id it does not know,
 * and a Codex chat whose model Codex's list has not named yet must not read
 * as a handoff to Claude.
 */
export function handoffAgent(
  model: string | null | undefined,
  agent: ConversationAgent | null,
): ConversationAgent | null {
  if (!model || !agent) return null;
  const of =
    allModels().find((entry) => entry.id === model)?.agent ??
    (OPENCODE_MODEL_ID.test(model) ? "opencode" : null);
  return of && of !== agent ? of : null;
}

const EMPTY: UsageLimitsState = { limits: [], stopped: [], autoContinue: [] };

/**
 * The usage limit in force on `agent` running `model`, this conversation's
 * stop by it and its auto-continue opt-in: read once, then kept by main's
 * events.
 */
export function useUsageLimit(
  project: string,
  conversation: string | null,
  agent: ConversationAgent | null,
  model: string | null,
) {
  const [state, setState] = useState<UsageLimitsState>(EMPTY);
  useEffect(() => {
    const surface = window.desktop?.conversation;
    if (!surface) return;
    let gone = false;
    // NOTE: Subscribed before the read: an event between the two is not
    // lost, and the read never overwrites a newer event's state.
    let heard = false;
    const off = surface.onUsageLimits((next) => {
      heard = true;
      if (!gone) setState(next);
    });
    void surface
      .usageLimits()
      .then((next) => {
        if (!gone && !heard) setState(next);
      })
      .catch(() => {});
    return () => {
      gone = true;
      off();
    };
  }, []);
  // NOTE: A model family's cap (Claude's weekly Opus one) is shown only on
  // a conversation running that family.
  const limit = limitOver(state.limits, agent, model);
  const stop = conversation
    ? (state.stopped.find(
        (entry) =>
          entry.project === project && entry.conversation === conversation,
      ) ?? null)
    : null;
  const autoContinue = conversation
    ? state.autoContinue.some(
        (entry) =>
          entry.project === project && entry.conversation === conversation,
      )
    : false;
  const setAutoContinue = async (on: boolean) => {
    const surface = window.desktop?.conversation;
    if (!surface || !conversation) return false;
    try {
      setState(await surface.setAutoContinue(project, conversation, on));
      return true;
    } catch {
      return false;
    }
  };

  const resetsAt = limit?.resetsAt ?? stop?.continueAt ?? null;
  const reset = resetsAt ? new Date(resetsAt) : null;
  const hasReset = reset !== null && Number.isFinite(reset.getTime());
  const snoozeKey = conversation
    ? `usage-limit-snooze:${JSON.stringify([project, conversation])}`
    : null;
  const snoozeWindow =
    limit && snoozeKey && hasReset
      ? JSON.stringify([
          snoozeKey,
          limit.agent,
          limit.scope,
          limit.window,
          resetsAt,
        ])
      : null;
  const [snoozed, setSnoozed] = useState(() =>
    snoozeKey ? sessionStorage.getItem(snoozeKey) : null,
  );
  useEffect(() => {
    setSnoozed(snoozeKey ? sessionStorage.getItem(snoozeKey) : null);
  }, [snoozeKey]);

  const snooze = async () => {
    if (!snoozeKey || !snoozeWindow) return false;
    if (!(await setAutoContinue(false))) return false;
    sessionStorage.setItem(snoozeKey, snoozeWindow);
    setSnoozed(snoozeWindow);
    return true;
  };

  return {
    limit: snoozeWindow && snoozed === snoozeWindow ? null : limit,
    reset: hasReset ? reset : null,
    autoContinue,
    canResume: Boolean(stop && (hasReset || autoContinue)),
    canSnooze: snoozeWindow !== null,
    setAutoContinue,
    snooze,
  };
}

function resetText(reset: Date | null): string {
  if (!reset) return "Reset time unknown";
  if (reset.getTime() <= Date.now()) return "Resetting now";

  const clock = reset.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const date =
    reset.toDateString() === new Date().toDateString()
      ? ""
      : `${reset.toLocaleDateString([], { month: "short", day: "numeric" })}, `;
  return `Resets ${date}${clock}`;
}

/** Shows the usage limit above the composer. */
export function LimitTab({
  agent,
  limit,
  reset,
  autoContinue,
  canResume,
  canSnooze,
  onAutoContinue,
  onSnooze,
  onHandOff,
  stacked,
}: {
  /** The CLI the limit is on: the current model's. */
  agent: ConversationAgent;
  limit: UsageLimit | null;
  reset: Date | null;
  autoContinue: boolean;
  canResume: boolean;
  canSnooze: boolean;
  onAutoContinue: (on: boolean) => void;
  onSnooze: () => void;
  /** Opens the model menu, where another harness's model hands off. */
  onHandOff?: () => void;
  stacked: boolean;
}) {
  if (!limit) return null;
  const label = AGENT_LABELS[agent];
  return (
    <section
      aria-label={`${label} usage limit`}
      className={cn(
        "text-foreground flex flex-col rounded-t-2xl border border-b-0",
        stacked ? "mx-3" : "mx-5",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-2.5 py-0.5 text-xs">
        <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-1 gap-y-0">
          <HugeiconsIcon
            icon={DashboardSpeed01Icon}
            className="text-muted-foreground me-1.5 size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="font-medium" title={limit.message || undefined}>
            Usage limit reached
          </span>
          <span className="text-muted-foreground tabular-nums">
            {resetText(reset)}
          </span>
        </div>
        <div className="ms-auto flex flex-wrap items-center justify-end gap-x-0.5">
          <Button
            type="button"
            aria-pressed={autoContinue}
            disabled={!canResume}
            onClick={() => onAutoContinue(!autoContinue)}
            variant="link"
          >
            Resume at reset
          </Button>
          <Button
            type="button"
            disabled={!canSnooze}
            onClick={onSnooze}
            variant="link"
          >
            Snooze until reset
          </Button>
          {onHandOff && (
            <Button type="button" onClick={onHandOff} variant="link">
              Hand off
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
