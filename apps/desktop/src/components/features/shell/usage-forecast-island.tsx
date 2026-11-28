import {
  Alert02Icon,
  MultiplicationSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { HarnessIcon } from "#/components/shared/agents/harness-island";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { desktopSurface } from "#/server/desktop";
import {
  announceIsland,
  ISLAND_PRIORITY,
  setIslandOpen,
  useIslandContent,
  useIslandFoldOutside,
  useIslandShowing,
} from "#/stores/island";
import { usePreferences } from "#/stores/preferences";
import {
  FORECAST_AGENTS,
  FORECAST_WINDOWS,
  type ForecastAgent,
  type ForecastWindow,
  forecastOf,
  type HeldForecast,
  historyKey,
  holdForecast,
  type UsageForecast,
  type UsageHistory,
} from "../../../../shared/usage-forecast";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How often the samples are read again; a local read, no network. */
const REFRESH_MS = MINUTE;
/** How long Snooze hides a forecast. */
export const SNOOZE_MS = HOUR;
/**
 * How far two `resetsAt` may drift and still name the same window. Providers
 * recompute the reset on every call, so it jitters by seconds.
 */
const SAME_RESET_MS = 5 * MINUTE;

/** Where Dismiss and Snooze are kept, so a reload does not nag again. */
export const FORECAST_QUIET_STORAGE_KEY = "lanework.usage-forecast.quiet";

const NAMES: Record<ForecastAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};
const WINDOW_NAMES: Record<ForecastWindow, string> = {
  "five-hour": "5-hour",
  weekly: "weekly",
};

/** One agent's window, as Dismiss and Snooze key it. */
export type ForecastKey = ReturnType<typeof historyKey>;

/**
 * The forecasts the user quieted, by {@link ForecastKey}.
 *
 * - `dismissed`: the `resetsAt` of the window dismissed. It holds until that
 *   window resets or its forecast clears.
 * - `snoozed`: the epoch ms until which the forecast stays hidden.
 */
export interface ForecastQuiet {
  dismissed: Partial<Record<ForecastKey, number>>;
  snoozed: Partial<Record<ForecastKey, number>>;
}

export const NO_QUIET: ForecastQuiet = { dismissed: {}, snoozed: {} };

function numbers(value: unknown): Partial<Record<ForecastKey, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const out: Partial<Record<ForecastKey, number>> = {};
  for (const agent of FORECAST_AGENTS)
    for (const window of FORECAST_WINDOWS) {
      const key = historyKey(agent, window);
      const at = (value as Record<string, unknown>)[key];
      if (typeof at === "number" && Number.isFinite(at)) out[key] = at;
    }
  return out;
}

/** Reads what {@link FORECAST_QUIET_STORAGE_KEY} holds. Never throws. */
export function readForecastQuiet(raw: string | null): ForecastQuiet {
  if (!raw) return NO_QUIET;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return NO_QUIET;
    const record = value as Record<string, unknown>;
    return {
      dismissed: numbers(record.dismissed),
      snoozed: numbers(record.snoozed),
    };
  } catch {
    return NO_QUIET;
  }
}

/** Whether a forecast stays off the island at `now`. */
export function isForecastQuiet(
  quiet: ForecastQuiet,
  key: ForecastKey,
  forecast: UsageForecast,
  now: number,
): boolean {
  const until = quiet.snoozed[key];
  if (until !== undefined && now < until) return true;
  const dismissed = quiet.dismissed[key];
  return (
    dismissed !== undefined &&
    Math.abs(dismissed - forecast.resetsAt) <= SAME_RESET_MS
  );
}

/** Dismiss a forecast until its window resets or it clears. */
export function dismissForecast(
  quiet: ForecastQuiet,
  key: ForecastKey,
  resetsAt: number,
): ForecastQuiet {
  return { ...quiet, dismissed: { ...quiet.dismissed, [key]: resetsAt } };
}

/** Hide a forecast for {@link SNOOZE_MS}. */
export function snoozeForecast(
  quiet: ForecastQuiet,
  key: ForecastKey,
  now: number,
): ForecastQuiet {
  return { ...quiet, snoozed: { ...quiet.snoozed, [key]: now + SNOOZE_MS } };
}

/**
 * Drops what no longer applies: a dismissal whose forecast cleared or whose
 * window reset, and a snooze that ran out.
 *
 * @param forecasts Every window's forecast now, by key; null where it cleared.
 * @returns `quiet` itself when nothing changed, so a caller can skip a write.
 */
export function settleForecastQuiet(
  quiet: ForecastQuiet,
  forecasts: Partial<Record<ForecastKey, UsageForecast | null>>,
  now: number,
): ForecastQuiet {
  let changed = false;
  const dismissed: ForecastQuiet["dismissed"] = {};
  for (const [key, resetsAt] of Object.entries(quiet.dismissed) as [
    ForecastKey,
    number,
  ][]) {
    const forecast = forecasts[key];
    if (
      forecast &&
      resetsAt > now &&
      Math.abs(resetsAt - forecast.resetsAt) <= SAME_RESET_MS
    )
      dismissed[key] = resetsAt;
    else changed = true;
  }
  const snoozed: ForecastQuiet["snoozed"] = {};
  for (const [key, until] of Object.entries(quiet.snoozed) as [
    ForecastKey,
    number,
  ][]) {
    if (until > now) snoozed[key] = until;
    else changed = true;
  }
  return changed ? { dismissed, snoozed } : quiet;
}

function loadQuiet(): ForecastQuiet {
  try {
    return readForecastQuiet(localStorage.getItem(FORECAST_QUIET_STORAGE_KEY));
  } catch {
    return NO_QUIET;
  }
}

function saveQuiet(quiet: ForecastQuiet): void {
  try {
    localStorage.setItem(FORECAST_QUIET_STORAGE_KEY, JSON.stringify(quiet));
  } catch {
    // A full or blocked storage only means the island may ask again.
  }
}

/** The island id of one agent's window. */
export function usageForecastIslandId(
  agent: ForecastAgent,
  window: ForecastWindow,
): string {
  return `usage-forecast:${agent}:${window}`;
}

/** A clock time in the user's locale, with the day when it is not today. */
function formatTime(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now).toDateString() === date.toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(today ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** A rough length: "about 3 h", "about 40 min", "about 2 days". */
function formatSpan(ms: number): string {
  if (ms >= 2 * DAY) return `about ${Math.round(ms / DAY)} days`;
  if (ms >= HOUR) return `about ${Math.round(ms / HOUR)} h`;
  return `about ${Math.max(1, Math.round(ms / MINUTE))} min`;
}

function formatRate(percentPerHour: number): string {
  const rounded =
    percentPerHour >= 10
      ? Math.round(percentPerHour)
      : Math.round(percentPerHour * 10) / 10;
  return `${rounded}% an hour`;
}

/** The pill's one line, and the sentence the island says. */
function headline(
  agent: ForecastAgent,
  window: ForecastWindow,
  forecast: UsageForecast,
  now: number,
): string {
  const quota = `${NAMES[agent]} ${WINDOW_NAMES[window]} quota`;
  return forecast.exhaustAt <= now
    ? `${quota} has run out`
    : `${quota} may run out around ${formatTime(forecast.exhaustAt, now)}`;
}

/**
 * Reads the usage samples on mount, every minute and when the window gets
 * focus, and the time they were read at.
 */
function useUsageHistory(enabled: boolean): {
  history: UsageHistory | null;
  now: number;
} {
  const [state, setState] = useState<{
    history: UsageHistory | null;
    now: number;
  }>(() => ({ history: null, now: Date.now() }));
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => {
      let read: Promise<UsageHistory>;
      try {
        read = desktopSurface("terminal").usageHistory();
      } catch {
        return;
      }
      read
        .then((history) => {
          if (alive) setState({ history, now: Date.now() });
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [enabled]);
  return state;
}

/**
 * The usage forecast on the island (FE-181).
 *
 * It warns when Claude's or Codex's pace would use up a rate-limit window
 * (five-hour or weekly) well before it resets, one content per agent and
 * window. The quota is the account's, so other apps on it count too.
 *
 * - A pill that opens on hover or a click: nothing the user just did caused
 *   it. Dismiss hides it until that window resets; Snooze hides it for an
 *   hour. Both survive a reload.
 * - It ranks under `notify()` toasts and over update offers
 *   ({@link ISLAND_PRIORITY}).
 *
 * Draws nothing itself: `<IslandHost/>` in the shell does.
 */
export function UsageForecastIsland() {
  const settings = usePreferences((state) => state.usageForecast);
  const { history, now } = useUsageHistory(settings.enabled);
  const [quiet, setQuiet] = useState(loadQuiet);

  // NOTE: What each window showed last, kept for `HOLD_MS[window]` once its forecast
  // stops holding (V5): a pace near the margin tips on and off between two
  // whole-percent readings, and the island would flicker with it. Written
  // while rendering, but only from (previous, reading, time), so a second
  // render of the same reading lands on the same value.
  const held = useRef<Partial<Record<ForecastKey, HeldForecast | null>>>({});
  const forecasts: Partial<Record<ForecastKey, UsageForecast | null>> = {};
  for (const agent of FORECAST_AGENTS)
    for (const window of FORECAST_WINDOWS) {
      const key = historyKey(agent, window);
      const fresh =
        history && settings.enabled
          ? forecastOf(history[key] ?? [], window, now, settings)
          : null;
      const keep =
        history && settings.enabled
          ? holdForecast(held.current[key] ?? null, fresh, now, window)
          : null;
      held.current[key] = keep;
      forecasts[key] = keep?.forecast ?? null;
    }

  // Drop dismissals whose forecast cleared, once there is a reading to judge
  // by: before the first one every forecast reads null.
  const settled = history ? settleForecastQuiet(quiet, forecasts, now) : quiet;
  useEffect(() => {
    if (settled === quiet) return;
    setQuiet(settled);
    saveQuiet(settled);
  }, [settled, quiet]);

  const update = (next: ForecastQuiet) => {
    setQuiet(next);
    saveQuiet(next);
  };

  return (
    <>
      {FORECAST_AGENTS.flatMap((agent) =>
        FORECAST_WINDOWS.map((window) => {
          const key = historyKey(agent, window);
          const forecast = forecasts[key] ?? null;
          const shown =
            forecast && !isForecastQuiet(quiet, key, forecast, now)
              ? forecast
              : null;
          return (
            <ForecastContent
              key={key}
              agent={agent}
              window={window}
              forecast={shown}
              now={now}
              onDismiss={(resetsAt) =>
                update(dismissForecast(quiet, key, resetsAt))
              }
              onSnooze={() => update(snoozeForecast(quiet, key, Date.now()))}
            />
          );
        }),
      )}
    </>
  );
}

/** One agent's window on the island, while it has a forecast to show. */
function ForecastContent({
  agent,
  window,
  forecast,
  now,
  onDismiss,
  onSnooze,
}: {
  agent: ForecastAgent;
  window: ForecastWindow;
  forecast: UsageForecast | null;
  now: number;
  onDismiss: (resetsAt: number) => void;
  onSnooze: () => void;
}) {
  const id = usageForecastIslandId(agent, window);
  const showing = useIslandShowing(id);
  useIslandFoldOutside(id, { escapeAnywhere: true });

  // Gone means folded: the next time it shows, it starts as a pill.
  useEffect(() => {
    if (!showing) setIslandOpen(id, false);
  }, [showing, id]);

  // Said once, when the forecast first appears.
  const present = forecast !== null;
  const said = forecast ? `${headline(agent, window, forecast, now)}.` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: speaks on appearance only, not on each new reading.
  useEffect(() => {
    if (present) announceIsland(said);
  }, [present]);

  useIslandContent(
    forecast
      ? {
          id,
          priority: ISLAND_PRIORITY.usageForecast,
          tone: "warning",
          label: `${NAMES[agent]} ${WINDOW_NAMES[window]} usage forecast`,
          swapKey: `${id}:${forecast.exhaustAt <= now ? "out" : "ahead"}`,
          attributes: {
            "data-testid": "usage-forecast-island",
            "data-agent": agent,
            "data-window": window,
          },
          pill: (context) => (
            <button
              type="button"
              onClick={() => context.setOpen(true, true)}
              aria-expanded={false}
              aria-label={`${said} Show the forecast.`}
              className="flex h-7 items-center gap-1.5 rounded-[inherit] pr-2.5 pl-2 text-[12px] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <HugeiconsIcon
                icon={Alert02Icon}
                className="size-3.5 text-amber-400"
                strokeWidth={2.2}
                aria-hidden="true"
              />
              <span>{headline(agent, window, forecast, now)}</span>
            </button>
          ),
          panel: (context) => (
            <Panel
              agent={agent}
              window={window}
              forecast={forecast}
              now={now}
              onDismiss={() => {
                onDismiss(forecast.resetsAt);
                context.setOpen(false);
              }}
              onSnooze={() => {
                onSnooze();
                context.setOpen(false);
              }}
            />
          ),
        }
      : null,
  );
  return null;
}

const PILL_BUTTON =
  "h-7 rounded-full px-3 text-[12px] focus-visible:ring-white/40 disabled:opacity-100";

/** The open island: when, by how much, and the way to quiet it. */
function Panel({
  agent,
  window,
  forecast,
  now,
  onDismiss,
  onSnooze,
}: {
  agent: ForecastAgent;
  window: ForecastWindow;
  forecast: UsageForecast;
  now: number;
  onDismiss: () => void;
  onSnooze: () => void;
}) {
  const out = forecast.exhaustAt <= now;
  const title = headline(agent, window, forecast, now);
  return (
    <section
      aria-label={`${NAMES[agent]} ${WINDOW_NAMES[window]} usage forecast`}
      className="flex w-[min(380px,calc(100vw-32px))] flex-col gap-3 p-4 pt-3.5"
    >
      <header className="flex items-start gap-2.5">
        <HarnessIcon agent={agent} className="mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
          <p className="text-[12px] text-white/60">
            {out
              ? `It resets in ${formatSpan(forecast.shortByMs)}.`
              : `That is ${formatSpan(forecast.shortByMs)} before it resets.`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss"
          title="Not again until this window resets"
          className="-mt-1 -mr-1.5 rounded-full text-white/60 hover:bg-white/10 hover:text-white dark:hover:bg-white/10"
          onClick={onDismiss}
        >
          <HugeiconsIcon
            icon={MultiplicationSignIcon}
            className="size-3.5"
            strokeWidth={2}
            aria-hidden="true"
          />
        </Button>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
        <dt className="text-white/60">Used</dt>
        <dd className="tabular-nums">{Math.round(forecast.usedPercent)}%</dd>
        <dt className="text-white/60">Pace</dt>
        <dd className="tabular-nums">
          {formatRate(forecast.ratePercentPerHour)}
        </dd>
        <dt className="text-white/60">Resets</dt>
        <dd className="tabular-nums">{formatTime(forecast.resetsAt, now)}</dd>
      </dl>
      <div className="flex items-center gap-2">
        <Button
          onClick={onDismiss}
          className={cn(PILL_BUTTON, "bg-white text-black hover:bg-white/85")}
        >
          Dismiss
        </Button>
        <Button
          onClick={onSnooze}
          className={cn(
            PILL_BUTTON,
            "bg-white/[0.14] text-white hover:bg-white/[0.22]",
          )}
        >
          Snooze 1 hour
        </Button>
      </div>
      <p className="text-[12px] text-white/50">
        The quota belongs to the account, so other apps signed in to it count
        too.
      </p>
    </section>
  );
}
