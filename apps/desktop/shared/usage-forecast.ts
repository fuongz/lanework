// The usage forecast island (FE-181): from the usage percentages a provider
// reports for a rate-limit window, tell when the agent will run out before the
// window resets.
//
// NOTE: Pure data and arithmetic only. Main records the samples and the
// renderer draws the forecast, so nothing here may import Node or Electron.

/**
 * The agents whose usage is forecast.
 *
 * OpenCode is left out: it reports no rate-limit windows of its own.
 * Everything below takes the agent as a plain key, so adding one is a change
 * to this list only.
 */
export const FORECAST_AGENTS = ["claude", "codex"] as const;
export type ForecastAgent = (typeof FORECAST_AGENTS)[number];

/** The rate-limit windows a forecast covers. */
export const FORECAST_WINDOWS = ["five-hour", "weekly"] as const;
export type ForecastWindow = (typeof FORECAST_WINDOWS)[number];

/** Each window's length, in minutes. */
export const WINDOW_MINUTES: Record<ForecastWindow, number> = {
  "five-hour": 300,
  weekly: 10080,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Maps a provider's window length to the window it stands for.
 *
 * Providers do not report the exact 300 or 10080, so the match is by range.
 *
 * @param minutes The provider's `windowMinutes`.
 * @returns `null` for a window that is neither, or a length that is not a
 * positive number.
 */
export function windowOfMinutes(minutes: number): ForecastWindow | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes <= 360) return "five-hour";
  if (minutes >= 10000) return "weekly";
  return null;
}

/** One reading of a window's usage. Times are epoch milliseconds. */
export interface UsageSample {
  at: number;
  /** 0..100. */
  usedPercent: number;
  /** When the window resets, or `null` when the provider did not say. */
  resetsAt: number | null;
}

/** Every recorded window's samples, oldest first, keyed by {@link historyKey}. */
export type UsageHistory = Record<string, UsageSample[]>;

/** The {@link UsageHistory} key of one agent's window. */
export function historyKey(
  agent: ForecastAgent,
  window: ForecastWindow,
): `${ForecastAgent}:${ForecastWindow}` {
  return `${agent}:${window}`;
}

/** What Settings holds for the forecast island. */
export interface UsageForecastSettings {
  /** The island as a whole. */
  enabled: boolean;
  fiveHour: boolean;
  weekly: boolean;
  /**
   * How far ahead of the reset the agent must run out before the island
   * warns. One of {@link MARGIN_MINUTES}.
   */
  marginMinutes: number;
}

/** The margins Settings offers, in minutes. */
export const MARGIN_MINUTES = [15, 30, 60, 120] as const;

export const DEFAULT_USAGE_FORECAST_SETTINGS: UsageForecastSettings = {
  enabled: true,
  fiveHour: true,
  weekly: true,
  marginMinutes: 30,
};

/**
 * Reads stored settings, field by field.
 *
 * A field that is missing or of the wrong shape takes its default, so one bad
 * field never resets the others. Never throws.
 */
export function readUsageForecastSettings(
  value: unknown,
): UsageForecastSettings {
  const defaults = DEFAULT_USAGE_FORECAST_SETTINGS;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ...defaults };
  const raw = value as Record<string, unknown>;
  const flag = (field: unknown, fallback: boolean) =>
    typeof field === "boolean" ? field : fallback;
  const margin = raw.marginMinutes;
  return {
    enabled: flag(raw.enabled, defaults.enabled),
    fiveHour: flag(raw.fiveHour, defaults.fiveHour),
    weekly: flag(raw.weekly, defaults.weekly),
    marginMinutes:
      typeof margin === "number" &&
      (MARGIN_MINUTES as readonly number[]).includes(margin)
        ? margin
        : defaults.marginMinutes,
  };
}

/**
 * How far two `resetsAt` may drift and still name the same window.
 *
 * Providers recompute the reset time on every call, so it jitters by seconds.
 */
const RESET_TOLERANCE_MS = 5 * MINUTE;

/** A reading this close to the previous one, with the same value, adds nothing. */
const MIN_SAMPLE_GAP_MS = MINUTE;

/** How long samples are kept, per window. */
const RETENTION_MS: Record<ForecastWindow, number> = {
  "five-hour": 24 * HOUR,
  weekly: 7 * 24 * HOUR,
};

/** Weekly samples are thinned to one per this many milliseconds. */
const WEEKLY_SPACING_MS = 10 * MINUTE;

/** A ceiling on one window's samples, should the rules above ever fail. */
const MAX_SAMPLES = 2000;

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function sameWindow(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  return Math.abs(a - b) <= RESET_TOLERANCE_MS;
}

/**
 * Adds a reading to a window's samples.
 *
 * - A `resetsAt` that moved by more than a few minutes starts a new window:
 *   the older samples are dropped.
 * - A reading under a minute after the previous one, with the same value, is
 *   skipped.
 * - Samples past the window's retention are dropped; weekly ones are thinned
 *   to one per 10 minutes, always keeping the newest.
 *
 * @param samples Oldest first. Not changed.
 * @returns A new array, oldest first.
 */
export function appendSample(
  samples: UsageSample[],
  sample: UsageSample,
  window: ForecastWindow,
): UsageSample[] {
  if (!Number.isFinite(sample.at) || !Number.isFinite(sample.usedPercent))
    return samples.slice();
  const resetsAt =
    sample.resetsAt !== null && Number.isFinite(sample.resetsAt)
      ? sample.resetsAt
      : null;
  const next: UsageSample = {
    at: sample.at,
    usedPercent: clampPercent(sample.usedPercent),
    resetsAt,
  };

  // A clock that went back leaves samples "after" this one; they cannot be
  // ordered against it, so they go.
  let kept = samples.filter((entry) => entry.at <= next.at);
  const previous = kept.at(-1);
  if (previous && !sameWindow(previous.resetsAt, next.resetsAt)) kept = [];
  else if (
    previous &&
    next.at - previous.at < MIN_SAMPLE_GAP_MS &&
    previous.usedPercent === next.usedPercent
  )
    return kept;

  const beforeLast = kept.at(-2);
  if (
    window === "weekly" &&
    beforeLast &&
    next.at - beforeLast.at <= WEEKLY_SPACING_MS
  )
    // The last sample is only the freshest reading since `beforeLast`; the
    // newer one takes its place until 10 minutes have passed.
    kept = kept.slice(0, -1);
  kept.push(next);

  const oldest = next.at - RETENTION_MS[window];
  const retained = kept.filter((entry) => entry.at >= oldest);
  return retained.length > MAX_SAMPLES
    ? retained.slice(-MAX_SAMPLES)
    : retained;
}

/**
 * When the island stays silent, whatever the pace.
 *
 * - `minUsedPercent`: little is used, so a warning would only be noise.
 * - `minElapsedMinutes`: the window just started; its pace means little yet.
 * - `minSamples`: too few readings in the lookback to measure a slope.
 */
export const QUIET = {
  minUsedPercent: 25,
  minElapsedMinutes: 15,
  minSamples: 3,
} as const;

/** How far back the recent pace is measured, per window. */
const LOOKBACK_MS: Record<ForecastWindow, number> = {
  "five-hour": HOUR,
  weekly: 24 * HOUR,
};

/** A window that will run out before it resets. Times are epoch ms. */
export interface UsageForecast {
  usedPercent: number;
  /** The recent pace, in percent of the window per hour. */
  ratePercentPerHour: number;
  /** When the window runs out; `now` when it already has. */
  exhaustAt: number;
  resetsAt: number;
  /** How long the agent will be out before the reset. */
  shortByMs: number;
}

function windowEnabled(
  window: ForecastWindow,
  settings: UsageForecastSettings,
): boolean {
  if (!settings.enabled) return false;
  return window === "five-hour" ? settings.fiveHour : settings.weekly;
}

/**
 * Forecasts whether a window runs out before it resets (FE-181/D4).
 *
 * Both the recent pace (over the lookback) and the average pace (since the
 * window started) must run out at least the margin before the reset, so one
 * short burst never warns. The later of the two is reported.
 *
 * @param samples The window's samples, oldest first, as {@link appendSample}
 * keeps them.
 * @returns `null` when the island has nothing to say: the window is off, too
 * quiet (see {@link QUIET}), or on pace to last until its reset.
 */
export function forecastOf(
  samples: UsageSample[],
  window: ForecastWindow,
  now: number,
  settings: UsageForecastSettings,
): UsageForecast | null {
  if (!windowEnabled(window, settings)) return null;
  const latest = samples.at(-1);
  if (!latest || latest.resetsAt === null || latest.resetsAt <= now)
    return null;
  const resetsAt = latest.resetsAt;
  const usedPercent = latest.usedPercent;
  if (usedPercent < QUIET.minUsedPercent) return null;

  const startedAt = resetsAt - WINDOW_MINUTES[window] * MINUTE;
  const elapsed = now - startedAt;
  if (elapsed < QUIET.minElapsedMinutes * MINUTE) return null;

  const since = Math.max(now - LOOKBACK_MS[window], startedAt);
  const recent = samples.filter(
    (sample) => sample.at >= since && sample.at <= now,
  );
  if (recent.length < QUIET.minSamples) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const span = last.at - first.at;
  const recentRate =
    span > 0 ? ((last.usedPercent - first.usedPercent) / span) * HOUR : 0;
  const averageRate = (usedPercent / elapsed) * HOUR;

  let exhaustAt: number;
  if (usedPercent >= 100) exhaustAt = now;
  else {
    if (recentRate <= 0) return null;
    const left = 100 - usedPercent;
    const byRecent = now + (left / recentRate) * HOUR;
    const byAverage = now + (left / averageRate) * HOUR;
    exhaustAt = Math.max(byRecent, byAverage);
  }

  const shortByMs = resetsAt - exhaustAt;
  if (shortByMs < settings.marginMinutes * MINUTE) return null;
  return {
    usedPercent,
    ratePercentPerHour: recentRate > 0 ? recentRate : averageRate,
    exhaustAt,
    resetsAt,
    shortByMs,
  };
}

/**
 * How long a forecast that stopped holding stays on the island (FE-181/V5).
 *
 * Claude's usage arrives every 5 minutes in whole percents, so a pace near the
 * margin tips the forecast on and off from one reading to the next. In a
 * simulation of 22 %/h with noise it stayed off for 25 to 35 minutes between
 * two ons, so the five-hour window keeps what it showed for 45 minutes. The
 * weekly window moves slower (its pace is read over a day): 6 hours.
 */
export const HOLD_MS: Record<ForecastWindow, number> = {
  "five-hour": 45 * MINUTE,
  weekly: 6 * HOUR,
};

/** A forecast the island is keeping, and when it last held for real. */
export interface HeldForecast {
  forecast: UsageForecast;
  /** Epoch ms of the last reading that produced `forecast`. */
  seenAt: number;
}

/**
 * What the island shows now: the fresh forecast, else the last one for up to
 * {@link HOLD_MS} while its window has not reset.
 *
 * @param held What {@link holdForecast} returned for this window last time.
 * @param current What {@link forecastOf} says now; null when it does not hold.
 * @param window The window the forecast is for: it sets how long to hold.
 * @returns The forecast to keep (pass it back as `held`), or null once the
 *   forecast has been gone for its {@link HOLD_MS} or its window reset.
 */
export function holdForecast(
  held: HeldForecast | null,
  current: UsageForecast | null,
  now: number,
  window: ForecastWindow,
): HeldForecast | null {
  if (current) return { forecast: current, seenAt: now };
  if (!held) return null;
  if (now - held.seenAt >= HOLD_MS[window]) return null;
  if (held.forecast.resetsAt <= now) return null;
  return held;
}
