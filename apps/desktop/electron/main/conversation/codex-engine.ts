// The composer's engine for a Codex conversation: one long-lived
// `codex app-server` per conversation sent from chat, spoken to over
// JSON-RPC (one JSON object per line, no `jsonrpc` field).
//
// - `initialize`, then `thread/start` (a new conversation, whose id Codex
//   names) or `thread/resume`. Each turn is a `turn/start` carrying the
//   composer's settings, so a change between turns needs no restart.
// - Text streams as `item/agentMessage/delta`. The rest of the turn is in
//   the rollout Codex writes as it goes, which the chat reads when the
//   activity watcher says it moved (`codex-transcript.ts`).
// - Codex asks before acting as SERVER requests (a command, a file change,
//   more permissions, a question, an MCP confirmation). They show as the
//   chat's permission and question cards and are answered on stdin.
// - A send while a turn runs goes into it with `turn/steer` (FE-67). One it
//   cannot take yet waits in `held` (`./queue`) and starts after
//   `turn/completed`. Stop is `turn/interrupt`.
//
// Nothing here imports Electron.
//
// NOTE: Nothing the page typed becomes an argument: the process is started
// with none but `app-server`, settings are checked again against the fixed
// lists, the id is a UUID Codex itself named, and images are files main
// wrote.
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AskQuestion,
  agentOfModel,
  type ComposerSettings,
  type ConversationEvent,
  checkSettings,
  type EngineState,
  type Permission,
  type PermissionAnswer,
  type PermissionRequest,
  type Turn,
} from "../../../shared/conversation";
import { isAgentSessionId } from "../../../shared/terminal";
import type { ClaudeCli } from "./claude-cli";
import type { ContentBlock } from "./outgoing";
import { Held, type Outgoing, sameSettings } from "./queue";
import { cut, inputText } from "./transcript";

/** What a {@link CodexEngine} needs from main; `spawn` is a test seam. */
interface CodexEngineDeps {
  cli: () => Promise<ClaudeCli>;
  emit: (event: ConversationEvent) => void;
  remember: (conversation: string, settings: ComposerSettings) => void;
  spawn?: typeof spawnChild;
  /** How long a request to the app-server is waited on. */
  requestTimeoutMs?: number;
}

type CodexOutgoing = Outgoing;

/** The file extension an attached image is written with, by media type. */
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/**
 * The composer's permission as Codex's approval policy, reviewer and sandbox.
 *
 * The same four permissions as Claude's, asked the same way.
 *
 * NOTE: Full access stays `on-request`, not `never`: `never` refuses an
 * escalation before it reaches us, and Full access answers it with yes.
 */
function codexPolicy(permission: Permission): {
  approvalPolicy: "untrusted" | "on-request";
  approvalsReviewer: "user" | "auto_review";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  sandboxPolicy: Json;
} {
  switch (permission) {
    case "manual":
      return {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: "read-only",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      };
    case "acceptEdits":
    case "auto":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: permission === "auto" ? "auto_review" : "user",
        sandbox: "workspace-write",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case "bypassPermissions":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}

/**
 * `settings`, checked: a listed Codex model and the fixed lists.
 *
 * @throws When anything is off the lists, or the model is not Codex's.
 */
function checked(value: ComposerSettings): ComposerSettings {
  const settings = checkSettings(value);
  if (!settings || agentOfModel(settings.model) !== "codex")
    throw new Error("Unknown settings");
  return settings;
}

/**
 * `content` as Codex's turn input: its text, and its images written to files.
 *
 * @returns The input, and the folder the images went to (null when none),
 *   for the caller to remove once the turn ends.
 */
async function inputOf(
  content: readonly ContentBlock[],
): Promise<{ input: Json[]; dir: string | null }> {
  const text = content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n");
  const input: Json[] = text ? [{ type: "text", text, text_elements: [] }] : [];
  const blocks = content.filter((block) => block.type === "image");
  if (blocks.length === 0) return { input, dir: null };
  const dir = join(tmpdir(), "lanework-codex", randomUUID());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [at, block] of blocks.entries()) {
    if (block.type !== "image") continue;
    const ext = EXT[block.source.media_type] ?? "png";
    const path = join(dir, `image-${at + 1}.${ext}`);
    await writeFile(path, Buffer.from(block.source.data, "base64"), {
      mode: 0o600,
    });
    input.push({ type: "localImage", path });
  }
  return { input, dir };
}

/** What a server request is waiting on, to answer it in Codex's shape. */
type Waiting =
  | { kind: "command" | "file" }
  | { kind: "permissions"; permissions: unknown }
  | { kind: "questions"; ids: Map<string, string> }
  | { kind: "elicitation"; content: Json };

/**
 * An MCP server's elicitation, when it is only a confirmation.
 *
 * A confirmation has no fields, or one yes/no, so Allow/Deny can answer it.
 *
 * @returns null for a real form.
 */
function confirmation(params: Json): { title: string; content: Json } | null {
  const schema = record(params.requestedSchema);
  const properties = record(schema.properties);
  if (
    !["form", "openai/form", "openaiForm"].includes(String(params.mode)) ||
    schema.type !== "object"
  )
    return null;
  const entries = Object.entries(properties);
  if (entries.length > 1) return null;
  let content: Json = {};
  let detail = "";
  if (entries.length === 1) {
    const [key, value] = entries[0] as [string, unknown];
    const field = record(value);
    if (field.type !== "boolean") return null;
    content = { [key]: true };
    detail = [str(field.title) ?? key, str(field.description)]
      .filter(Boolean)
      .join(" — ");
  }
  const server = str(params.serverName) ?? "MCP";
  const message = str(params.message) ?? "Approve request";
  return {
    title: `${server}: ${message}${detail ? ` — ${detail}` : ""}`,
    content,
  };
}

/** A request of ours the app-server has not answered yet. */
interface Pending {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One Codex conversation's `codex app-server`, and the turn it runs. */
export class CodexEngine {
  child: ChildProcess | null = null;
  busy = false;
  starting = false;
  stopping = false;
  error: string | null = null;
  /** What waits to be sent. */
  held = new Held();
  /** Whether `drain` is running: one at a time, so the order holds. */
  private pumping = false;
  /** The permission and question cards shown now, by request id. */
  permissions = new Map<string, PermissionRequest>();
  /** The server request behind each card, to answer it in Codex's shape. */
  waiting = new Map<string, { rpcId: number | string; waiting: Waiting }>();
  /** Items Codex started this turn, by id: a file change's diff. */
  items = new Map<string, Json>();
  stderr = "";
  buffer = "";
  /** The running turn's id, for `turn/interrupt`. */
  turnId: string | null = null;
  /** The settings the running turn was started with. */
  applied: ComposerSettings | null = null;
  /** The images of the running turn and its steers, removed when it ends. */
  dirs: string[] = [];
  exited: Promise<void> = Promise.resolve();
  /** Resolves with the id once Codex names a new conversation. */
  named: Promise<string>;
  private name: (id: string) => void = () => {};
  private refuse: (error: Error) => void = () => {};
  private next = 0;
  private requests = new Map<number, Pending>();
  /** Resolves once `initialize` is answered and the thread is open. */
  private ready: Promise<void> | null = null;

  constructor(
    readonly workspace: string,
    /** Null until a new conversation's `thread/start` names it. */
    public conversation: string | null,
    readonly folder: string,
    readonly deps: CodexEngineDeps,
  ) {
    this.named = new Promise((resolve, reject) => {
      this.name = resolve;
      this.refuse = reject;
    });
    // Nobody waits on it for a conversation that already has its id.
    this.named.catch(() => {});
    if (conversation) this.name(conversation);
  }

  state(): EngineState {
    const held = this.held.state();
    if (this.error && !this.busy)
      return { state: "error", message: this.error, ...held };
    if (this.busy && this.starting) return { state: "starting", ...held };
    if (this.busy) return { state: "running", ...held };
    return { state: "idle", ...held };
  }

  /** Nothing is held here: the rollout is the turn, as soon as it exists. */
  turns(): Turn[] {
    return [];
  }

  /** The last state sent, so an unchanged one is not sent again. */
  told = "";

  emit(event: Json & { type: ConversationEvent["type"] }) {
    if (!this.conversation) return;
    this.deps.emit({
      ...event,
      workspace: this.workspace,
      conversation: this.conversation,
    } as ConversationEvent);
  }

  emitState() {
    if (!this.conversation) return;
    const engine = this.state();
    const said = JSON.stringify(engine);
    if (said === this.told) return;
    this.told = said;
    this.emit({ type: "state", engine });
  }

  /**
   * Send one message to the app-server.
   *
   * @throws When Codex is not running.
   */
  write(message: Json): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable)
      throw new Error("Codex is not running.");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * Call `method` and wait for its result.
   *
   * Rejects when Codex refuses, exits, or does not answer in time.
   */
  request(method: string, params: Json): Promise<Json> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`Codex did not answer ${method}.`));
      }, this.deps.requestTimeoutMs ?? 60_000);
      this.requests.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(error as Error);
      }
    });
  }

  /** Start `codex app-server`, introduce ourselves, open the thread. */
  async start(settings: ComposerSettings): Promise<void> {
    const cli = await this.deps.cli();
    const spawn = this.deps.spawn ?? spawnChild;
    const child = spawn(cli.file, ["app-server"], {
      cwd: this.folder,
      env: cli.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
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
      this.ready = null;
      // What Codex said last on stderr, else how it ended.
      const said =
        this.stderr
          .trim()
          .split("\n")
          .filter((line) => line.trim() && !/\b(WARN|INFO|DEBUG)\b/.test(line))
          .at(-1)
          ?.slice(0, 300) ||
        `Codex stopped (${signal ?? `exit ${code ?? "?"}`}).`;
      for (const pending of this.requests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(said));
      }
      this.requests.clear();
      this.dropPermissions();
      if (this.busy && !this.stopping) {
        this.error = said;
        this.held.paused = this.held.length > 0;
      }
      if (!this.conversation)
        this.refuse(new Error(this.error ?? "Codex did not start."));
      this.endTurn();
      this.stopping = false;
      this.emitState();
      done();
    };
    child.once("exit", exit);
    child.once("error", (error) => {
      this.error = error.message;
      exit(null, null);
    });

    await this.request("initialize", {
      clientInfo: { name: "lanework", title: "Lanework", version: "1.0.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.write({ method: "initialized" });
    const policy = codexPolicy(settings.permission);
    const thread = {
      cwd: this.folder,
      model: settings.model,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
      sandbox: policy.sandbox,
    };
    if (this.conversation) {
      try {
        await this.request("thread/resume", {
          ...thread,
          threadId: this.conversation,
          excludeTurns: true,
        });
      } catch (error) {
        // NOTE: An app-server that could not open the thread is of no use;
        // ending it lets the next send start clean.
        await this.halt();
        // Another Codex (a terminal outside Lanework, Codex's own app)
        // writes the thread; only Lanework's tabs are found beforehand.
        if (/already has an active writer/.test((error as Error).message))
          throw new Error(
            "Codex is running this conversation somewhere else. Exit it there to continue here.",
          );
        throw error;
      }
      return;
    }
    const started = await this.request("thread/start", thread);
    const id = record(record(started).thread).id;
    if (!isAgentSessionId(id))
      throw new Error("Codex did not name the conversation.");
    this.conversation = id;
    this.name(id);
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
      let message: Json;
      try {
        message = JSON.parse(text) as Json;
      } catch {
        continue;
      }
      try {
        this.handle(message);
      } catch {
        // One odd line never stops the stream.
      }
    }
    if (this.buffer.length > 64 * 1024 * 1024) this.buffer = "";
  }

  /** One message from the app-server: a response, a request or a notice. */
  handle(message: Json): void {
    const method = typeof message.method === "string" ? message.method : null;
    const id = message.id;
    // A response to one of ours.
    if (!method && typeof id === "number") {
      const pending = this.requests.get(id);
      if (!pending) return;
      this.requests.delete(id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new Error(str(record(message.error).message) ?? "Codex refused."),
        );
      else pending.resolve(record(message.result));
      return;
    }
    if (!method) return;
    const params = record(message.params);
    // NOTE: Codex's own request ids start at 0: test for presence, not truth.
    if (typeof id === "number" || typeof id === "string") {
      this.onServerRequest(id, method, params);
      return;
    }
    if (
      this.conversation &&
      typeof params.threadId === "string" &&
      params.threadId !== this.conversation
    )
      return;
    switch (method) {
      case "turn/started":
        this.turnId = str(record(params.turn).id) ?? this.turnId;
        this.starting = false;
        this.emitState();
        this.pump();
        return;
      case "item/started": {
        const item = record(params.item);
        if (typeof item.id === "string") this.items.set(item.id, item);
        return;
      }
      case "item/completed":
        this.emit({ type: "moved" });
        return;
      case "item/agentMessage/delta":
        if (typeof params.delta === "string" && params.delta)
          this.emit({ type: "delta", text: params.delta });
        return;
      case "serverRequest/resolved": {
        const rpcId = params.requestId;
        for (const [key, entry] of this.waiting)
          if (entry.rpcId === rpcId) this.settle(key);
        return;
      }
      case "error": {
        if (params.willRetry === true) return;
        this.error = str(record(params.error).message)?.slice(0, 300) ?? null;
        return;
      }
      case "turn/completed": {
        const turn = record(params.turn);
        if (turn.status === "failed" && !this.stopping)
          this.error =
            str(record(turn.error).message)?.slice(0, 300) ??
            this.error ??
            "The turn failed.";
        this.onTurnEnd();
        return;
      }
    }
  }

  /**
   * A question Codex asks before acting: a card, answered later.
   *
   * Full access answers a permissions request or an MCP confirmation itself.
   * A request this cannot show is answered at once, with an empty answer or
   * a refusal.
   */
  onServerRequest(rpcId: number | string, method: string, params: Json): void {
    const key = `codex-${String(rpcId)}`;
    const mode = this.applied?.permission ?? "manual";
    const ask = (request: Omit<PermissionRequest, "id">, waiting: Waiting) => {
      const permission: PermissionRequest = { id: key, ...request };
      this.permissions.set(key, permission);
      this.waiting.set(key, { rpcId, waiting });
      this.emit({ type: "permission", request: permission });
    };
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const command = str(params.command) ?? "";
        ask(
          {
            tool: "exec_command",
            summary: (str(params.reason) ?? command ?? "Run a command").slice(
              0,
              300,
            ),
            input: cut(
              [command, str(params.cwd) ? `in ${params.cwd}` : null]
                .filter(Boolean)
                .join("\n"),
            ),
            suggestMode: null,
            questions: null,
          },
          { kind: "command" },
        );
        return;
      }
      case "item/fileChange/requestApproval": {
        const item =
          typeof params.itemId === "string"
            ? this.items.get(params.itemId)
            : undefined;
        const changes = Array.isArray(item?.changes)
          ? (item.changes as Json[])
          : [];
        const paths = changes.flatMap((change) =>
          typeof change.path === "string" ? [change.path] : [],
        );
        ask(
          {
            tool: "apply_patch",
            summary: (
              str(params.reason) ??
              (paths.length ? `Edit ${paths.join(", ")}` : "Change files")
            ).slice(0, 300),
            input: cut(
              changes
                .map((change) =>
                  [str(change.path), str(change.diff)]
                    .filter(Boolean)
                    .join("\n"),
                )
                .join("\n\n") || inputText(params),
            ),
            suggestMode: null,
            questions: null,
          },
          { kind: "file" },
        );
        return;
      }
      case "item/permissions/requestApproval": {
        // Full access grants more without asking; the others ask.
        if (mode === "bypassPermissions") {
          this.reply(rpcId, {
            scope: "session",
            permissions: params.permissions ?? {},
          });
          return;
        }
        ask(
          {
            tool: "permissions",
            summary: (str(params.reason) ?? "Codex asks for more access").slice(
              0,
              300,
            ),
            input: inputText(params.permissions),
            suggestMode: null,
            questions: null,
          },
          { kind: "permissions", permissions: params.permissions ?? {} },
        );
        return;
      }
      case "item/tool/requestUserInput": {
        const list = Array.isArray(params.questions)
          ? (params.questions as Json[])
          : [];
        const ids = new Map<string, string>();
        const questions: AskQuestion[] = list.slice(0, 8).map((entry) => {
          const question = (str(entry.question) ?? "").slice(0, 1000);
          if (typeof entry.id === "string") ids.set(question, entry.id);
          return {
            question,
            header: (str(entry.header) ?? "").slice(0, 100),
            options: (Array.isArray(entry.options)
              ? (entry.options as Json[])
              : []
            )
              .slice(0, 12)
              .map((option) => ({
                label: (str(option.label) ?? "").slice(0, 200),
                description: (str(option.description) ?? "").slice(0, 500),
              }))
              .filter((option) => option.label),
            multiSelect: false,
          };
        });
        if (questions.length === 0 || questions.some((q) => !q.question)) {
          this.reply(rpcId, { answers: {} });
          return;
        }
        ask(
          {
            tool: "AskUserQuestion",
            summary: questions[0]?.question ?? "Codex asks",
            input: "",
            suggestMode: null,
            questions,
          },
          { kind: "questions", ids },
        );
        return;
      }
      case "mcpServer/elicitation/request": {
        const confirm = confirmation(params);
        if (!confirm) {
          // A real form or a sign-in page: not something Allow/Deny answers.
          this.reply(rpcId, { action: "cancel", content: null, _meta: null });
          return;
        }
        if (mode === "bypassPermissions") {
          this.reply(rpcId, {
            action: "accept",
            content: confirm.content,
            _meta: null,
          });
          return;
        }
        ask(
          {
            tool: `mcp__${str(params.serverName) ?? "mcp"}`,
            summary: confirm.title.slice(0, 300),
            input: inputText(params.requestedSchema),
            suggestMode: null,
            questions: null,
          },
          { kind: "elicitation", content: confirm.content },
        );
        return;
      }
      default:
        // Refuse plainly: an empty answer would hide what is missing.
        try {
          this.write({
            id: rpcId,
            error: { code: -32601, message: `Unsupported method: ${method}` },
          });
        } catch {
          // Gone already.
        }
    }
  }

  /** Answer server request `rpcId`; a gone process is left to its exit. */
  reply(rpcId: number | string, result: Json): void {
    try {
      this.write({ id: rpcId, result });
    } catch {
      // The process is gone; its exit tells the page.
    }
  }

  /**
   * Answer card `id` in the shape its request is waiting on.
   *
   * @throws When the request was already answered.
   */
  answer(id: string, answer: PermissionAnswer): void {
    const entry = this.waiting.get(id);
    if (!entry) throw new Error("That request was already answered.");
    const allow = answer.behavior === "allow";
    const { rpcId, waiting } = entry;
    switch (waiting.kind) {
      case "command":
      case "file":
        this.reply(rpcId, { decision: allow ? "accept" : "decline" });
        break;
      case "permissions":
        this.reply(
          rpcId,
          allow
            ? { scope: "turn", permissions: waiting.permissions }
            : { permissions: {} },
        );
        break;
      case "questions": {
        const answers: Json = {};
        if (allow)
          for (const [question, value] of Object.entries(
            answer.answers ?? {},
          )) {
            const qid = waiting.ids.get(question);
            if (qid)
              answers[qid] = {
                answers: value
                  .split(", ")
                  .map((part) => part.trim())
                  .filter(Boolean),
              };
          }
        this.reply(rpcId, { answers });
        break;
      }
      case "elicitation":
        this.reply(rpcId, {
          action: allow ? "accept" : "decline",
          content: allow ? waiting.content : null,
          _meta: null,
        });
        break;
    }
    this.settle(id);
  }

  /** Close the card of a request answered here, or by Codex itself. */
  settle(key: string): void {
    if (!this.permissions.has(key) && !this.waiting.has(key)) return;
    this.permissions.delete(key);
    this.waiting.delete(key);
    this.emit({ type: "permission-done", id: key });
  }

  /** Close every card: the turn or the process they belonged to has ended. */
  dropPermissions(): void {
    for (const key of [...this.permissions.keys()]) this.settle(key);
    this.waiting.clear();
  }

  /** Clear what a turn leaves behind, its image files included. */
  endTurn(): void {
    this.busy = false;
    this.starting = false;
    this.turnId = null;
    this.items.clear();
    for (const dir of this.dirs)
      void rm(dir, { recursive: true, force: true }).catch(() => {});
    this.dirs = [];
  }

  /** A turn ended: clear it, and let what is held go. */
  onTurnEnd(): void {
    this.dropPermissions();
    this.endTurn();
    this.stopping = false;
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
    // Pump before emitting: one that steers at once is never drawn as queued.
    this.pump();
    this.emitState();
  }

  /** Let a paused queue go on. */
  resume(): void {
    this.held.paused = false;
    for (const item of this.held.items) item.error = null;
    this.emitState();
    this.pump();
  }

  /** Start {@link CodexEngine.drain} unless it is already running. */
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.drain().finally(() => {
      this.pumping = false;
    });
  }

  /**
   * Send what is held, in order, for as long as Codex can take it.
   *
   * Idle, the head starts a turn. Busy, it steers the running turn, but only
   * once that turn is up and with the same settings; otherwise it waits.
   */
  private async drain(): Promise<void> {
    while (!this.held.paused && this.held.length) {
      const head = this.held.items[0] as Outgoing;
      if (!this.busy) {
        this.held.items.shift();
        try {
          await this.deliver(head);
        } catch (error) {
          this.held.restore([head], (error as Error).message);
          this.emitState();
          return;
        }
        continue;
      }
      const turnId = this.turnId;
      if (
        !turnId ||
        !this.conversation ||
        this.starting ||
        this.stopping ||
        !sameSettings(this.applied, head.settings)
      )
        return;
      this.held.items.shift();
      try {
        const { input, dir } = await inputOf(head.content);
        if (dir) this.dirs.push(dir);
        await this.request("turn/steer", {
          threadId: this.conversation,
          expectedTurnId: turnId,
          input,
        });
        head.error = null;
        this.emitState();
      } catch (error) {
        // The turn ended first: it goes as a turn of its own (FE-67/D7).
        if (!this.busy || this.turnId !== turnId) {
          this.held.items.unshift(head);
          continue;
        }
        this.held.restore([head], (error as Error).message);
        this.emitState();
        return;
      }
    }
  }

  /**
   * Start `out` as the next turn, the app-server first if it is not up.
   *
   * @throws When the settings are off the lists, or Codex fails to start or
   *   refuses the turn.
   */
  async deliver(out: CodexOutgoing): Promise<void> {
    const settings = checked(out.settings);
    this.busy = true;
    this.starting = true;
    this.stopping = false;
    this.error = null;
    this.emitState();
    try {
      if (!this.child) this.ready = null;
      this.ready ??= this.start(settings);
      await this.ready;
      const { input, dir } = await inputOf(out.content);
      if (dir) this.dirs.push(dir);
      this.applied = settings;
      const policy = codexPolicy(settings.permission);
      if (this.conversation) this.deps.remember(this.conversation, settings);
      const started = await this.request("turn/start", {
        threadId: this.conversation,
        input,
        model: settings.model,
        effort: settings.effort,
        // "default" is standard speed: off turns the user's own fast off.
        serviceTierForTurn: settings.fast ? "fast" : "default",
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandboxPolicy: policy.sandboxPolicy,
      });
      this.turnId = str(record(started.turn).id) ?? this.turnId;
      this.emitState();
      // Sent while this one was getting ready: it steers it now.
      this.pump();
    } catch (error) {
      this.endTurn();
      this.refuse(error as Error);
      throw error;
    }
  }

  /** End the process and wait for it. */
  async halt(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    child.stdin?.end();
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await this.exited;
    clearTimeout(killer);
  }

  /**
   * Stop the running turn with `turn/interrupt`.
   *
   * Ends the process when the interrupt cannot be sent or is refused.
   */
  async stop(): Promise<void> {
    // What waits stays, paused (FE-67/D5): Resume or the next send lets it go.
    if (this.held.length) this.held.paused = true;
    if (!this.busy || !this.child) {
      this.emitState();
      return;
    }
    this.stopping = true;
    try {
      if (!this.turnId || !this.conversation) throw new Error("No turn");
      await this.request("turn/interrupt", {
        threadId: this.conversation,
        turnId: this.turnId,
      });
    } catch {
      await this.halt();
    }
  }
}
