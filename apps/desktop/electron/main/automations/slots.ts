// When an automation runs (FE-99): its slots, read with croner in the
// automation's own zone, and what to do with the ones that came due.
//
// Pure: no Electron, no store, no clock of its own. The scheduler passes the
// time; a script can call `planSlots` with any dates (V3).

import { Cron } from "croner";
import {
  AUTOMATION_RUNS_KEPT,
  type Automation,
  type AutomationTrigger,
  scheduleCron,
} from "../../../shared/automations";

/** What the slots depend on. */
export type SlotAutomation = Pick<
  Automation,
  "schedule" | "timezone" | "graceMinutes"
>;

/**
 * How late a slot may start and still count as on time (`schedule`), not
 * caught up: the tick runs every 30 s, so a due slot is seen well inside it.
 */
export const ON_TIME_MS = 2 * 60_000;

/** What {@link planSlots} decided. */
export interface SlotPlan {
  /** The one slot to run now, or null. */
  run: { slot: string; trigger: Exclude<AutomationTrigger, "manual"> } | null;
  /**
   * Slots that came due and will not run, oldest first, ISO. Capped at
   * {@link AUTOMATION_RUNS_KEPT}: the history keeps no more.
   */
  skipped: string[];
  /** The next slot after `now`, ISO; null when there is none. */
  next: string | null;
}

/**
 * The croner job for a recurring schedule, or null for `once`.
 *
 * NOTE: Paused and without a callback: it only computes dates, never fires.
 *
 * @throws When croner refuses the expression or the zone.
 */
export function cronOf(automation: SlotAutomation): Cron | null {
  const expr = scheduleCron(automation.schedule);
  if (expr === null) return null;
  return new Cron(expr, { timezone: automation.timezone, paused: true });
}

/**
 * Whether croner accepts `automation`'s schedule.
 *
 * @returns null when it does, else croner's reason.
 */
export function scheduleError(automation: SlotAutomation): string | null {
  try {
    cronOf(automation);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The first slot strictly after `now`, ISO, or null. */
export function nextSlot(automation: SlotAutomation, now: Date): string | null {
  if (automation.schedule.kind === "once") {
    const at = Date.parse(automation.schedule.at);
    return at > now.getTime() ? new Date(at).toISOString() : null;
  }
  return cronOf(automation)?.nextRun(now)?.toISOString() ?? null;
}

/**
 * The slots in `(since, now]`, newest first, at most `max`.
 *
 * NOTE: Walked back from `now` (croner's `previousRuns`), not forward from
 * `since`: a minutely cron after a week asleep would be ten thousand steps,
 * and only the newest ones are ever recorded.
 */
function dueSlots(
  automation: SlotAutomation,
  since: Date,
  now: Date,
  max: number,
): Date[] {
  if (automation.schedule.kind === "once") {
    const at = Date.parse(automation.schedule.at);
    return at > since.getTime() && at <= now.getTime() ? [new Date(at)] : [];
  }
  const cron = cronOf(automation);
  if (!cron) return [];
  // `previousRuns` is exclusive of its reference: one ms on takes in `now`.
  return cron
    .previousRuns(max, new Date(now.getTime() + 1))
    .filter((slot) => slot.getTime() > since.getTime());
}

/**
 * What to do with the slots that came due between `since` and `now`
 * (FE-99/D9).
 *
 * Only the latest due slot can run, and only when it is at most
 * `graceMinutes` old; it is `schedule` when it is on time
 * ({@link ON_TIME_MS}), else `catch_up`. Every other due slot is skipped:
 * a Mac that slept through three slots runs once when it wakes.
 *
 * @param since The last time the slots were looked at, exclusive. The
 *   scheduler passes just before the stored `nextRunAt`.
 * @param now Inclusive: a slot at `now` is due.
 * @throws When croner refuses the schedule.
 */
export function planSlots(
  automation: SlotAutomation,
  since: Date,
  now: Date,
): SlotPlan {
  const due = dueSlots(automation, since, now, AUTOMATION_RUNS_KEPT + 1);
  const next = nextSlot(automation, now);
  const [latest, ...older] = due;
  if (!latest) return { run: null, skipped: [], next };
  const late = now.getTime() - latest.getTime();
  const inGrace = late <= automation.graceMinutes * 60_000;
  const skipped = (inGrace ? older : due)
    .slice(0, AUTOMATION_RUNS_KEPT)
    .reverse()
    .map((slot) => slot.toISOString());
  return {
    run: inGrace
      ? {
          slot: latest.toISOString(),
          trigger: late <= ON_TIME_MS ? "schedule" : "catch_up",
        }
      : null,
    skipped,
    next,
  };
}
