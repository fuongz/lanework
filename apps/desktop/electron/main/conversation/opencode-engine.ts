// The composer's engine for an OpenCode conversation (FE-104): OpenCode v2's
// background service, the user's own, spoken to over HTTP and SSE
// (`opencode-client.ts`). No process is the engine's: the service runs every
// OpenCode session of the machine, and outlives the app.
//
// - A new conversation is `POST /api/session` in the folder, whose `ses_` id
//   OpenCode names; an old one is checked with `GET /api/session/{id}`.
// - `GET /api/event` is opened BEFORE the prompt goes, so none of the turn's
//   events is missed. Each turn is `POST /api/session/{id}/prompt`, after
//   the composer's model (`/model`, its effort as the model's variant) and
//   permission (the session's rules) are set.
// - The turn is drawn from its events as it streams (`session.text.*`,
//   `session.tool.*`, `session.step.*`), and ends only on THIS session's
//   `session.execution.*` or `session.idle`. OpenCode writes the same turn to
//   its database step by step, which the chat reads once it ends
//   (`opencode-transcript.ts`).
// - OpenCode asks before acting with `permission.asked` (answered `once` or
//   `reject`) and asks questions with `form.created`. They show as the chat's
//   permission and question cards, a sub-agent's too.
// - A send while a turn runs goes into it (`delivery: "steer"`, FE-67). One
//   it cannot take yet waits in `held` (`./queue`). Stop rejects every
//   pending permission first, then `POST /interrupt`.
//
// Ported from Monocode's `provider/opencode.rs` and `opencode/events.rs`.
// Nothing here imports Electron.
//
// NOTE: Nothing the page typed becomes a path or a flag: settings are checked
// again against the fixed lists, the id is one OpenCode named (`ses_`, FE-103
// D6), every id in a path is encoded, and images are files main wrote.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AskQuestion,
  type AssistantTurn,
  agentOfModel,
  type ComposerSettings,
  type ConversationEvent,
  checkSettings,
  type EngineState,
  type Permission,
  type PermissionAnswer,
  type PermissionRequest,
  type Turn,
  type UserTurn,
} from "../../../shared/conversation";
import { isAgentSessionIdOf } from "../../../shared/terminal";
import { engineTap, safely } from "../orchestration/engine-tap";
import type { ConversationEngine } from "./conversation-engine";
import {
  errorMessage,
  frameOf,
  type OpenCodeClient,
  type OpenCodeEvents,
  OpenCodeHttpError,
  type OpenCodeService,
  openCodeClient,
  segment,
} from "./opencode-client";
import { modelRef, opencodeAgent, opencodeVariant } from "./opencode-models";
import {
  addPart,
  type StepTokens,
  stepTokens,
  turnUsage,
} from "./opencode-transcript";
import type { ContentBlock } from "./outgoing";
import { Held, type Outgoing, sameSettings } from "./queue";
import { cut, inputText } from "./transcript";

/** What an {@link OpenCodeEngine} needs from main; `fetch` is a test seam. */
export interface OpenCodeEngineDeps {
  /**
   * OpenCode's service; `fresh` asks the CLI again (it moved, or restarted).
   *
   * @throws When OpenCode is missing, older than 2.0.15, or will not start.
   */
  service: (fresh?: boolean) => Promise<OpenCodeService>;
  emit: (event: ConversationEvent) => void;
  remember: (conversation: string, settings: ComposerSettings) => void;
  fetch?: typeof fetch;
  /** How long Stop waits for OpenCode to end the turn before it lets go. */
  stopTimeoutMs?: number;
}

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/** The file extension an attached image is written with, by media type. */
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The tools whose input names a file they write, for orchestration. */
const WRITE_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "apply_patch",
  "multiedit",
]);

/**
 * The composer's permission as an OpenCode session's rules (v2's
 * `{ action, resource, effect }`), as Monocode sets them.
 *
 * - Supervised asks before anything but a question.
 * - Auto-accept edits lets edits through too; Auto, reads as well (OpenCode
 *   has no reviewer to hand a decision to).
 * - Full access allows everything.
 */
export function opencodeRules(
  permission: Permission,
): { action: string; resource: string; effect: "allow" | "ask" }[] {
  const rule = (action: string, effect: "allow" | "ask") => ({
    action,
    resource: "*",
    effect,
  });
  if (permission === "bypassPermissions") return [rule("*", "allow")];
  const rules = [rule("*", "ask"), rule("question", "allow")];
  if (permission === "acceptEdits" || permission === "auto")
    rules.push(rule("edit", "allow"));
  if (permission === "auto") rules.push(rule("read", "allow"));
  return rules;
}

/**
 * `settings`, checked: a listed OpenCode model and the fixed lists.
 *
 * @throws When anything is off the lists, or the model is not OpenCode's.
 */
function checked(value: ComposerSettings): ComposerSettings {
  const settings = checkSettings(value);
  if (!settings || agentOfModel(settings.model) !== "opencode")
    throw new Error("Unknown settings");
  return settings;
}

/** The model a turn runs on, as OpenCode's `{ providerID, id, variant }`. */
function modelOf(settings: ComposerSettings): Json {
  const variant = opencodeVariant(settings.model, settings.effort);
  return { ...modelRef(settings.model), ...(variant ? { variant } : {}) };
}

/**
 * `content` as OpenCode's prompt: its text, and its images written to files.
 *
 * @returns The body's text and files, and the folder the images went to
 *   (null when none), for the caller to remove once the turn ends.
 */
async function promptOf(content: readonly ContentBlock[]): Promise<{
  text: string;
  files: { uri: string; name: string }[];
  dir: string | null;
}> {
  const text = content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n");
  const images = content.filter((block) => block.type === "image");
  if (!images.length) return { text, files: [], dir: null };
  // A fresh 0700 folder of its own, never a shared, predictable parent
  // another user could create first (FE-78/D8).
  const dir = await mkdtemp(join(tmpdir(), "lanework-opencode-"));
  const files: { uri: string; name: string }[] = [];
  for (const [at, block] of images.entries()) {
    if (block.type !== "image") continue;
    const name = `image-${at + 1}.${EXT[block.source.media_type] ?? "png"}`;
    const path = join(dir, name);
    await writeFile(path, Buffer.from(block.source.data, "base64"), {
      mode: 0o600,
    });
    files.push({ uri: pathToFileURL(path).href, name });
  }
  return { text, files, dir };
}

/** What a card is waiting on, to answer it in OpenCode's shape. */
type Waiting =
  | { kind: "permission"; session: string; wire: string }
  | {
      kind: "form";
      session: string;
      wire: string;
      /** Each question's field, by question text. */
      fields: Map<string, Json>;
    };

/** One assistant turn of the running work, as its events draw it. */
interface Answering {
  turn: AssistantTurn;
  /** Its parts by key, in the order they began. */
  parts: Map<string, Json>;
  /** Each step's tokens, by assistant message id. */
  steps: Map<string, StepTokens>;
  firstAt: number;
}

/** A form's fields as the chat's questions; null when one cannot be asked. */
function formQuestions(
  form: Json,
): { questions: AskQuestion[]; fields: Map<string, Json> } | null {
  const fields = new Map<string, Json>();
  const questions: AskQuestion[] = [];
  const list = Array.isArray(form.fields) ? (form.fields as unknown[]) : [];
  for (const entry of list.slice(0, 8)) {
    const field = record(entry);
    if (field.hidden === true) continue;
    const key = str(field.key);
    if (!key) return null;
    const question = (str(field.title) ?? key).slice(0, 1000);
    let options = (Array.isArray(field.options) ? field.options : [])
      .slice(0, 12)
      .map((option) => {
        const o = record(option);
        return {
          label: (str(o.label) ?? str(o.value) ?? "").slice(0, 200),
          description: "",
        };
      })
      .filter((option) => option.label);
    if (field.type === "boolean" && !options.length)
      options = [
        { label: "Yes", description: "" },
        { label: "No", description: "" },
      ];
    fields.set(question, field);
    questions.push({
      question,
      header: (str(form.title) ?? "").slice(0, 100),
      options,
      multiSelect: field.type === "multiselect",
    });
  }
  return questions.length ? { questions, fields } : null;
}

/** The chat's answers as a form's, each in its field's type. */
function formAnswer(
  fields: Map<string, Json>,
  answers: Record<string, string>,
): Json {
  const out: Json = {};
  for (const [question, field] of fields) {
    const given = answers[question];
    const key = str(field.key);
    if (given === undefined || !key) continue;
    const optionValue = (label: string) => {
      const option = (Array.isArray(field.options) ? field.options : [])
        .map(record)
        .find((entry) => entry.label === label || entry.value === label);
      return str(option?.value) ?? label;
    };
    switch (field.type) {
      case "multiselect":
        out[key] = given
          .split(", ")
          .map((part) => part.trim())
          .filter(Boolean)
          .map(optionValue);
        break;
      case "boolean":
        out[key] = /^(yes|true)$/i.test(given.trim());
        break;
      case "number":
      case "integer": {
        const number = Number(given.trim());
        if (given.trim() && Number.isFinite(number)) out[key] = number;
        break;
      }
      default:
        out[key] = optionValue(given);
    }
  }
  return out;
}

/** One OpenCode conversation in the user's service, and the turn it runs. */
export class OpenCodeEngine implements ConversationEngine {
  readonly agent = "opencode" as const;
  /** OpenCode asks no trust of a folder (FE-104): never limited, never stale. */
  readonly untrusted = false;
  stale = false;
  busy = false;
  /** Prompted, and OpenCode has not begun the turn yet. */
  starting = false;
  stopping = false;
  error: string | null = null;
  held = new Held();
  permissions = new Map<string, PermissionRequest>();
  /** The settings the running turn was started with. */
  applied: ComposerSettings | null = null;
  /** Resolves with the id once OpenCode names a new conversation. */
  readonly named: Promise<string>;
  /** The last state sent, so an unchanged one is not sent again. */
  told = "";
  private name: (id: string) => void = () => {};
  private refuse: (error: Error) => void = () => {};
  /** Whether `drain` is running: one at a time, so the order holds. */
  private pumping = false;
  private waiting = new Map<string, Waiting>();
  private client: OpenCodeClient | null = null;
  private stream: OpenCodeEvents | null = null;
  /** The session was found in this folder since the client was made. */
  private checked = false;
  /** The permission the session's rules were last set to. */
  private rules: Permission | null = null;
  /** The model (with its variant) the session was last set to. */
  private model: string | null = null;
  /** Prompts of the running work not yet run out, by OpenCode's inbox id. */
  private posted = new Set<string>();
  /** Those of them OpenCode said it took into a run. */
  private delivered = new Set<string>();
  /** OpenCode says when it takes a prompt in: `posted` can be trusted. */
  private reportsDelivery = false;
  /** The running work's turns, as its events draw them. */
  private live: Turn[] = [];
  /** Its assistant turns by OpenCode's assistant message id. */
  private answering = new Map<string, Answering>();
  /** The assistant turn new parts go to; null after a prompt. */
  private current: Answering | null = null;
  /** Sessions' parents, to find a sub-agent's asks. */
  private parents = new Map<string, string | null>();
  /** The images of the running turn and its steers, removed when it ends. */
  private dirs: string[] = [];
  /** Lets go of a Stop OpenCode does not answer. */
  private stopTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly project: string,
    /** Null until a new conversation's `POST /api/session` names it. */
    public conversation: string | null,
    readonly folder: string,
    readonly deps: OpenCodeEngineDeps,
  ) {
    this.named = new Promise((resolve, reject) => {
      this.name = resolve;
      this.refuse = reject;
    });
    // Nobody waits on it for a conversation that already has its id.
    this.named.catch(() => {});
    if (conversation) this.name(conversation);
  }

  /** The service is OpenCode's own, not a process of the engine's. */
  pid(): number | null {
    return null;
  }

  alive(): boolean {
    return this.stream !== null;
  }

  state(): EngineState {
    const held = this.held.state();
    if (this.error && !this.busy)
      return { state: "error", message: this.error, ...held };
    if (this.busy && this.starting) return { state: "starting", ...held };
    if (this.busy) return { state: "running", ...held };
    return { state: "idle", ...held };
  }

  /**
   * The running work as its events drew it.
   *
   * OpenCode writes a step to its database when the step ends, so a read
   * mid-turn puts these over what the database has.
   */
  turns(): Turn[] {
    if (!this.busy) return [];
    return this.live.map((turn) =>
      turn.role === "assistant" ? { ...turn, blocks: [...turn.blocks] } : turn,
    );
  }

  emit(event: Json & { type: ConversationEvent["type"] }) {
    if (!this.conversation) return;
    const full = {
      ...event,
      project: this.project,
      conversation: this.conversation,
    } as ConversationEvent;
    this.deps.emit(full);
    // FE-87: orchestration follows its lead and workers through these too.
    safely(() => engineTap().event?.(full, this.folder));
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
   * Call OpenCode for this conversation.
   *
   * @throws When there is no client: the engine is not open.
   */
  private request(method: string, path: string, body?: unknown) {
    const client = this.client;
    if (!client) return Promise.reject(new Error("OpenCode is not open."));
    return client.request(method, path, body);
  }

  /** This session's path under `/api/session/`. */
  private path(rest = ""): string {
    return `/api/session/${segment(this.conversation ?? "")}${rest}`;
  }

  /**
   * Find the service, the session and its events, in that order.
   *
   * A service that moved or restarted is asked for again, once.
   */
  private async open(settings: ComposerSettings): Promise<void> {
    try {
      await this.connect(settings, false);
    } catch (error) {
      const http = error instanceof OpenCodeHttpError ? error.status : null;
      // Only a service that could not be reached, or refused the password.
      if (http !== null && http !== 401) throw error;
      this.close();
      await this.connect(settings, true);
    }
  }

  private async connect(
    settings: ComposerSettings,
    fresh: boolean,
  ): Promise<void> {
    if (!this.client) {
      const service = await this.deps.service(fresh);
      this.client = openCodeClient(service, this.folder, this.deps.fetch);
      this.checked = false;
    }
    const client = this.client;
    if (!this.conversation) {
      const created = record(
        await client.request("POST", "/api/session", {
          location: { directory: this.folder },
          agent: opencodeAgent(),
          model: modelOf(settings),
          permissions: opencodeRules(settings.permission),
        }),
      );
      const id = created.id;
      if (!isAgentSessionIdOf("opencode", id))
        throw new Error("OpenCode did not name the conversation.");
      this.conversation = id;
      this.rules = settings.permission;
      this.model = JSON.stringify(modelOf(settings));
      this.checked = true;
      this.name(id);
    } else if (!this.checked) {
      const session = record(await client.request("GET", this.path()));
      const directory =
        str(record(session.location).directory) ?? str(session.directory);
      if (directory !== null && directory !== this.folder)
        throw new Error("That conversation belongs to another folder.");
      this.checked = true;
      // Set again on the next turn: another client may have changed them.
      this.rules = null;
      this.model = null;
    }
    if (!this.stream) {
      // NOTE: Open before any prompt goes, or its first events are missed.
      this.stream = await client.events(
        (frame) => this.onFrame(frame),
        (why) => this.onStreamEnd(why),
      );
      this.emitState();
    }
  }

  /** End the client and its stream; nothing else is told. */
  private close(): void {
    const stream = this.stream;
    this.stream = null;
    stream?.close();
    this.client = null;
    this.checked = false;
  }

  /** The event stream ended on its own: the turn cannot be followed. */
  private onStreamEnd(why: string): void {
    this.stream = null;
    this.client = null;
    this.checked = false;
    if (this.busy && !this.stopping) {
      this.error = why;
      this.held.paused = this.held.length > 0;
    }
    if (this.busy) this.onTurnEnd(true);
    else this.emitState();
  }

  /** One frame of `/api/event`. */
  private onFrame(raw: unknown): void {
    const frame = frameOf(raw);
    if (!frame || !this.conversation) return;
    const { type, data } = frame;
    if (type === "session.created" || type === "session.updated") {
      const info = record(data.info);
      const id = str(info.id) ?? str(data.sessionID);
      if (id)
        this.parents.set(id, str(info.parentID) ?? str(data.parentID) ?? null);
      return;
    }
    const session =
      str(data.sessionID) ??
      str(record(data.request).sessionID) ??
      str(record(data.form).sessionID) ??
      str(record(data.info).sessionID) ??
      str(record(data.part).sessionID);
    if (!session) return;
    const interaction = type === "permission.asked" || type === "form.created";
    if (session !== this.conversation) {
      // The service tells every session's events. A sub-agent's ask is ours
      // to show; anything else of another session is not ours at all.
      if (interaction)
        void this.descends(session).then((ours) => {
          if (ours) this.onAsk(type, data, session);
        });
      return;
    }
    if (interaction) {
      this.onAsk(type, data, session);
      return;
    }
    this.onEvent(type, data);
  }

  /** Whether `session` is a sub-agent's of this conversation, at any depth. */
  private async descends(session: string): Promise<boolean> {
    const seen = new Set<string>();
    let at: string | null = session;
    while (at && !seen.has(at) && seen.size < 16) {
      if (at === this.conversation) return true;
      seen.add(at);
      if (!this.parents.has(at)) {
        const id: string = at;
        const info = record(
          await this.request("GET", `/api/session/${segment(id)}`).catch(
            () => null,
          ),
        );
        this.parents.set(id, str(info.parentID));
        if (this.parents.size > 512)
          this.parents.delete(this.parents.keys().next().value as string);
      }
      at = this.parents.get(at) ?? null;
    }
    return false;
  }

  /** One event of this conversation's own session. */
  private onEvent(type: string, data: Json): void {
    switch (type) {
      case "session.inbox.delivered": {
        const id = str(data.inboxID);
        if (!id) return;
        this.reportsDelivery = true;
        // NOTE: Kept even before it is ours: OpenCode may tell it before the
        // prompt's own request answers with its id, and a turn whose input
        // was never seen delivered would never end (FE-105). Only ids of
        // this session reach here; a few are kept.
        this.delivered.add(id);
        if (this.delivered.size > 64)
          this.delivered.delete(this.delivered.values().next().value as string);
        this.began();
        return;
      }
      case "session.execution.started":
        this.began();
        return;
      case "session.step.started": {
        this.began();
        const turn = this.stepTurn(data);
        if (!turn) return;
        const model = record(data.model);
        const provider = str(model.providerID);
        const id = str(model.id);
        if (provider && id)
          turn.turn.model = id.startsWith(`${provider}/`)
            ? id
            : `${provider}/${id}`;
        return;
      }
      case "session.step.ended":
      case "session.step.failed": {
        const turn = this.stepTurn(data);
        const message = str(data.assistantMessageID);
        const tokens = stepTokens(data.tokens);
        if (!turn || !message) return;
        if (tokens) turn.steps.set(message, tokens);
        if (type === "session.step.failed") {
          const why = errorMessage(data.error, "");
          if (why)
            turn.parts.set(`${message}:failed`, {
              type: "text",
              text: `The step failed: ${why}`,
            });
        }
        this.draw(turn);
        return;
      }
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended": {
        const turn = this.stepTurn(data);
        const message = str(data.assistantMessageID);
        if (!turn || !message) return;
        const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
        const key = `${message}:text:${ordinal}`;
        const part = turn.parts.get(key) ?? { type: "text", text: "" };
        const isNew = !turn.parts.has(key);
        if (type === "session.text.delta") {
          // A delta may be only whitespace: never trimmed.
          const delta = typeof data.delta === "string" ? data.delta : "";
          if (!delta) return;
          part.text = `${String(part.text ?? "")}${delta}`;
          turn.parts.set(key, part);
          // The page joins it to the turn's last text; a new part, or one
          // not last, is drawn whole instead.
          if (!isNew && [...turn.parts.keys()].at(-1) === key)
            this.emit({ type: "delta", text: delta });
          else this.draw(turn);
          return;
        }
        if (typeof data.text === "string") part.text = data.text;
        turn.parts.set(key, part);
        if (type === "session.text.ended") {
          if (typeof part.text === "string" && part.text.trim())
            this.lastText = part.text;
          this.draw(turn);
        } else if (isNew && part.text) this.draw(turn);
        return;
      }
      case "session.tool.input.started":
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed": {
        const turn = this.stepTurn(data);
        const id = str(data.id);
        if (!turn || !id) return;
        const before = record(turn.parts.get(`tool:${id}`));
        const state = record(before.state);
        const status =
          type === "session.tool.input.started"
            ? "pending"
            : type === "session.tool.success"
              ? "completed"
              : type === "session.tool.failed"
                ? "error"
                : "running";
        const part: Json = {
          type: "tool",
          id,
          name: str(data.name) ?? str(before.name) ?? "tool",
          state: {
            status,
            input: data.input ?? state.input ?? {},
            metadata: data.metadata ?? state.metadata,
            content: data.content ?? state.content,
            error: data.error ?? state.error,
          },
        };
        turn.parts.set(`tool:${id}`, part);
        if (type === "session.tool.called") this.tellWrites(part);
        // A progress tick changes nothing drawn.
        if (type !== "session.tool.progress") this.draw(turn);
        return;
      }
      case "session.retry.scheduled":
        // OpenCode retries by itself; the turn goes on.
        return;
      case "session.error":
        if (!this.stopping)
          this.error = errorMessage(data.error, "OpenCode failed.").slice(
            0,
            300,
          );
        return;
      case "permission.replied":
      case "form.replied":
      case "form.cancelled": {
        // Answered elsewhere (OpenCode's own TUI, another client).
        const wire =
          str(data.requestID) ?? str(data.formID) ?? str(data.id) ?? "";
        for (const [key, entry] of this.waiting)
          if (entry.wire === wire) this.settle(key);
        return;
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted":
      case "session.execution.failed":
        this.onExecutionEnd(type, data);
        return;
      case "session.idle":
        // Nothing runs and nothing waits: whatever was ours has ended.
        if (this.busy) this.finish(false);
        return;
    }
  }

  /** OpenCode began the turn: it is running, not starting. */
  private began(): void {
    if (!this.busy || !this.starting) return;
    this.starting = false;
    this.emitState();
    this.pump();
  }

  /**
   * An execution of this session ended.
   *
   * It ends the turn only when it ran a prompt of ours: a late `interrupted`
   * of a run stopped before is not the next turn's end. A prompt that came
   * in too late for it keeps the work going.
   */
  private onExecutionEnd(type: string, data: Json): void {
    if (!this.busy) return;
    const failed = type === "session.execution.failed";
    // Stopping, any end of this session is the one Stop asked for.
    if (this.reportsDelivery && this.posted.size && !this.stopping) {
      const ran = [...this.delivered].filter((id) => this.posted.has(id));
      if (!ran.length) return;
      for (const id of ran) {
        this.posted.delete(id);
        this.delivered.delete(id);
      }
      if (this.posted.size && !failed && !this.stopping) {
        // Steered after this run took its input: OpenCode runs it next.
        this.current = null;
        return;
      }
    }
    if (failed && !this.stopping)
      this.error = errorMessage(data.error, "The turn failed.").slice(0, 300);
    this.finish(failed);
  }

  /** The work ended: tell orchestration, clear the turn, let held go. */
  private finish(failed: boolean): void {
    const text = this.lastText;
    this.lastText = "";
    safely(() =>
      engineTap().result?.({
        project: this.project,
        conversation: this.conversation,
        folder: this.folder,
        text,
        error: failed,
      }),
    );
    this.onTurnEnd(false);
  }

  /** The running turn's last text, told when the turn ends. */
  private lastText = "";

  /**
   * The assistant turn a step's event belongs to, made when it is the first.
   *
   * Every step until the next prompt is the same turn, as the transcript
   * reads it.
   */
  private stepTurn(data: Json): Answering | null {
    if (!this.busy) return null;
    const message = str(data.assistantMessageID);
    if (!message) return null;
    const known = this.answering.get(message);
    if (known) return known;
    let turn = this.current;
    if (!turn) {
      const now = Date.now();
      turn = {
        turn: {
          role: "assistant",
          id: message,
          blocks: [],
          model: null,
          usage: null,
          at: new Date(now).toISOString(),
          endedAt: null,
          open: true,
        },
        parts: new Map(),
        steps: new Map(),
        firstAt: now,
      };
      this.live.push(turn.turn);
      this.current = turn;
    }
    this.answering.set(message, turn);
    return turn;
  }

  /** Draw `turn` from its parts, and send it to the page. */
  private draw(turn: Answering): void {
    turn.turn.blocks = [];
    for (const part of turn.parts.values())
      addPart(turn.turn.blocks, part, this.folder);
    turn.turn.usage = turnUsage(
      turn.steps.values(),
      (Date.now() - turn.firstAt) / 1000,
    );
    if (!turn.turn.blocks.length) return;
    this.emit({
      type: "turn",
      turn: { ...turn.turn, blocks: [...turn.turn.blocks] },
    });
  }

  /** Tell orchestration the file a tool call writes (FE-87). */
  private tellWrites(part: Json): void {
    const tap = engineTap().write;
    const tool = String(part.name).toLowerCase();
    if (!tap || !WRITE_TOOLS.has(tool)) return;
    const input = record(record(part.state).input);
    const file = str(input.filePath) ?? str(input.path);
    if (!file) return;
    const path = isAbsolute(file) ? file : join(this.folder, file);
    safely(() =>
      tap({
        project: this.project,
        conversation: this.conversation,
        folder: this.folder,
        tool,
        paths: [path],
      }),
    );
  }

  /**
   * OpenCode asks before acting, or asks a question: a card, answered later.
   *
   * Full access answers a permission itself. A form the chat cannot ask is
   * cancelled at once rather than left waiting.
   */
  private onAsk(type: string, data: Json, session: string): void {
    if (type === "permission.asked") {
      const request = record(data.request ?? data);
      const wire = str(request.id) ?? str(request.requestID);
      if (!wire) return;
      const key = `opencode-permission-${wire}`;
      if (this.waiting.has(key)) return;
      if (this.applied?.permission === "bypassPermissions") {
        void this.request(
          "POST",
          `/api/session/${segment(session)}/permission/${segment(wire)}/reply`,
          { decision: "once" },
        ).catch(() => {});
        return;
      }
      const action =
        str(request.action) ?? str(request.permission) ?? "permission";
      const resources = Array.isArray(request.resources)
        ? (request.resources as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      const summary =
        str(request.message) ??
        (resources.length ? `${action} ${resources.join(", ")}` : action);
      const permission: PermissionRequest = {
        id: key,
        tool: action,
        summary: summary.split("\n")[0]?.slice(0, 300) ?? action,
        input: cut(
          inputText({
            ...(resources.length ? { resources } : {}),
            ...record(request.metadata),
          }),
        ),
        suggestMode: null,
        questions: null,
      };
      this.permissions.set(key, permission);
      this.waiting.set(key, { kind: "permission", session, wire });
      this.emit({ type: "permission", request: permission });
      return;
    }
    const form = record(data.form ?? data);
    const wire = str(form.id);
    if (!wire) return;
    const key = `opencode-form-${wire}`;
    if (this.waiting.has(key)) return;
    const asked = formQuestions(form);
    if (!asked) {
      void this.request(
        "DELETE",
        `/api/session/${segment(session)}/form/${segment(wire)}`,
      ).catch(() => {});
      return;
    }
    const permission: PermissionRequest = {
      id: key,
      tool: "AskUserQuestion",
      summary: (
        asked.questions[0]?.question ??
        str(form.title) ??
        "OpenCode asks"
      ).slice(0, 300),
      input: "",
      suggestMode: null,
      questions: asked.questions,
    };
    this.permissions.set(key, permission);
    this.waiting.set(key, {
      kind: "form",
      session,
      wire,
      fields: asked.fields,
    });
    this.emit({ type: "permission", request: permission });
  }

  /**
   * Answer card `id`: a permission `once` or `reject`, a form's answers or
   * its cancel.
   *
   * @throws When the request was already answered.
   */
  answer(id: string, answer: PermissionAnswer): void {
    const entry = this.waiting.get(id);
    if (!entry) throw new Error("That request was already answered.");
    const allow = answer.behavior === "allow";
    const base = `/api/session/${segment(entry.session)}`;
    const sent =
      entry.kind === "permission"
        ? this.request(
            "POST",
            `${base}/permission/${segment(entry.wire)}/reply`,
            {
              decision: allow ? "once" : "reject",
              ...(!allow && answer.message?.trim()
                ? { message: answer.message.trim() }
                : {}),
            },
          )
        : allow
          ? this.request("POST", `${base}/form/${segment(entry.wire)}/reply`, {
              answer: formAnswer(entry.fields, answer.answers ?? {}),
            })
          : this.request("DELETE", `${base}/form/${segment(entry.wire)}`);
    void sent.catch((error: Error) => {
      // The ask is gone (answered elsewhere, the turn ended): nothing waits.
      if (this.busy) this.error = error.message.slice(0, 300);
    });
    this.settle(id);
  }

  /** Close the card of a request answered here, or elsewhere. */
  private settle(key: string): void {
    if (!this.permissions.has(key) && !this.waiting.has(key)) return;
    this.permissions.delete(key);
    this.waiting.delete(key);
    this.emit({ type: "permission-done", id: key });
  }

  /** Close every card: the turn they belonged to has ended. */
  private dropPermissions(): void {
    for (const key of [...this.permissions.keys()]) this.settle(key);
    this.waiting.clear();
  }

  /**
   * Refuse every ask still open, in OpenCode too: a permission `reject`, a
   * form cancelled. Before an interrupt, so nothing waits on the person
   * after the turn is gone.
   */
  private async rejectAll(): Promise<void> {
    const open = [...this.waiting.entries()];
    await Promise.all(
      open.map(([key, entry]) => {
        const base = `/api/session/${segment(entry.session)}`;
        const sent =
          entry.kind === "permission"
            ? this.request(
                "POST",
                `${base}/permission/${segment(entry.wire)}/reply`,
                { decision: "reject" },
              )
            : this.request("DELETE", `${base}/form/${segment(entry.wire)}`);
        return sent.catch(() => {}).then(() => this.settle(key));
      }),
    );
  }

  /** Clear what a turn leaves behind, its image files included. */
  private endTurn(): void {
    this.busy = false;
    this.starting = false;
    this.posted.clear();
    this.delivered.clear();
    this.live = [];
    this.answering.clear();
    this.current = null;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    for (const dir of this.dirs)
      void rm(dir, { recursive: true, force: true }).catch(() => {});
    this.dirs = [];
  }

  /**
   * A turn ended: clear it, and let what is held go.
   *
   * @param broken The stream broke: what is held waits for a send.
   */
  private onTurnEnd(broken: boolean): void {
    this.dropPermissions();
    this.endTurn();
    this.stopping = false;
    this.emitState();
    if (!broken) this.pump();
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

  /** Start {@link OpenCodeEngine.drain} unless it is already running. */
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.drain().finally(() => {
      this.pumping = false;
    });
  }

  /**
   * Send what is held, in order, for as long as OpenCode can take it.
   *
   * Idle, the head starts a turn. Busy, it steers the running turn, but only
   * once that turn has begun and with the same settings; otherwise it waits.
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
      if (
        !this.conversation ||
        !this.stream ||
        this.starting ||
        this.stopping ||
        !sameSettings(this.applied, head.settings)
      )
        return;
      this.held.items.shift();
      try {
        await this.post(head, "steer");
        head.error = null;
        this.emitState();
      } catch (error) {
        // The turn ended first: it goes as a turn of its own (FE-67/D7).
        if (!this.busy) {
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
   * Prompt OpenCode with `out`: the next turn (`queue`), or into the running
   * one (`steer`). Its user turn is drawn at once.
   */
  private async post(out: Outgoing, delivery: "queue" | "steer") {
    const { text, files, dir } = await promptOf(out.content);
    if (dir) this.dirs.push(dir);
    const user: UserTurn = {
      role: "user",
      id: out.id,
      text: out.text,
      attachments: [],
      at: new Date().toISOString(),
    };
    // Drawn before it goes: its answer's first events may come before the
    // request answers. The answer is a turn of its own, as the transcript
    // reads it.
    this.live.push(user);
    this.current = null;
    let result: Json;
    try {
      result = record(
        await this.request("POST", this.path("/prompt"), {
          text,
          ...(files.length ? { files } : {}),
          delivery,
        }),
      );
    } catch (error) {
      this.live = this.live.filter((turn) => turn !== user);
      throw error;
    }
    const id = str(result.id);
    if (id) {
      user.id = id;
      this.posted.add(id);
    }
  }

  /**
   * Start `out` as the next turn: the service, the session and its events
   * first, then the session's model and rules, then the prompt.
   *
   * @throws When the settings are off the lists, or OpenCode is missing, too
   *   old, unreachable, or refuses the turn.
   */
  async deliver(out: Outgoing): Promise<void> {
    const settings = checked(out.settings);
    this.busy = true;
    this.starting = true;
    this.stopping = false;
    this.error = null;
    this.emitState();
    try {
      await this.open(settings);
      const model = JSON.stringify(modelOf(settings));
      if (this.model !== model) {
        await this.request("POST", this.path("/model"), {
          model: modelOf(settings),
        });
        this.model = model;
      }
      if (this.rules !== settings.permission) {
        await this.request("PATCH", this.path(), {
          permissions: opencodeRules(settings.permission),
        });
        this.rules = settings.permission;
      }
      this.applied = settings;
      if (this.conversation) this.deps.remember(this.conversation, settings);
      await this.post(out, "queue");
      this.emitState();
      // Sent while this one was getting ready: it steers it once it begins.
      this.pump();
    } catch (error) {
      this.endTurn();
      this.emitState();
      this.refuse(error as Error);
      throw error;
    }
  }

  /**
   * Stop the running turn: every open ask refused, then `POST /interrupt`.
   *
   * The turn ends on OpenCode's `session.execution.interrupted`; one that
   * does not come in time ends here.
   */
  async stop(): Promise<void> {
    // What waits stays, paused (FE-67/D5): Resume or the next send lets it go.
    if (this.held.length) this.held.paused = true;
    if (!this.busy || !this.conversation || !this.client) {
      this.emitState();
      return;
    }
    this.stopping = true;
    this.emitState();
    await this.rejectAll();
    try {
      await this.request("POST", this.path("/interrupt?resume=false"));
    } catch {
      // Nothing OpenCode will end: the turn ends here.
      if (this.busy) this.onTurnEnd(false);
      return;
    }
    if (this.busy && !this.stopTimer)
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null;
        if (this.busy && this.stopping) this.onTurnEnd(false);
      }, this.deps.stopTimeoutMs ?? 10_000);
  }

  /**
   * Let go of the service: a running turn is stopped first (the rail's Stop
   * cuts it off), then the event stream is closed.
   */
  async halt(): Promise<void> {
    if (this.busy) await this.stop().catch(() => {});
    this.close();
    if (this.busy) this.onTurnEnd(true);
  }

  /**
   * App quit: OpenCode's service outlives the app, so a running turn is
   * interrupted (its asks refused) without waiting, and the stream closed.
   */
  kill(): void {
    if (this.busy && this.conversation && this.client) {
      this.stopping = true;
      const path = this.path("/interrupt?resume=false");
      void this.rejectAll()
        .then(() => this.request("POST", path))
        .catch(() => {})
        .finally(() => this.close());
      return;
    }
    this.close();
  }
}
