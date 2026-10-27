// The run engine (FE-87): runs, their workers, and the lead's control calls.
//
// - A run starts when the user approves the lead's proposal. Its tasks queue,
//   and the scheduler starts each one when a worker slot is free, every task
//   it depends on was accepted (`review`), and no task holding files it
//   claims is still open.
// - Each worker is an ordinary Claude or Codex conversation, run by the chat's
//   own engines, in a git worktree on `lanework/<run>/<task>` with a private
//   scratch folder as TMPDIR. Its first turn carries the hidden assignment
//   envelope.
// - A write outside a worker's scope stops that worker alone (`blocked`):
//   the engines report each write as the CLI names it, and the files it
//   changed are checked again when its turn ends.
// - `review` merges the worker's files into the main checkout three ways, all
//   or nothing; a conflict blocks the task instead.
// - The lead's CLI reaches the run over the control server with the run's
//   token, and only while the lead is in a turn. A request id is applied at
//   most once.
// - Jev, when set, answers three bounded questions; it is acted on only when
//   it says it decided, and told what was done in the end.
//
// Nothing here imports Electron: `index.ts` hands in the app's paths, the
// engines and the broadcast, so a script can drive it in a temp folder.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allModels,
  type ComposerSettings,
  type ConversationAgent,
  type ConversationEvent,
  checkSettings,
  DEFAULT_SETTINGS,
  type Effort,
  type EngineState,
  type PermissionAnswer,
  type PermissionRequest,
  settingsFor,
} from "../../../shared/conversation";
import {
  CONTROL_ENV,
  type ControlCall,
  ControlInputError,
  type ControlInputs,
  type DelegateInput,
  type JevMainHandlers,
  type JudgeRequest,
  type JudgeResult,
  type NeedsInput,
  type OrchestrationEvent,
  type OrchestrationProposal,
  type OrchestrationRun,
  type OrchestrationTask,
  type ProposedTask,
  TASKS_MAX,
  TIERS,
  type Tier,
  type TierModel,
  WAIT_MAX_SECONDS,
  type WorkerChoice,
} from "../../../shared/orchestration";
import type { Outgoing } from "../conversation/queue";
import type { EngineResult, EngineTarget, EngineWrite } from "./engine-tap";
import {
  checkoutTop,
  createWorktree,
  mergeWorker,
  removeWorktree,
  workerChanges,
} from "./git";
import {
  approvedTurn,
  recoveryTurn,
  resumedTurn,
  updateTurn,
  visibleText,
  workerTurn,
} from "./prompts";
import { checkWrite, inScopes, scopesOverlap } from "./scopes";

// ─── Seams ──────────────────────────────────────────────────────────────────

/** What the run engine needs of the chat's engines (`conversation/engine`). */
export interface OrchestrationEngines {
  state(workspace: string, conversation: string): Promise<EngineState>;
  start(
    workspace: string,
    conversation: string,
    folder: string,
    out: Outgoing,
  ): Promise<EngineState>;
  startCodex(
    workspace: string,
    folder: string,
    out: Outgoing,
  ): Promise<{ conversation: string; engine: EngineState }>;
  send(
    workspace: string,
    conversation: string,
    folder: string,
    out: Outgoing,
    agent?: ConversationAgent,
  ): Promise<EngineState>;
  stop(workspace: string, conversation: string): Promise<void>;
  answer(
    workspace: string,
    conversation: string,
    id: string,
    answer: PermissionAnswer,
  ): void;
  release(workspace: string, conversation: string): Promise<void>;
  close(workspace: string, conversation: string): Promise<void>;
  settingsOf(conversation: string): ComposerSettings | null;
  alive(workspace: string): string[];
}

export interface RuntimeDeps {
  /** The chat's engines; null before the conversation view registered. */
  engines: () => OrchestrationEngines | null;
  /** The folder main wrote down for a workspace. */
  folderOf: (workspace: string) => Promise<string | null>;
  /** Where runs, worktrees and nothing else of ours are kept. */
  dataDir: string;
  broadcast: (event: OrchestrationEvent) => void;
  /** The lead's control CLI, as it is told to run it. */
  cliPath: string;
  /** The control server's `127.0.0.1:<port>`, once it listens. */
  endpoint: () => string | null;
  /** How long Jev is waited on before its answer counts as not decided. */
  jevTimeoutMs?: number;
}

/** A refusal the lead reads and acts on; retrying the same call cannot help. */
export class ControlRefusal extends Error {
  override name = "ControlRefusal";
}

function refuse(message: string): never {
  throw new ControlRefusal(message);
}

// ─── Records ────────────────────────────────────────────────────────────────

/** What main keeps of a task besides what the page sees. */
interface TaskPrivate {
  worktree: string | null;
  scratch: string | null;
  baseline: string | null;
  /** The text the next dispatch sends: a message, a retry, a recovery. */
  turn: string | null;
  /** The current dispatch's turn has been seen running. */
  seen: boolean;
  lastText: string;
  /** Approvals and questions waiting on the lead, oldest first. */
  inputs: { needs: NeedsInput; logId: string | null }[];
}

interface RunRecord {
  version: 1;
  run: OrchestrationRun;
  /** The main checkout, resolved. */
  folder: string;
  tasks: Record<string, TaskPrivate>;
  /** Applied request ids: the call's signature and its answer. */
  receipts: Record<string, { signature: string; result: unknown }>;
}

const RECEIPTS_MAX = 512;
const ACTIVE = new Set(["running", "cancelling"]);
/** Tools Jev may allow on its own: they read, never write. */
const READ_ONLY = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const privateOf = (): TaskPrivate => ({
  worktree: null,
  scratch: null,
  baseline: null,
  turn: null,
  seen: false,
  lastText: "",
  inputs: [],
});

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The tiers' models when Jev has none set. */
function defaultTiers(lead: ConversationAgent): Record<Tier, TierModel> {
  if (lead === "codex") {
    const model = settingsFor("codex", DEFAULT_SETTINGS).model;
    return {
      light: { agent: "codex", model, effort: "low" },
      standard: { agent: "codex", model, effort: "medium" },
      heavy: { agent: "codex", model, effort: "high" },
    };
  }
  return {
    light: { agent: "claude", model: "claude-haiku-5-5", effort: "low" },
    standard: { agent: "claude", model: "claude-sonnet-5-5", effort: "medium" },
    heavy: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
  };
}

/** One message to a CLI: `text` is sent, its visible part is what shows. */
function outgoing(text: string, settings: ComposerSettings): Outgoing {
  return {
    id: randomUUID(),
    text: visibleText(text),
    attachments: [],
    content: [{ type: "text", text }],
    settings,
  };
}

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

// ─── The engine ─────────────────────────────────────────────────────────────

export class Orchestrator {
  private records = new Map<string, RunRecord>();
  private loading: Promise<void> | null = null;
  /** Token hash → run id. */
  private tokens = new Map<string, string>();
  /** Run id → its live token. */
  private tokenOf = new Map<string, string>();
  private chains = new Map<string, Promise<unknown>>();
  private saves = new Map<string, Promise<void>>();
  private waiters = new Map<string, Set<(taskId: string) => void>>();
  private inflight = new Map<
    string,
    { signature: string; promise: Promise<unknown> }
  >();
  /** Tasks the lead has not been told about, per run. */
  private notes = new Map<string, Set<string>>();
  private noteTimers = new Map<string, NodeJS.Timeout>();
  private briefing = new Set<string>();
  private jev: JevMainHandlers | null = null;

  constructor(private readonly deps: RuntimeDeps) {}

  setJev(handlers: JevMainHandlers | null): void {
    this.jev = handlers;
  }

  // ── Loading and saving ──

  private load(): Promise<void> {
    this.loading ??= this.loadAll();
    return this.loading;
  }

  private async loadAll(): Promise<void> {
    const dir = join(this.deps.dataDir, "runs");
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(
          await readFile(join(dir, name), "utf8"),
        ) as RunRecord;
        if (record.version !== 1 || !record.run?.id) continue;
        this.recover(record);
        this.records.set(record.run.id, record);
      } catch {
        // A file we cannot read is left for a person to look at.
      }
    }
  }

  /** A record read from disk: the app quit under whatever ran. */
  private recover(record: RunRecord): void {
    const { run } = record;
    let changed = false;
    for (const task of run.tasks) {
      const own = record.tasks[task.id] ?? privateOf();
      record.tasks[task.id] = own;
      own.seen = false;
      own.inputs = [];
      own.lastText = "";
      if (task.needsInput) {
        task.needsInput = null;
        changed = true;
      }
      if (task.status === "running") {
        task.status = "interrupted";
        own.turn ??= recoveryTurn("Lanework quit while you worked");
        changed = true;
      } else if (task.status === "cancelling") {
        task.status = "cancelled";
        changed = true;
      }
    }
    if (run.status === "active") {
      run.status = "paused";
      run.reason =
        "Lanework quit while this run was active. Resume continues interrupted workers in their own checkouts.";
      changed = true;
    }
    if (changed) {
      run.updatedAt = Date.now();
      void this.save(record);
    }
  }

  private save(record: RunRecord): Promise<void> {
    const id = record.run.id;
    const previous = this.saves.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const dir = join(this.deps.dataDir, "runs");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const file = join(dir, `${id}.json`);
        const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
        await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
        await rename(temp, file);
      });
    this.saves.set(id, next);
    return next;
  }

  /** Save, tell the page, wake waiters on `taskIds`. */
  private touch(record: RunRecord, taskIds: string[] = []): void {
    record.run.updatedAt = Date.now();
    void this.save(record).catch((error: unknown) =>
      console.error("Unable to save orchestration run", error),
    );
    try {
      this.deps.broadcast({ workspace: record.run.workspace, run: record.run });
    } catch {
      // No window to tell.
    }
    const waiters = this.waiters.get(record.run.id);
    if (waiters)
      for (const taskId of taskIds) for (const wake of waiters) wake(taskId);
  }

  private patch(
    record: RunRecord,
    task: OrchestrationTask,
    patch: Partial<OrchestrationTask>,
  ): void {
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.touch(record, [task.id]);
  }

  /** Run `work` after every earlier one of this run: one change at a time. */
  private serial<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.chains.set(
      runId,
      next.catch(() => {}),
    );
    return next;
  }

  private engines(): OrchestrationEngines {
    const engines = this.deps.engines();
    if (!engines) throw new Error("Conversations are not ready yet.");
    return engines;
  }

  private own(record: RunRecord, task: OrchestrationTask): TaskPrivate {
    record.tasks[task.id] ??= privateOf();
    return record.tasks[task.id] as TaskPrivate;
  }

  // ── Tokens ──

  private mint(record: RunRecord): void {
    if (this.tokenOf.has(record.run.id)) return;
    const token = randomBytes(32).toString("hex");
    this.tokenOf.set(record.run.id, token);
    this.tokens.set(hash(token), record.run.id);
  }

  private revoke(runId: string): void {
    const token = this.tokenOf.get(runId);
    if (token) this.tokens.delete(hash(token));
    this.tokenOf.delete(runId);
  }

  /** The run a token belongs to, or null for a wrong or revoked one. */
  runOfToken(token: string): string | null {
    if (typeof token !== "string" || token.length !== 64) return null;
    return this.tokens.get(hash(token)) ?? null;
  }

  // ── Engine listeners ──

  private workerAt(
    folder: string,
  ): { record: RunRecord; task: OrchestrationTask; own: TaskPrivate } | null {
    for (const record of this.records.values())
      for (const task of record.run.tasks) {
        const own = record.tasks[task.id];
        if (own?.worktree && own.worktree === folder)
          return { record, task, own };
      }
    return null;
  }

  /** A worker's conversation, as the chat should read it: its worktree. */
  workerFolder(workspace: string, conversation: string): string | null {
    for (const record of this.records.values()) {
      if (record.run.workspace !== workspace) continue;
      for (const task of record.run.tasks)
        if (task.conversation === conversation)
          return record.tasks[task.id]?.worktree ?? null;
    }
    return null;
  }

  /** The extra environment one engine process starts with. */
  envFor(target: EngineTarget): Record<string, string> | null {
    const worker = this.workerAt(target.folder);
    if (worker) {
      const scratch = worker.own.scratch;
      return scratch ? { TMPDIR: scratch, TMP: scratch, TEMP: scratch } : null;
    }
    if (!target.conversation) return null;
    const endpoint = this.deps.endpoint();
    if (!endpoint) return null;
    for (const record of this.records.values()) {
      const { run } = record;
      if (
        run.workspace !== target.workspace ||
        run.lead !== target.conversation
      )
        continue;
      if (run.status !== "active" && run.status !== "paused") continue;
      const token = this.tokenOf.get(run.id);
      if (token)
        return {
          [CONTROL_ENV.endpoint]: endpoint,
          [CONTROL_ENV.token]: token,
        };
    }
    return null;
  }

  onEvent(event: ConversationEvent, folder: string): void {
    const worker = this.workerAt(folder);
    if (worker) {
      this.onWorkerEvent(worker.record, worker.task, worker.own, event);
      return;
    }
    if (event.type !== "state" || event.engine.state !== "idle") return;
    for (const record of this.records.values())
      if (
        record.run.workspace === event.workspace &&
        record.run.lead === event.conversation
      )
        this.scheduleNote(record, 300);
  }

  onResult(result: EngineResult): void {
    const worker = this.workerAt(result.folder);
    if (worker) worker.own.lastText = result.text;
  }

  onWrite(write: EngineWrite): void {
    const worker = this.workerAt(write.folder);
    if (worker?.task.status !== "running") return;
    const { record, task, own } = worker;
    void (async () => {
      for (const path of write.paths) {
        if (!own.worktree) return;
        const check = await checkWrite(
          own.worktree,
          own.scratch,
          task.files,
          path,
        );
        if (!check.ok) {
          await this.block(
            record,
            task,
            `Wrote outside its scope: ${check.path}`,
          );
          return;
        }
      }
    })().catch((error: unknown) =>
      console.error("Orchestration write guard failed", error),
    );
  }

  private onWorkerEvent(
    record: RunRecord,
    task: OrchestrationTask,
    own: TaskPrivate,
    event: ConversationEvent,
  ): void {
    if (!task.conversation && "conversation" in event && event.conversation) {
      task.conversation = event.conversation;
      this.touch(record, [task.id]);
    }
    switch (event.type) {
      case "state": {
        const state = event.engine.state;
        if (state === "running" || state === "starting") {
          own.seen = true;
          return;
        }
        if (state !== "idle" && state !== "error") return;
        if (!own.seen) return;
        own.seen = false;
        const error =
          event.engine.state === "error" ? event.engine.message : null;
        void this.serial(record.run.id, () =>
          this.turnEnded(record, task, error),
        ).catch((failure: unknown) =>
          console.error("Orchestration turn end failed", failure),
        );
        return;
      }
      case "permission":
        void this.onPermission(record, task, own, event.request).catch(
          (error: unknown) =>
            console.error("Orchestration permission failed", error),
        );
        return;
      case "permission-done": {
        const before = own.inputs.length;
        own.inputs = own.inputs.filter(
          (entry) => entry.needs.requestId !== event.id,
        );
        if (own.inputs.length !== before)
          this.patch(record, task, {
            needsInput: own.inputs[0]?.needs ?? null,
          });
        return;
      }
    }
  }

  // ── Jev ──

  private async ask(request: JudgeRequest): Promise<JudgeResult | null> {
    const jev = this.jev;
    if (!jev) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        jev.ask(request),
        new Promise<null>((resolve) => {
          timer = setTimeout(
            () => resolve(null),
            this.deps.jevTimeoutMs ?? 20_000,
          );
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private settle(logId: string | null | undefined, outcome: string): void {
    if (!logId || !this.jev) return;
    void this.jev.settle(logId, outcome).catch(() => {});
  }

  private async tiers(
    lead: ConversationAgent,
  ): Promise<Record<Tier, TierModel>> {
    if (this.jev) {
      try {
        const state = await this.jev.get();
        if (state.config.provider) return state.config.tiers;
      } catch {
        // Jev's settings unreadable: the defaults.
      }
    }
    return defaultTiers(lead);
  }

  /**
   * The agent, model and effort a task runs on.
   *
   * A named model must be one of the run's choices. With none named, Jev
   * picks the tier when the run asks it and it decided; otherwise `standard`.
   */
  private async placement(
    record: RunRecord,
    input: {
      title: string;
      prompt: string;
      files: string[];
      agent?: ConversationAgent | null;
      model?: string | null;
      effort?: Effort | null;
    },
  ): Promise<{
    agent: ConversationAgent;
    model: string;
    effort: Effort | null;
    tier: Tier | null;
  }> {
    const { run } = record;
    const choices = run.choices;
    const allowed = () =>
      choices.map((choice) => `${choice.agent}:${choice.model}`).join(", ");
    if (input.model) {
      const choice = choices.find(
        (entry) =>
          entry.model === input.model &&
          (!input.agent || entry.agent === input.agent),
      );
      if (!choice)
        refuse(
          `Model "${input.model}"${input.agent ? ` on ${input.agent}` : ""} is not allowed in this run. Allowed: ${allowed()}`,
        );
      return {
        agent: choice.agent,
        model: choice.model,
        effort: input.effort ?? null,
        tier: null,
      };
    }
    let tier: Tier = "standard";
    if (run.jev) {
      const answer = await this.ask({
        point: "model-tier",
        question:
          "Which model tier does this delegated coding task need? light: small, mechanical, well specified. standard: ordinary feature or fix work. heavy: hard design, subtle bugs, wide changes.",
        options: [...TIERS],
        context: cut(
          `Title: ${input.title}\nFiles: ${input.files.join(", ")}\n\n${input.prompt}`,
          19_000,
        ),
      });
      if (
        answer?.decided &&
        answer.choice &&
        (TIERS as readonly string[]).includes(answer.choice)
      )
        tier = answer.choice as Tier;
      this.settle(answer?.logId, tier);
    }
    const model = (await this.tiers(run.leadAgent))[tier];
    let agent = model.agent;
    let id = model.model;
    if (input.agent && input.agent !== agent) {
      const first = choices.find((entry) => entry.agent === input.agent);
      if (!first)
        refuse(
          `No ${input.agent} model is allowed in this run. Allowed: ${allowed()}`,
        );
      agent = first.agent;
      id = first.model;
    }
    if (!choices.some((entry) => entry.agent === agent && entry.model === id))
      refuse(
        `The ${tier} tier's model "${id}" is not allowed in this run. Name a model from list. Allowed: ${allowed()}`,
      );
    return {
      agent,
      model: id,
      effort: input.effort ?? model.effort ?? null,
      tier,
    };
  }

  // ── Scheduling ──

  /** Whether `other` still holds the files it claims. */
  private holds(other: OrchestrationTask): boolean {
    if (other.accepted) return false;
    return !["queued", "cancelled"].includes(other.status);
  }

  /** Why a queued task has not started; null when it may start now. */
  private waitingFor(
    record: RunRecord,
    task: OrchestrationTask,
  ): string | null {
    if (task.status !== "queued") return null;
    const { run } = record;
    if (run.status !== "active") return `The run is ${run.status}`;
    for (const id of task.dependsOn) {
      const dependency = run.tasks.find((entry) => entry.id === id);
      if (!dependency) return `Depends on an unknown task ${id}`;
      if (dependency.status === "cancelled")
        return `Depends on ${id}, which was cancelled: cancel this task or delegate a new one`;
      if (!dependency.accepted)
        return `Waiting for ${id} "${dependency.title}" to be reviewed (it is ${dependency.status})`;
    }
    const holder = run.tasks.find(
      (other) =>
        other.id !== task.id &&
        this.holds(other) &&
        scopesOverlap(other.files, task.files),
    );
    if (holder)
      return `Waiting for files held by ${holder.id} "${holder.title}" (${holder.status}${holder.status === "completed" ? ", not reviewed" : ""})`;
    const running = run.tasks.filter((entry) =>
      ACTIVE.has(entry.status),
    ).length;
    if (running >= run.maxWorkers)
      return `Waiting for a worker slot (${running}/${run.maxWorkers} busy)`;
    return null;
  }

  private pump(record: RunRecord): void {
    void this.serial(record.run.id, async () => {
      const { run } = record;
      if (run.status !== "active") return;
      for (const task of run.tasks) {
        if (task.status !== "queued") continue;
        if (this.waitingFor(record, task) !== null) continue;
        this.patch(record, task, { status: "running", error: null });
        void this.dispatch(record, task);
      }
    });
  }

  /** Start or continue one worker's turn. */
  private async dispatch(
    record: RunRecord,
    task: OrchestrationTask,
  ): Promise<void> {
    const own = this.own(record, task);
    own.seen = false;
    own.lastText = "";
    try {
      const engines = this.engines();
      if (!own.worktree || !(await exists(own.worktree))) {
        const branch = `lanework/${record.run.id}/${task.id}`;
        const checkout = await createWorktree(
          record.folder,
          join(this.deps.dataDir, "worktrees", record.run.id, task.id),
          branch,
        );
        own.worktree = checkout.path;
        own.baseline = checkout.baseline;
        task.branch = branch;
      }
      if (!own.scratch || !(await exists(own.scratch))) {
        const scratch = await mkdtemp(join(tmpdir(), "lanework-worker-"));
        await chmod(scratch, 0o700);
        own.scratch = await realpath(scratch);
      }
      const settings = checkSettings({
        model: task.model,
        effort: task.effort ?? "medium",
        fast: false,
        permission: "acceptEdits",
      } satisfies ComposerSettings);
      if (!settings)
        throw new Error(
          `Model "${task.model}" is not available here any more. Retry the task on another model.`,
        );
      const text = task.conversation
        ? (own.turn ?? recoveryTurn("the run was interrupted"))
        : own.turn
          ? `${task.prompt}\n\n${own.turn}`
          : task.prompt;
      const out = outgoing(workerTurn(text, task.files, own.scratch), settings);
      own.turn = null;
      this.touch(record, [task.id]);
      let state: EngineState;
      if (task.conversation)
        state = await engines.send(
          record.run.workspace,
          task.conversation,
          own.worktree,
          out,
          task.agent,
        );
      else if (task.agent === "codex") {
        const started = await engines.startCodex(
          record.run.workspace,
          own.worktree,
          out,
        );
        task.conversation = started.conversation;
        state = started.engine;
      } else {
        const id = randomUUID();
        task.conversation = id;
        state = await engines.start(
          record.run.workspace,
          id,
          own.worktree,
          out,
        );
      }
      this.touch(record, [task.id]);
      if (state.state === "terminal")
        throw new Error("A terminal is running this worker's conversation.");
      if (state.state === "running" || state.state === "starting")
        own.seen = true;
    } catch (error) {
      await this.serial(record.run.id, async () => {
        if (task.status !== "running") return;
        this.patch(record, task, {
          status: "failed",
          error: `Could not start the worker: ${messageOf(error)}`,
        });
        this.note(record, task.id);
      });
      this.pump(record);
    }
  }

  /** A worker's turn ended: check its files, then settle it. */
  private async turnEnded(
    record: RunRecord,
    task: OrchestrationTask,
    error: string | null,
  ): Promise<void> {
    const own = this.own(record, task);
    if (task.status === "cancelling") {
      this.patch(record, task, { status: "cancelled", needsInput: null });
      own.inputs = [];
      this.note(record, task.id);
      this.pump(record);
      return;
    }
    if (task.status !== "running") return;
    own.inputs = [];
    const result = own.lastText;
    if (error) {
      this.patch(record, task, {
        status: "failed",
        error,
        result,
        needsInput: null,
      });
    } else {
      const outside = await this.outsideScope(own, task).catch(
        (failure: unknown) => [
          `(could not list its changes: ${messageOf(failure)})`,
        ],
      );
      if (outside.length) {
        this.patch(record, task, {
          status: "blocked",
          result,
          needsInput: null,
          error: `Changed files outside its scope: ${outside.slice(0, 20).join(", ")}. Message it to undo them, retry with corrected files, or cancel it.`,
        });
      } else {
        let status: "completed" | "failed" = "completed";
        let note: string | null = null;
        if (this.jev && result.trim()) {
          const answer = await this.ask({
            point: "report",
            question:
              "Does this worker's final report say the checks it ran passed?",
            options: ["passed", "failed", "unclear"],
            context: cut(`Task: ${task.title}\n\nReport:\n${result}`, 19_000),
          });
          if (answer?.decided && answer.choice === "failed") {
            status = "failed";
            note = `Its report says its checks failed (Jev, p=${answer.p.toFixed(2)}). Message it to fix them, or review it anyway after a look.`;
          }
          this.settle(answer?.logId, status);
        }
        this.patch(record, task, {
          status,
          result,
          error: note,
          needsInput: null,
        });
      }
    }
    this.note(record, task.id);
    this.pump(record);
  }

  /** The files a worker changed outside its scope. */
  private async outsideScope(
    own: TaskPrivate,
    task: OrchestrationTask,
  ): Promise<string[]> {
    if (!own.worktree || !own.baseline) return [];
    const changes = await workerChanges(own.worktree, own.baseline);
    return changes
      .map((change) => change.path)
      .filter((path) => !inScopes(task.files, path));
  }

  /** Stop one worker for a policy: it alone is blocked. */
  private async block(
    record: RunRecord,
    task: OrchestrationTask,
    why: string,
  ): Promise<void> {
    await this.serial(record.run.id, async () => {
      if (task.status !== "running") return;
      const own = this.own(record, task);
      this.patch(record, task, {
        status: "blocked",
        error: `${why}. Message it to stay in scope, retry with corrected files, or cancel it.`,
        needsInput: null,
      });
      this.denyAll(
        record,
        task,
        own,
        "The orchestration run stopped this worker.",
      );
      if (task.conversation)
        await this.engines()
          .stop(record.run.workspace, task.conversation)
          .catch(() => {});
      this.note(record, task.id);
    });
    this.pump(record);
  }

  private denyAll(
    record: RunRecord,
    task: OrchestrationTask,
    own: TaskPrivate,
    message: string,
  ): void {
    const engines = this.deps.engines();
    for (const entry of own.inputs) {
      if (task.conversation)
        try {
          engines?.answer(
            record.run.workspace,
            task.conversation,
            entry.needs.requestId,
            {
              behavior: "deny",
              message,
            },
          );
        } catch {
          // Answered already.
        }
      this.settle(entry.logId, "deny");
    }
    own.inputs = [];
  }

  // ── Permissions ──

  private answerWorker(
    record: RunRecord,
    task: OrchestrationTask,
    id: string,
    answer: PermissionAnswer,
  ): void {
    if (!task.conversation) throw new Error("The worker has no conversation");
    this.engines().answer(record.run.workspace, task.conversation, id, answer);
  }

  private async onPermission(
    record: RunRecord,
    task: OrchestrationTask,
    own: TaskPrivate,
    request: PermissionRequest,
  ): Promise<void> {
    const deny = (message: string) => {
      try {
        this.answerWorker(record, task, request.id, {
          behavior: "deny",
          message,
        });
      } catch {
        // Answered already.
      }
    };
    if (task.status !== "running") {
      deny("The orchestration run stopped this worker.");
      return;
    }
    if (request.questions) {
      this.queueInput(record, task, own, {
        needs: {
          kind: "question",
          requestId: request.id,
          questions: request.questions,
        },
        logId: null,
      });
      return;
    }
    if (EDIT_TOOLS.has(request.tool) && own.worktree) {
      let path: string | null = null;
      try {
        const input = JSON.parse(request.input) as Record<string, unknown>;
        path =
          typeof input.file_path === "string"
            ? input.file_path
            : typeof input.notebook_path === "string"
              ? input.notebook_path
              : null;
      } catch {
        path = null;
      }
      if (path) {
        const check = await checkWrite(
          own.worktree,
          own.scratch,
          task.files,
          path,
        );
        if (check.ok) {
          try {
            this.answerWorker(record, task, request.id, { behavior: "allow" });
          } catch {
            // Answered already.
          }
          return;
        }
        deny(`${check.path} is outside your write scope.`);
        await this.block(
          record,
          task,
          `Tried to write outside its scope: ${check.path}`,
        );
        return;
      }
    }
    const readOnly = READ_ONLY.has(request.tool);
    const answer = await this.ask({
      point: "permission",
      question: readOnly
        ? `A worker asks to use the read-only tool ${request.tool}. Allow it, or ask the lead?`
        : `A worker asks to use ${request.tool}. Is it plainly outside the worker's task, so it should be denied, or should the lead decide?`,
      options: readOnly ? ["allow", "ask the lead"] : ["deny", "ask the lead"],
      context: cut(
        `Task: ${task.title}\nWrite scope: ${task.files.join(", ")}\n\n${task.prompt}\n\nTool: ${request.tool}\n${request.summary}\n${request.input}`,
        19_000,
      ),
    });
    if (task.status !== "running") {
      deny("The orchestration run stopped this worker.");
      this.settle(answer?.logId, "deny");
      return;
    }
    if (
      answer?.decided &&
      (answer.choice === "allow" || answer.choice === "deny")
    ) {
      try {
        this.answerWorker(
          record,
          task,
          request.id,
          answer.choice === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: "This is outside your task." },
        );
        this.settle(answer.logId, answer.choice);
        return;
      } catch {
        // Answered meanwhile (the user, in the chat).
        this.settle(answer.logId, "answered elsewhere");
        return;
      }
    }
    this.queueInput(record, task, own, {
      needs: {
        kind: "permission",
        requestId: request.id,
        tool: request.tool,
        summary: request.summary,
      },
      logId: answer?.logId ?? null,
    });
  }

  private queueInput(
    record: RunRecord,
    task: OrchestrationTask,
    own: TaskPrivate,
    entry: TaskPrivate["inputs"][number],
  ): void {
    own.inputs.push(entry);
    this.patch(record, task, { needsInput: own.inputs[0]?.needs ?? null });
    this.note(record, task.id);
  }

  // ── Telling the lead ──

  private note(record: RunRecord, taskId: string): void {
    let set = this.notes.get(record.run.id);
    if (!set) {
      set = new Set();
      this.notes.set(record.run.id, set);
    }
    set.add(taskId);
    this.scheduleNote(record, 1500);
  }

  private seen(record: RunRecord, taskIds: readonly string[]): void {
    const set = this.notes.get(record.run.id);
    if (set) for (const id of taskIds) set.delete(id);
  }

  private scheduleNote(record: RunRecord, delay: number): void {
    if (!this.notes.get(record.run.id)?.size) return;
    clearTimeout(this.noteTimers.get(record.run.id));
    this.noteTimers.set(
      record.run.id,
      setTimeout(() => {
        this.noteTimers.delete(record.run.id);
        void this.flushNotes(record).catch(() => {});
      }, delay),
    );
  }

  /** Tell an idle lead what changed; a busy one hears at its next idle. */
  private async flushNotes(record: RunRecord): Promise<void> {
    const set = this.notes.get(record.run.id);
    if (!set?.size || record.run.status !== "active") return;
    if (this.briefing.has(record.run.id)) return;
    const engines = this.deps.engines();
    if (!engines) return;
    const { run } = record;
    const state = await engines.state(run.workspace, run.lead);
    if (state.state !== "idle") return;
    const changed = [...set];
    set.clear();
    await engines
      .send(
        run.workspace,
        run.lead,
        await this.leadFolder(record),
        outgoing(
          updateTurn(run, changed, this.deps.cliPath),
          this.leadSettings(record),
        ),
        run.leadAgent,
      )
      .catch((error: unknown) =>
        console.error("Unable to tell the lead about its workers", error),
      );
  }

  /**
   * The lead's folder exactly as the chat names it: the CLI files its
   * transcript under that path, and the engine is keyed on it.
   */
  private async leadFolder(record: RunRecord): Promise<string> {
    return (
      (await this.deps.folderOf(record.run.workspace).catch(() => null)) ??
      record.folder
    );
  }

  private leadSettings(record: RunRecord): ComposerSettings {
    const engines = this.deps.engines();
    const known = engines?.settingsOf(record.run.lead) ?? null;
    return settingsFor(record.run.leadAgent, known ?? DEFAULT_SETTINGS);
  }

  /**
   * Give the lead a fresh process (so its next turn has the control env),
   * then send it `text` as a turn of its own.
   */
  private async brief(record: RunRecord, text: string): Promise<void> {
    const { run } = record;
    this.briefing.add(run.id);
    try {
      const engines = this.engines();
      const deadline = Date.now() + 30 * 60_000;
      for (;;) {
        const state = await engines.state(run.workspace, run.lead);
        if (state.state === "terminal") {
          run.reason =
            "The lead's conversation is open in a terminal, which cannot reach the run. Close it there, then Resume.";
          this.touch(record);
          return;
        }
        if (state.state !== "running" && state.state !== "starting") break;
        if (Date.now() > deadline) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (engines.alive(run.workspace).includes(run.lead))
        await engines.release(run.workspace, run.lead).catch(() => {});
      await engines.send(
        run.workspace,
        run.lead,
        await this.leadFolder(record),
        outgoing(text, this.leadSettings(record)),
        run.leadAgent,
      );
    } finally {
      this.briefing.delete(run.id);
    }
  }

  // ── Views ──

  private view(
    record: RunRecord,
    full: string | null = null,
  ): OrchestrationRun {
    return {
      ...record.run,
      tasks: record.run.tasks.map((task) =>
        this.taskView(record, task, task.id === full),
      ),
    };
  }

  private taskView(
    record: RunRecord,
    task: OrchestrationTask,
    full: boolean,
  ): OrchestrationTask & { waitingFor?: string } {
    const waitingFor = this.waitingFor(record, task);
    return {
      ...task,
      prompt: full ? task.prompt : cut(task.prompt, 600),
      result: full ? task.result : cut(task.result, 2_000),
      ...(waitingFor ? { waitingFor } : {}),
    };
  }

  // ── IPC ──

  async runs(workspace: string): Promise<OrchestrationRun[]> {
    await this.load();
    return [...this.records.values()]
      .filter((record) => record.run.workspace === workspace)
      .map((record) => record.run)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async run(
    workspace: string,
    runId: string,
  ): Promise<OrchestrationRun | null> {
    await this.load();
    const record = this.records.get(runId);
    return record && record.run.workspace === workspace ? record.run : null;
  }

  private async recordIn(workspace: string, runId: string): Promise<RunRecord> {
    await this.load();
    const record = this.records.get(runId);
    if (!record || record.run.workspace !== workspace)
      throw new Error("That run is not in this project.");
    return record;
  }

  async approve(proposal: OrchestrationProposal): Promise<OrchestrationRun> {
    await this.load();
    const existing = this.records.get(proposal.id);
    if (existing) {
      if (existing.run.workspace !== proposal.workspace)
        throw new Error("That proposal belongs to another project.");
      return existing.run;
    }
    const open = [...this.records.values()].find(
      (record) =>
        record.run.workspace === proposal.workspace &&
        (record.run.status === "active" || record.run.status === "paused"),
    );
    if (open)
      throw new Error(
        `Run "${open.run.id}" is still ${open.run.status} in this project. Stop or finish it first.`,
      );
    const folder = await this.deps.folderOf(proposal.workspace);
    if (!folder) throw new Error("This project has no folder here.");
    const top = await checkoutTop(folder);
    const choices: WorkerChoice[] = allModels()
      .filter((model) => !model.legacy)
      .map((model) => ({
        agent: model.agent,
        model: model.id,
        label: model.label,
      }));
    let jev = false;
    if (this.jev)
      jev = await this.jev
        .get()
        .then((state) => state.config.provider !== null)
        .catch(() => false);
    const now = Date.now();
    const run: OrchestrationRun = {
      id: proposal.id,
      workspace: proposal.workspace,
      lead: proposal.lead,
      leadAgent: proposal.leadAgent,
      status: "active",
      reason: null,
      maxWorkers: proposal.maxWorkers,
      choices,
      jev,
      tasks: [],
      createdAt: now,
      updatedAt: now,
    };
    const record: RunRecord = {
      version: 1,
      run,
      folder: top,
      tasks: {},
      receipts: {},
    };
    for (const proposed of proposal.tasks)
      run.tasks.push(await this.taskFrom(record, proposed, now));
    this.records.set(run.id, record);
    this.mint(record);
    await this.save(record);
    this.touch(record);
    void this.brief(record, approvedTurn(run, this.deps.cliPath)).catch(
      (error: unknown) => console.error("Unable to brief the lead", error),
    );
    this.pump(record);
    return run;
  }

  private async taskFrom(
    record: RunRecord,
    proposed: ProposedTask,
    now: number,
  ): Promise<OrchestrationTask> {
    const placed = await this.placement(record, proposed).catch(
      (error: unknown) => {
        throw new Error(`Task ${proposed.id}: ${messageOf(error)}`);
      },
    );
    record.tasks[proposed.id] = privateOf();
    return {
      id: proposed.id,
      title: proposed.title,
      ...placed,
      prompt: proposed.prompt,
      files: proposed.files,
      dependsOn: proposed.dependsOn,
      status: "queued",
      accepted: false,
      result: "",
      error: null,
      needsInput: null,
      conversation: null,
      branch: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async pause(workspace: string, runId: string): Promise<OrchestrationRun> {
    const record = await this.recordIn(workspace, runId);
    return this.serial(runId, async () => {
      const { run } = record;
      if (run.status !== "active") return run;
      run.status = "paused";
      run.reason =
        "Paused by the user. Resume continues interrupted workers in their own checkouts.";
      await this.stopWorkers(record, "interrupted", "the user paused the run");
      await this.deps
        .engines()
        ?.stop(run.workspace, run.lead)
        .catch(() => {});
      this.touch(
        record,
        run.tasks.map((task) => task.id),
      );
      return run;
    });
  }

  async resume(workspace: string, runId: string): Promise<OrchestrationRun> {
    const record = await this.recordIn(workspace, runId);
    const run = await this.serial(runId, async () => {
      const { run } = record;
      if (run.status !== "paused") return run;
      if (run.tasks.some((task) => ACTIVE.has(task.status)))
        throw new Error("Workers are still stopping; try again in a moment.");
      run.status = "active";
      run.reason = null;
      for (const task of run.tasks)
        if (task.status === "interrupted") {
          const own = this.own(record, task);
          own.turn ??= recoveryTurn("the run was paused");
          Object.assign(task, {
            status: "queued",
            error: null,
            updatedAt: Date.now(),
          });
        }
      this.mint(record);
      this.touch(
        record,
        run.tasks.map((task) => task.id),
      );
      return run;
    });
    void this.brief(record, resumedTurn(run, this.deps.cliPath)).catch(
      () => {},
    );
    this.pump(record);
    return run;
  }

  async stop(workspace: string, runId: string): Promise<OrchestrationRun> {
    const record = await this.recordIn(workspace, runId);
    return this.serial(runId, async () => {
      const { run } = record;
      if (run.status === "stopped" || run.status === "finished") return run;
      run.status = "stopped";
      run.reason = "Stopped by the user.";
      this.revoke(run.id);
      await this.stopWorkers(record, "cancelled", null);
      for (const task of run.tasks)
        if (task.status === "queued")
          Object.assign(task, { status: "cancelled", updatedAt: Date.now() });
      await this.deps
        .engines()
        ?.stop(run.workspace, run.lead)
        .catch(() => {});
      await this.cleanup(record, false);
      this.touch(
        record,
        run.tasks.map((task) => task.id),
      );
      return run;
    });
  }

  async cancelTask(
    workspace: string,
    runId: string,
    taskId: string,
  ): Promise<OrchestrationRun> {
    const record = await this.recordIn(workspace, runId);
    await this.serial(runId, () =>
      this.cancel(record, this.task(record, taskId)),
    );
    this.pump(record);
    return record.run;
  }

  /** Stop every running worker, leaving each `status`. */
  private async stopWorkers(
    record: RunRecord,
    status: "interrupted" | "cancelled",
    reason: string | null,
  ): Promise<void> {
    const engines = this.deps.engines();
    for (const task of record.run.tasks) {
      if (!ACTIVE.has(task.status)) continue;
      const own = this.own(record, task);
      this.denyAll(
        record,
        task,
        own,
        "The orchestration run stopped this worker.",
      );
      const next = task.status === "cancelling" ? "cancelled" : status;
      Object.assign(task, {
        status: next,
        needsInput: null,
        updatedAt: Date.now(),
      });
      if (next === "interrupted" && reason) own.turn = recoveryTurn(reason);
      if (task.conversation)
        await engines
          ?.stop(record.run.workspace, task.conversation)
          .catch(() => {});
    }
  }

  /**
   * Remove worktrees and scratch folders.
   *
   * @param all Every one. Otherwise a worktree whose work was neither
   *   accepted nor empty is kept, with its branch, for a person to look at.
   */
  private async cleanup(record: RunRecord, all: boolean): Promise<void> {
    const engines = this.deps.engines();
    for (const task of record.run.tasks) {
      const own = this.own(record, task);
      if (task.conversation)
        await engines
          ?.close(record.run.workspace, task.conversation)
          .catch(() => {});
      if (own.scratch) {
        await rm(own.scratch, { recursive: true, force: true }).catch(() => {});
        own.scratch = null;
      }
      if (!own.worktree) continue;
      let keep = false;
      if (!all && !task.accepted && own.baseline)
        keep = await workerChanges(own.worktree, own.baseline)
          .then((changes) => changes.length > 0)
          .catch(() => true);
      if (keep) continue;
      await removeWorktree(record.folder, own.worktree, task.branch).catch(
        () => {},
      );
      own.worktree = null;
    }
  }

  // ── Control ──

  private task(record: RunRecord, taskId: string): OrchestrationTask {
    const task = record.run.tasks.find((entry) => entry.id === taskId);
    if (!task)
      refuse(
        `Task "${taskId}" is not in this run. Use a taskId from list or delegate.`,
      );
    return task;
  }

  /**
   * One authenticated control call.
   *
   * @throws {ControlRefusal} When the lead is not in a turn, the run does not
   *   take the call now, or the call makes no sense for the task.
   */
  async control(
    runId: string,
    call: ControlCall,
    requestId: string,
  ): Promise<unknown> {
    await this.load();
    const record = this.records.get(runId);
    if (!record) refuse("Connection revoked or unauthorized");
    const { run } = record;
    if (!this.tokenOf.has(run.id)) refuse("Connection revoked or unauthorized");
    const engines = this.engines();
    const lead = await engines.state(run.workspace, run.lead);
    if (lead.state !== "running" && lead.state !== "starting")
      refuse(
        "The control CLI only works while the lead's turn runs. Retrying outside a turn will not help.",
      );
    if (call.action === "list") {
      this.seen(
        record,
        run.tasks.map((task) => task.id),
      );
      return { run: this.view(record) };
    }
    if (call.action === "get") {
      const task = this.task(record, call.input.taskId);
      this.seen(record, [task.id]);
      return { task: this.taskView(record, task, true) };
    }
    if (call.action === "wait") return this.wait(record, call.input);
    if (run.status !== "active")
      refuse(
        run.status === "paused"
          ? `This run is paused: ${run.reason ?? "ask the user to Resume it"}. list, get and wait still work; ask the user to click Resume rather than retrying.`
          : `This run is ${run.status}. list and get still work; do not retry.`,
      );
    const signature = JSON.stringify(call);
    const receipt = record.receipts[requestId];
    if (receipt) {
      if (receipt.signature !== signature)
        refuse(
          "This requestId was already used with a different call. Use a new one.",
        );
      return receipt.result;
    }
    const key = `${run.id}\0${requestId}`;
    const pending = this.inflight.get(key);
    if (pending) {
      if (pending.signature !== signature)
        refuse(
          "This requestId was already used with a different call. Use a new one.",
        );
      return pending.promise;
    }
    const promise = this.serial(run.id, async () => {
      const result = await this.execute(record, call);
      record.receipts[requestId] = { signature, result };
      const ids = Object.keys(record.receipts);
      for (const old of ids.slice(0, Math.max(0, ids.length - RECEIPTS_MAX)))
        delete record.receipts[old];
      await this.save(record);
      return result;
    });
    this.inflight.set(key, { signature, promise });
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
      this.pump(record);
    }
  }

  private wait(
    record: RunRecord,
    input: ControlInputs["wait"],
  ): Promise<{ run: OrchestrationRun; changed: string[] }> {
    const { run } = record;
    const live = run.tasks.some(
      (task) => task.status === "queued" || ACTIVE.has(task.status),
    );
    if (!live) return Promise.resolve({ run: this.view(record), changed: [] });
    const ms = Math.round((input.timeoutSeconds ?? WAIT_MAX_SECONDS) * 1000);
    return new Promise((resolve) => {
      const changed = new Set<string>();
      let settle: NodeJS.Timeout | undefined;
      let waiters = this.waiters.get(run.id);
      if (!waiters) {
        waiters = new Set();
        this.waiters.set(run.id, waiters);
      }
      const done = () => {
        clearTimeout(timer);
        clearTimeout(settle);
        waiters?.delete(wake);
        const ids = [...changed];
        this.seen(record, ids);
        resolve({ run: this.view(record), changed: ids });
      };
      const wake = (taskId: string) => {
        changed.add(taskId);
        clearTimeout(settle);
        settle = setTimeout(done, 150);
      };
      const timer = setTimeout(done, ms);
      waiters.add(wake);
    });
  }

  private async execute(
    record: RunRecord,
    call: ControlCall,
  ): Promise<unknown> {
    const { run } = record;
    switch (call.action) {
      case "delegate":
        return this.delegate(record, call.input);
      case "respond": {
        const task = this.task(record, call.input.taskId);
        const own = this.own(record, task);
        const entry = own.inputs[0];
        if (entry?.needs.kind !== "permission")
          refuse(
            `${task.id} is not waiting on an approval. Read needsInput from get or wait.`,
          );
        if (entry.needs.requestId !== call.input.requestId)
          refuse(
            `Stale requestId: ${task.id} waits on ${entry.needs.requestId}.`,
          );
        try {
          this.answerWorker(
            record,
            task,
            entry.needs.requestId,
            call.input.decision === "allow"
              ? { behavior: "allow" }
              : { behavior: "deny", message: "The lead denied this." },
          );
        } catch {
          refuse("That request was already answered.");
        }
        this.settle(entry.logId, call.input.decision);
        own.inputs.shift();
        this.patch(record, task, { needsInput: own.inputs[0]?.needs ?? null });
        return { task: this.taskView(record, task, false) };
      }
      case "answer": {
        const task = this.task(record, call.input.taskId);
        const own = this.own(record, task);
        const entry = own.inputs[0];
        if (entry?.needs.kind !== "question")
          refuse(
            `${task.id} is not waiting on a question. Read needsInput from get or wait.`,
          );
        if (entry.needs.requestId !== call.input.requestId)
          refuse(
            `Stale requestId: ${task.id} waits on ${entry.needs.requestId}.`,
          );
        try {
          this.answerWorker(
            record,
            task,
            entry.needs.requestId,
            call.input.skip
              ? {
                  behavior: "deny",
                  message:
                    "The lead skipped this question. Go on with your best judgment and say what you assumed.",
                }
              : { behavior: "allow", answers: call.input.answers },
          );
        } catch {
          refuse("That question was already answered.");
        }
        own.inputs.shift();
        this.patch(record, task, { needsInput: own.inputs[0]?.needs ?? null });
        return { task: this.taskView(record, task, false) };
      }
      case "steer": {
        const task = this.task(record, call.input.taskId);
        const own = this.own(record, task);
        if (task.status !== "running" || !task.conversation || !own.worktree)
          refuse(
            `Only a running worker can be steered; ${task.id} is ${task.status}. ${task.status === "queued" ? "It has not started." : "Use message for a stopped one."}`,
          );
        const settings = checkSettings({
          model: task.model,
          effort: task.effort ?? "medium",
          fast: false,
          permission: "acceptEdits",
        });
        if (!settings) refuse("The worker's model is not available any more.");
        await this.engines().send(
          run.workspace,
          task.conversation,
          own.worktree,
          outgoing(call.input.text, settings),
          task.agent,
        );
        return { task: this.taskView(record, task, false) };
      }
      case "message":
      case "retry": {
        const task = this.task(record, call.input.taskId);
        if (task.accepted)
          refuse(
            `${task.id} was already reviewed and merged. Delegate a new task for more work.`,
          );
        if (
          !["completed", "failed", "blocked", "interrupted"].includes(
            task.status,
          )
        )
          refuse(
            `${task.id} is ${task.status}. ${task.status === "running" ? "Use steer, or wait for it to stop." : "Only a stopped worker takes another turn."}`,
          );
        const started = run.tasks.find(
          (other) =>
            other.dependsOn.includes(task.id) &&
            other.status !== "queued" &&
            other.status !== "cancelled",
        );
        if (started)
          refuse(
            `${started.id} depends on ${task.id} and already started; delegate a separate fix instead.`,
          );
        const own = this.own(record, task);
        own.turn = call.input.text;
        this.patch(record, task, {
          status: "queued",
          error: null,
          result: "",
          needsInput: null,
          ...(call.action === "retry" ? { files: call.input.files } : {}),
        });
        return { task: this.taskView(record, task, false) };
      }
      case "cancel": {
        const task = this.task(record, call.input.taskId);
        await this.cancel(record, task);
        return { task: this.taskView(record, task, false) };
      }
      case "review":
        return this.review(record, this.task(record, call.input.taskId));
      case "finish": {
        const open = run.tasks.filter(
          (task) => !task.accepted && task.status !== "cancelled",
        );
        if (open.length)
          refuse(
            `Review or cancel every task first. Still open: ${open.map((task) => `${task.id} (${task.status})`).join(", ")}`,
          );
        run.status = "finished";
        run.reason = null;
        this.revoke(run.id);
        await this.cleanup(record, true);
        this.touch(
          record,
          run.tasks.map((task) => task.id),
        );
        return { run: this.view(record) };
      }
    }
    throw new ControlInputError(
      `Unknown action ${(call as { action: string }).action}`,
    );
  }

  private async delegate(
    record: RunRecord,
    input: DelegateInput,
  ): Promise<unknown> {
    const { run } = record;
    if (run.tasks.length >= TASKS_MAX)
      refuse(`This run already has ${TASKS_MAX} tasks, its limit.`);
    for (const id of input.dependsOn ?? []) {
      const dependency = run.tasks.find((task) => task.id === id);
      if (!dependency) refuse(`dependsOn names an unknown task "${id}".`);
      if (dependency.status === "cancelled")
        refuse(`dependsOn names "${id}", which was cancelled.`);
    }
    const placed = await this.placement(record, input);
    let n = run.tasks.length + 1;
    while (run.tasks.some((task) => task.id === `t${n}`)) n++;
    const now = Date.now();
    const task: OrchestrationTask = {
      id: `t${n}`,
      title: input.title,
      ...placed,
      prompt: input.prompt,
      files: input.files,
      dependsOn: input.dependsOn ?? [],
      status: "queued",
      accepted: false,
      result: "",
      error: null,
      needsInput: null,
      conversation: null,
      branch: null,
      createdAt: now,
      updatedAt: now,
    };
    record.tasks[task.id] = privateOf();
    run.tasks.push(task);
    this.touch(record, [task.id]);
    return { taskId: task.id, task: this.taskView(record, task, false) };
  }

  private async cancel(
    record: RunRecord,
    task: OrchestrationTask,
  ): Promise<void> {
    if (task.accepted) refuse(`${task.id} was already reviewed and merged.`);
    if (task.status === "cancelled" || task.status === "cancelling") return;
    const own = this.own(record, task);
    this.denyAll(record, task, own, "The lead cancelled this task.");
    if (task.status !== "running") {
      this.patch(record, task, { status: "cancelled", needsInput: null });
      this.note(record, task.id);
      return;
    }
    this.patch(record, task, { status: "cancelling", needsInput: null });
    if (task.conversation)
      await this.engines()
        .stop(record.run.workspace, task.conversation)
        .catch(() => {});
    // A worker that never says it stopped is cancelled anyway.
    setTimeout(() => {
      void this.serial(record.run.id, async () => {
        if (task.status !== "cancelling") return;
        this.patch(record, task, { status: "cancelled" });
        this.note(record, task.id);
      }).then(() => this.pump(record));
    }, 10_000);
  }

  private async review(
    record: RunRecord,
    task: OrchestrationTask,
  ): Promise<unknown> {
    if (task.accepted) return { task: this.taskView(record, task, false) };
    if (task.status !== "completed")
      refuse(
        `Only a completed task can be reviewed; ${task.id} is ${task.status}. ${["failed", "blocked", "interrupted"].includes(task.status) ? "message it, retry it with corrected files, or cancel it." : "Wait for it, or cancel it."}`,
      );
    const own = this.own(record, task);
    if (!own.worktree || !own.baseline || !(await exists(own.worktree)))
      refuse(
        `${task.id}'s checkout is gone; its work cannot be merged. Retry or cancel it.`,
      );
    const changes = await workerChanges(own.worktree, own.baseline);
    const outside = changes.filter(
      (change) => !inScopes(task.files, change.path),
    );
    if (outside.length) {
      this.patch(record, task, {
        status: "blocked",
        error: `Changed files outside its scope: ${outside
          .slice(0, 20)
          .map((change) => change.path)
          .join(
            ", ",
          )}. Message it to undo them, retry with corrected files, or cancel it.`,
      });
      return { task: this.taskView(record, task, false) };
    }
    const merged = await mergeWorker(
      record.folder,
      own.worktree,
      own.baseline,
      changes,
    );
    if (merged.conflicts.length) {
      this.patch(record, task, {
        status: "blocked",
        error: `Could not merge into the checkout, nothing was written: ${merged.conflicts
          .slice(0, 20)
          .map((conflict) => `${conflict.path} (${conflict.reason})`)
          .join("; ")}. Retry it on the current files, or cancel it.`,
      });
      return { task: this.taskView(record, task, false) };
    }
    this.patch(record, task, { accepted: true, error: null });
    return { task: this.taskView(record, task, false), merged: merged.applied };
  }
}
