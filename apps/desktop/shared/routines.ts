// Routines (FE-99): an agent run on a schedule. Main keeps the
// routines and their runs in the session store (`lw.db`), ticks a
// scheduler, and starts each run as a fresh headless conversation; the page
// at `/w/$slug/routines` lists, edits and runs them by hand.

import { type ComposerSettings, checkSettings } from "./conversation";

/** The agents a routine can run: the two with a headless engine. */
export const ROUTINE_AGENTS = ["claude", "codex"] as const;
export type RoutineAgent = (typeof ROUTINE_AGENTS)[number];

/**
 * Where a run works. `current`: the project's own folder. `worktree`: a
 * fresh git worktree made for the run, removed after it unless the agent
 * changed something there: then it is kept, branch and all, for review.
 */
export const ROUTINE_WORKSPACES = ["current", "worktree"] as const;
export type RoutineWorkspace = (typeof ROUTINE_WORKSPACES)[number];

export const ROUTINE_PRESETS = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
] as const;
export type RoutinePreset = (typeof ROUTINE_PRESETS)[number];

/**
 * When a routine runs (FE-99/D7), read in its `timezone`.
 *
 * - `preset`: `hourly` at `minute` past every hour; `daily` and `weekdays`
 *   (Mon–Fri) at `hour:minute`; `weekly` on `weekday` (0 Sunday … 6
 *   Saturday) at `hour:minute`.
 * - `cron`: a five-field cron expression.
 * - `once`: one run at `at`, an ISO date-time with its offset.
 * - `loop`: self-paced (FE-172): the run's agent says when the next one is
 *   with `schedule_next` (lanework-control), or ends the loop with
 *   `schedule_stop`; without a word the next is `minutes` after this one.
 */
export type RoutineSchedule =
  | {
      kind: "preset";
      preset: RoutinePreset;
      minute: number;
      hour?: number;
      weekday?: number;
    }
  | { kind: "cron"; expr: string }
  | { kind: "once"; at: string }
  | { kind: "loop"; minutes: number };

/**
 * A self-paced loop's bounds, in minutes (FE-172, decided 2026-11-25): what
 * `schedule_next` may ask (`@lanework/contracts` LOOP_MINUTES_MIN/MAX) and
 * what a loop's default may be.
 */
export const LOOP_MINUTES_MIN = 5;
export const LOOP_MINUTES_MAX = 1440;

/** `minutes` held to the loop's bounds, rounded. */
export function clampLoopMinutes(minutes: number): number {
  return Math.min(
    LOOP_MINUTES_MAX,
    Math.max(LOOP_MINUTES_MIN, Math.round(minutes)),
  );
}

/** What the person sets: everything a routine has but its bookkeeping. */
export interface RoutineInput {
  name: string;
  prompt: string;
  agent: RoutineAgent;
  settings: ComposerSettings;
  workspace: RoutineWorkspace;
  schedule: RoutineSchedule;
  /** IANA zone, e.g. `Asia/Ho_Chi_Minh`. */
  timezone: string;
  /**
   * How late a missed slot may still run, in minutes. Only the latest
   * missed slot inside it runs, once (FE-99/D9); older ones are `skipped`.
   */
  graceMinutes: number;
  /** A run still going after this is stopped and `timed_out`. */
  timeoutMinutes: number;
  enabled: boolean;
}

export interface Routine extends RoutineInput {
  id: string;
  /** The project's slug. */
  project: string;
  /** The next slot, ISO; null when disabled or a `once` that has run. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Why a run started. */
export const ROUTINE_TRIGGERS = ["schedule", "catch_up", "manual"] as const;
export type RoutineTrigger = (typeof ROUTINE_TRIGGERS)[number];

/**
 * - `queued`: due, waiting for a free slot (at most two run at once).
 * - `nothing_to_report`: the agent's last answer was exactly
 *   {@link NOTHING_TO_REPORT}; its conversation is archived, no notification.
 * - `skipped`: a missed slot older than the one caught up, or past grace.
 */
export const ROUTINE_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "skipped",
  "nothing_to_report",
] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];

export interface RoutineRun {
  id: string;
  routineId: string;
  trigger: RoutineTrigger;
  /** The slot it was for, ISO; for a manual run, when it was asked for. */
  scheduledFor: string;
  startedAt: string | null;
  endedAt: string | null;
  status: RoutineRunStatus;
  agent: RoutineAgent;
  /** The conversation it ran in, once started. */
  conversation: string | null;
  /** The worktree's path, for a `worktree` run. */
  worktree: string | null;
  error: string | null;
  /**
   * What a self-paced run said of its pace (FE-172): `schedule_next`'s or
   * `schedule_stop`'s reason, or null.
   */
  note: string | null;
  /**
   * The tokens its turns used (FE-177), summed; null when the CLI said none
   * (a run that never started, or one from before they were kept).
   */
  tokens: RoutineTokens | null;
  /**
   * What it cost in USD as the CLI prices it (FE-177): Claude's
   * API-equivalent price, not what a subscription is billed. Null for Codex.
   */
  costUSD: number | null;
}

/** A run's tokens (FE-177): uncached input, output, and cache reads. */
export interface RoutineTokens {
  input: number;
  output: number;
  cached: number;
}

/** The answer that means "nothing happened worth telling". */
export const NOTHING_TO_REPORT = "NOTHING_TO_REPORT";

/**
 * What a run sends: the person's prompt, then the one line that tells the
 * agent how to stay quiet (FE-99, decided 2026-11-25).
 *
 * NOTE: Added by main on every run, not written into the saved prompt, so
 * the person never has to remember it and editing the prompt cannot drop it.
 */
export function runPrompt(prompt: string): string {
  return `${prompt.trimEnd()}\n\nIf there is nothing worth reporting, reply with exactly ${NOTHING_TO_REPORT} and nothing else.`;
}

/**
 * The line a self-paced run's prompt gets (FE-172): how to set the loop's
 * pace with the lanework-control tools.
 *
 * NOTE: Fixed text, never the routine's own minutes, so editing the
 * default does not change what the agent reads.
 */
export const LOOP_RUN_LINE = `This routine paces itself: near the end of this run, call the schedule_next tool (lanework_control) once with the minutes until the next run (${LOOP_MINUTES_MIN} to ${LOOP_MINUTES_MAX}: sooner while work is in flight, later when nothing moves) and a short reason, or call schedule_stop with a reason when the work it watches is done.`;

/**
 * What a run of `routine` sends: {@link runPrompt}, with
 * {@link LOOP_RUN_LINE} before its last line for a `loop` schedule.
 */
export function routineRunPrompt(
  routine: Pick<RoutineInput, "prompt" | "schedule">,
): string {
  return runPrompt(
    routine.schedule.kind === "loop"
      ? `${routine.prompt.trimEnd()}\n\n${LOOP_RUN_LINE}`
      : routine.prompt,
  );
}

/** Runs kept per routine; older ones are deleted. */
export const ROUTINE_RUNS_KEPT = 100;

/** Runs going at once across the app (FE-99/D13). */
export const ROUTINE_MAX_CONCURRENT = 2;

export const ROUTINE_DEFAULTS = {
  graceMinutes: 60,
  timeoutMinutes: 60,
} as const;

/**
 * The cron expression a recurring schedule fires on, or null for `once`.
 *
 * NOTE: Presets become cron here so main computes every recurring slot one
 * way (croner, in the routine's zone).
 */
export function scheduleCron(schedule: RoutineSchedule): string | null {
  switch (schedule.kind) {
    case "cron":
      return schedule.expr.trim();
    case "once":
    case "loop":
      return null;
    case "preset": {
      const minute = schedule.minute;
      const hour = schedule.hour ?? 0;
      switch (schedule.preset) {
        case "hourly":
          return `${minute} * * * *`;
        case "daily":
          return `${minute} ${hour} * * *`;
        case "weekdays":
          return `${minute} ${hour} * * 1-5`;
        case "weekly":
          return `${minute} ${hour} * * ${schedule.weekday ?? 1}`;
      }
    }
  }
}

function isInt(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function checkSchedule(value: unknown): RoutineSchedule | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "cron") {
    return typeof v.expr === "string" && v.expr.trim().split(/\s+/).length === 5
      ? { kind: "cron", expr: v.expr.trim() }
      : null;
  }
  if (v.kind === "once") {
    return typeof v.at === "string" && !Number.isNaN(Date.parse(v.at))
      ? { kind: "once", at: v.at }
      : null;
  }
  if (v.kind === "loop")
    return isInt(v.minutes, LOOP_MINUTES_MIN, LOOP_MINUTES_MAX)
      ? { kind: "loop", minutes: v.minutes }
      : null;
  if (v.kind !== "preset") return null;
  if (!ROUTINE_PRESETS.includes(v.preset as RoutinePreset)) return null;
  if (!isInt(v.minute, 0, 59)) return null;
  const preset = v.preset as RoutinePreset;
  if (preset === "hourly") return { kind: "preset", preset, minute: v.minute };
  if (!isInt(v.hour, 0, 23)) return null;
  if (preset !== "weekly")
    return { kind: "preset", preset, minute: v.minute, hour: v.hour };
  if (!isInt(v.weekday, 0, 6)) return null;
  return {
    kind: "preset",
    preset,
    minute: v.minute,
    hour: v.hour,
    weekday: v.weekday,
  };
}

/** Whether `zone` is an IANA zone this runtime knows. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * An input from the page, checked field by field.
 *
 * NOTE: A cron expression is only checked for five fields here; main parses
 * it with croner and refuses what croner refuses.
 *
 * @returns null when any field is missing or out of range.
 */
export function checkRoutineInput(value: unknown): RoutineInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const settings = checkSettings(v.settings);
  const schedule = checkSchedule(v.schedule);
  if (
    typeof v.name !== "string" ||
    !v.name.trim() ||
    v.name.length > 200 ||
    typeof v.prompt !== "string" ||
    !v.prompt.trim() ||
    v.prompt.length > 20_000 ||
    !ROUTINE_AGENTS.includes(v.agent as RoutineAgent) ||
    !settings ||
    !ROUTINE_WORKSPACES.includes(v.workspace as RoutineWorkspace) ||
    !schedule ||
    !isTimeZone(v.timezone) ||
    !isInt(v.graceMinutes, 0, 7 * 24 * 60) ||
    !isInt(v.timeoutMinutes, 1, 24 * 60) ||
    typeof v.enabled !== "boolean"
  )
    return null;
  return {
    name: v.name.trim(),
    prompt: v.prompt,
    agent: v.agent as RoutineAgent,
    settings,
    workspace: v.workspace as RoutineWorkspace,
    schedule,
    timezone: v.timezone,
    graceMinutes: v.graceMinutes,
    timeoutMinutes: v.timeoutMinutes,
    enabled: v.enabled,
  };
}

/** What changed, pushed to every window. */
export interface RoutinesChange {
  project: string;
  /** The routine whose row or runs changed. */
  routineId: string;
}

export const routinesChannels = {
  list: "routines:list",
  create: "routines:create",
  update: "routines:update",
  remove: "routines:remove",
  setEnabled: "routines:set-enabled",
  runNow: "routines:run-now",
  runs: "routines:runs",
  /** Main → renderer: a routine or its runs changed. */
  changed: "routines:changed",
} as const;

export interface DesktopRoutinesApi {
  /** A project's routines, by name. */
  list: (project: string) => Promise<Routine[]>;
  /** @throws When the input does not check, or the cron does not parse. */
  create: (project: string, input: RoutineInput) => Promise<Routine>;
  /** @throws As create, or when there is no such routine. */
  update: (id: string, input: RoutineInput) => Promise<Routine>;
  /** Deletes it and its runs; a run going on is stopped. */
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<Routine>;
  /**
   * Start a run now (`manual`), or queue it behind the running ones.
   *
   * @throws When one of this routine's runs is already going.
   */
  runNow: (id: string) => Promise<RoutineRun>;
  /** Its runs, newest first. */
  runs: (routineId: string, limit?: number) => Promise<RoutineRun[]>;
  onChanged: (listener: (change: RoutinesChange) => void) => () => void;
}
