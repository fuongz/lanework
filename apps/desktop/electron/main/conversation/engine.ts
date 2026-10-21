// The composer's engine (FE-62/D1): one long-lived, headless `claude` per
// conversation sent from chat, spoken to over stream-json.
//
// - Each turn is one stdin line; text deltas, permission prompts and the
//   turn's lines come back on stdout, and a `result` line ends the turn.
// - Permission prompts are the CLI's `control_request` / `can_use_tool`,
//   answered on stdin; Stop is a host `interrupt` control request.
// - A send while a turn runs is written at once (FE-67): the CLI takes it
//   in at the turn's next tool result, or runs it as a turn of its own after
//   the `result`. Its replay (`isReplay`) says it was taken in. One it cannot
//   take yet waits in `held` (`./queue`).
// - Only one process writes a conversation at a time: a live pty running
//   Claude on it wins, and the composer waits (`terminal`).
//
// ⚠️ Nothing the page typed becomes an argument: settings are checked again
// against the fixed lists (`checkSettings`) and the id is a UUID. Nothing
// here imports Electron, so a Node script can drive it against a real CLI.
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type AskQuestion,
  type ComposerSettings,
  type ConversationEvent,
  checkSettings,
  type EngineState,
  isPermission,
  type Permission,
  type PermissionAnswer,
  type PermissionRequest,
  type Turn,
} from "../../../shared/conversation";
import { isAgentSessionId } from "../../../shared/terminal";
import type { ClaudeCli } from "./claude-cli";
import { CodexEngine } from "./codex-engine";
import { Held, type Outgoing, sameSettings } from "./queue";
import { buildTurns, inputText, type Line } from "./transcript";

interface EngineDeps {
  cli: () => Promise<ClaudeCli>;
  /** The `codex` binary, for a Codex conversation. */
  codexCli?: () => Promise<ClaudeCli>;
  emit: (event: ConversationEvent) => void;
  /** The id of a live pty running Claude on this conversation, or null. */
  terminalOn: (
    workspace: string,
    conversation: string,
    ours: ReadonlySet<number>,
  ) => Promise<string | null>;
  /** Stop that pty through the terminal's own kill path. */
  killTerminal: (terminalId: string) => Promise<void>;
  /** The settings a turn was sent with, remembered for the next read. */
  remember: (conversation: string, settings: ComposerSettings) => void;
  spawn?: typeof spawnChild;
  /** How long a control request is waited on. */
  controlTimeoutMs?: number;
}

/**
 * The CLI's arguments for `settings` — every value from a fixed list. A
 * `fresh` conversation has no transcript yet: the CLI starts it under `id`
 * (`--session-id`) instead of resuming it.
 */
function engineArgs(
  id: string,
  value: ComposerSettings,
  fresh = false,
): string[] {
  const settings = checkSettings(value);
  if (!settings || !isAgentSessionId(id)) throw new Error("Unknown settings");
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    fresh ? "--session-id" : "--resume",
    id,
    "--model",
    settings.model,
    "--effort",
    settings.effort,
    "--permission-mode",
    settings.permission,
    "--permission-prompt-tool",
    "stdio",
  ];
  // ⚠️ `fastMode` is the CLI's own settings key (its init line reports
  // `fast_mode_state`); an account or model without fast mode ignores it.
  if (settings.fast)
    args.push("--settings", JSON.stringify({ fastMode: true }));
  return args;
}

/** `AskUserQuestion`'s questions, or null when its input is not that shape. */
function askQuestions(input: unknown): AskQuestion[] | null {
  const list = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list) || list.length === 0) return null;
  const text = (value: unknown, max: number) =>
    typeof value === "string" ? value.slice(0, max) : "";
  const questions = list.slice(0, 8).map((entry) => {
    const q = (entry ?? {}) as Record<string, unknown>;
    return {
      question: text(q.question, 1000),
      header: text(q.header, 100),
      options: (Array.isArray(q.options) ? q.options : [])
        .slice(0, 12)
        .map((option) => {
          const o = (option ?? {}) as Record<string, unknown>;
          return {
            label: text(o.label, 200),
            description: text(o.description, 500),
          };
        })
        .filter((option) => option.label),
      multiSelect: q.multiSelect === true,
    };
  });
  return questions.every((q) => q.question) ? questions : null;
}

/** The CLI calls the composer's "Supervised" mode `default` in its status. */
function permissionOf(mode: unknown): Permission | null {
  if (mode === "default") return "manual";
  return isPermission(mode) ? mode : null;
}

interface Control {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class Engine {
  child: ChildProcess | null = null;
  /** What the process was started with, as changed since by control requests. */
  applied: ComposerSettings | null = null;
  busy = false;
  starting = false;
  stopping = false;
  /** A restart in `deliver`: its exit is not news. */
  quiet = false;
  error: string | null = null;
  /** What waits to be written (FE-67). */
  held = new Held();
  /**
   * Written to the CLI and not taken in yet — no replay back. While any are,
   * a `result` does not end the work: the CLI runs them next.
   */
  inflight: Outgoing[] = [];
  /** The running turn's own message is written: others may steer it now. */
  posted = false;
  /**
   * Stopped with messages written and not taken in: the process ends on the
   * interrupt's `result`, before it runs them, and they wait again.
   */
  reclaim = false;
  permissions = new Map<string, PermissionRequest>();
  inputs = new Map<string, unknown>();
  controls = new Map<string, Control>();
  /** The running turn's lines, for `turn` events. */
  rows: Line[] = [];
  stderr = "";
  buffer = "";
  /** Resolves when the current child exits. */
  exited: Promise<void> = Promise.resolve();

  constructor(
    readonly workspace: string,
    readonly conversation: string,
    readonly folder: string,
    readonly deps: EngineDeps,
    /**
     * Started from the new-conversation page: no transcript until the CLI
     * writes its first line, so the first process names the id instead of
     * resuming it. Cleared once a line of the conversation comes back.
     */
    public fresh = false,
  ) {}

  state(): EngineState {
    const held = this.held.state();
    if (this.error && !this.busy)
      return { state: "error", message: this.error, ...held };
    if (this.busy && this.starting) return { state: "starting", ...held };
    if (this.busy) return { state: "running", ...held };
    return { state: "idle", ...held };
  }

  /** The running turn so far, for a read before the transcript exists. */
  turns(): Turn[] {
    const turns = buildTurns(this.rows, this.folder);
    const last = turns.at(-1);
    if (last?.role === "assistant" && this.busy) {
      last.open = true;
      last.endedAt = null;
    }
    return turns;
  }

  emit(event: Record<string, unknown> & { type: ConversationEvent["type"] }) {
    this.deps.emit({
      ...event,
      workspace: this.workspace,
      conversation: this.conversation,
    } as ConversationEvent);
  }

  /** The last state told, so a repeat is not news. */
  told = "";

  emitState() {
    const engine = this.state();
    const said = JSON.stringify(engine);
    if (said === this.told) return;
    this.told = said;
    this.emit({ type: "state", engine });
  }

  write(message: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable)
      throw new Error("Claude is not running.");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  control(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `lanework-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        reject(new Error("Claude did not answer."));
      }, this.deps.controlTimeoutMs ?? 10_000);
      this.controls.set(id, { resolve, reject, timer });
      try {
        this.write({ type: "control_request", request_id: id, request });
      } catch (error) {
        clearTimeout(timer);
        this.controls.delete(id);
        reject(error as Error);
      }
    });
  }

  async start(settings: ComposerSettings): Promise<void> {
    const cli = await this.deps.cli();
    const spawn = this.deps.spawn ?? spawnChild;
    const child = spawn(
      cli.file,
      engineArgs(this.conversation, settings, this.fresh),
      {
        cwd: this.folder,
        env: cli.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.applied = settings;
    this.starting = true;
    this.stopping = false;
    this.error = null;
    this.buffer = "";
    this.stderr = "";
    let done: () => void = () => {};
    this.exited = new Promise((resolve) => {
      done = resolve;
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.read(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4096);
    });
    child.stdin?.on("error", () => {
      // A broken pipe shows as the exit below.
    });
    const exit = (code: number | null, signal: string | null) => {
      if (this.child !== child) return done();
      this.child = null;
      this.applied = null;
      this.starting = false;
      for (const control of this.controls.values()) {
        clearTimeout(control.timer);
        control.reject(new Error("Claude stopped."));
      }
      this.controls.clear();
      this.dropPermissions();
      if (this.busy && !this.stopping) {
        const said = this.stderr.trim().split("\n").filter(Boolean).at(-1);
        this.error =
          said?.slice(0, 300) ||
          `Claude stopped (${signal ?? `exit ${code ?? "?"}`}).`;
        this.held.paused = this.held.length > 0;
      }
      // Never taken in: they wait again, not lost.
      this.held.restore(this.inflight);
      this.inflight = [];
      this.reclaim = false;
      this.posted = false;
      this.busy = false;
      this.rows = [];
      if (!this.quiet) this.emitState();
      done();
    };
    child.once("exit", exit);
    child.once("error", (error) => {
      this.error = error.message;
      exit(null, null);
    });
  }

  read(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) break;
      const text = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (!text.trim()) continue;
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }
      try {
        this.handle(line);
      } catch {
        // One odd line never stops the stream.
      }
    }
    // A runaway line without a newline is not ours.
    if (this.buffer.length > 64 * 1024 * 1024) this.buffer = "";
  }

  handle(line: Record<string, unknown>): void {
    switch (line.type) {
      case "system": {
        if (line.subtype === "init") {
          this.starting = false;
          if (this.busy) this.emitState();
        }
        const mode = permissionOf(line.permissionMode);
        if (mode && this.applied)
          this.applied = { ...this.applied, permission: mode };
        return;
      }
      case "stream_event": {
        const event = (line.event ?? {}) as Record<string, unknown>;
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        if (
          event.type === "content_block_delta" &&
          delta.type === "text_delta" &&
          typeof delta.text === "string" &&
          !line.parent_tool_use_id
        )
          this.emit({ type: "delta", text: delta.text });
        return;
      }
      case "control_request":
        this.onControlRequest(line);
        return;
      case "control_response": {
        const response = (line.response ?? {}) as Record<string, unknown>;
        const id = response.request_id;
        const control =
          typeof id === "string" ? this.controls.get(id) : undefined;
        if (!control || typeof id !== "string") return;
        this.controls.delete(id);
        clearTimeout(control.timer);
        if (response.subtype === "success")
          control.resolve((response.response ?? {}) as Record<string, unknown>);
        else
          control.reject(
            new Error(
              typeof response.error === "string" ? response.error : "Refused",
            ),
          );
        return;
      }
      case "user":
      case "assistant": {
        if (line.parent_tool_use_id) return;
        // A message written to the CLI, taken in.
        if (line.isReplay === true) this.inflight.shift();
        this.starting = false;
        // The CLI wrote the conversation down: a restart resumes it now.
        this.fresh = false;
        const row: Line = { ...line };
        if (typeof row.timestamp !== "string")
          row.timestamp = new Date().toISOString();
        this.rows.push(row);
        const turns: Turn[] = buildTurns(this.rows, this.folder);
        const last = turns.at(-1);
        if (!last) return;
        if (last.role === "assistant") {
          // A thinking-only line has nothing to draw yet.
          if (last.blocks.length === 0) return;
          last.open = true;
          last.endedAt = null;
        }
        this.emit({ type: "turn", turn: last });
        return;
      }
      case "result":
        this.onResult();
        return;
    }
  }

  onControlRequest(line: Record<string, unknown>): void {
    const id = line.request_id;
    const request = (line.request ?? {}) as Record<string, unknown>;
    if (typeof id !== "string") return;
    if (request.subtype !== "can_use_tool") {
      // Nothing else is ours to answer; say so rather than leave it hanging.
      this.write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: id,
          error: `${String(request.subtype)} is not supported here`,
        },
      });
      return;
    }
    const tool =
      typeof request.tool_name === "string" ? request.tool_name : "tool";
    const suggestions = Array.isArray(request.permission_suggestions)
      ? (request.permission_suggestions as Record<string, unknown>[])
      : [];
    const suggestMode =
      suggestions
        .filter((entry) => entry?.type === "setMode")
        .map((entry) => permissionOf(entry.mode))
        .find(
          (mode): mode is Permission => mode !== null && mode !== "manual",
        ) ?? null;
    const input = inputText(request.input);
    const firstLine =
      typeof request.description === "string" && request.description.trim()
        ? request.description.trim()
        : (input
            .split("\n")
            .find((part) => part.trim() && part.trim() !== "{") ?? tool);
    const permission: PermissionRequest = {
      id,
      tool,
      summary: firstLine.trim().slice(0, 300),
      input,
      suggestMode,
      questions:
        tool === "AskUserQuestion" ? askQuestions(request.input) : null,
    };
    this.permissions.set(id, permission);
    this.inputs.set(id, request.input ?? {});
    this.emit({ type: "permission", request: permission });
  }

  answer(id: string, answer: PermissionAnswer): void {
    if (!this.permissions.has(id))
      throw new Error("That request was already answered.");
    const input = this.inputs.get(id);
    const response =
      answer.behavior === "allow"
        ? {
            behavior: "allow",
            // ⚠️ AskUserQuestion reads its answers off its own input.
            updatedInput: answer.answers
              ? { ...((input ?? {}) as object), answers: answer.answers }
              : (input ?? {}),
            ...(answer.mode
              ? {
                  updatedPermissions: [
                    {
                      type: "setMode",
                      mode: answer.mode,
                      destination: "session",
                    },
                  ],
                }
              : {}),
          }
        : {
            behavior: "deny",
            message: answer.message?.trim() || "The user denied this.",
          };
    this.write({
      type: "control_response",
      response: { subtype: "success", request_id: id, response },
    });
    this.permissions.delete(id);
    this.inputs.delete(id);
    if (answer.behavior === "allow" && answer.mode && this.applied) {
      this.applied = { ...this.applied, permission: answer.mode };
      this.deps.remember(this.conversation, this.applied);
    }
    this.emit({ type: "permission-done", id });
  }

  dropPermissions(): void {
    for (const id of this.permissions.keys())
      this.emit({ type: "permission-done", id });
    this.permissions.clear();
    this.inputs.clear();
  }

  onResult(): void {
    this.rows = [];
    this.dropPermissions();
    if (this.reclaim && this.inflight.length) {
      // Stopped: what the CLI would run next waits again instead.
      this.reclaim = false;
      this.held.restore(this.inflight);
      this.inflight = [];
      this.busy = false;
      this.starting = false;
      this.posted = false;
      void this.halt();
      this.emitState();
      return;
    }
    if (this.inflight.length) {
      // Written while text streamed: the CLI runs it as the next turn.
      this.emitState();
      return;
    }
    this.busy = false;
    this.starting = false;
    this.stopping = false;
    this.reclaim = false;
    this.posted = false;
    this.emitState();
    this.pump();
  }

  /** Send `out` — into the running turn, or as a turn — or hold it. */
  async accept(out: Outgoing): Promise<void> {
    if (!this.busy && !this.held.length) {
      await this.deliver(out);
      return;
    }
    // A new message picks a paused queue back up (D5).
    this.held.paused = false;
    this.held.items.push(out);
    this.pump();
    this.emitState();
  }

  /** What is held goes, in order, for as long as the CLI can take it. */
  pump(): void {
    while (!this.held.paused && this.held.length) {
      const head = this.held.items[0] as Outgoing;
      if (!this.busy) {
        this.held.items.shift();
        void this.deliver(head).catch((error: Error) => {
          // Not sent: it waits again, with why (D7).
          this.error = error.message;
          this.held.restore([head], error.message);
          this.emitState();
        });
        return;
      }
      if (
        !this.posted ||
        this.stopping ||
        !sameSettings(this.applied, head.settings)
      )
        return;
      this.held.items.shift();
      try {
        this.post(head);
      } catch (error) {
        this.held.restore([head], (error as Error).message);
        this.emitState();
        return;
      }
    }
  }

  /** Write `out` to the CLI, to be taken in. */
  post(out: Outgoing): void {
    this.write({
      type: "user",
      message: { role: "user", content: out.content },
      parent_tool_use_id: null,
    });
    out.error = null;
    this.inflight.push(out);
  }

  /** Let a paused queue go on. */
  resume(): void {
    this.held.paused = false;
    for (const item of this.held.items) item.error = null;
    this.pump();
    this.emitState();
  }

  /**
   * Write `out` as the next turn, the process first brought to its settings:
   * model and permission by control request, effort and fast mode — which
   * have none — by a restart on `--resume` (only ever while idle).
   */
  async deliver(out: Outgoing): Promise<void> {
    this.busy = true;
    this.posted = false;
    this.error = null;
    // No process yet: it boots first.
    if (!this.child) this.starting = true;
    this.emitState();
    try {
      const was = this.applied;
      const restart =
        !this.child ||
        !was ||
        was.effort !== out.settings.effort ||
        was.fast !== out.settings.fast;
      if (!restart && was) {
        try {
          if (was.model !== out.settings.model)
            await this.control({
              subtype: "set_model",
              model: out.settings.model,
            });
          if (was.permission !== out.settings.permission)
            await this.control({
              subtype: "set_permission_mode",
              mode: out.settings.permission,
            });
          this.applied = out.settings;
        } catch {
          await this.halt();
        }
      } else if (this.child) await this.halt();
      if (!this.child) await this.start(out.settings);
      // A restart's exit cleared these.
      this.busy = true;
      this.error = null;
      this.deps.remember(this.conversation, out.settings);
      this.rows = [];
      this.post(out);
      this.posted = true;
      this.emitState();
      // Sent while this one was getting ready: it steers it now.
      this.pump();
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  /** End the process and wait for it (idle only). */
  async halt(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.quiet = this.busy;
    child.stdin?.end();
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await this.exited;
    clearTimeout(killer);
    this.quiet = false;
  }

  async stop(): Promise<void> {
    // What waits stays, paused (D5): Resume or the next send lets it go.
    if (this.held.length) this.held.paused = true;
    if (!this.busy || !this.child) {
      this.emitState();
      return;
    }
    this.stopping = true;
    // ⚠️ The CLI runs what it has not taken in yet after an interrupt, as a
    // turn of its own: the process ends at the interrupt's `result` instead.
    if (this.inflight.length) this.reclaim = true;
    this.emitState();
    try {
      await this.control({ subtype: "interrupt" });
    } catch {
      this.child?.kill("SIGINT");
    }
  }
}

/** Every conversation's engine, by workspace and id. */
export function createEngines(deps: EngineDeps) {
  const engines = new Map<string, Engine | CodexEngine>();
  const codexDeps = () => ({
    cli:
      deps.codexCli ??
      (() => Promise.reject(new Error("Codex is not available."))),
    emit: deps.emit,
    remember: deps.remember,
    spawn: deps.spawn,
  });
  const keyOf = (workspace: string, conversation: string) =>
    `${workspace}\0${conversation}`;

  function pids(): Set<number> {
    const out = new Set<number>();
    for (const engine of engines.values())
      if (engine.child?.pid) out.add(engine.child.pid);
    return out;
  }

  async function terminalState(
    workspace: string,
    conversation: string,
  ): Promise<EngineState | null> {
    const terminalId = await deps
      .terminalOn(workspace, conversation, pids())
      .catch(() => null);
    return terminalId ? { state: "terminal", terminalId } : null;
  }

  async function state(
    workspace: string,
    conversation: string,
  ): Promise<EngineState> {
    const engine = engines.get(keyOf(workspace, conversation));
    if (engine?.child || engine?.busy) return engine.state();
    return (
      (await terminalState(workspace, conversation)) ??
      engine?.state() ?? { state: "idle" }
    );
  }

  return {
    pids,
    state,

    /**
     * Queue `out` behind a running turn, or write it now — through the CLI
     * of `agent`, the conversation's own.
     */
    async send(
      workspace: string,
      conversation: string,
      folder: string,
      out: Outgoing,
      agent: "claude" | "codex" = "claude",
    ): Promise<EngineState> {
      const key = keyOf(workspace, conversation);
      let engine = engines.get(key);
      if (
        engine &&
        (engine.folder !== folder ||
          engine instanceof CodexEngine !== (agent === "codex"))
      ) {
        if (engine.busy) throw new Error("A turn is still running.");
        await engine.halt();
        engines.delete(key);
        engine = undefined;
      }
      if (engine?.busy || engine?.held.length) {
        await engine.accept(out);
        return engine.state();
      }
      if (!engine?.child) {
        // ⚠️ Single writer: a pty already running Claude on it wins.
        const terminal = await terminalState(workspace, conversation);
        if (terminal) return terminal;
      }
      if (!engine) {
        engine =
          agent === "codex"
            ? new CodexEngine(workspace, conversation, folder, codexDeps())
            : new Engine(workspace, conversation, folder, deps);
        engines.set(key, engine);
      }
      const running = engine;
      await running.accept(out).catch((error: Error) => {
        running.error = error.message;
        running.emitState();
        throw error;
      });
      return running.state();
    },

    /**
     * A NEW Codex conversation with `out` as its first turn. Codex names
     * the id itself, on its first line: answered once it has.
     */
    async startCodex(
      workspace: string,
      folder: string,
      out: Outgoing,
    ): Promise<{ conversation: string; engine: EngineState }> {
      const engine = new CodexEngine(workspace, null, folder, codexDeps());
      await engine.deliver(out);
      let timer: NodeJS.Timeout | undefined;
      const conversation = await Promise.race([
        engine.named,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Codex did not start the conversation.")),
            30_000,
          );
        }),
      ])
        .catch(async (error: Error) => {
          await engine.halt();
          throw error;
        })
        .finally(() => clearTimeout(timer));
      engines.set(keyOf(workspace, conversation), engine);
      engine.emitState();
      return { conversation, engine: engine.state() };
    },

    /**
     * A NEW conversation under `conversation` — an id main just made — with
     * `out` as its first turn.
     */
    async start(
      workspace: string,
      conversation: string,
      folder: string,
      out: Outgoing,
    ): Promise<EngineState> {
      const key = keyOf(workspace, conversation);
      if (engines.has(key)) throw new Error("That conversation exists.");
      const engine = new Engine(workspace, conversation, folder, deps, true);
      engines.set(key, engine);
      await engine.deliver(out).catch((error: Error) => {
        engine.error = error.message;
        engine.emitState();
        throw error;
      });
      return engine.state();
    },

    /**
     * What an engine holds of a conversation the CLI has not written down
     * yet (started here, first turn running), or null.
     */
    pending(
      workspace: string,
      conversation: string,
    ): { agent: "claude" | "codex"; turns: Turn[]; working: boolean } | null {
      const engine = engines.get(keyOf(workspace, conversation));
      if (!engine) return null;
      return {
        agent: engine instanceof CodexEngine ? "codex" : "claude",
        turns: engine.turns(),
        working: engine.busy,
      };
    },

    /** The requests the engine is still waiting on, oldest first. */
    permissions(workspace: string, conversation: string): PermissionRequest[] {
      const engine = engines.get(keyOf(workspace, conversation));
      return engine ? [...engine.permissions.values()] : [];
    },

    async stop(workspace: string, conversation: string): Promise<void> {
      await engines.get(keyOf(workspace, conversation))?.stop();
    },

    clearQueue(workspace: string, conversation: string): number {
      const engine = engines.get(keyOf(workspace, conversation));
      if (!engine) return 0;
      const dropped = engine.held.clear();
      engine.emitState();
      return dropped;
    },

    /** One queued message taken back out to be edited, or null: it went. */
    takeQueued(
      workspace: string,
      conversation: string,
      id: string,
    ): Outgoing | null {
      const engine = engines.get(keyOf(workspace, conversation));
      const taken = engine?.held.remove(id) ?? null;
      engine?.emitState();
      return taken;
    },

    resumeQueue(workspace: string, conversation: string): void {
      engines.get(keyOf(workspace, conversation))?.resume();
    },

    answer(
      workspace: string,
      conversation: string,
      id: string,
      answer: PermissionAnswer,
    ): void {
      const engine = engines.get(keyOf(workspace, conversation));
      if (!engine) throw new Error("That request was already answered.");
      engine.answer(id, answer);
    },

    /** Stop the pty running this conversation so the composer may write it. */
    async takeOver(
      workspace: string,
      conversation: string,
    ): Promise<EngineState> {
      const terminalId = await deps
        .terminalOn(workspace, conversation, pids())
        .catch(() => null);
      if (terminalId) {
        await deps.killTerminal(terminalId);
        // The CLI needs a moment to let go of the file.
        for (let tries = 0; tries < 20; tries++) {
          const still = await deps
            .terminalOn(workspace, conversation, pids())
            .catch(() => null);
          if (!still) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      const now = await state(workspace, conversation);
      if (now.state === "terminal")
        throw new Error("The terminal is still running this conversation.");
      deps.emit({ type: "state", workspace, conversation, engine: now });
      return now;
    },

    /** Let a terminal resume it: end an idle engine's process. */
    async release(workspace: string, conversation: string): Promise<void> {
      const key = keyOf(workspace, conversation);
      const engine = engines.get(key);
      if (!engine) return;
      if (engine.busy) throw new Error("Stop the running turn first.");
      await engine.halt();
      engines.delete(key);
      engine.emitState();
    },

    /** The conversations of `workspace` whose engine process is alive. */
    alive(workspace: string): string[] {
      return [...engines.values()]
        .filter((engine) => engine.workspace === workspace && engine.child)
        .flatMap((engine) =>
          engine.conversation ? [engine.conversation] : [],
        );
    },

    /**
     * Stop the engine outright — the rail's Stop: whatever turn runs is cut
     * off, the queue dropped, and the process ended.
     */
    async close(workspace: string, conversation: string): Promise<void> {
      const key = keyOf(workspace, conversation);
      const engine = engines.get(key);
      if (!engine) return;
      engine.held.clear();
      await engine.halt();
      engines.delete(key);
      engine.busy = false;
      engine.emitState();
    },

    killAll(): void {
      for (const engine of engines.values()) {
        engine.stopping = true;
        engine.child?.kill("SIGTERM");
      }
    },
  };
}
