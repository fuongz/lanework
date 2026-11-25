// Words and conversions for automations: a schedule as a sentence, a time
// to come, a run's length, and a wall-clock time in another zone.

import type {
  AutomationPreset,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationTrigger,
} from "#/../shared/automations";

export const PRESET_LABELS: Record<AutomationPreset, string> = {
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Every week",
};

/** Sunday first, as cron and `Date#getDay` count them. */
export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  schedule: "Scheduled",
  catch_up: "Catch-up",
  manual: "Manual",
};

export const STATUS_LABELS: Record<AutomationRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed out",
  skipped: "Skipped",
  nothing_to_report: "Nothing to report",
};

/** The zone this machine is in. */
export function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Every IANA zone this runtime knows, or just the machine's. */
export function timeZones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  return intl.supportedValuesOf?.("timeZone") ?? [machineTimeZone()];
}

/** `hour:minute` as this locale writes a time of day. */
export function clock(hour: number, minute: number): string {
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A schedule as a sentence: "Every day at 9:00 AM", "Every hour at :15".
 *
 * @param timezone Read with the schedule; named only when it is not the
 *   machine's, since then the times are not the clock on this screen.
 */
export function describeSchedule(
  schedule: AutomationSchedule,
  timezone?: string,
): string {
  const zone =
    timezone && timezone !== machineTimeZone() ? ` (${timezone})` : "";
  switch (schedule.kind) {
    case "cron":
      return `Cron ${schedule.expr}${zone}`;
    case "once": {
      const at = new Date(schedule.at);
      if (Number.isNaN(at.getTime())) return "Once";
      return `Once on ${at.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        ...(timezone ? { timeZone: timezone } : {}),
      })}${zone}`;
    }
    case "preset": {
      const time = clock(schedule.hour ?? 0, schedule.minute);
      switch (schedule.preset) {
        case "hourly":
          return `Every hour at :${String(schedule.minute).padStart(2, "0")}`;
        case "daily":
          return `Every day at ${time}${zone}`;
        case "weekdays":
          return `Weekdays at ${time}${zone}`;
        case "weekly":
          return `Every ${WEEKDAY_LABELS[schedule.weekday ?? 1]} at ${time}${zone}`;
      }
    }
  }
}

/** "in 3 hours", "in 5 minutes": a time to come, for a row. */
export function untilTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const seconds = Math.round((at - now) / 1000);
  if (seconds < 45) return "any moment";
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const scales: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of scales) {
    if (seconds >= size) return format.format(Math.floor(seconds / size), unit);
  }
  return "any moment";
}

/** A date-time in full, for a title or a table cell. */
export function fullTime(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** "4m 12s", "1h 3m": how long a run took, or has been going. */
export function duration(
  start: string | null,
  end: string | null,
  now: number,
): string {
  if (!start) return "";
  const from = new Date(start).getTime();
  const to = end ? new Date(end).getTime() : now;
  if (Number.isNaN(from) || Number.isNaN(to)) return "";
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The wall-clock fields of `at` in `zone`. */
function zonedParts(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** How far `zone` is ahead of UTC at instant `at`, in minutes. */
function zoneOffset(at: number, zone: string): number {
  const p = zonedParts(at, zone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A `datetime-local` value (`2026-11-26T09:00`) read in `zone`, as the ISO
 * date-time with offset a `once` schedule keeps (`2026-11-26T09:00:00+07:00`).
 *
 * @returns null when `local` is not a date-time.
 */
export function zonedToIso(local: string, zone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(
    local,
  );
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Twice: the offset at the guess may differ from the one at the answer
  // across a daylight-saving change.
  let offset = zoneOffset(wall, zone);
  offset = zoneOffset(wall - offset * 60_000, zone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${local.slice(0, 16)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** An ISO instant as a `datetime-local` value in `zone`. */
export function isoToZoned(iso: string, zone: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const p = zonedParts(at, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
