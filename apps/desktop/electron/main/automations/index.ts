// Automations in main (FE-99): the scheduler, the runner and the page's IPC.
//
// - The scheduler ticks every 30 s and on a wake from sleep. An automation
//   is due once its stored `nextRunAt` has passed; `planSlots` (pure, in
//   `slots.ts`) turns the slots since then into at most one run and a list
//   of skipped ones, and gives the next slot.
// - A run is a fresh headless conversation (Claude or Codex) started through
//   the chat's engines, named `Automation: <name>` on the rail. At most
//   AUTOMATION_MAX_CONCURRENT run at once across the app; the rest wait as
//   `queued`. One automation never has two runs going.
// - Its end is heard from the chat's own events (`automations.onEvent`,
//   called beside the conductor's in `conversation/index.ts`). A last answer
//   of exactly NOTHING_TO_REPORT archives the conversation quietly; any
//   other end notifies.
// - A run's engine is gone once the app quits: a run left `running` or
//   `queued` by an earlier process is closed as `failed` at start.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, powerMonitor } from "electron";
import {
  AUTOMATION_MAX_CONCURRENT,
  AUTOMATION_RUNS_KEPT,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationsChange,
  type AutomationTrigger,
  automationsChannels,
  checkAutomationInput,
  NOTHING_TO_REPORT,
  runPrompt,
} from "../../../shared/automations";
import type {
  ConversationEvent,
  EngineState,
  Turn,
} from "../../../shared/conversation";
import { AGENT_NAME_MAX } from "../../../shared/terminal";
import type { SessionStore } from "../../session-store";
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

function changed(project: string, automationId: string): void {
  broadcast(automationsChannels.changed, {
    project,
    automationId,
  } satisfies AutomationsChange);
}

// ── Runs going on ───────────────────────────────────────────────────────────

interface Live {
  runId: string;
  automation: Automation;
  /** Its native conversation, once known. */
  conversation: string | null;
  /**
   * The project's id, as the engines, the rail and the chat key it; null
   * until resolved. The automation itself keeps the slug the page gave.
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
  /** Its automation was deleted: nothing is recorded or told. */
  removed: boolean;
  ending: boolean;
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
      ? (engines.pending(run.key ?? run.automation.project, run.conversation)
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
  status: AutomationRunStatus,
  detail: string,
): Promise<void> {
  if (!run.conversation) return;
  const { project: found } = await knownProject(run.automation.project);
  const name = run.automation.name;
  const title =
    status === "succeeded"
      ? `Automation: ${name}`
      : status === "timed_out"
        ? `Automation timed out: ${name}`
        : `Automation failed: ${name}`;
  await notify({
    kind: "automations",
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
  const { project } = run.automation;
  const answer = finalAnswer(run);
  const status: AutomationRunStatus = run.timedOut
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
      run.automation.agent,
      run.conversation,
      runCodex,
      store(),
    ).catch((cause: unknown) =>
      console.warn("Unable to archive an automation's conversation", cause),
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
    store().updateAutomationRun(run.runId, {
      status,
      endedAt: new Date().toISOString(),
      error: run.timedOut
        ? `Stopped after ${run.automation.timeoutMinutes} minutes.`
        : error,
    });
    changed(project, run.automation.id);
    if (status !== "nothing_to_report")
      void notifyEnd(run, status, error ?? answer).catch(() => {});
  }
  pump();
}

/** Hear the conversation `run` started, from here on. */
function attach(run: Live, conversation: string): void {
  run.conversation = conversation;
  byConversation.set(
    keyOf(run.key ?? run.automation.project, conversation),
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
 * Start queued run `runId` of `automation`. Synchronous up to its first
 * await, so {@link pump} counts it at once.
 */
function launch(automation: Automation, runId: string): void {
  const run: Live = {
    runId,
    automation,
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
  };
  live.set(runId, run);
  store().updateAutomationRun(runId, {
    status: "running",
    startedAt: new Date().toISOString(),
  });
  changed(automation.project, automation.id);
  // Armed before the start: a worktree or a slow CLI counts too.
  run.timer = setTimeout(() => {
    run.timedOut = true;
    void finish(run, null);
  }, automation.timeoutMinutes * 60_000);
  void start(run).catch((error: unknown) =>
    finish(run, error instanceof Error ? error.message : String(error)),
  );
}

async function start(run: Live): Promise<void> {
  const { automation } = run;
  const { agent } = automation;
  const engines = sharedEngines();
  if (!engines) throw new Error("Conversations are not ready yet.");
  // NOTE: The page names the project by slug, but the engines, the rail and
  // the chat key a project by its id: a run started under the slug was a
  // conversation no rail listed and no chat could answer (its permission
  // prompts went unseen and the run hung).
  const { project: found } = await knownProject(automation.project);
  // As the page's `useProjectKey`: the id, or the slug of a project with none.
  const project = found.id ?? found.slug;
  run.key = project;
  const root = await terminalFolder(project);
  if (!root) throw new Error("This project has no folder here.");
  run.root = root;
  run.folder = root;
  if (automation.workspace === "worktree") {
    const branch = `lanework/automation/${run.runId}`;
    const path = join(
      app.getPath("userData"),
      "automations",
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
    store().updateAutomationRun(run.runId, { worktree: tree.path });
  }
  const folder = run.folder;
  const out: Outgoing = {
    id: randomUUID(),
    text: runPrompt(automation.prompt),
    attachments: [],
    content: [{ type: "text", text: runPrompt(automation.prompt) }],
    settings: automation.settings,
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
    store().updateAutomationRun(run.runId, { conversation });
    changed(automation.project, automation.id);
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
    `Automation: ${automation.name}`.slice(0, AGENT_NAME_MAX).trim(),
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
  let queued: AutomationRun[];
  try {
    queued = store()
      .activeAutomationRuns()
      .filter((run) => run.status === "queued" && !live.has(run.id));
  } catch {
    return;
  }
  for (const run of queued) {
    if (live.size >= AUTOMATION_MAX_CONCURRENT) return;
    const automation = store().getAutomation(run.automationId);
    if (!automation) continue;
    launch(automation, run.id);
  }
}

/** Whether `automationId` has a run queued or going. */
function busy(automationId: string): boolean {
  return store()
    .activeAutomationRuns()
    .some((run) => run.automationId === automationId);
}

function newRun(
  automation: Automation,
  trigger: AutomationTrigger,
  scheduledFor: string,
  status: AutomationRunStatus,
  error: string | null = null,
): AutomationRun {
  const over = status === "skipped";
  return {
    id: randomUUID(),
    automationId: automation.id,
    trigger,
    scheduledFor,
    startedAt: null,
    endedAt: over ? new Date().toISOString() : null,
    status,
    agent: automation.agent,
    conversation: null,
    worktree: null,
    error,
  };
}

// ── The chat's events ───────────────────────────────────────────────────────

/** What `conversation/index.ts` tells of every engine event. */
export const automations = {
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
 * The worktree an automation's conversation ran in, or null: its transcript
 * is kept under that folder, not the project's.
 */
export function automationFolderOf(conversation: string): string | null {
  return runFolders.get(conversation) ?? null;
}

// ── Scheduler ───────────────────────────────────────────────────────────────

let ticking = false;

/**
 * Look at every enabled automation whose next slot has passed: record the
 * slots that will not run, queue the one that will, move `nextRunAt` on.
 */
function tick(now = new Date()): void {
  if (ticking || closed) return;
  ticking = true;
  try {
    for (const automation of store().allAutomations()) {
      if (!automation.enabled || !automation.nextRunAt) continue;
      const due = Date.parse(automation.nextRunAt);
      if (Number.isNaN(due) || due > now.getTime()) continue;
      let plan: ReturnType<typeof planSlots>;
      try {
        plan = planSlots(automation, new Date(due - 1), now);
      } catch (error) {
        console.warn("An automation's schedule no longer parses", error);
        store().setAutomationNextRun(automation.id, null);
        changed(automation.project, automation.id);
        continue;
      }
      const reason = plan.run
        ? "A later missed slot ran instead."
        : "Missed by more than the grace period.";
      for (const slot of plan.skipped)
        store().addAutomationRun(
          newRun(automation, "schedule", slot, "skipped", reason),
          slot,
        );
      if (plan.run) {
        if (busy(automation.id))
          store().addAutomationRun(
            newRun(
              automation,
              plan.run.trigger,
              plan.run.slot,
              "skipped",
              "The previous run was still going.",
            ),
          );
        else
          store().addAutomationRun(
            newRun(automation, plan.run.trigger, plan.run.slot, "queued"),
          );
      }
      store().setAutomationNextRun(automation.id, plan.next);
      changed(automation.project, automation.id);
    }
  } catch (error) {
    console.warn("The automations tick failed", error);
  } finally {
    ticking = false;
  }
  pump();
}

let interval: ReturnType<typeof setInterval> | null = null;

/** Close what an earlier process left going: its engines are gone. */
function closeLeftovers(): void {
  const at = new Date().toISOString();
  for (const run of store().activeAutomationRuns())
    store().updateAutomationRun(run.id, {
      status: "failed",
      endedAt: at,
      error: QUIT_ERROR,
    });
  for (const automation of store().allAutomations())
    for (const run of store().listAutomationRuns(
      automation.id,
      AUTOMATION_RUNS_KEPT,
    ))
      if (run.worktree && run.conversation)
        runFolders.set(run.conversation, run.worktree);
}

// ── IPC ─────────────────────────────────────────────────────────────────────

function idArg(value: unknown, what = "An automation"): string {
  if (typeof value !== "string" || !value || value.length > 200)
    throw new Error(`${what} is required.`);
  return value;
}

function inputArg(value: unknown): AutomationInput {
  const input = checkAutomationInput(value);
  if (!input) throw new Error("That automation is not complete.");
  const refused = scheduleError(input);
  if (refused) throw new Error(`That schedule does not parse: ${refused}`);
  return input;
}

function existing(id: string): Automation {
  const automation = store().getAutomation(id);
  if (!automation) throw new Error("That automation is gone.");
  return automation;
}

/** `automation` with its next slot from `now`; null when disabled. */
function scheduled(automation: Automation, now: Date): Automation {
  return {
    ...automation,
    nextRunAt: automation.enabled ? nextSlot(automation, now) : null,
  };
}

/**
 * Refuse a one-off whose time has passed: it would never run.
 *
 * @throws When an enabled `once` is at or before `now`.
 */
function assertFuture(input: AutomationInput, now: Date): void {
  if (
    input.enabled &&
    input.schedule.kind === "once" &&
    Date.parse(input.schedule.at) <= now.getTime()
  )
    throw new Error("That time has passed.");
}

/** Stop `automationId`'s run going on, if any, recording nothing. */
async function stopRunsOf(automationId: string): Promise<void> {
  for (const run of live.values()) {
    if (run.automation.id !== automationId) continue;
    run.removed = true;
    await finish(run, null);
  }
}

/**
 * Register the automations' channels, close what an earlier process left
 * going, and start the scheduler.
 *
 * NOTE: After the conversation view: a run starts through its engines.
 */
export function registerAutomations(devUrl?: string): void {
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
    if (result.error)
      run.failure = run.failure ?? (result.text.trim() || "The turn failed.");
  });
  handle(automationsChannels.list, devUrl, (args): Automation[] => {
    if (args.length !== 1) throw new Error("A project is required.");
    return store().listAutomations(idArg(args[0], "A project"));
  });

  handle(automationsChannels.create, devUrl, (args): Automation => {
    if (args.length !== 2)
      throw new Error("A project and an automation are required.");
    const project = idArg(args[0], "A project");
    const input = inputArg(args[1]);
    const now = new Date();
    assertFuture(input, now);
    const at = now.toISOString();
    const automation = scheduled(
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
    store().saveAutomation(automation);
    changed(project, automation.id);
    return automation;
  });

  handle(automationsChannels.update, devUrl, (args): Automation => {
    if (args.length !== 2)
      throw new Error("An automation and its fields are required.");
    const before = existing(idArg(args[0]));
    const input = inputArg(args[1]);
    const now = new Date();
    assertFuture(input, now);
    const automation = scheduled(
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
    store().saveAutomation(automation);
    changed(automation.project, automation.id);
    return automation;
  });

  handle(automationsChannels.remove, devUrl, async (args): Promise<void> => {
    if (args.length !== 1) throw new Error("An automation is required.");
    const automation = existing(idArg(args[0]));
    await stopRunsOf(automation.id);
    store().removeAutomation(automation.id);
    changed(automation.project, automation.id);
  });

  handle(automationsChannels.setEnabled, devUrl, (args): Automation => {
    const [id, enabled] = args;
    if (args.length !== 2 || typeof enabled !== "boolean")
      throw new Error("An automation and whether it is on are required.");
    const before = existing(idArg(id));
    const now = new Date();
    const automation = scheduled(
      { ...before, enabled, updatedAt: now.toISOString() },
      now,
    );
    store().saveAutomation(automation);
    changed(automation.project, automation.id);
    return automation;
  });

  handle(automationsChannels.runNow, devUrl, (args): AutomationRun => {
    if (args.length !== 1) throw new Error("An automation is required.");
    const automation = existing(idArg(args[0]));
    if (busy(automation.id))
      throw new Error("A run of this automation is already going.");
    const run = newRun(
      automation,
      "manual",
      new Date().toISOString(),
      "queued",
    );
    store().addAutomationRun(run);
    changed(automation.project, automation.id);
    pump();
    return store().getAutomationRun(run.id) ?? run;
  });

  handle(automationsChannels.runs, devUrl, (args): AutomationRun[] => {
    const [id, limit] = args;
    if (args.length < 1 || args.length > 2)
      throw new Error("An automation is required.");
    if (
      limit !== undefined &&
      (typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > AUTOMATION_RUNS_KEPT)
    )
      throw new Error(`A limit from 1 to ${AUTOMATION_RUNS_KEPT} is required.`);
    return store().listAutomationRuns(idArg(id), limit);
  });

  try {
    closeLeftovers();
  } catch (error) {
    console.warn("Unable to close automation runs left going", error);
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
export function stopAutomations(): void {
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
    sessions.updateAutomationRun(run.runId, {
      status: "failed",
      endedAt: at,
      error: QUIT_ERROR,
    });
  }
  live.clear();
}
