// When a routine runs (FE-99): its slots, read with croner in the
// routine's own zone, and what to do with the ones that came due.
//
// Pure: no Electron, no store, no clock of its own. The scheduler passes the
// time; a script can call `planSlots` with any dates (V3).

import { Cron } from "croner";
import {
  ROUTINE_RUNS_KEPT,
  type Routine,
  type RoutineTrigger,
  scheduleCron,
} from "../../../shared/routines";

/** What the slots depend on. */
export type SlotRoutine = Pick<
  Routine,
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
  run: { slot: string; trigger: Exclude<RoutineTrigger, "manual"> } | null;
  /**
   * Slots that came due and will not run, oldest first, ISO. Capped at
   * {@link ROUTINE_RUNS_KEPT}: the history keeps no more.
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
export function cronOf(routine: SlotRoutine): Cron | null {
  const expr = scheduleCron(routine.schedule);
  if (expr === null) return null;
  return new Cron(expr, { timezone: routine.timezone, paused: true });
}

/**
 * Whether croner accepts `routine`'s schedule.
 *
 * @returns null when it does, else croner's reason.
 */
export function scheduleError(routine: SlotRoutine): string | null {
  try {
    cronOf(routine);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The first slot strictly after `now`, ISO, or null. A `loop` has no slots:
 * its default minutes after `now`.
 */
export function nextSlot(routine: SlotRoutine, now: Date): string | null {
  // FE-172: a self-paced loop's first run, or its next without a word from
  // the agent, is its own default after `now`.
  if (routine.schedule.kind === "loop")
    return new Date(
      now.getTime() + routine.schedule.minutes * 60_000,
    ).toISOString();
  if (routine.schedule.kind === "once") {
    const at = Date.parse(routine.schedule.at);
    return at > now.getTime() ? new Date(at).toISOString() : null;
  }
  return cronOf(routine)?.nextRun(now)?.toISOString() ?? null;
}

/**
 * The slots in `(since, now]`, newest first, at most `max`.
 *
 * NOTE: Walked back from `now` (croner's `previousRuns`), not forward from
 * `since`: a minutely cron after a week asleep would be ten thousand steps,
 * and only the newest ones are ever recorded.
 */
function dueSlots(
  routine: SlotRoutine,
  since: Date,
  now: Date,
  max: number,
): Date[] {
  if (routine.schedule.kind === "once") {
    const at = Date.parse(routine.schedule.at);
    return at > since.getTime() && at <= now.getTime() ? [new Date(at)] : [];
  }
  const cron = cronOf(routine);
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
  routine: SlotRoutine,
  since: Date,
  now: Date,
): SlotPlan {
  const due = dueSlots(routine, since, now, ROUTINE_RUNS_KEPT + 1);
  const next = nextSlot(routine, now);
  const [latest, ...older] = due;
  if (!latest) return { run: null, skipped: [], next };
  const late = now.getTime() - latest.getTime();
  const inGrace = late <= routine.graceMinutes * 60_000;
  const skipped = (inGrace ? older : due)
    .slice(0, ROUTINE_RUNS_KEPT)
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
