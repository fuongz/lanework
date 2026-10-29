// What the agent usage strip and Settings › Agents say about an account's
// usage limits, with no React: the view-model both draw from, and the words
// for its ages and countdowns.
import type {
  ClaudeUsage,
  ClaudeUsageError,
  CodexQuota,
  CodexQuotaWindow,
  CodexResetCredits,
  OpenCodeUsage,
  OpenCodeUsageWindow,
} from "../../shared/terminal";

/** A window this full reads in the warning tone. */
export const NEARLY_SPENT = 90;

const ERROR_TEXT: Record<ClaudeUsageError, string> = {
  expired: "Your Claude sign-in has expired. Sign in to Claude again.",
  unavailable: "No Claude sign-in found on this machine.",
  failed: "Couldn’t refresh Claude usage.",
};

/** The agents whose account usage the strip can show. */
export type UsageAgent = "claude" | "codex" | "opencode";

/** One limit as the strip draws it, whichever agent it came from. */
export interface UsageWindow {
  usedPercent: number;
  /** Epoch ms; null when the source does not say. */
  resetsAt: number | null;
}

/** What the strip and its popover need, whichever agent it came from. */
export interface UsageView {
  agent: UsageAgent;
  /** "Claude Code", "Codex", "OpenCode". */
  name: string;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  /** OpenCode Go's monthly limit; null for the others. */
  monthly: UsageWindow | null;
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

export const clamp = (percent: number) => Math.max(0, Math.min(100, percent));

export const titleCase = (word: string) =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** How long `ms` is, as a countdown: "now", "42m", "3h 5m", "4d 6h". */
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

export function resetText(window: UsageWindow, now: number): string {
  if (window.resetsAt === null) return "Reset time unknown";
  const duration = resetDuration(window.resetsAt - now);
  return duration === "now" ? "Resets now" : `Resets in ${duration}`;
}

/**
 * When a window resets, for "resets …".
 *
 * "in 42 minutes" within the hour, "at 8:30 PM" later today, "Thu at 9:00 AM"
 * on another day, "now" once it is past. The time is in the system's own
 * format, so a 24-hour Mac reads "at 20:30".
 */
export function resetClock(at: number, now: number): string {
  if (at <= now) return "now";
  // Rounded up: 30 seconds left still reads "in 1 minute", never "in 0".
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes < 60)
    return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
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
    monthly: null,
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
    monthly: null,
    at: quota.at,
    stale: false,
    plan: quota.plan ? titleCase(quota.plan) : null,
    error: null,
    empty: "—",
    planNote: null,
    resets: quota.resetCredits ?? null,
  };
}

/** How long each of OpenCode Go's windows runs, in minutes (FE-104/D10). */
const OPENCODE_WINDOW = {
  fiveHour: 300,
  weekly: 10_080,
  monthly: 43_200,
} as const;

/**
 * OpenCode Go's limits, or null without a Go subscription (FE-104/D10).
 *
 * Its rolling 5-hour window, its week and its month. A window past its reset
 * has started over since, so its number is dropped rather than shown wrong. A
 * refused key reads as the others' expired sign-in.
 */
export function opencodeView(
  usage: OpenCodeUsage | null,
  now: number,
): UsageView | null {
  if (!usage) return null;
  const pick = (minutes: number): UsageWindow | null => {
    const found = usage.windows.find(
      (window: OpenCodeUsageWindow) => window.windowMinutes === minutes,
    );
    if (!found) return null;
    if (found.resetsAt !== null && found.resetsAt <= now) return null;
    return { usedPercent: found.usedPercent, resetsAt: found.resetsAt };
  };
  const expired = usage.error === "expired";
  return {
    agent: "opencode",
    name: "OpenCode",
    fiveHour: pick(OPENCODE_WINDOW.fiveHour),
    weekly: pick(OPENCODE_WINDOW.weekly),
    monthly: pick(OPENCODE_WINDOW.monthly),
    at: usage.at,
    stale: expired,
    plan: "Go",
    error: expired
      ? "Your OpenCode sign-in has expired. Sign in to OpenCode again."
      : null,
    empty: expired ? "expired" : "—",
    planNote: null,
    resets: null,
  };
}

export function barTone(used: number) {
  return used >= NEARLY_SPENT ? "bg-tone-amber" : "bg-foreground/55";
}

export const usageAgent = (kind: string | undefined): UsageAgent | null =>
  kind === "claude" || kind === "codex" || kind === "opencode" ? kind : null;
