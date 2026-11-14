// Stop on a conductor's rail row: every engine the conductor still runs in
// a project, ended at once.
//
// A conductor may run more than its current conversation: an earlier one
// whose engine is still alive (a Reset lets the conversation go, not its
// process), the sessions it started (`sessions.start`, FE-128), and the
// orchestration run it leads. Each keeps the project switcher's running mark
// lit until its engine ends.
//
// NOTE: Engines only. Conversations, transcripts, the ledger and memory
// stay; a run is stopped the way its panel's Stop does it, which keeps the
// worktrees with unreviewed work.

import type {
  ConductorStopPreview,
  ConductorStopRun,
  ConductorStopSummary,
} from "../../../shared/conductor-sessions";

/** What a conductor's Stop needs of the app. */
export interface ConductorStopDeps {
  /** The conversations of `project` with a live engine, workers left out. */
  alive: (project: string) => string[];
  /** A turn of the conversation is running now. */
  working: (project: string, conversation: string) => boolean;
  /**
   * The conductor whose conversation this is, or was while its engine ran;
   * null for none.
   */
  conductorOf: (
    project: string,
    conversation: string,
  ) => Promise<string | null>;
  /** The sessions conductor `lead` started in `project`. */
  sessionsOf: (project: string, lead: string) => Promise<string[]>;
  /**
   * The runs `lead` leads in `project` that are active or paused and this
   * app drives, newest first.
   */
  runsOf: (project: string, lead: string) => Promise<ConductorStopRun[]>;
  /** Keep a report owed to the conductor from starting it again. */
  hold: (
    project: string,
    lead: string,
    conversations: readonly string[],
  ) => Promise<void>;
  /** The run panel's Stop. */
  stopRun: (project: string, runId: string) => Promise<unknown>;
  /** The rail's Stop of one conversation: the turn cut off, the engine ended. */
  close: (project: string, conversation: string) => Promise<void>;
}

/** What Stop would end, by id. */
interface Plan {
  conversations: string[];
  sessions: string[];
  runs: ConductorStopRun[];
}

async function planOf(
  deps: ConductorStopDeps,
  project: string,
  lead: string,
): Promise<Plan> {
  const [launched, runs] = await Promise.all([
    deps.sessionsOf(project, lead).then((ids) => new Set(ids)),
    deps.runsOf(project, lead),
  ]);
  const conversations: string[] = [];
  const sessions: string[] = [];
  for (const id of deps.alive(project)) {
    if (launched.has(id)) sessions.push(id);
    else if ((await deps.conductorOf(project, id).catch(() => null)) === lead)
      conversations.push(id);
  }
  return { conversations, sessions, runs };
}

/**
 * The newest run, with every live run's working workers: a conductor
 * rarely leads two at once, and Stop ends them all.
 */
function runOf(runs: readonly ConductorStopRun[]): ConductorStopRun | null {
  const [newest] = runs;
  if (!newest) return null;
  return {
    ...newest,
    workers: runs.reduce((sum, run) => sum + run.workers, 0),
  };
}

/** What Stop would end now; ends nothing. */
export async function previewConductorStop(
  deps: ConductorStopDeps,
  project: string,
  lead: string,
): Promise<ConductorStopPreview> {
  const plan = await planOf(deps, project, lead);
  return {
    conversations: plan.conversations.length,
    sessions: plan.sessions.length,
    run: runOf(plan.runs),
    answering: plan.conversations.some((id) => deps.working(project, id)),
  };
}

/**
 * End every engine conductor `lead` runs in `project`.
 *
 * Its reports are held first, so a session cut off here cannot start it
 * again; then its runs stop, then every engine closes. One that fails does
 * not keep the others running.
 *
 * @throws The first failure, once everything else was ended.
 */
export async function stopConductor(
  deps: ConductorStopDeps,
  project: string,
  lead: string,
): Promise<ConductorStopSummary> {
  const plan = await planOf(deps, project, lead);
  await deps.hold(project, lead, plan.conversations);
  const failures: unknown[] = [];
  for (const run of plan.runs)
    await deps.stopRun(project, run.id).catch((error) => failures.push(error));
  const closed = await Promise.allSettled(
    [...plan.sessions, ...plan.conversations].map((id) =>
      deps.close(project, id),
    ),
  );
  for (const result of closed)
    if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw failures[0];
  return {
    conversations: plan.conversations.length,
    sessions: plan.sessions.length,
    run: runOf(plan.runs),
  };
}
