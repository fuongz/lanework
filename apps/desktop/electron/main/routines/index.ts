// Routines in main (FE-99): the scheduler, the runner and the page's IPC.
//
// - The scheduler ticks every 30 s and on a wake from sleep. A routine
//   is due once its stored `nextRunAt` has passed; `planSlots` (pure, in
//   `slots.ts`) turns the slots since then into at most one run and a list
//   of skipped ones, and gives the next slot.
// - A run is a fresh headless conversation (Claude or Codex) started through
//   the chat's engines, named `Routine: <name>` on the rail. At most
//   ROUTINE_MAX_CONCURRENT run at once across the app; the rest wait as
//   `queued`. One routine never has two runs going.
// - Its end is heard from the chat's own events (`routines.onEvent`,
//   called beside the conductor's in `conversation/index.ts`). A last answer
//   of exactly NOTHING_TO_REPORT archives the conversation quietly; any
//   other end notifies.
// - A run's engine is gone once the app quits: a run left `running` or
//   `queued` by an earlier process is closed as `failed` at start.
// - A self-paced `loop` (FE-172) has no slots: a due `nextRunAt` queues one
//   run. Its process gets the schedule_next / schedule_stop tools
//   (`routineLoop`, through the conductor sessions' control channel); the
//   run's end sets `nextRunAt` from what the agent asked, else the loop's
//   default, or turns the routine off on a stop.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, powerMonitor } from "electron";
import { permissionInFolder } from "../../../shared/autonomy";
import type {
  SessionInputs,
  SessionResults,
} from "../../../shared/conductor-sessions";
import type {
  ConversationEvent,
  EngineState,
  Turn,
} from "../../../shared/conversation";
import {
  checkRoutineInput,
  NOTHING_TO_REPORT,
  ROUTINE_MAX_CONCURRENT,
  ROUTINE_RUNS_KEPT,
  type Routine,
  type RoutineInput,
  type RoutineRun,
  type RoutineRunStatus,
  type RoutinesChange,
  type RoutineTokens,
  type RoutineTrigger,
  routineRunPrompt,
  routinesChannels,
} from "../../../shared/routines";
import { AGENT_NAME_MAX } from "../../../shared/terminal";
import type { SessionStore } from "../../session-store";
import { trust as projectTrust } from "../agent-setup";
import { sharedEngines } from "../conversation/engine";
import type { Outgoing } from "../conversation/queue";
import { broadcast, handle } from "../ipc";
import { notify } from "../notifications";
import { onEngineResult } from "../orchestration/engine-tap";
import {
  createWorktree,
  hasChanges,
  removeWorktree,
  type WorkerCheckout,
} from "../orchestration/git";
import { knownProject, terminalFolder } from "../projects";
import {
  nameConversation,
  registerAgentSession,
  sessionStore,
} from "../terminal";
import { archiveAgentTranscript } from "../terminal/agent-archive";
import { codexCli, codexDirs } from "../terminal/usage";
import { agentHomeDir } from "../test-seams";
import { nextSlot, planSlots, scheduleError } from "./slots";

export { nextSlot, ON_TIME_MS, planSlots, type SlotPlan } from "./slots";

/** How often the scheduler looks for due slots. */
const TICK_MS = 30_000;

/** Why a run left by an earlier process, or cut by a quit, failed. */
const QUIT_ERROR = "Lanework quit before the run ended.";

// ── Store ───────────────────────────────────────────────────────────────────

/** Set at quit: nothing new starts after it. */
let closed = false;

/**
 * Lanework's session store (`lw.db`): the one handle main shares.
 *
 * @throws Once the app is quitting.
 */
function store(): SessionStore {
  return sessionStore();
}

function changed(project: string, routineId: string): void {
  broadcast(routinesChannels.changed, {
    project,
    routineId,
  } satisfies RoutinesChange);
}

// ── Runs going on ───────────────────────────────────────────────────────────

interface Live {
  runId: string;
  routine: Routine;
  /** Its native conversation, once known. */
  conversation: string | null;
  /**
   * The project's id, as the engines, the rail and the chat key it; null
   * until resolved. The routine itself keeps the slug the page gave.
   */
  key: string | null;
  /** The project's folder: the git root a worktree is made from. */
  root: string | null;
  /** Where the agent works: the project's folder or the worktree. */
  folder: string | null;
  tree: (WorkerCheckout & { branch: string }) | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Its turn was seen running: an idle after that is its end. */
  working: boolean;
  /** The last text the agent wrote, from the `turn` events. */
  lastText: string;
  timedOut: boolean;
  /**
   * Why the turn failed though its engine went back to idle: Claude refused
   * it for a sign-in to redo (`claude-auth`). Told before the idle.
   */
  failure: string | null;
  /** Its routine was deleted: nothing is recorded or told. */
  removed: boolean;
  ending: boolean;
  /**
   * What the agent last asked of a self-paced loop (FE-172): the next run
   * in `minutes`, or no more runs. Null: the loop's default.
   */
  pace:
    | { kind: "next"; minutes: number; reason: string | null }
    | { kind: "stop"; reason: string | null }
    | null;
  /** Its turns' tokens so far (FE-177); null until a turn tells some. */
  tokens: RoutineTokens | null;
  /** Its turns' cost so far in USD; null until a turn tells one. */
  costUSD: number | null;
}

/** Run id → the run going on. */
const live = new Map<string, Live>();
/** `project\0conversation` → run id, for the chat's events. */
const byConversation = new Map<string, string>();
/**
 * Conversation → the worktree it ran in, for every worktree run the
 * history holds: the chat reads its transcript from there.
 */
const runFolders = new Map<string, string>();

const keyOf = (project: string, conversation: string) =>
  `${project}\0${conversation}`;

/** The last text block of an assistant turn, trimmed; "" when none. */
function lastTextOf(turn: Turn): string {
  if (turn.role !== "assistant") return "";
  for (let at = turn.blocks.length - 1; at >= 0; at--) {
    const block = turn.blocks[at];
    if (block?.type === "text" && block.text.trim()) return block.text.trim();
  }
  return "";
}

/**
 * The agent's final answer: the turn's result as the engine told it, else
 * the newest assistant text the engine holds.
 */
function finalAnswer(run: Live): string {
  if (run.lastText) return run.lastText;
  const engines = sharedEngines();
  const turns =
    run.conversation && engines
      ? (engines.pending(run.key ?? run.routine.project, run.conversation)
          ?.turns ?? [])
      : [];
  for (let at = turns.length - 1; at >= 0; at--) {
    const turn = turns[at];
    if (turn?.role === "assistant") {
      const text = lastTextOf(turn);
      if (text) return text;
    }
  }
  return "";
}

/**
 * Run `codex <args>` against the Codex home the rail lists, as the rail's
 * Archive does (`terminal/index.ts`).
 */
async function runCodex(args: string[]): Promise<void> {
  const cli = await codexCli();
  await new Promise<void>((resolve, reject) => {
    execFile(
      cli.file,
      args,
      {
        cwd: homedir(),
        env: { ...cli.env, CODEX_HOME: codexDirs().home },
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve();
        const said = `${stderr}\n${stdout}`.trim().split("\n").pop()?.trim();
        reject(new Error(said || `codex ${args[0]} failed.`));
      },
    );
  });
}

function oneLine(text: string, max = 160): string {
  const line = text.split("\n").find((entry) => entry.trim()) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

async function notifyEnd(
  run: Live,
  status: RoutineRunStatus,
  detail: string,
): Promise<void> {
  if (!run.conversation) return;
  const { project: found } = await knownProject(run.routine.project);
  const name = run.routine.name;
  const title =
    status === "succeeded"
      ? `Routine: ${name}`
      : status === "timed_out"
        ? `Routine timed out: ${name}`
        : `Routine failed: ${name}`;
  await notify({
    kind: "routines",
    title,
    body: oneLine(detail) || "Finished.",
    target: {
      kind: "session",
      slug: found.slug,
      conversation: run.conversation,
    },
  });
}

/**
 * End a run: record how it went, tidy its conversation and worktree, tell
 * the person, and start what waits.
 *
 * @param error Why it failed, when it did.
 */
async function finish(run: Live, error: string | null): Promise<void> {
  if (run.ending) return;
  run.ending = true;
  if (run.timer) clearTimeout(run.timer);
  run.timer = null;
  const { project } = run.routine;
  const answer = finalAnswer(run);
  const status: RoutineRunStatus = run.timedOut
    ? "timed_out"
    : error !== null
      ? "failed"
      : answer === NOTHING_TO_REPORT
        ? "nothing_to_report"
        : "succeeded";
  const engines = sharedEngines();
  // NOTE: Its engine stays warm for a follow-up only in the project's own
  // folder: a worktree is about to go, and an archived conversation is
  // done.
  if (run.conversation && engines && (run.tree || status !== "succeeded"))
    await engines.close(run.key ?? project, run.conversation).catch(() => {});
  if (
    status === "nothing_to_report" &&
    run.conversation &&
    run.folder &&
    !closed
  )
    await archiveAgentTranscript(
      agentHomeDir(),
      run.folder,
      run.routine.agent,
      run.conversation,
      runCodex,
      store(),
    ).catch((cause: unknown) =>
      console.warn("Unable to archive a routine's conversation", cause),
    );
  if (run.tree && run.root) {
    // NOTE: A worktree the agent changed is kept, branch and all: removing
    // it would throw its work away. The run's row names it.
    const changedFiles = await hasChanges(run.tree, run.tree.baseline).catch(
      () => true,
    );
    if (!changedFiles)
      await removeWorktree(run.root, run.tree.path, run.tree.branch).catch(
        () => {},
      );
  }
  live.delete(run.runId);
  if (run.conversation)
    byConversation.delete(keyOf(run.key ?? project, run.conversation));
  if (!run.removed && !closed) {
    const endedAt = new Date();
    store().updateRoutineRun(run.runId, {
      status,
      endedAt: endedAt.toISOString(),
      error: run.timedOut
        ? `Stopped after ${run.routine.timeoutMinutes} minutes.`
        : error,
      ...(run.pace?.reason ? { note: run.pace.reason } : {}),
      tokens: run.tokens,
      costUSD: run.costUSD,
    });
    reschedule(run, endedAt);
    changed(project, run.routine.id);
    if (status !== "nothing_to_report")
      void notifyEnd(run, status, error ?? answer).catch(() => {});
  }
  pump();
}

/**
 * After a run of a self-paced loop (FE-172): turn it off on a stop, else
 * set its next run from `endedAt`, by what the agent asked or the loop's
 * default. A failed or timed-out run paces the loop all the same, so one
 * bad run does not end it.
 *
 * NOTE: Read from the store, not the run's copy: the person may have
 * edited, turned off or deleted the routine while the run went.
 */
function reschedule(run: Live, endedAt: Date): void {
  const current = store().getRoutine(run.routine.id);
  if (current?.schedule.kind !== "loop") return;
  if (run.pace?.kind === "stop") {
    store().saveRoutine({
      ...current,
      enabled: false,
      nextRunAt: null,
      updatedAt: endedAt.toISOString(),
    });
    return;
  }
  // Turned off meanwhile (or a manual run of an off loop): stays off.
  if (!current.enabled) return;
  const minutes = run.pace?.minutes ?? current.schedule.minutes;
  store().setRoutineNextRun(
    current.id,
    new Date(endedAt.getTime() + minutes * 60_000).toISOString(),
  );
}

/** Hear the conversation `run` started, from here on. */
function attach(run: Live, conversation: string): void {
  run.conversation = conversation;
  byConversation.set(
    keyOf(run.key ?? run.routine.project, conversation),
    run.runId,
  );
}

/** Whether `engine` says the turn is over. */
function ended(engine: EngineState): boolean {
  return engine.state === "idle" || engine.state === "error";
}

/** The run's turn ended with `engine` (an idle or an error). */
function endedWith(run: Live, engine: EngineState): void {
  // NOTE: A refused turn leaves the engine idle, not in error: a sign-in
  // that ran out, a turn the CLI says failed, or a prompt still held in its
  // queue is a failed run all the same, never a quiet "succeeded".
  const held = "queue" in engine ? engine.queue?.find((m) => m.error) : null;
  void finish(
    run,
    engine.state === "error"
      ? engine.message
      : (run.failure ?? held?.error ?? null),
  );
}

/**
 * Start queued run `runId` of `routine`. Synchronous up to its first
 * await, so {@link pump} counts it at once.
 */
function launch(routine: Routine, runId: string): void {
  const run: Live = {
    runId,
    routine,
    conversation: null,
    key: null,
    root: null,
    folder: null,
    tree: null,
    timer: null,
    working: false,
    lastText: "",
    timedOut: false,
    removed: false,
    ending: false,
    failure: null,
    pace: null,
    tokens: null,
    costUSD: null,
  };
  live.set(runId, run);
  store().updateRoutineRun(runId, {
    status: "running",
    startedAt: new Date().toISOString(),
  });
  changed(routine.project, routine.id);
  // Armed before the start: a worktree or a slow CLI counts too.
  run.timer = setTimeout(() => {
    run.timedOut = true;
    void finish(run, null);
  }, routine.timeoutMinutes * 60_000);
  void start(run).catch((error: unknown) =>
    finish(run, error instanceof Error ? error.message : String(error)),
  );
}

async function start(run: Live): Promise<void> {
  const { routine } = run;
  const { agent } = routine;
  const engines = sharedEngines();
  if (!engines) throw new Error("Conversations are not ready yet.");
  // NOTE: The page names the project by slug, but the engines, the rail and
  // the chat key a project by its id: a run started under the slug was a
  // conversation no rail listed and no chat could answer (its permission
  // prompts went unseen and the run hung).
  const { project: found } = await knownProject(routine.project);
  // As the page's `useProjectKey`: the id, or the slug of a project with none.
  const project = found.id ?? found.slug;
  run.key = project;
  const root = await terminalFolder(project);
  if (!root) throw new Error("This project has no folder here.");
  run.root = root;
  run.folder = root;
  if (routine.workspace === "worktree") {
    const branch = `lanework/routine/${run.runId}`;
    const path = join(
      app.getPath("userData"),
      "routines",
      "worktrees",
      run.runId,
    );
    const tree = await createWorktree(root, path, branch);
    run.tree = { ...tree, branch };
    run.folder = tree.path;
    // Timed out or deleted while git made it: nobody will tidy it but us.
    if (run.ending) {
      await removeWorktree(root, tree.path, branch).catch(() => {});
      return;
    }
    store().updateRoutineRun(run.runId, { worktree: tree.path });
  }
  const folder = run.folder;
  // FE-173/D3: nobody watches a run, so a folder its CLI does not trust runs
  // Supervised. Read for the project's own folder: a worktree is a copy of
  // the same repository, and the CLI keeps no trust record for it. A read
  // that fails counts as untrusted.
  const trusted = await projectTrust(routine.project)
    .then((found) => found[agent].trusted)
    .catch(() => false);
  const prompt = routineRunPrompt(routine);
  const out: Outgoing = {
    id: randomUUID(),
    text: prompt,
    attachments: [],
    content: [{ type: "text", text: prompt }],
    settings: {
      ...routine.settings,
      permission: permissionInFolder(routine.settings.permission, trusted),
    },
    // FE-172: a loop's process lists schedule_next / schedule_stop.
    routine: routine.schedule.kind === "loop",
  };
  let engine: EngineState;
  if (agent === "claude") {
    // Heard before it starts: its first events come before start answers.
    attach(run, randomUUID());
    engine = await engines.start(
      project,
      run.conversation as string,
      folder,
      out,
    );
  } else {
    const started = await engines.startCodex(project, folder, out);
    attach(run, started.conversation);
    engine = started.engine;
  }
  // NOTE: Codex answers only once its turn is under way, so the `running`
  // event can come before `attach`: without this its idle would be missed
  // and the run would stay `running` until its timeout.
  if (engine.state === "running" || engine.state === "starting")
    run.working = true;
  const conversation = run.conversation as string;
  if (run.tree) runFolders.set(conversation, folder);
  if (run.ending) {
    // Ended while its CLI started: `finish` may have missed the engine.
    await engines.close(project, conversation).catch(() => {});
  } else {
    store().updateRoutineRun(run.runId, { conversation });
    changed(routine.project, routine.id);
  }
  // NOTE: A worktree run is registered without a folder: a folder here
  // would move the project's transcript watch onto the worktree.
  await registerAgentSession(
    project,
    agent,
    conversation,
    run.tree ? null : folder,
  ).catch(() => {});
  await nameConversation(
    agent,
    conversation,
    `Routine: ${routine.name}`.slice(0, AGENT_NAME_MAX).trim(),
  ).catch(() => {});
  // A turn that ended before it was heard (a quick Codex refusal).
  if (
    !run.ending &&
    ended(engine) &&
    !engines.pending(project, conversation)?.working
  )
    endedWith(run, engine);
}

/** Start queued runs, oldest first, while there is room. */
function pump(): void {
  if (closed) return;
  let queued: RoutineRun[];
  try {
    queued = store()
      .activeRoutineRuns()
      .filter((run) => run.status === "queued" && !live.has(run.id));
  } catch {
    return;
  }
  for (const run of queued) {
    if (live.size >= ROUTINE_MAX_CONCURRENT) return;
    const routine = store().getRoutine(run.routineId);
    if (!routine) continue;
    launch(routine, run.id);
  }
}

/** Whether `routineId` has a run queued or going. */
function busy(routineId: string): boolean {
  return store()
    .activeRoutineRuns()
    .some((run) => run.routineId === routineId);
}

function newRun(
  routine: Routine,
  trigger: RoutineTrigger,
  scheduledFor: string,
  status: RoutineRunStatus,
  error: string | null = null,
): RoutineRun {
  const over = status === "skipped";
  return {
    id: randomUUID(),
    routineId: routine.id,
    trigger,
    scheduledFor,
    startedAt: null,
    endedAt: over ? new Date().toISOString() : null,
    status,
    agent: routine.agent,
    conversation: null,
    worktree: null,
    error,
    note: null,
    tokens: null,
    costUSD: null,
  };
}

// ── The chat's events ───────────────────────────────────────────────────────

/** What `conversation/index.ts` tells of every engine event. */
export const routines = {
  onEvent(event: ConversationEvent): void {
    if (typeof event.conversation !== "string" || !byConversation.size) return;
    const runId = byConversation.get(keyOf(event.project, event.conversation));
    const run = runId ? live.get(runId) : undefined;
    if (!run || run.ending) return;
    if (event.type === "turn") {
      const text = lastTextOf(event.turn);
      if (text) run.lastText = text;
      return;
    }
    if (event.type === "claude-auth") {
      if (event.state === "failed")
        run.failure = event.message ?? "Claude needs to sign in again.";
      return;
    }
    if (event.type !== "state") return;
    if (event.engine.state === "running" || event.engine.state === "starting")
      run.working = true;
    else if (run.working && ended(event.engine)) endedWith(run, event.engine);
  },
};

/**
 * The running run of a self-paced loop that `conversation` is, for
 * `loop.next` / `loop.stop`.
 *
 * @throws With the message the agent is told, when it is not one.
 */
function loopRunOf(project: string, conversation: string): Live {
  const runId = byConversation.get(keyOf(project, conversation));
  const run = runId ? live.get(runId) : undefined;
  if (!run || run.ending || run.removed)
    throw new Error(
      "Only a running routine's own run can set when it runs next.",
    );
  const current = store().getRoutine(run.routine.id);
  if (current?.schedule.kind !== "loop")
    throw new Error(
      "This routine runs on a fixed schedule; only a self-paced (loop) routine sets its own next run.",
    );
  return run;
}

/**
 * A self-paced routine's pace (FE-172), as its run's agent sets it with
 * schedule_next / schedule_stop. Kept on the live run until it ends; the
 * last call wins. Handed to `ConductorSessions` as its `loop` dep.
 */
export const routineLoop = {
  next(
    project: string,
    conversation: string,
    input: SessionInputs["loop.next"],
  ): SessionResults["loop.next"] {
    const run = loopRunOf(project, conversation);
    const reason = input.reason ?? null;
    run.pace = { kind: "next", minutes: input.minutes, reason };
    return {
      minutes: input.minutes,
      reason,
      next: `The next run starts ${input.minutes} minutes after this one ends. Calling schedule_next or schedule_stop again replaces this.`,
    };
  },
  stop(
    project: string,
    conversation: string,
    input: SessionInputs["loop.stop"],
  ): SessionResults["loop.stop"] {
    const run = loopRunOf(project, conversation);
    const reason = input.reason ?? null;
    run.pace = { kind: "stop", reason };
    return {
      stopped: true,
      reason,
      next: "No run is scheduled after this one; the routine turns off when it ends, until the user turns it on again.",
    };
  },
};

/**
 * The worktree a routine's conversation ran in, or null: its transcript
 * is kept under that folder, not the project's.
 */
export function routineFolderOf(conversation: string): string | null {
  return runFolders.get(conversation) ?? null;
}

// ── Scheduler ───────────────────────────────────────────────────────────────

let ticking = false;

/**
 * Look at every enabled routine whose next slot has passed: record the
 * slots that will not run, queue the one that will, move `nextRunAt` on.
 */
function tick(now = new Date()): void {
  if (ticking || closed) return;
  ticking = true;
  try {
    for (const routine of store().allRoutines()) {
      if (!routine.enabled || !routine.nextRunAt) continue;
      const due = Date.parse(routine.nextRunAt);
      if (Number.isNaN(due) || due > now.getTime()) continue;
      if (routine.schedule.kind === "loop") {
        tickLoop(routine, now);
        continue;
      }
      let plan: ReturnType<typeof planSlots>;
      try {
        plan = planSlots(routine, new Date(due - 1), now);
      } catch (error) {
        console.warn("A routine's schedule no longer parses", error);
        store().setRoutineNextRun(routine.id, null);
        changed(routine.project, routine.id);
        continue;
      }
      const reason = plan.run
        ? "A later missed slot ran instead."
        : "Missed by more than the grace period.";
      for (const slot of plan.skipped)
        store().addRoutineRun(
          newRun(routine, "schedule", slot, "skipped", reason),
          slot,
        );
      if (plan.run) {
        if (busy(routine.id))
          store().addRoutineRun(
            newRun(
              routine,
              plan.run.trigger,
              plan.run.slot,
              "skipped",
              "The previous run was still going.",
            ),
          );
        else
          store().addRoutineRun(
            newRun(routine, plan.run.trigger, plan.run.slot, "queued"),
          );
      }
      store().setRoutineNextRun(routine.id, plan.next);
      changed(routine.project, routine.id);
    }
  } catch (error) {
    console.warn("The routines tick failed", error);
  } finally {
    ticking = false;
  }
  pump();
}

/**
 * A self-paced loop whose `nextRunAt` has passed (FE-172): queue one run,
 * unless one still goes. Never `planSlots`: a loop has no slots to skip, and
 * a run missed while the app was closed runs once now, whatever its grace.
 *
 * NOTE: `nextRunAt` moves to the default after now meanwhile, so a run
 * cut off by a quit (closed as failed at the next launch, never reaching
 * `reschedule`) does not end the loop; its end replaces it.
 */
function tickLoop(routine: Routine, now: Date): void {
  if (!busy(routine.id))
    store().addRoutineRun(
      newRun(routine, "schedule", now.toISOString(), "queued"),
    );
  store().setRoutineNextRun(routine.id, nextSlot(routine, now));
  changed(routine.project, routine.id);
}

let interval: ReturnType<typeof setInterval> | null = null;

/** Close what an earlier process left going: its engines are gone. */
function closeLeftovers(): void {
  const at = new Date().toISOString();
  for (const run of store().activeRoutineRuns())
    store().updateRoutineRun(run.id, {
      status: "failed",
      endedAt: at,
      error: QUIT_ERROR,
    });
  for (const routine of store().allRoutines())
    for (const run of store().listRoutineRuns(routine.id, ROUTINE_RUNS_KEPT))
      if (run.worktree && run.conversation)
        runFolders.set(run.conversation, run.worktree);
}

// ── IPC ─────────────────────────────────────────────────────────────────────

function idArg(value: unknown, what = "A routine"): string {
  if (typeof value !== "string" || !value || value.length > 200)
    throw new Error(`${what} is required.`);
  return value;
}

function inputArg(value: unknown): RoutineInput {
  const input = checkRoutineInput(value);
  if (!input) throw new Error("That routine is not complete.");
  const refused = scheduleError(input);
  if (refused) throw new Error(`That schedule does not parse: ${refused}`);
  return input;
}

function existing(id: string): Routine {
  const routine = store().getRoutine(id);
  if (!routine) throw new Error("That routine is gone.");
  return routine;
}

/** `routine` with its next slot from `now`; null when disabled. */
function scheduled(routine: Routine, now: Date): Routine {
  return {
    ...routine,
    nextRunAt: routine.enabled ? nextSlot(routine, now) : null,
  };
}

/**
 * Refuse a one-off whose time has passed: it would never run.
 *
 * @throws When an enabled `once` is at or before `now`.
 */
function assertFuture(input: RoutineInput, now: Date): void {
  if (
    input.enabled &&
    input.schedule.kind === "once" &&
    Date.parse(input.schedule.at) <= now.getTime()
  )
    throw new Error("That time has passed.");
}

/** Stop `routineId`'s run going on, if any, recording nothing. */
async function stopRunsOf(routineId: string): Promise<void> {
  for (const run of live.values()) {
    if (run.routine.id !== routineId) continue;
    run.removed = true;
    await finish(run, null);
  }
}

/**
 * Register the routines' channels, close what an earlier process left
 * going, and start the scheduler.
 *
 * NOTE: After the conversation view: a run starts through its engines.
 */
export function registerRoutines(devUrl?: string): void {
  // NOTE: How a turn ended, for Claude and Codex alike, before the engine
  // goes idle: Codex streams no `turn` event, so this is the only place its
  // final answer (and NOTHING_TO_REPORT) is heard.
  onEngineResult((result) => {
    if (!result.conversation) return;
    const runId = byConversation.get(
      keyOf(result.project, result.conversation),
    );
    const run = runId ? live.get(runId) : undefined;
    if (!run || run.ending) return;
    if (result.text.trim()) run.lastText = result.text.trim();
    // FE-177: every turn of the run adds up.
    if (result.usage) {
      const before = run.tokens ?? { input: 0, output: 0, cached: 0 };
      run.tokens = {
        input: before.input + result.usage.input,
        output: before.output + result.usage.output,
        cached: before.cached + result.usage.cached,
      };
    }
    if (typeof result.costUSD === "number")
      run.costUSD = (run.costUSD ?? 0) + result.costUSD;
    if (result.error)
      run.failure = run.failure ?? (result.text.trim() || "The turn failed.");
  });
  handle(routinesChannels.list, devUrl, (args): Routine[] => {
    if (args.length !== 1) throw new Error("A project is required.");
    return store().listRoutines(idArg(args[0], "A project"));
  });

  handle(routinesChannels.create, devUrl, (args): Routine => {
    if (args.length !== 2)
      throw new Error("A project and a routine are required.");
    const project = idArg(args[0], "A project");
    const input = inputArg(args[1]);
    const now = new Date();
    assertFuture(input, now);
    const at = now.toISOString();
    const routine = scheduled(
      {
        ...input,
        id: randomUUID(),
        project,
        nextRunAt: null,
        createdAt: at,
        updatedAt: at,
      },
      now,
    );
    store().saveRoutine(routine);
    changed(project, routine.id);
    return routine;
  });

  handle(routinesChannels.update, devUrl, (args): Routine => {
    if (args.length !== 2)
      throw new Error("A routine and its fields are required.");
    const before = existing(idArg(args[0]));
    const input = inputArg(args[1]);
    const now = new Date();
    assertFuture(input, now);
    const routine = scheduled(
      {
        ...input,
        id: before.id,
        project: before.project,
        nextRunAt: null,
        createdAt: before.createdAt,
        updatedAt: now.toISOString(),
      },
      now,
    );
    store().saveRoutine(routine);
    changed(routine.project, routine.id);
    return routine;
  });

  handle(routinesChannels.remove, devUrl, async (args): Promise<void> => {
    if (args.length !== 1) throw new Error("A routine is required.");
    const routine = existing(idArg(args[0]));
    await stopRunsOf(routine.id);
    store().removeRoutine(routine.id);
    changed(routine.project, routine.id);
  });

  handle(routinesChannels.setEnabled, devUrl, (args): Routine => {
    const [id, enabled] = args;
    if (args.length !== 2 || typeof enabled !== "boolean")
      throw new Error("A routine and whether it is on are required.");
    const before = existing(idArg(id));
    const now = new Date();
    const routine = scheduled(
      { ...before, enabled, updatedAt: now.toISOString() },
      now,
    );
    store().saveRoutine(routine);
    changed(routine.project, routine.id);
    return routine;
  });

  handle(routinesChannels.runNow, devUrl, (args): RoutineRun => {
    if (args.length !== 1) throw new Error("A routine is required.");
    const routine = existing(idArg(args[0]));
    if (busy(routine.id))
      throw new Error("A run of this routine is already going.");
    const run = newRun(routine, "manual", new Date().toISOString(), "queued");
    store().addRoutineRun(run);
    changed(routine.project, routine.id);
    pump();
    return store().getRoutineRun(run.id) ?? run;
  });

  handle(routinesChannels.runs, devUrl, (args): RoutineRun[] => {
    const [id, limit] = args;
    if (args.length < 1 || args.length > 2)
      throw new Error("A routine is required.");
    if (
      limit !== undefined &&
      (typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > ROUTINE_RUNS_KEPT)
    )
      throw new Error(`A limit from 1 to ${ROUTINE_RUNS_KEPT} is required.`);
    return store().listRoutineRuns(idArg(id), limit);
  });

  try {
    closeLeftovers();
  } catch (error) {
    console.warn("Unable to close routine runs left going", error);
  }
  // A slot missed while the app was closed runs (or is skipped) now.
  tick();
  interval = setInterval(() => tick(), TICK_MS);
  // NOTE: A Mac asleep runs no timers: its missed slots are seen at wake,
  // not up to a tick later.
  powerMonitor.on("resume", () => tick());
}

/**
 * At quit: stop the scheduler, record the runs going on as cut off (their
 * engines end with the app), and close the store handle.
 */
export function stopRoutines(): void {
  closed = true;
  if (interval) clearInterval(interval);
  interval = null;
  // NOTE: The terminal module closes the shared store at will-quit too; if
  // it went first, the runs are closed as left over at the next launch.
  let sessions: SessionStore | null = null;
  try {
    sessions = store();
  } catch {
    sessions = null;
  }
  const at = new Date().toISOString();
  for (const run of live.values()) {
    if (run.timer) clearTimeout(run.timer);
    if (run.removed || !sessions) continue;
    sessions.updateRoutineRun(run.runId, {
      status: "failed",
      endedAt: at,
      error: QUIT_ERROR,
    });
  }
  live.clear();
}
