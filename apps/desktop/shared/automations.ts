// Automations (FE-99): an agent run on a schedule. Main keeps the
// automations and their runs in the session store (`lw.db`), ticks a
// scheduler, and starts each run as a fresh headless conversation; the page
// at `/w/$slug/automations` lists, edits and runs them by hand.

import { type ComposerSettings, checkSettings } from "./conversation";

/** The agents an automation can run: the two with a headless engine. */
export const AUTOMATION_AGENTS = ["claude", "codex"] as const;
export type AutomationAgent = (typeof AUTOMATION_AGENTS)[number];

/**
 * Where a run works. `current`: the project's own folder. `worktree`: a
 * fresh git worktree made for the run, removed after it unless the agent
 * changed something there: then it is kept, branch and all, for review.
 */
export const AUTOMATION_WORKSPACES = ["current", "worktree"] as const;
export type AutomationWorkspace = (typeof AUTOMATION_WORKSPACES)[number];

export const AUTOMATION_PRESETS = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
] as const;
export type AutomationPreset = (typeof AUTOMATION_PRESETS)[number];

/**
 * When an automation runs (FE-99/D7), read in its `timezone`.
 *
 * - `preset`: `hourly` at `minute` past every hour; `daily` and `weekdays`
 *   (Mon–Fri) at `hour:minute`; `weekly` on `weekday` (0 Sunday … 6
 *   Saturday) at `hour:minute`.
 * - `cron`: a five-field cron expression.
 * - `once`: one run at `at`, an ISO date-time with its offset.
 */
export type AutomationSchedule =
  | {
      kind: "preset";
      preset: AutomationPreset;
      minute: number;
      hour?: number;
      weekday?: number;
    }
  | { kind: "cron"; expr: string }
  | { kind: "once"; at: string };

/** What the person sets: everything an automation has but its bookkeeping. */
export interface AutomationInput {
  name: string;
  prompt: string;
  agent: AutomationAgent;
  settings: ComposerSettings;
  workspace: AutomationWorkspace;
  schedule: AutomationSchedule;
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

export interface Automation extends AutomationInput {
  id: string;
  /** The project's slug. */
  project: string;
  /** The next slot, ISO; null when disabled or a `once` that has run. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Why a run started. */
export const AUTOMATION_TRIGGERS = ["schedule", "catch_up", "manual"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

/**
 * - `queued`: due, waiting for a free slot (at most two run at once).
 * - `nothing_to_report`: the agent's last answer was exactly
 *   {@link NOTHING_TO_REPORT}; its conversation is archived, no notification.
 * - `skipped`: a missed slot older than the one caught up, or past grace.
 */
export const AUTOMATION_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "skipped",
  "nothing_to_report",
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export interface AutomationRun {
  id: string;
  automationId: string;
  trigger: AutomationTrigger;
  /** The slot it was for, ISO; for a manual run, when it was asked for. */
  scheduledFor: string;
  startedAt: string | null;
  endedAt: string | null;
  status: AutomationRunStatus;
  agent: AutomationAgent;
  /** The conversation it ran in, once started. */
  conversation: string | null;
  /** The worktree's path, for a `worktree` run. */
  worktree: string | null;
  error: string | null;
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

/** Runs kept per automation; older ones are deleted. */
export const AUTOMATION_RUNS_KEPT = 100;

/** Runs going at once across the app (FE-99/D13). */
export const AUTOMATION_MAX_CONCURRENT = 2;

export const AUTOMATION_DEFAULTS = {
  graceMinutes: 60,
  timeoutMinutes: 60,
} as const;

/**
 * The cron expression a recurring schedule fires on, or null for `once`.
 *
 * NOTE: Presets become cron here so main computes every recurring slot one
 * way (croner, in the automation's zone).
 */
export function scheduleCron(schedule: AutomationSchedule): string | null {
  switch (schedule.kind) {
    case "cron":
      return schedule.expr.trim();
    case "once":
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

function checkSchedule(value: unknown): AutomationSchedule | null {
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
  if (v.kind !== "preset") return null;
  if (!AUTOMATION_PRESETS.includes(v.preset as AutomationPreset)) return null;
  if (!isInt(v.minute, 0, 59)) return null;
  const preset = v.preset as AutomationPreset;
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
export function checkAutomationInput(value: unknown): AutomationInput | null {
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
    !AUTOMATION_AGENTS.includes(v.agent as AutomationAgent) ||
    !settings ||
    !AUTOMATION_WORKSPACES.includes(v.workspace as AutomationWorkspace) ||
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
    agent: v.agent as AutomationAgent,
    settings,
    workspace: v.workspace as AutomationWorkspace,
    schedule,
    timezone: v.timezone,
    graceMinutes: v.graceMinutes,
    timeoutMinutes: v.timeoutMinutes,
    enabled: v.enabled,
  };
}

/** What changed, pushed to every window. */
export interface AutomationsChange {
  project: string;
  /** The automation whose row or runs changed. */
  automationId: string;
}

export const automationsChannels = {
  list: "automations:list",
  create: "automations:create",
  update: "automations:update",
  remove: "automations:remove",
  setEnabled: "automations:set-enabled",
  runNow: "automations:run-now",
  runs: "automations:runs",
  /** Main → renderer: an automation or its runs changed. */
  changed: "automations:changed",
} as const;

export interface DesktopAutomationsApi {
  /** A project's automations, by name. */
  list: (project: string) => Promise<Automation[]>;
  /** @throws When the input does not check, or the cron does not parse. */
  create: (project: string, input: AutomationInput) => Promise<Automation>;
  /** @throws As create, or when there is no such automation. */
  update: (id: string, input: AutomationInput) => Promise<Automation>;
  /** Deletes it and its runs; a run going on is stopped. */
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<Automation>;
  /**
   * Start a run now (`manual`), or queue it behind the running ones.
   *
   * @throws When one of this automation's runs is already going.
   */
  runNow: (id: string) => Promise<AutomationRun>;
  /** Its runs, newest first. */
  runs: (automationId: string, limit?: number) => Promise<AutomationRun[]>;
  onChanged: (listener: (change: AutomationsChange) => void) => () => void;
}
