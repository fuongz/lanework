// The composer's engine (FE-62/D1): one long-lived, headless `claude` per
// conversation sent from chat, spoken to over stream-json.
//
// - Each turn is one stdin line. Text deltas, permission prompts and the
//   turn's lines come back on stdout, and a `result` line ends the turn.
// - Permission prompts are the CLI's `control_request` / `can_use_tool`,
//   answered on stdin. Stop is a host `interrupt` control request.
// - A send while a turn runs is written at once (FE-67): the CLI takes it
//   in at the turn's next tool result, or runs it as a turn of its own after
//   the `result`. Its replay (`isReplay`) says it was taken in. One it cannot
//   take yet waits in `held` (`./queue`).
// - Only one process writes a conversation at a time: a live pty running
//   Claude on it wins, and the composer waits (`terminal`).
//
// Nothing here imports Electron, so a Node script can drive it against a
// real CLI.
//
// NOTE: Nothing the page typed becomes an argument: settings are checked
// again against the fixed lists (`checkSettings`) and the id is a UUID.
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type AskQuestion,
  type ComposerSettings,
  type ConversationEvent,
  checkSettings,
  type EngineQueue,
  type EngineState,
  isPermission,
  type Permission,
  type PermissionAnswer,
  type PermissionRequest,
  type Turn,
} from "../../../shared/conversation";
import { isAgentSessionId } from "../../../shared/terminal";
import {
  agentEnv,
  engineTap,
  safely,
  writtenPaths,
} from "../orchestration/engine-tap";
import type { ClaudeCli } from "./claude-cli";
import { claudeJsonFor, isClaudeTrusted } from "./claude-trust";
import { CodexEngine } from "./codex-engine";
import { Held, type Outgoing, sameSettings } from "./queue";
import { buildTurns, inputText, type Line } from "./transcript";

/** What the engines need from main; `spawn` is a test seam. */
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
  /**
   * Whether Claude's own trust record covers `folder` (FE-77/D3); `env` is
   * the CLI's. Asked at every process start. Defaults to `~/.claude.json`.
   */
  trusted?: (folder: string, env: Record<string, string>) => Promise<boolean>;
  spawn?: typeof spawnChild;
  /** How long a control request is waited on. */
  controlTimeoutMs?: number;
}

/**
 * The CLI's arguments for `settings`, every value from a fixed list.
 *
 * A `fresh` conversation has no transcript yet: the CLI starts it under `id`
 * (`--session-id`) instead of resuming it.
 *
 * A folder Claude has not recorded as trusted loads user settings only
 * (FE-77/D3, SX-01): `-p` skips Claude's trust dialog, so the repo's
 * `.claude/settings*.json` hooks, `env` and `apiKeyHelper` would otherwise
 * run unasked. A trusted folder's arguments are unchanged.
 *
 * @throws When the settings are off the lists or `id` is not a session id.
 */
export function engineArgs(
  id: string,
  value: ComposerSettings,
  fresh = false,
  trusted = true,
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
  // `fastMode` is the CLI's own settings key (its init line reports
  // `fast_mode_state`); an account or model without fast mode ignores it.
  if (settings.fast)
    args.push("--settings", JSON.stringify({ fastMode: true }));
  if (!trusted) args.push("--setting-sources", "user");
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

/**
 * A permission mode the CLI reports, as the composer's permission.
 *
 * The CLI calls the composer's "Supervised" mode `default`.
 */
function permissionOf(mode: unknown): Permission | null {
  if (mode === "default") return "manual";
  return isPermission(mode) ? mode : null;
}

/**
 * The text a `result` line ends its turn with. A failed turn (an API error,
 * `error_max_turns`, a usage limit) may carry none: what it says instead
 * (FE-90/D3).
 */
function resultText(line: Record<string, unknown>): string {
  const text = typeof line.result === "string" ? line.result : "";
  if (line.is_error !== true || text.trim()) return text;
  const errors = Array.isArray(line.errors)
    ? line.errors.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (errors.length) return errors.join("\n").slice(0, 2_000);
  return typeof line.subtype === "string" && line.subtype !== "success"
    ? `The turn failed (${line.subtype}).`
    : "The turn failed.";
}

/** A control request of ours the CLI has not answered yet. */
interface Control {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One Claude conversation's headless `claude`, and the turn it runs. */
class Engine {
  child: ChildProcess | null = null;
  /** The process's settings: as started, then as control requests changed. */
  applied: ComposerSettings | null = null;
  busy = false;
  starting = false;
  stopping = false;
  /** Set while `deliver` restarts the process: that exit is not news. */
  quiet = false;
  error: string | null = null;
  /** What waits to be written. */
  held = new Held();
  /**
   * Written to the CLI and not taken in yet (no replay back).
   *
   * While any are, a `result` does not end the work: the CLI runs them next.
   */
  inflight: Outgoing[] = [];
  /** The running turn's own message is written: others may steer it now. */
  posted = false;
  /**
   * Stopped with messages written and not taken in.
   *
   * The process then ends on the interrupt's `result`, before it runs them,
   * and they wait again.
   */
  reclaim = false;
  /** The permission and question cards shown now, by request id. */
  permissions = new Map<string, PermissionRequest>();
  /** Each card's tool input, sent back with an allow. */
  inputs = new Map<string, unknown>();
  /** Our control requests in flight, by request id. */
  controls = new Map<string, Control>();
  /** The running turn's lines, for `turn` events. */
  rows: Line[] = [];
  stderr = "";
  buffer = "";
  /** Resolves when the current child exits. */
  exited: Promise<void> = Promise.resolve();
  /**
   * The running process loads user settings only: Claude has no trust on
   * record for the folder (FE-77/D3). Set again at every start.
   */
  untrusted = false;
  /**
   * The folder's trust changed while a turn ran: the process restarts before
   * the next one, to load (or drop) the repo's settings (FE-101).
   */
  stale = false;

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
    const held: EngineQueue = this.held.state();
    if (this.untrusted && this.child) held.untrusted = true;
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
    const full = {
      ...event,
      workspace: this.workspace,
      conversation: this.conversation,
    } as ConversationEvent;
    this.deps.emit(full);
    // FE-87: orchestration follows its lead and workers through the same
    // events the page gets.
    safely(() => engineTap().event?.(full, this.folder));
  }

  /** The last state sent, so an unchanged one is not sent again. */
  told = "";

  emitState() {
    const engine = this.state();
    const said = JSON.stringify(engine);
    if (said === this.told) return;
    this.told = said;
    this.emit({ type: "state", engine });
  }

  /**
   * Write one line to the CLI's stdin.
   *
   * @throws When Claude is not running.
   */
  write(message: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable)
      throw new Error("Claude is not running.");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * Send a host control request and wait for its answer.
   *
   * Rejects when the CLI refuses, stops, or does not answer in time.
   */
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

  /** Start the CLI with `settings`, and wire its output and exit. */
  async start(settings: ComposerSettings): Promise<void> {
    const cli = await this.deps.cli();
    const spawn = this.deps.spawn ?? spawnChild;
    // NOTE: Asked again at every start, never cached: trust given in a
    // Claude tab counts from the next process on (FE-77/D3).
    const trusted = await (
      this.deps.trusted ??
      ((folder, env) => isClaudeTrusted(folder, claudeJsonFor(env)))
    )(this.folder, cli.env).catch(() => false);
    this.untrusted = !trusted;
    this.stale = false;
    const child = spawn(
      cli.file,
      engineArgs(this.conversation, settings, this.fresh, trusted),
      {
        cwd: this.folder,
        // FE-87: a lead's control endpoint, a worker's scratch; never the
        // control variables for anyone else.
        env: agentEnv(cli.env, {
          workspace: this.workspace,
          conversation: this.conversation,
          folder: this.folder,
        }),
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

  /** Take a chunk of stdout and handle every whole line in it. */
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

  /** One line of the CLI's stream-json output. */
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
        // FE-87: a write is told as soon as the CLI names it, a sub-agent's
        // too, so a worker's write guard sees it before the tool runs.
        if (line.type === "assistant") this.tellWrites(line);
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
        safely(() =>
          engineTap().result?.({
            workspace: this.workspace,
            conversation: this.conversation,
            folder: this.folder,
            text: resultText(line),
            error: line.is_error === true,
          }),
        );
        this.onResult();
        return;
    }
  }

  /** Tell orchestration the files an assistant line's tool calls write. */
  tellWrites(line: Record<string, unknown>): void {
    const tap = engineTap().write;
    if (!tap) return;
    const message = (line.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      const paths = writtenPaths(block);
      if (!paths) continue;
      safely(() =>
        tap({
          workspace: this.workspace,
          conversation: this.conversation,
          folder: this.folder,
          tool: String((block as { name?: unknown }).name),
          paths,
        }),
      );
    }
  }

  /**
   * A control request from the CLI: a `can_use_tool` becomes a card.
   *
   * Any other kind is refused at once rather than left hanging.
   */
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

  /**
   * Answer card `id` on stdin.
   *
   * @throws When the request was already answered.
   */
  answer(id: string, answer: PermissionAnswer): void {
    if (!this.permissions.has(id))
      throw new Error("That request was already answered.");
    const input = this.inputs.get(id);
    const response =
      answer.behavior === "allow"
        ? {
            behavior: "allow",
            // NOTE: AskUserQuestion reads its answers off its own input.
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

  /** Close every card: the turn or the process they belonged to has ended. */
  dropPermissions(): void {
    for (const id of this.permissions.keys())
      this.emit({ type: "permission-done", id });
    this.permissions.clear();
    this.inputs.clear();
  }

  /**
   * A `result` line: the turn ended.
   *
   * The work goes on while messages written to the CLI are still to run.
   */
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

  /** Send `out` (into the running turn, or as a turn), or hold it. */
  async accept(out: Outgoing): Promise<void> {
    if (!this.busy && !this.held.length) {
      await this.deliver(out);
      return;
    }
    // A new message picks a paused queue back up (FE-67/D5).
    this.held.paused = false;
    this.held.items.push(out);
    this.pump();
    this.emitState();
  }

  /**
   * Send what is held, in order, for as long as the CLI can take it.
   *
   * Idle, the head starts a turn. Busy, it is written into the running turn,
   * but only once that turn's own message is and with the same settings;
   * otherwise it waits.
   */
  pump(): void {
    while (!this.held.paused && this.held.length) {
      const head = this.held.items[0] as Outgoing;
      if (!this.busy) {
        this.held.items.shift();
        void this.deliver(head).catch((error: Error) => {
          // Not sent: it waits again, with why (FE-67/D7).
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

  /**
   * Write `out` to the CLI, to be taken in.
   *
   * @throws When Claude is not running.
   */
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
   * Write `out` as the next turn, the process first brought to its settings.
   *
   * Model and permission change by control request. Effort and fast mode have
   * none, so they change by a restart on `--resume`, which only ever happens
   * between turns.
   *
   * @throws When the process cannot be started or written to.
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
        this.stale ||
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

  /**
   * End the process and wait for it.
   *
   * Ended while busy (a restart in `deliver`), its exit is quiet.
   */
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

  /**
   * Stop the running turn with an `interrupt` control request.
   *
   * Falls back to SIGINT when the CLI does not answer it.
   */
  async stop(): Promise<void> {
    // What waits stays, paused (FE-67/D5): Resume or the next send lets it go.
    if (this.held.length) this.held.paused = true;
    if (!this.busy || !this.child) {
      this.emitState();
      return;
    }
    this.stopping = true;
    // NOTE: The CLI runs what it has not taken in yet after an interrupt, as a
    // turn of its own, so the process ends at the interrupt's `result`.
    if (this.inflight.length) this.reclaim = true;
    this.emitState();
    try {
      await this.control({ subtype: "interrupt" });
    } catch {
      this.child?.kill("SIGINT");
    }
  }
}

/** The engines {@link createEngines} made last: orchestration's (FE-87). */
let shared: Engines | null = null;

/** The app's engines, once the conversation view registered them. */
export function sharedEngines(): Engines | null {
  return shared;
}

export type Engines = ReturnType<typeof createEngines>;

/** Every conversation's engine, by workspace and id. */
export function createEngines(input: EngineDeps) {
  const engines = new Map<string, Engine | CodexEngine>();
  // The settings each conversation last ran with here, so orchestration can
  // send its lead a turn on them (FE-87).
  const lastSettings = new Map<string, ComposerSettings>();
  const deps: EngineDeps = {
    ...input,
    remember: (conversation, settings) => {
      lastSettings.delete(conversation);
      lastSettings.set(conversation, settings);
      if (lastSettings.size > 256)
        lastSettings.delete(lastSettings.keys().next().value as string);
      input.remember(conversation, settings);
    },
  };
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

  // The engines' own process ids, so a terminal check never counts them.
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

  const api = {
    pids,
    state,

    /** The settings `conversation` last ran with here, or null. */
    settingsOf(conversation: string): ComposerSettings | null {
      return lastSettings.get(conversation) ?? null;
    },

    /**
     * Queue `out` behind a running turn, or write it now.
     *
     * It goes through the CLI of `agent`, the conversation's own. A pty
     * already running Claude on the conversation wins, and its state is the
     * answer.
     *
     * @throws When the engine must change while a turn is still running, or
     *   the send fails.
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
        // NOTE: Single writer: a pty already running Claude on it wins.
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
     * Start a NEW Codex conversation with `out` as its first turn.
     *
     * Codex names the id itself, on its first line; this answers once it
     * has.
     *
     * @throws When Codex fails, or names no conversation within 30 seconds.
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
     * Start a NEW Claude conversation with `out` as its first turn.
     *
     * @param conversation An id main just made.
     * @throws When that conversation exists, or the first turn fails.
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
     * What an engine holds of a conversation, or null when none runs it.
     *
     * For one the CLI has not written down yet (started here, first turn
     * running).
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

    /**
     * The conversation's Claude process runs without the project's settings:
     * Claude has no trust on record for its folder (FE-77/D3).
     */
    untrusted(workspace: string, conversation: string): boolean {
      const engine = engines.get(keyOf(workspace, conversation));
      return (
        engine instanceof Engine && Boolean(engine.child) && engine.untrusted
      );
    },

    async stop(workspace: string, conversation: string): Promise<void> {
      await engines.get(keyOf(workspace, conversation))?.stop();
    },

    /** Drop every queued message; returns how many went. */
    clearQueue(workspace: string, conversation: string): number {
      const engine = engines.get(keyOf(workspace, conversation));
      if (!engine) return 0;
      const dropped = engine.held.clear();
      engine.emitState();
      return dropped;
    },

    /**
     * Take one queued message back out to be edited.
     *
     * @returns null when it already went.
     */
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

    /**
     * Answer a permission or question card.
     *
     * @throws When the request was already answered.
     */
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

    /**
     * Stop the pty running this conversation so the composer may write it.
     *
     * @throws When the terminal still runs it after about three seconds.
     */
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

    /**
     * End an idle engine's process, so a terminal may resume the
     * conversation.
     *
     * @throws When a turn is still running.
     */
    async release(workspace: string, conversation: string): Promise<void> {
      const key = keyOf(workspace, conversation);
      const engine = engines.get(key);
      if (!engine) return;
      if (engine.busy) throw new Error("Stop the running turn first.");
      await engine.halt();
      engines.delete(key);
      engine.emitState();
    },

    /**
     * Bring `agent`'s engines on `folder` onto a trust answer just written
     * (FE-101).
     *
     * An idle one's process ends now, and the next turn starts it with the
     * new trust. A running turn is never cut off: its process restarts before
     * the next turn instead.
     */
    async retrust(
      workspace: string,
      folder: string,
      agent: "claude" | "codex",
    ): Promise<void> {
      await Promise.all(
        [...engines.values()]
          .filter(
            (engine) =>
              engine.workspace === workspace &&
              engine.folder === folder &&
              engine instanceof CodexEngine === (agent === "codex") &&
              engine.child,
          )
          .map(async (engine) => {
            if (engine.busy) {
              engine.stale = true;
              return;
            }
            await engine.halt();
            engine.emitState();
          }),
      );
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
     * Stop the engine outright: the rail's Stop.
     *
     * Whatever turn runs is cut off, the queue dropped, and the process ended.
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

    /** Signal every engine's process to end, without waiting: app quit. */
    killAll(): void {
      for (const engine of engines.values()) {
        engine.stopping = true;
        engine.child?.kill("SIGTERM");
      }
    },
  };
  shared = api;
  return api;
}
