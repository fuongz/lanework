// A conductor's own sessions in main (see `shared/conductor-sessions.ts`).
//
// - Every chat engine's process but a worker's starts with a token of its
//   own (`envFor`). A call is taken only when that process's conversation is
//   a conductor's own (FE-95), looked up on each call: a conversation bound
//   after its process started counts, one let go of no longer does.
// - A conductor reaches only the sessions it started, kept on disk so a
//   restart does not hand them back to nobody.
// - A session started or followed up with notifyOnComplete is watched from
//   the engines' events. Once its turn ends, the conductor is sent a hidden
//   turn naming it; a conductor that is busy hears at its next idle, with
//   every report that piled up in one turn. What is watched lives in memory:
//   a restart drops the reports still owed.
//
// Nothing here imports Electron: `index.ts` hands in the engines, the
// transcripts and the marks.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  READ_CHARS_DEFAULT,
  SESSIONS_ENV,
  SESSIONS_LIST_MAX,
  SESSIONS_RUNNING_MAX,
  SESSIONS_TAG,
  type SessionAction,
  type SessionCall,
  type SessionExchange,
  type SessionInputs,
  type SessionResults,
  type SessionStatus,
  type SessionSummary,
} from "../../../shared/conductor-sessions";
import {
  agentOfModel,
  allModels,
  type ComposerSettings,
  type Conversation,
  type ConversationAgent,
  type ConversationEvent,
  checkSettings,
  DEFAULT_SETTINGS,
  type EngineState,
  type PermissionRequest,
  settingsFor,
  type Turn,
} from "../../../shared/conversation";
import { CONTROL_ENV, ControlInputError } from "../../../shared/orchestration";
import type { EngineTarget } from "../orchestration/engine-tap";
import { visibleText } from "../orchestration/prompts";
import type { Outgoing } from "./queue";

/** The engines' calls this needs. */
export interface SessionEngines {
  start(
    workspace: string,
    conversation: string,
    folder: string,
    out: Outgoing,
  ): Promise<EngineState>;
  /** A new Codex or OpenCode conversation, named by its CLI (FE-104). */
  startNamed(
    agent: Exclude<ConversationAgent, "claude">,
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
  state(workspace: string, conversation: string): Promise<EngineState>;
  permissions(workspace: string, conversation: string): PermissionRequest[];
  pending(
    workspace: string,
    conversation: string,
  ): { agent: ConversationAgent; turns: Turn[]; working: boolean } | null;
  settingsOf(conversation: string): ComposerSettings | null;
}

export interface ConductorSessionsDeps {
  engines: () => SessionEngines;
  /** The project's checkout; throws when it has none here. */
  folderOf: (workspace: string) => Promise<string>;
  /** Which CLI wrote a conversation of `folder`, or null for neither. */
  agentOf: (folder: string, id: string) => Promise<ConversationAgent | null>;
  /** A conversation of `folder`, as the chat reads it. */
  read: (folder: string, id: string) => Promise<Conversation>;
  /** The settings a conversation last ran with from the chat, or null. */
  storedSettings: (conversation: string) => Promise<ComposerSettings | null>;
  /** The conductor whose own conversation this is, or null. */
  conductorOf: (
    workspace: string,
    agent: ConversationAgent,
    id: string,
  ) => Promise<string | null>;
  /** Give a new conversation its name in the rail. */
  name: (agent: ConversationAgent, id: string, title: string) => Promise<void>;
  /** An engine in this folder runs a worker of a run. */
  isWorkerFolder: (folder: string) => boolean;
  /** The control server's endpoint, once it listens. */
  endpoint: () => string | null;
  /** The control CLI's path, for the env and the reports. */
  cliPath: string;
  /** Where the sessions each conductor started are kept. */
  file: string;
}

/** A session a conductor started. */
interface Launch {
  workspace: string;
  /** The conductor's own conversation. */
  conductor: string;
  conductorAgent: ConversationAgent;
  session: string;
  agent: ConversationAgent;
  title: string;
  model: string;
  createdAt: number;
}

/** A process's credential: the conversation it runs. */
interface Caller {
  workspace: string;
  conversation: () => string | null;
}

/** A session whose turn the conductor waits to hear about. */
interface Watch {
  launch: Launch;
  /** The turn was seen running: an idle before that is the old one's. */
  started: boolean;
}

/** A report owed to a conductor. */
interface Report {
  launch: Launch;
  error: string | null;
}

/** The most sessions kept on disk, over every conductor. */
const LAUNCHES_MAX = 400;
/** The most live process tokens; the oldest go first. */
const TOKENS_MAX = 512;
/** The most request ids remembered, so a retry is applied once. */
const REQUESTS_MAX = 200;
/** The most of a session's last reply a report carries. */
const REPORT_REPLY_MAX = 3000;

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const keyOf = (workspace: string, conversation: string) =>
  `${workspace}\0${conversation}`;

function refuse(message: string): never {
  throw new ControlInputError(message);
}

/** `text` cut to `max`, from its start or (for a reply) its end. */
function cut(text: string, max: number, fromEnd = false): string {
  if (text.length <= max) return text;
  return fromEnd ? `…${text.slice(-max)}` : `${text.slice(0, max)}…`;
}

function replyOf(turn: Turn): string {
  if (turn.role !== "assistant") return "";
  return turn.blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/** Every prompt with the answer to it, oldest first. */
function exchangesOf(turns: readonly Turn[]): SessionExchange[] {
  const out: SessionExchange[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      const prompt = visibleText(turn.text);
      if (prompt) out.push({ prompt, reply: "" });
      continue;
    }
    const last = out[out.length - 1];
    const reply = replyOf(turn);
    if (last && reply)
      last.reply = last.reply ? `${last.reply}\n\n${reply}` : reply;
  }
  return out;
}

function outgoing(text: string, settings: ComposerSettings): Outgoing {
  return {
    id: randomUUID(),
    text: visibleText(text),
    attachments: [],
    content: [{ type: "text", text }],
    settings,
  };
}

export class ConductorSessions {
  private launches: Launch[] | null = null;
  private loading: Promise<Launch[]> | null = null;
  private saving: Promise<void> = Promise.resolve();
  /** Token hash → the process it was minted for. */
  private callers = new Map<string, Caller>();
  /** Request id → its answer, so a retried call is applied once. */
  private requests = new Map<string, Promise<unknown>>();
  /** Session key → the turn its conductor waits on. */
  private watches = new Map<string, Watch>();
  /** Conductor key → the reports it is owed. */
  private reports = new Map<string, Report[]>();
  /** Conductors a report is being sent to now. */
  private sending = new Set<string>();

  constructor(private readonly deps: ConductorSessionsDeps) {}

  // ── Credentials ──

  /** The env one engine process starts with; none for a worker's. */
  envFor(target: EngineTarget): Record<string, string> | null {
    if (this.deps.isWorkerFolder(target.folder)) return null;
    const endpoint = this.deps.endpoint();
    if (!endpoint) return null;
    const token = randomBytes(32).toString("hex");
    const fixed = target.conversation;
    this.callers.set(hash(token), {
      workspace: target.workspace,
      conversation: () => fixed ?? target.named?.() ?? null,
    });
    if (this.callers.size > TOKENS_MAX)
      this.callers.delete(this.callers.keys().next().value as string);
    return {
      [CONTROL_ENV.endpoint]: endpoint,
      [SESSIONS_ENV.token]: token,
      [SESSIONS_ENV.cli]: this.deps.cliPath,
    };
  }

  /** The process a token was minted for, or null for a wrong one. */
  callerOf(token: string): Caller | null {
    if (typeof token !== "string" || token.length !== 64) return null;
    return this.callers.get(hash(token)) ?? null;
  }

  // ── Calls ──

  /**
   * Run one call for `caller`; a request id seen before answers as it did.
   *
   * @throws {ControlInputError} When the call is refused.
   */
  call(
    caller: Caller,
    call: SessionCall,
    requestId: string,
  ): Promise<SessionResults[SessionAction]> {
    // One conversation's ids never answer another's.
    const key = `${keyOf(caller.workspace, caller.conversation() ?? "")}\0${requestId}`;
    const seen = this.requests.get(key);
    if (seen) return seen as Promise<SessionResults[SessionAction]>;
    const answer = this.run(caller, call);
    this.requests.set(key, answer);
    if (this.requests.size > REQUESTS_MAX)
      this.requests.delete(this.requests.keys().next().value as string);
    // A refusal may be fixed and sent again under the same id.
    answer.catch(() => this.requests.delete(key));
    return answer;
  }

  private async run(
    caller: Caller,
    call: SessionCall,
  ): Promise<SessionResults[SessionAction]> {
    const conductor = await this.conductorOf(caller);
    switch (call.action) {
      case "sessions.start":
        return this.start(conductor, call.input);
      case "sessions.list":
        return this.list(conductor);
      case "sessions.read":
        return this.read(conductor, call.input);
      case "sessions.send":
        return this.send(conductor, call.input);
    }
  }

  /** The caller as a conductor, or refused. */
  private async conductorOf(caller: Caller): Promise<{
    workspace: string;
    conversation: string;
    agent: ConversationAgent;
  }> {
    const conversation = caller.conversation();
    if (!conversation)
      refuse("This conversation has no id yet. Try again in a moment.");
    const { workspace } = caller;
    const agent =
      this.deps.engines().pending(workspace, conversation)?.agent ??
      (await this.deps
        .agentOf(await this.deps.folderOf(workspace), conversation)
        .catch(() => null)) ??
      "claude";
    const lead = await this.deps
      .conductorOf(workspace, agent, conversation)
      .catch(() => null);
    if (!lead)
      refuse(
        "Only a conductor's own conversation can start sessions. Do the work here, or ask the user to hand it to a conductor.",
      );
    return { workspace, conversation, agent };
  }

  private async start(
    conductor: {
      workspace: string;
      conversation: string;
      agent: ConversationAgent;
    },
    input: SessionInputs["sessions.start"],
  ): Promise<SessionResults["sessions.start"]> {
    const { workspace } = conductor;
    const engines = this.deps.engines();
    const mine = (await this.all()).filter(
      (launch) =>
        launch.workspace === workspace &&
        launch.conductor === conductor.conversation,
    );
    let working = 0;
    for (const launch of mine.slice(-SESSIONS_LIST_MAX)) {
      const state = await engines.state(workspace, launch.session);
      if (state.state === "running" || state.state === "starting") working++;
    }
    if (working >= SESSIONS_RUNNING_MAX)
      refuse(
        `${working} of your sessions are still working, the most at once. Wait for one to finish, or follow one up with sessions.send.`,
      );
    const base = await this.settingsOf(conductor.conversation, conductor.agent);
    const model = input.model ?? base.model;
    if (!allModels().some((entry) => entry.id === model))
      refuse(
        `model "${model}" is not one Lanework offers. Use one of: ${allModels()
          .filter((entry) => !entry.legacy)
          .map((entry) => entry.id)
          .join(", ")}`,
      );
    const agent = agentOfModel(model);
    // NOTE: The conductor's own permission mode, never another: a session
    // it starts may not do more without asking than the conductor may.
    const settings = checkSettings({
      ...settingsFor(agent, base),
      model,
      effort: input.effort ?? base.effort,
      fast: agent === conductor.agent ? base.fast : false,
    });
    if (!settings) refuse(`model "${model}" cannot run with these settings.`);
    const folder = await this.deps.folderOf(workspace);
    const text = input.taskId
      ? `Work on ${input.taskId}.\n\n${input.prompt}`
      : input.prompt;
    const out = outgoing(text, settings);
    const launch: Omit<Launch, "session"> = {
      workspace,
      conductor: conductor.conversation,
      conductorAgent: conductor.agent,
      agent,
      title: input.title,
      model,
      createdAt: Date.now(),
    };
    let session: string;
    if (agent !== "claude") {
      session = (await engines.startNamed(agent, workspace, folder, out))
        .conversation;
      if (input.notifyOnComplete)
        await this.watch({ ...launch, session }, true);
    } else {
      session = randomUUID();
      // Watched before it starts: its turn may end before start answers.
      if (input.notifyOnComplete) this.arm({ ...launch, session }, false);
      try {
        await engines.start(workspace, session, folder, out);
      } catch (error) {
        this.watches.delete(keyOf(workspace, session));
        throw error;
      }
    }
    await this.deps.name(agent, session, input.title).catch(() => {});
    await this.remember({ ...launch, session });
    return {
      sessionId: session,
      title: input.title,
      agent,
      model,
      notifyOnComplete: input.notifyOnComplete,
    };
  }

  private async list(conductor: {
    workspace: string;
    conversation: string;
  }): Promise<SessionResults["sessions.list"]> {
    const mine = (await this.all())
      .filter(
        (launch) =>
          launch.workspace === conductor.workspace &&
          launch.conductor === conductor.conversation,
      )
      .slice(-SESSIONS_LIST_MAX)
      .reverse();
    const sessions: SessionSummary[] = [];
    for (const launch of mine)
      sessions.push({
        sessionId: launch.session,
        title: launch.title,
        agent: launch.agent,
        model: launch.model,
        status: await this.status(launch.workspace, launch.session),
        notifyOnComplete: this.watches.has(
          keyOf(launch.workspace, launch.session),
        ),
        createdAt: launch.createdAt,
      });
    return { sessions };
  }

  private async read(
    conductor: { workspace: string; conversation: string },
    input: SessionInputs["sessions.read"],
  ): Promise<SessionResults["sessions.read"]> {
    const launch = await this.own(conductor, input.sessionId);
    const turns = await this.turnsOf(launch);
    const max = input.maxChars || READ_CHARS_DEFAULT;
    return {
      sessionId: launch.session,
      title: launch.title,
      status: await this.status(launch.workspace, launch.session),
      exchanges: exchangesOf(turns)
        .slice(-input.limit)
        .map((entry) => ({
          prompt: cut(entry.prompt, max),
          reply: cut(entry.reply, max, true),
        })),
    };
  }

  private async send(
    conductor: { workspace: string; conversation: string },
    input: SessionInputs["sessions.send"],
  ): Promise<SessionResults["sessions.send"]> {
    const launch = await this.own(conductor, input.sessionId);
    const status = await this.status(launch.workspace, launch.session);
    if (status === "working" || status === "waiting")
      refuse(
        `Session ${launch.session} is ${status === "working" ? "still working" : "waiting for the user"}. Send it a follow-up once it is idle.`,
      );
    if (status === "terminal")
      refuse(
        `Session ${launch.session} is open in a terminal, which Lanework cannot send to. Ask the user to continue it there.`,
      );
    const engines = this.deps.engines();
    const settings = await this.settingsOf(launch.session, launch.agent);
    const folder = await this.deps.folderOf(launch.workspace);
    if (input.notifyOnComplete) this.arm(launch, false);
    try {
      const next = await engines.send(
        launch.workspace,
        launch.session,
        folder,
        outgoing(input.prompt, settings),
        launch.agent,
      );
      if (next.state === "terminal")
        refuse(
          `Session ${launch.session} is open in a terminal, which Lanework cannot send to.`,
        );
    } catch (error) {
      this.watches.delete(keyOf(launch.workspace, launch.session));
      throw error;
    }
    return {
      sessionId: launch.session,
      title: launch.title,
      submitted: true,
      notifyOnComplete: input.notifyOnComplete,
    };
  }

  /** One of the conductor's sessions, or refused. */
  private async own(
    conductor: { workspace: string; conversation: string },
    session: string,
  ): Promise<Launch> {
    const launch = (await this.all()).find(
      (entry) =>
        entry.workspace === conductor.workspace &&
        entry.conductor === conductor.conversation &&
        entry.session === session,
    );
    if (!launch)
      refuse(
        `Session ${session} is not one you started. sessions.list shows yours.`,
      );
    return launch;
  }

  private async status(
    workspace: string,
    session: string,
  ): Promise<SessionStatus> {
    const engines = this.deps.engines();
    const state = await engines.state(workspace, session);
    if (state.state === "terminal") return "terminal";
    if (engines.permissions(workspace, session).length) return "waiting";
    if (state.state === "running" || state.state === "starting")
      return "working";
    return state.state === "error" ? "failed" : "idle";
  }

  /** A conversation's settings: as it last ran, else its CLI's default. */
  private async settingsOf(
    conversation: string,
    agent: ConversationAgent,
  ): Promise<ComposerSettings> {
    const known =
      this.deps.engines().settingsOf(conversation) ??
      (await this.deps.storedSettings(conversation).catch(() => null));
    return settingsFor(agent, known ?? DEFAULT_SETTINGS);
  }

  private async turnsOf(launch: Launch): Promise<Turn[]> {
    const pending = this.deps
      .engines()
      .pending(launch.workspace, launch.session);
    const folder = await this.deps.folderOf(launch.workspace);
    const read = await this.deps.read(folder, launch.session).catch(() => null);
    return read?.turns.length ? read.turns : (pending?.turns ?? []);
  }

  // ── Reports ──

  /** Watch a session's turn; `started` when it is known to run already. */
  private arm(launch: Launch, started: boolean): void {
    this.watches.set(keyOf(launch.workspace, launch.session), {
      launch,
      started,
    });
  }

  /** Watch a session started already: its turn may have ended meanwhile. */
  private async watch(launch: Launch, started: boolean): Promise<void> {
    this.arm(launch, started);
    const state = await this.deps
      .engines()
      .state(launch.workspace, launch.session);
    this.onState(launch.workspace, launch.session, state);
  }

  /** Every engine event, as the chat's own listener hears it. */
  onEvent(event: ConversationEvent): void {
    if (event.type !== "state" || typeof event.conversation !== "string")
      return;
    this.onState(event.workspace, event.conversation, event.engine);
  }

  private onState(
    workspace: string,
    conversation: string,
    engine: EngineState,
  ): void {
    const key = keyOf(workspace, conversation);
    const watch = this.watches.get(key);
    if (watch) {
      if (engine.state === "running" || engine.state === "starting")
        watch.started = true;
      else if (engine.state === "terminal") this.watches.delete(key);
      else if (watch.started) {
        this.watches.delete(key);
        const { launch } = watch;
        const owed = keyOf(launch.workspace, launch.conductor);
        const list = this.reports.get(owed) ?? [];
        list.push({
          launch,
          error: engine.state === "error" ? engine.message : null,
        });
        this.reports.set(owed, list);
        void this.flush(launch.workspace, launch.conductor);
      }
    }
    if (
      (engine.state === "idle" || engine.state === "error") &&
      this.reports.has(key)
    )
      void this.flush(workspace, conversation);
  }

  /** Tell an idle conductor what its sessions did; a busy one hears later. */
  private async flush(workspace: string, conductor: string): Promise<void> {
    const key = keyOf(workspace, conductor);
    const owed = this.reports.get(key);
    if (!owed?.length || this.sending.has(key)) return;
    this.sending.add(key);
    try {
      const engines = this.deps.engines();
      const state = await engines.state(workspace, conductor);
      if (state.state !== "idle" && state.state !== "error") return;
      const taken = owed.splice(0);
      this.reports.delete(key);
      const agent = taken[0]?.launch.conductorAgent ?? "claude";
      try {
        const next = await engines.send(
          workspace,
          conductor,
          await this.deps.folderOf(workspace),
          outgoing(
            await this.reportTurn(taken),
            await this.settingsOf(conductor, agent),
          ),
          agent,
        );
        if (next.state === "terminal")
          throw new Error("its conversation is open in a terminal");
      } catch (error) {
        // Kept for its next idle.
        this.reports.set(key, [...taken, ...(this.reports.get(key) ?? [])]);
        console.error("Unable to tell a conductor about its sessions", error);
      }
    } finally {
      this.sending.delete(key);
    }
  }

  private async reportTurn(reports: readonly Report[]): Promise<string> {
    const lines: string[] = [];
    for (const { launch, error } of reports) {
      const turns = await this.turnsOf(launch).catch(() => []);
      const last = [...turns].reverse().find((turn) => replyOf(turn));
      const reply = last ? cut(replyOf(last), REPORT_REPLY_MAX, true) : "";
      lines.push(
        `- ${launch.session} "${launch.title}": ${error ? `failed: ${cut(error, 300)}` : "finished its turn"}`,
        reply
          ? `  Its last reply:\n<session_reply>\n${reply}\n</session_reply>`
          : "  It wrote no reply.",
      );
    }
    const cli = `"$${SESSIONS_ENV.cli}"`;
    return `<${SESSIONS_TAG}>
Lanework adds this note: the user did not write it and does not see it. ${reports.length === 1 ? "A session you started has" : "Sessions you started have"} stopped:
${lines.join("\n")}
Review the result (${cli} sessions.read for more), then tell the user in a few lines what was done and what is left. Do not start more work unless they asked for it.
</${SESSIONS_TAG}>`;
  }

  // ── Storage ──

  private async all(): Promise<Launch[]> {
    if (this.launches) return this.launches;
    this.loading ??= readFile(this.deps.file, "utf8")
      .then((text) => {
        const data = JSON.parse(text) as { v?: unknown; launches?: unknown };
        return data?.v === 1 && Array.isArray(data.launches)
          ? (data.launches as Launch[]).filter(
              (entry) =>
                typeof entry?.session === "string" &&
                typeof entry.conductor === "string" &&
                typeof entry.workspace === "string",
            )
          : [];
      })
      .catch(() => []);
    this.launches = await this.loading;
    return this.launches;
  }

  private async remember(launch: Launch): Promise<void> {
    const all = await this.all();
    all.push(launch);
    if (all.length > LAUNCHES_MAX) all.splice(0, all.length - LAUNCHES_MAX);
    const text = `${JSON.stringify({ v: 1, launches: all }, null, 2)}\n`;
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.deps.file), { recursive: true });
        const temp = `${this.deps.file}.${process.pid}.tmp`;
        await writeFile(temp, text, { mode: 0o600 });
        await rename(temp, this.deps.file);
      });
    await this.saving.catch((error: unknown) =>
      console.error("Unable to save a conductor's sessions", error),
    );
  }
}
