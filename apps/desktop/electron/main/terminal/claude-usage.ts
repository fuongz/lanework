import { readFile } from "node:fs/promises";
import type { ClaudeQuotaWindow, ClaudeUsage } from "../../../shared/terminal";

/** The file in the app's home where the status line bridge saves limits. */
export const CLAUDE_USAGE_FILE = "claude-usage.json";
/**
 * One rate-limit window as Claude's status line input gives it.
 *
 * @param minutes How long the window is.
 * @returns null for a missing window, or one with an out-of-range value.
 */
function claudeWindow(
  value: unknown,
  minutes: number,
): ClaudeQuotaWindow | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.used_percentage !== "number" ||
    !Number.isFinite(v.used_percentage) ||
    v.used_percentage < 0 ||
    v.used_percentage > 100
  )
    return null;
  const resets = v.resets_at;
  if (
    resets != null &&
    (typeof resets !== "number" || !Number.isFinite(resets) || resets < 0)
  )
    return null;
  return {
    usedPercent: v.used_percentage,
    windowMinutes: minutes,
    resetsAt: typeof resets === "number" ? resets * 1000 : null,
  };
}

/**
 * The rate-limit windows of Claude's status line input.
 *
 * It copies no session, prompt, account, or credential fields.
 *
 * @returns null when the input has neither window.
 */
export function claudeQuotaOf(value: unknown, at = new Date().toISOString()) {
  if (!value || typeof value !== "object") return null;
  const limits = (value as Record<string, unknown>).rate_limits;
  if (!limits || typeof limits !== "object") return null;
  const v = limits as Record<string, unknown>;
  const primary = claudeWindow(v.five_hour, 300);
  const secondary = claudeWindow(v.seven_day, 10080);
  return primary || secondary ? { primary, secondary, at } : null;
}

/**
 * The windows the status line bridge last saved to `file`.
 *
 * A file that is too big, unreadable, or dated in the future reads as no
 * windows. One older than ten minutes is `stale`.
 */
export async function readClaudeQuota(
  file: string,
): Promise<Pick<ClaudeUsage, "primary" | "secondary" | "at" | "stale">> {
  const empty = { primary: null, secondary: null, at: null, stale: false };
  try {
    const text = await readFile(file, "utf8");
    if (text.length > 4096) return empty;
    const value = JSON.parse(text);
    const parse = (v: Record<string, unknown> | null, minutes: number) =>
      v?.windowMinutes === minutes
        ? claudeWindow(
            {
              used_percentage: v.usedPercent,
              resets_at:
                typeof v.resetsAt === "number" ? v.resetsAt / 1000 : v.resetsAt,
            },
            minutes,
          )
        : null;
    const primary = parse(value.primary, 300);
    const secondary = parse(value.secondary, 10080);
    const time = typeof value.at === "string" ? Date.parse(value.at) : NaN;
    if (
      (!primary && !secondary) ||
      !Number.isFinite(time) ||
      time > Date.now() + 60_000
    )
      return empty;
    return {
      primary,
      secondary,
      at: new Date(time).toISOString(),
      stale: Date.now() - time > 600_000,
    };
  } catch {
    return empty;
  }
}
