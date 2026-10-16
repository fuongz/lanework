// The composer's engine (FE-62/D1): one long-lived, headless `claude` per
// conversation sent from chat, spoken to over stream-json.
//
// - Each turn is one stdin line; text deltas, permission prompts and the
//   turn's lines come back on stdout, and a `result` line ends the turn.
// - Permission prompts are the CLI's `control_request` / `can_use_tool`,
//   answered on stdin; Stop is a host `interrupt` control request.
// - Sends while a turn runs are queued here and written after its `result`.
// - Only one process writes a conversation at a time: a live pty running
//   Claude on it wins, and the composer waits (`terminal`).
//
// ⚠️ Nothing the page typed becomes an argument: settings are checked again
// against the fixed lists (`checkSettings`) and the id is a UUID. Nothing
// here imports Electron, so a Node script can drive it against a real CLI.
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
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
import type { ContentBlock } from "./outgoing";
import { buildTurns, inputText, type Line } from "./transcript";

export interface EngineDeps {
  cli: () => Promise<ClaudeCli>;
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

export interface Outgoing {
  content: ContentBlock[];
  settings: ComposerSettings;
}

/** The CLI's arguments for `settings` — every value from a fixed list. */
export function engineArgs(id: string, value: ComposerSettings): string[] {
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
    "--resume",
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
  queue: Outgoing[] = [];
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
  ) {}

  state(): EngineState {
    if (this.error && !this.busy)
      return { state: "error", message: this.error };
    if (this.busy && this.starting) return { state: "starting" };
    if (this.busy) return { state: "running", queued: this.queue.length };
    return { state: "idle" };
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
    const child = spawn(cli.file, engineArgs(this.conversation, settings), {
      cwd: this.folder,
      env: cli.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
        this.queue = [];
      }
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
        this.starting = false;
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
            updatedInput: input ?? {},
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
    this.busy = false;
    this.starting = false;
    this.stopping = false;
    this.rows = [];
    this.dropPermissions();
    const next = this.queue.shift();
    if (next)
      void this.deliver(next).catch((error: Error) => {
        this.error = error.message;
        this.emitState();
      });
    else this.emitState();
  }

  /**
   * Write `out` as the next turn, the process first brought to its settings:
   * model and permission by control request, effort and fast mode — which
   * have none — by a restart on `--resume` (only ever while idle).
   */
  async deliver(out: Outgoing): Promise<void> {
    this.busy = true;
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
      this.write({
        type: "user",
        message: { role: "user", content: out.content },
        parent_tool_use_id: null,
      });
      this.emitState();
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
    this.queue = [];
    if (!this.busy || !this.child) {
      this.emitState();
      return;
    }
    this.stopping = true;
    try {
      await this.control({ subtype: "interrupt" });
    } catch {
      this.child?.kill("SIGINT");
    }
  }
}

/** Every conversation's engine, by workspace and id. */
export function createEngines(deps: EngineDeps) {
  const engines = new Map<string, Engine>();
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

    /** Queue `out` behind a running turn, or write it now. */
    async send(
      workspace: string,
      conversation: string,
      folder: string,
      out: Outgoing,
    ): Promise<EngineState> {
      const key = keyOf(workspace, conversation);
      let engine = engines.get(key);
      if (engine && engine.folder !== folder) {
        if (engine.busy) throw new Error("A turn is still running.");
        await engine.halt();
        engines.delete(key);
        engine = undefined;
      }
      if (engine?.busy) {
        engine.queue.push(out);
        engine.emitState();
        return engine.state();
      }
      if (!engine?.child) {
        // ⚠️ Single writer: a pty already running Claude on it wins.
        const terminal = await terminalState(workspace, conversation);
        if (terminal) return terminal;
      }
      if (!engine) {
        engine = new Engine(workspace, conversation, folder, deps);
        engines.set(key, engine);
      }
      await engine.deliver(out).catch((error: Error) => {
        engine.error = error.message;
        engine.emitState();
        throw error;
      });
      return engine.state();
    },

    async stop(workspace: string, conversation: string): Promise<void> {
      await engines.get(keyOf(workspace, conversation))?.stop();
    },

    clearQueue(workspace: string, conversation: string): void {
      const engine = engines.get(keyOf(workspace, conversation));
      if (!engine) return;
      engine.queue = [];
      engine.emitState();
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

    killAll(): void {
      for (const engine of engines.values()) {
        engine.stopping = true;
        engine.child?.kill("SIGTERM");
      }
    },
  };
}

export type Engines = ReturnType<typeof createEngines>;
