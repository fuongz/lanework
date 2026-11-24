// A conductor's own sessions in main (see `shared/conductor-sessions.ts`).
//
// - Every chat engine's process but a worker's starts with a token of its
//   own (`envFor`). A call is taken only when that process's conversation is
//   a conductor's own (FE-95), looked up on each call: a conversation bound
//   after its process started counts, one let go of no longer does.
// - A conductor reaches only the sessions it started, kept on disk so a
//   restart does not hand them back to nobody. They are the conductor's
//   (the team lead's) in a project, not one conversation's (FE-128): after
//   a Reset, its new conversation still reaches them. A launch saved before
//   that names only the conversation; it is handed to the lead that
//   conversation is bound to, while it still is.
// - The user sees a session a conductor started read-only until that
//   conductor lets them in (`userAccess` on start, `sessions.access`
//   later). The flag lives beside `launchedBy` in the session store, where
//   the rail and the page's IPC read it; the conductor's own calls here go
//   to the engines directly and never ask it.
// - Each conductor keeps a memory per project (`conductor-memory.ts`): a
//   ledger entry per session, written as it starts and as each of its turns
//   ends, and the notes it writes itself.
// - A session started or followed up with notifyOnComplete is watched from
//   the engines' events. Once its turn ends, the conductor is sent a hidden
//   turn naming it; a conductor that is busy hears at its next idle, with
//   every report that piled up in one turn. The watch and the report owed
//   are kept on the launch too (FE-133): after a restart, a session no
//   longer running is reported as cut off, and every report still owed is
//   delivered once its conductor is idle. One older than a day, or whose
//   conductor is gone, is dropped.
// - A session without user access that starts waiting on a permission
//   request waits on its conductor: the user cannot answer it. The
//   conductor is told whether or not it watches the session's turn
//   (notifyOnComplete covers turn ends only), once per request, and answers
//   it with `sessions.answer` (only it, and only while the user has no
//   access). A request is told once its report is handed over; one the user
//   could answer until `sessions.access` took that back is told then. Kept
//   in memory only: a restart ends the request.
//
// Nothing here imports Electron: `index.ts` hands in the engines, the
// transcripts, the marks and Lanework's session store (FE-112).

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MEMORY_SUMMARY_MAX,
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
  type SessionWaiting,
  WAITING_ASK_MAX,
} from "../../../shared/conductor-sessions";
import {
  AGENT_LABELS,
  agentOfModel,
  allModels,
  type ComposerSettings,
  type Conversation,
  type ConversationAgent,
  type ConversationEvent,
  checkSettings,
  DEFAULT_SETTINGS,
  type EngineState,
  PERMISSIONS,
  type PermissionAnswer,
  type PermissionRequest,
  settingsFor,
  type Turn,
} from "../../../shared/conversation";
import {
  CONDUCTOR_DEFAULTS,
  CONDUCTOR_INSTRUCTIONS,
  CONTROL_ENV,
  ControlInputError,
  LEAD_REF_PATTERN,
  type TeamLead,
  type TeamLeadInput,
} from "../../../shared/orchestration";
import type { SessionLauncher } from "../../../shared/terminal";
import { redact } from "../../hook/redact";
import type { EngineTarget } from "../orchestration/engine-tap";
import { visibleText } from "../orchestration/prompts";
import type { ConductorMemoryStore } from "./conductor-memory";
import { modelsListing } from "./models-list";
import type { Outgoing } from "./queue";

/** The engines' calls this needs. */
export interface SessionEngines {
  start(
    project: string,
    conversation: string,
    folder: string,
    out: Outgoing,
  ): Promise<EngineState>;
  /** A new Codex or OpenCode conversation, named by its CLI (FE-104). */
  startNamed(
    agent: Exclude<ConversationAgent, "claude">,
    project: string,
    folder: string,
    out: Outgoing,
  ): Promise<{ conversation: string; engine: EngineState }>;
  send(
    project: string,
    conversation: string,
    folder: string,
    out: Outgoing,
    agent?: ConversationAgent,
  ): Promise<EngineState>;
  state(project: string, conversation: string): Promise<EngineState>;
  permissions(project: string, conversation: string): PermissionRequest[];
  /**
   * Answer a permission request, as the page's answerPermission does.
   *
   * @throws When it was already answered.
   */
  answer(
    project: string,
    conversation: string,
    id: string,
    answer: PermissionAnswer,
  ): void;
  pending(
    project: string,
    conversation: string,
  ): { agent: ConversationAgent; turns: Turn[]; working: boolean } | null;
  settingsOf(conversation: string): ComposerSettings | null;
}

export interface ConductorSessionsDeps {
  engines: () => SessionEngines;
  /** The project's checkout; throws when it has none here. */
  folderOf: (project: string) => Promise<string>;
  /** Which CLI wrote a conversation of `folder`, or null for neither. */
  agentOf: (folder: string, id: string) => Promise<ConversationAgent | null>;
  /** A conversation of `folder`, as the chat reads it. */
  read: (folder: string, id: string) => Promise<Conversation>;
  /** The settings a conversation last ran with from the chat, or null. */
  storedSettings: (conversation: string) => Promise<ComposerSettings | null>;
  /** The conductor whose own conversation this is, or null. */
  conductorOf: (
    project: string,
    agent: ConversationAgent,
    id: string,
  ) => Promise<string | null>;
  /**
   * Make a conversation just started known to Lanework's session store
   * (FE-112), so the rail lists it without a Pull. Before {@link name}.
   * `launchedBy` marks it the conductor's own (FE-128): the rail hides it
   * from Agents, and the user sees it read-only without `userAccess`.
   */
  register: (
    project: string,
    agent: ConversationAgent,
    id: string,
    folder: string,
    launchedBy?: SessionLauncher,
  ) => Promise<void>;
  /**
   * A session is starting under a conductor: managed before the store has
   * its row ({@link register}), so its first turn is not the user's either.
   */
  launching?: (id: string, launchedBy: SessionLauncher | null) => void;
  /**
   * Let the user work in a session a conductor started, or take that back,
   * where `register` keeps `launchedBy`. False when the store has no such
   * session.
   */
  setUserAccess: (
    agent: ConversationAgent,
    id: string,
    userAccess: boolean,
  ) => boolean;
  /**
   * Whether the user may act on a session (send, stop, answer its
   * permissions): the page's own gate, so exactly one of the user and the
   * conductor answers a request.
   */
  userMayAct: (session: string) => Promise<boolean>;
  /**
   * The newest session of `session`'s thread (an in-place handoff), where
   * its engine runs; itself for one in no thread.
   */
  newestOf?: (session: string) => string;
  /** The head of the thread native session `session` is in; itself if none. */
  headOf?: (session: string) => string;
  /**
   * The conductor let the user into session `session`, or shut them out
   * (`sessions.access`), after the store has it: main tells the user what
   * now waits on them.
   */
  accessChanged?: (
    project: string,
    session: string,
    userAccess: boolean,
  ) => void;
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
  /**
   * Save a new personal conductor of `project`, under an id none has yet
   * (BE-01). Through the leads store, so it is checked and the rail hears.
   */
  createConductor: (
    project: string,
    input: Omit<TeamLeadInput, "id">,
  ) => Promise<TeamLead>;
  /** Each conductor's memory of each project (FE-128). */
  memory: Pick<
    ConductorMemoryStore,
    "read" | "appendNotes" | "writeNotes" | "record"
  >;
  /**
   * Make sure `agent`'s model list is read, `model` among it when it is one
   * of OpenCode's, before a session picks a model on it.
   */
  knowModels?: (agent: ConversationAgent, model?: string) => Promise<void>;
  /** A conductor of the project, for its own workers (FE-156); null if gone. */
  leadOf?: (project: string, id: string) => Promise<TeamLead | null>;
  /**
   * `thread.read` (BE-03) for the caller's own conversation: refused with an
   * error whose message is told to the caller.
   */
  readThread?: (
    project: string,
    conversation: string,
    input: SessionInputs["thread.read"],
  ) => Promise<SessionResults["thread.read"]>;
}

/** A session a conductor started. */
interface Launch {
  project: string;
  /**
   * The conductor's conversation that hears its reports: the one that
   * started it, then the last one of the same conductor that reached it.
   */
  conductor: string;
  conductorAgent: ConversationAgent;
  /**
   * The conductor (team lead id) whose session it is (FE-128). Absent on a
   * launch saved before, until {@link ConductorSessions.adopt} finds it.
   */
  conductorId?: string;
  session: string;
  agent: ConversationAgent;
  title: string;
  model: string;
  /** The board card `sessions.start` named. */
  taskId?: string;
  createdAt: number;
  /**
   * Its turn the conductor waits to hear about (FE-133), kept so a restart
   * still reports it. Absent on a launch saved before: nothing watched.
   */
  notify?: Notify | null;
  /** The report it owes its conductor, not yet handed over (FE-133). */
  owed?: Owed | null;
}

/** A watch, as saved. */
interface Notify {
  started: boolean;
  /** When it was armed. */
  since: number;
}

/** A report owed, as saved. */
interface Owed {
  error: string | null;
  /** The app restarted while the turn ran: it may be incomplete. */
  cut: boolean;
  /** When it became owed. */
  since: number;
}

/** The caller, as the conductor it is. */
interface Conductor {
  project: string;
  /** The caller's own conversation. */
  conversation: string;
  agent: ConversationAgent;
  /** Its team lead's id. */
  id: string;
}

/** A process's credential: the conversation it runs. */
interface Caller {
  project: string;
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
  cut: boolean;
  /** Its saved form: cleared from the launch once handed over. */
  owed: Owed;
  /**
   * Not a turn's end: the session waits on this permission request. Never
   * saved on the launch: the request ends with the app.
   */
  waiting?: SessionWaiting;
}

/** The most sessions kept on disk, over every conductor. */
const LAUNCHES_MAX = 400;
/** The most live process tokens; the oldest go first. */
const TOKENS_MAX = 512;
/** The most request ids remembered, so a retry is applied once. */
const REQUESTS_MAX = 200;
/** The most permission requests remembered as told, over every session. */
const TOLD_MAX = 500;
/** The most of a session's last reply a report carries. */
const REPORT_REPLY_MAX = 3000;
/** A saved watch or report older than this is dropped at startup. */
const OWED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const keyOf = (project: string, conversation: string) =>
  `${project}\0${conversation}`;

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isNotify(value: unknown): value is Notify {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<Notify>;
  return typeof entry.started === "boolean" && isTime(entry.since);
}

function isOwed(value: unknown): value is Owed {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<Owed>;
  return (
    (entry.error === null || typeof entry.error === "string") &&
    typeof entry.cut === "boolean" &&
    isTime(entry.since)
  );
}

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

/**
 * A permission request as `sessions.read` lists it: what it asks on one
 * line, as the awaiting notice words it (the first question, else the
 * summary), redacted and cut to {@link WAITING_ASK_MAX}.
 */
export function waitingOf(request: PermissionRequest): SessionWaiting {
  const question = request.questions?.[0]?.question;
  const text = redact(
    question ? `Question: ${question}` : request.summary || request.tool,
  )
    .replace(/\s+/g, " ")
    .trim();
  return {
    requestId: request.id,
    tool: request.tool,
    ask:
      text.length > WAITING_ASK_MAX
        ? `${text.slice(0, WAITING_ASK_MAX - 1).trimEnd()}…`
        : text,
  };
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
  /**
   * Permission requests a conductor was told its session waits on, by
   * session key and request id ({@link toldKey}): never told twice.
   *
   * NOTE: Marked once the report is handed over, never on sight: a request
   * the user could answer when it came, or whose report was dropped since,
   * is told when it waits on the conductor again.
   */
  private told = new Set<string>();
  /**
   * Requests being looked up, or whose report waits in line, by the same
   * key: an event repeated meanwhile owes nothing more.
   */
  private telling = new Set<string>();
  /** Conductors a report is being sent to now. */
  private sending = new Set<string>();
  /** Session key → its turn was seen running: the memory hears its end. */
  private running = new Set<string>();
  /** Launches whose conversation no conductor holds: not asked again. */
  private unresolved = new Set<Launch>();
  /** The one {@link adopt} pass running now. */
  private adopting: Promise<void> | null = null;
  /** The one {@link restore} pass, run once at startup. */
  private restoring: Promise<void> | null = null;
  /**
   * Conductor conversations the user stopped, by key: a report owed to one
   * waits until it runs again, so it never starts it by itself.
   */
  private held = new Set<string>();

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
      project: target.project,
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
    const key = `${keyOf(caller.project, caller.conversation() ?? "")}\0${requestId}`;
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
    // Any conversation the app started may save a conductor: it is the
    // user's own, and nothing runs until they open it (PD-04).
    if (call.action === "conductors.create")
      return this.createConductor(caller, call.input);
    // Any conversation may ask which models a proposal may name (FE-156);
    // a conductor's own also gets its workers and how its runs went.
    if (call.action === "models.list") return this.models(caller, call.input);
    // Any conversation may read back its own thread (BE-03).
    if (call.action === "thread.read") {
      const conversation = caller.conversation();
      if (!conversation)
        refuse("This conversation has no id yet. Try again in a moment.");
      if (!this.deps.readThread) refuse("thread.read is not available here.");
      try {
        return await this.deps.readThread(
          caller.project,
          conversation,
          call.input,
        );
      } catch (error) {
        refuse(error instanceof Error ? error.message : String(error));
      }
    }
    const memory =
      call.action === "memory.read" ||
      call.action === "memory.append" ||
      call.action === "memory.write";
    const conductor = await this.conductorOf(
      caller,
      memory
        ? "Only a conductor's own conversation has a memory. Keep what matters in this conversation, or ask the user to hand the work to a conductor."
        : "Only a conductor's own conversation can start sessions. Do the work here, or ask the user to hand it to a conductor.",
    );
    switch (call.action) {
      case "sessions.start":
        return this.start(conductor, call.input);
      case "sessions.list":
        return this.list(conductor);
      case "sessions.read":
        return this.read(conductor, call.input);
      case "sessions.send":
        return this.send(conductor, call.input);
      case "sessions.access":
        return this.access(conductor, call.input);
      case "sessions.answer":
        return this.answer(conductor, call.input);
      case "memory.read":
        return this.deps.memory.read(conductor.project, conductor.id);
      case "memory.append":
        return this.deps.memory.appendNotes(
          conductor.project,
          conductor.id,
          call.input.text,
        );
      case "memory.write":
        return this.deps.memory.writeNotes(
          conductor.project,
          conductor.id,
          call.input.notes,
        );
    }
  }

  /** `models.list`: the catalog, or the conductor's own workers. */
  private async models(
    caller: Caller,
    input: SessionInputs["models.list"],
  ): Promise<SessionResults["models.list"]> {
    const conductor = await this.conductorOf(caller, "").catch(() => null);
    await Promise.all(
      (["codex", "opencode"] as const).map((agent) =>
        this.deps.knowModels?.(agent).catch(() => {}),
      ),
    );
    const [lead, memory] = conductor
      ? await Promise.all([
          this.deps.leadOf?.(conductor.project, conductor.id) ?? null,
          this.deps.memory
            .read(conductor.project, conductor.id)
            .catch(() => null),
        ])
      : [null, null];
    return modelsListing({
      input,
      catalog: allModels(),
      lead: lead ?? null,
      runs: memory?.runs ?? [],
    });
  }

  /**
   * Save a conductor of the caller's project. Its project is the token's,
   * never one the agent names; agent, model and effort default to the
   * caller's own.
   */
  private async createConductor(
    caller: Caller,
    input: SessionInputs["conductors.create"],
  ): Promise<SessionResults["conductors.create"]> {
    const { project } = caller;
    const conversation = caller.conversation();
    const folder = await this.deps.folderOf(project).catch(() => null);
    if (!folder)
      refuse(
        "This project has no folder on this machine any more. Link it again in Lanework, then retry.",
      );
    const callerAgent = conversation
      ? (this.deps.engines().pending(project, conversation)?.agent ??
        (await this.deps.agentOf(folder, conversation).catch(() => null)) ??
        "claude")
      : null;
    const mine = conversation
      ? await this.settingsOf(conversation, callerAgent ?? "claude")
      : DEFAULT_SETTINGS;
    // A conductor runs on Claude or Codex (FE-105): an OpenCode caller's
    // conductor defaults to Claude.
    const agent = input.agent ?? (callerAgent === "codex" ? "codex" : "claude");
    const same = callerAgent === agent;
    const base = settingsFor(agent, same ? mine : DEFAULT_SETTINGS);
    const model = input.model ?? base.model;
    const offered = allModels().filter(
      (entry) => entry.agent === agent && !entry.legacy,
    );
    if (
      !allModels().some((entry) => entry.id === model && entry.agent === agent)
    )
      refuse(
        `model "${model}" is not a ${agent} model Lanework offers. Use one of: ${offered
          .map((entry) => entry.id)
          .join(", ")}`,
      );
    // NOTE: Never more than the caller may do without asking, as with
    // sessions.start: a conversation cannot hand a looser mode to the
    // conductor it saves.
    const permission = input.permission ?? null;
    if (
      permission &&
      PERMISSIONS.indexOf(permission) > PERMISSIONS.indexOf(mine.permission)
    )
      refuse(
        `permission "${permission}" allows more than this conversation's own "${mine.permission}". Leave it out, or ask the user to set it in the conductor's settings.`,
      );
    let lead: TeamLead;
    try {
      lead = await this.deps.createConductor(project, {
        name: input.name,
        icon: input.icon ?? "Robot02Icon",
        lead: {
          agent,
          model,
          effort: input.effort ?? (same ? mine.effort : null),
        },
        instructions: input.instructions ?? CONDUCTOR_INSTRUCTIONS,
        contextFiles: input.contextFiles ?? [],
        workers: [...CONDUCTOR_DEFAULTS.workers],
        maxWorkers: CONDUCTOR_DEFAULTS.maxWorkers,
        checks: [...CONDUCTOR_DEFAULTS.checks],
        jev: null,
        permission,
      });
    } catch (error) {
      // The store's refusals (a full project, a bad field) do not change
      // on a retry of the same call.
      refuse(error instanceof Error ? error.message : String(error));
    }
    return {
      id: lead.id,
      name: lead.name,
      icon: lead.icon,
      agent: lead.lead.agent as "claude" | "codex",
      model: lead.lead.model,
      effort: lead.lead.effort,
      contextFiles: lead.contextFiles,
      permission: lead.permission,
    };
  }

  /** The caller as a conductor, or refused with `refusal`. */
  private async conductorOf(
    caller: Caller,
    refusal: string,
  ): Promise<Conductor> {
    const conversation = caller.conversation();
    if (!conversation)
      refuse("This conversation has no id yet. Try again in a moment.");
    const { project } = caller;
    const agent =
      this.deps.engines().pending(project, conversation)?.agent ??
      (await this.deps
        .agentOf(await this.deps.folderOf(project), conversation)
        .catch(() => null)) ??
      "claude";
    const id = await this.deps
      .conductorOf(project, agent, conversation)
      .catch(() => null);
    if (!id) refuse(refusal);
    return { project, conversation, agent, id };
  }

  /**
   * The conductor's sessions in its project, oldest first: every launch of
   * its lead, and an old one only its conversation names. Each one it
   * reaches reports to this conversation from now on.
   */
  private async mine(conductor: Conductor): Promise<Launch[]> {
    await this.adopt();
    const out: Launch[] = [];
    let moved = false;
    for (const launch of await this.all()) {
      if (launch.project !== conductor.project) continue;
      if (!launch.conductorId && launch.conductor === conductor.conversation) {
        // Saved before FE-128, by the conversation calling now.
        launch.conductorId = conductor.id;
        this.unresolved.delete(launch);
        moved = true;
      }
      if (launch.conductorId !== conductor.id) continue;
      if (launch.conductor !== conductor.conversation) {
        // A Reset gave the conductor a new conversation: it hears now.
        launch.conductor = conductor.conversation;
        launch.conductorAgent = conductor.agent;
        moved = true;
      }
      out.push(launch);
    }
    if (moved) await this.save();
    return out;
  }

  /**
   * The sessions conductor `conductorId` started in `project`, oldest
   * first, whatever conversation of it started them.
   */
  async sessionsOf(project: string, conductorId: string): Promise<string[]> {
    await this.adopt();
    return (await this.all())
      .filter(
        (launch) =>
          launch.project === project && launch.conductorId === conductorId,
      )
      .map((launch) => launch.session);
  }

  /**
   * Before Stop ends a conductor's engines: no turn of its sessions is
   * watched any more, and no report goes to `conversations`, or to any
   * conversation its sessions report to, until that one runs again. The
   * reports owed stay owed: its next turn's end hands them over. The memory
   * still hears each session's end.
   */
  async hold(
    project: string,
    conductorId: string,
    conversations: readonly string[],
  ): Promise<void> {
    await this.adopt();
    for (const conversation of conversations)
      this.held.add(keyOf(project, conversation));
    let moved = false;
    for (const launch of await this.all()) {
      if (launch.project !== project || launch.conductorId !== conductorId)
        continue;
      this.held.add(keyOf(project, launch.conductor));
      const key = keyOf(project, launch.session);
      if (!this.watches.delete(key) && !launch.notify) continue;
      launch.notify = null;
      moved = true;
    }
    if (moved) await this.save();
  }

  /**
   * Hand every launch saved before FE-128 to the conductor its conversation
   * is bound to now, and save what moved. Main runs it once at startup, so
   * a Reset after an upgrade does not cut a conductor off its old sessions;
   * {@link mine} runs it again for any it could not place then.
   */
  adopt(): Promise<void> {
    this.adopting ??= (async () => {
      let moved = false;
      for (const launch of await this.all()) {
        if (launch.conductorId || this.unresolved.has(launch)) continue;
        const id = await this.deps
          .conductorOf(launch.project, launch.conductorAgent, launch.conductor)
          .catch(() => null);
        if (id) {
          launch.conductorId = id;
          moved = true;
        } else this.unresolved.add(launch);
      }
      if (moved) await this.save();
    })().finally(() => {
      this.adopting = null;
    });
    return this.adopting;
  }

  /**
   * The CLI and model a new session runs on: `agent` when given, else the
   * model's CLI, else the conductor's own; the model when given, else the
   * conductor's own on its CLI, else that CLI's default.
   */
  private async pickModel(
    conductor: Conductor,
    base: ComposerSettings,
    input: SessionInputs["sessions.start"],
  ): Promise<{ agent: ConversationAgent; model: string }> {
    const agent =
      input.agent ??
      (input.model ? agentOfModel(input.model) : conductor.agent);
    await this.deps.knowModels?.(agent, input.model).catch(() => {});
    const offered = () =>
      allModels()
        .filter((entry) => entry.agent === agent && !entry.legacy)
        .map((entry) => entry.id)
        .join(", ");
    if (input.model && agentOfModel(input.model) !== agent)
      refuse(
        `model "${input.model}" is not a ${AGENT_LABELS[agent]} model. Leave it out for ${AGENT_LABELS[agent]}'s default, or use one of: ${offered()}`,
      );
    const model = input.model ?? settingsFor(agent, base).model;
    if (!model)
      refuse(
        `Lanework does not know ${AGENT_LABELS[agent]}'s models yet. Pass "model" as provider/model, or try again in a moment.`,
      );
    if (
      !allModels().some((entry) => entry.id === model && entry.agent === agent)
    )
      refuse(
        `model "${model}" is not a ${AGENT_LABELS[agent]} model Lanework offers. Use one of: ${offered()}`,
      );
    return { agent, model };
  }

  private async start(
    conductor: Conductor,
    input: SessionInputs["sessions.start"],
  ): Promise<SessionResults["sessions.start"]> {
    const { project } = conductor;
    const engines = this.deps.engines();
    const mine = await this.mine(conductor);
    let working = 0;
    for (const launch of mine.slice(-SESSIONS_LIST_MAX)) {
      const state = await engines.state(project, launch.session);
      if (state.state === "running" || state.state === "starting") working++;
    }
    if (working >= SESSIONS_RUNNING_MAX)
      refuse(
        `${working} of your sessions are still working, the most at once. Wait for one to finish, or follow one up with sessions.send.`,
      );
    const base = await this.settingsOf(conductor.conversation, conductor.agent);
    const { agent, model } = await this.pickModel(conductor, base, input);
    // NOTE: The conductor's own permission mode, never another: a session
    // it starts may not do more without asking than the conductor may.
    const settings = checkSettings({
      ...settingsFor(agent, base),
      model,
      effort: input.effort ?? base.effort,
      fast: agent === conductor.agent ? base.fast : false,
    });
    if (!settings) refuse(`model "${model}" cannot run with these settings.`);
    const folder = await this.deps.folderOf(project);
    const text = input.taskId
      ? `Work on ${input.taskId}.\n\n${input.prompt}`
      : input.prompt;
    const out = outgoing(text, settings);
    // FE-166: a session inherits what its conductor turned off, fixed when
    // its process starts. A Claude session is found by the engine through
    // `launching` below (its id is known now). A new Codex conversation is
    // named by its CLI after the process started, so its list travels with
    // the first turn. OpenCode runs on the shared service: nothing to apply.
    if (agent === "codex") {
      const disabled = (
        await this.deps.leadOf?.(project, conductor.id).catch(() => null)
      )?.connectors?.disabled;
      if (disabled?.length) out.connectors = disabled;
    }
    const fields: Omit<Launch, "session"> = {
      project,
      conductor: conductor.conversation,
      conductorAgent: conductor.agent,
      conductorId: conductor.id,
      agent,
      title: input.title,
      model,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      createdAt: Date.now(),
    };
    const launcher: SessionLauncher = {
      conductor: conductor.id,
      project,
      userAccess: input.userAccess,
    };
    let launch: Launch;
    if (agent !== "claude") {
      const session = (await engines.startNamed(agent, project, folder, out))
        .conversation;
      // NOTE: Named only once its CLI answered: managed from that moment.
      this.deps.launching?.(session, launcher);
      launch = { ...fields, session };
      // Its first turn was submitted: the memory hears when it ends.
      this.running.add(keyOf(project, session));
      // Its first entry before any turn end can overwrite it.
      await this.note(launch, "working", "");
      if (input.notifyOnComplete) await this.watch(launch, true);
    } else {
      launch = { ...fields, session: randomUUID() };
      this.deps.launching?.(launch.session, launcher);
      // Watched before it starts: its turn may end before start answers.
      if (input.notifyOnComplete) this.arm(launch, false);
      this.running.add(keyOf(project, launch.session));
      await this.note(launch, "working", "");
      try {
        await engines.start(project, launch.session, folder, out);
      } catch (error) {
        this.unwatch(keyOf(project, launch.session));
        this.running.delete(keyOf(project, launch.session));
        this.deps.launching?.(launch.session, null);
        await this.note(launch, "failed", "");
        throw error;
      }
    }
    const { session } = launch;
    // The store has its row now: it answers from here on, access changes
    // included.
    await this.deps
      .register(project, agent, session, folder, launcher)
      .then(() => this.deps.launching?.(session, null))
      .catch(() => {});
    await this.deps.name(agent, session, input.title).catch(() => {});
    await this.remember(launch);
    // Unwatched, its turn may have ended before it was remembered.
    if (!input.notifyOnComplete)
      this.onState(project, session, await engines.state(project, session));
    // A request asked before it was remembered found no launch.
    await this.askedBefore(launch);
    return {
      sessionId: session,
      title: input.title,
      agent,
      model,
      notifyOnComplete: input.notifyOnComplete,
      userAccess: input.userAccess,
    };
  }

  private async list(
    conductor: Conductor,
  ): Promise<SessionResults["sessions.list"]> {
    const mine = (await this.mine(conductor))
      .slice(-SESSIONS_LIST_MAX)
      .reverse();
    const sessions: SessionSummary[] = [];
    for (const launch of mine)
      sessions.push({
        sessionId: launch.session,
        title: launch.title,
        agent: launch.agent,
        model: launch.model,
        status: await this.status(launch.project, launch.session),
        notifyOnComplete: this.watches.has(
          keyOf(launch.project, launch.session),
        ),
        createdAt: launch.createdAt,
      });
    return { sessions };
  }

  private async read(
    conductor: Conductor,
    input: SessionInputs["sessions.read"],
  ): Promise<SessionResults["sessions.read"]> {
    const launch = await this.own(conductor, input.sessionId);
    const turns = await this.turnsOf(launch);
    const max = input.maxChars || READ_CHARS_DEFAULT;
    return {
      sessionId: launch.session,
      title: launch.title,
      status: await this.status(launch.project, launch.session),
      exchanges: exchangesOf(turns)
        .slice(-input.limit)
        .map((entry) => ({
          prompt: cut(entry.prompt, max),
          reply: cut(entry.reply, max, true),
        })),
      waiting: this.deps
        .engines()
        .permissions(launch.project, this.newest(launch.session))
        .map(waitingOf),
    };
  }

  private async send(
    conductor: Conductor,
    input: SessionInputs["sessions.send"],
  ): Promise<SessionResults["sessions.send"]> {
    const launch = await this.own(conductor, input.sessionId);
    const status = await this.status(launch.project, launch.session);
    if (status === "working")
      refuse(
        `Session ${launch.session} is still working. Send it a follow-up once it is idle.`,
      );
    if (status === "waiting")
      refuse(
        (await this.deps.userMayAct(launch.session))
          ? `Session ${launch.session} is waiting for the user to answer a permission request. Send it a follow-up once it is idle.`
          : `Session ${launch.session} waits on you to answer a permission request. sessions.read lists it; answer it with sessions.answer.`,
      );
    if (status === "terminal")
      refuse(
        `Session ${launch.session} is open in a terminal, which Lanework cannot send to. Ask the user to continue it there.`,
      );
    const engines = this.deps.engines();
    const settings = await this.settingsOf(launch.session, launch.agent);
    const folder = await this.deps.folderOf(launch.project);
    if (input.notifyOnComplete) this.arm(launch, false);
    try {
      const next = await engines.send(
        launch.project,
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
      this.unwatch(keyOf(launch.project, launch.session));
      throw error;
    }
    return {
      sessionId: launch.session,
      title: launch.title,
      submitted: true,
      notifyOnComplete: input.notifyOnComplete,
    };
  }

  /**
   * `sessions.access`: let the user work in one of the conductor's
   * sessions, or take that back. Only the conductor that started it may: a
   * session another conductor started, or the user did, is not its to open.
   */
  private async access(
    conductor: Conductor,
    input: SessionInputs["sessions.access"],
  ): Promise<SessionResults["sessions.access"]> {
    const launch = await this.own(
      conductor,
      input.sessionId,
      `Session ${input.sessionId} is not one you started, so who may work in it is not yours to change. sessions.list shows yours.`,
    );
    if (
      !this.deps.setUserAccess(launch.agent, launch.session, input.userAccess)
    )
      refuse(
        `Lanework no longer has session ${launch.session}. sessions.list shows the ones it still has.`,
      );
    // NOTE: A request asked while the user had access was theirs, so the
    // conductor was never told: now it is the conductor's, it is told. One
    // granted is left to `flush`, which drops what the user answers now.
    if (!input.userAccess) await this.askedBefore(launch);
    this.deps.accessChanged?.(launch.project, launch.session, input.userAccess);
    return {
      sessionId: launch.session,
      title: launch.title,
      userAccess: input.userAccess,
    };
  }

  /**
   * `sessions.answer`: allow or deny a permission request one of the
   * conductor's sessions waits on. Only the conductor that started it may,
   * and only while the user has no access: with access, the user answers
   * it. A question is the user's to answer: allow alone cannot, so only a
   * deny is taken.
   */
  private async answer(
    conductor: Conductor,
    input: SessionInputs["sessions.answer"],
  ): Promise<SessionResults["sessions.answer"]> {
    const launch = await this.own(
      conductor,
      input.sessionId,
      `Session ${input.sessionId} is not one you started, so its permissions are not yours to answer. sessions.list shows yours.`,
    );
    if (await this.deps.userMayAct(launch.session))
      refuse(
        `The user has access to session ${launch.session} and answers its permissions themselves. Leave it to them, or take access back with sessions.access first.`,
      );
    const engines = this.deps.engines();
    const native = this.newest(launch.session);
    const stale = `Session ${launch.session} does not wait on request ${input.requestId}: it was answered, or its turn ended. sessions.read lists what it waits on now.`;
    const request = engines
      .permissions(launch.project, native)
      .find((entry) => entry.id === input.requestId);
    if (!request) refuse(stale);
    if (request.questions && input.allow)
      refuse(
        `Request ${request.id} is a question (${request.tool}) that waits on an answer, which allow alone cannot give. Deny it with a message that tells the session how to go on, or give the user access with sessions.access so they answer it.`,
      );
    const answer: PermissionAnswer = input.allow
      ? { behavior: "allow" }
      : {
          behavior: "deny",
          // NOTE: Not the engine's default ("The user denied this."): the
          // user never saw it.
          message: input.message ?? "The conductor that started you denied it.",
        };
    try {
      engines.answer(launch.project, native, request.id, answer);
    } catch {
      // Answered, or the engine closed, since it was looked up.
      refuse(stale);
    }
    return {
      sessionId: launch.session,
      title: launch.title,
      requestId: request.id,
      allow: input.allow,
    };
  }

  /** The session a launch's thread runs on now: its newest. */
  private newest(session: string): string {
    return this.deps.newestOf?.(session) ?? session;
  }

  /** One of the conductor's sessions, or refused with `refusal`. */
  private async own(
    conductor: Conductor,
    session: string,
    refusal = `Session ${session} is not one you started. sessions.list shows yours.`,
  ): Promise<Launch> {
    const launch = (await this.mine(conductor)).find(
      (entry) => entry.session === session,
    );
    if (!launch) refuse(refusal);
    return launch;
  }

  private async status(
    project: string,
    session: string,
  ): Promise<SessionStatus> {
    const engines = this.deps.engines();
    const state = await engines.state(project, session);
    if (state.state === "terminal") return "terminal";
    if (engines.permissions(project, this.newest(session)).length)
      return "waiting";
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
    const pending = this.deps.engines().pending(launch.project, launch.session);
    const folder = await this.deps.folderOf(launch.project);
    const read = await this.deps.read(folder, launch.session).catch(() => null);
    return read?.turns.length ? read.turns : (pending?.turns ?? []);
  }

  // ── Reports ──

  /**
   * Watch a session's turn; `started` when it is known to run already. The
   * watch is saved on the launch, so a restart still reports it.
   */
  private arm(launch: Launch, started: boolean, since = Date.now()): void {
    this.watches.set(keyOf(launch.project, launch.session), {
      launch,
      started,
    });
    launch.notify = { started, since };
    void this.save();
  }

  /** Stop watching a session's turn, on disk too. */
  private unwatch(key: string): void {
    const watch = this.watches.get(key);
    if (!watch) return;
    this.watches.delete(key);
    watch.launch.notify = null;
    void this.save();
  }

  /** Watch a session started already: its turn may have ended meanwhile. */
  private async watch(launch: Launch, started: boolean): Promise<void> {
    this.arm(launch, started);
    const engines = this.deps.engines();
    const state = await engines.state(launch.project, launch.session);
    this.onState(launch.project, launch.session, state);
    // A request asked before the watch was armed was not heard.
    await this.askedBefore(launch);
  }

  /**
   * Hear again every request `launch`'s session waits on now: one asked
   * before the session was known here, or while the user had access.
   * {@link onPermission} tells each one once.
   */
  private async askedBefore(launch: Launch): Promise<void> {
    const native = this.newest(launch.session);
    for (const request of this.deps
      .engines()
      .permissions(launch.project, native))
      await this.onPermission(launch.project, native, request);
  }

  /**
   * Owe `launch`'s conductor a report, on disk too. The watch it ends (if
   * any) is cleared in the same write, so a restart never sees both or
   * neither.
   */
  private owe(launch: Launch, error: string | null, cut: boolean): void {
    const owed: Owed = { error, cut, since: Date.now() };
    const key = keyOf(launch.project, launch.conductor);
    const list = this.reports.get(key) ?? [];
    list.push({ launch, error, cut, owed });
    this.reports.set(key, list);
    launch.owed = owed;
    void this.save();
  }

  /** Every engine event, as the chat's own listener hears it. */
  onEvent(event: ConversationEvent): void {
    if (typeof event.conversation !== "string") return;
    if (event.type === "permission")
      void this.onPermission(event.project, event.conversation, event.request);
    if (event.type !== "state") return;
    this.onState(event.project, event.conversation, event.engine);
  }

  /**
   * A session asks for a permission. Its conductor is told when the user
   * has no access, so nobody else answers it; watched or not, since
   * notifyOnComplete is about the turn's end and a request left waiting
   * stalls the session for good. Once per request ({@link told}).
   *
   * @param native The session that asks: a thread's newest, named by its
   *   head here.
   */
  private async onPermission(
    project: string,
    native: string,
    request: PermissionRequest,
  ): Promise<void> {
    const session = this.deps.headOf?.(native) ?? native;
    const key = keyOf(project, session);
    const told = `${key}\0${request.id}`;
    if (this.told.has(told) || this.telling.has(told)) return;
    // NOTE: Held before the lookups: an event repeated meanwhile is not
    // owed twice. Let go of below unless a report is owed.
    this.telling.add(told);
    let launch: Launch | undefined;
    try {
      launch =
        this.watches.get(key)?.launch ??
        (await this.all()).find(
          (entry) => entry.project === project && entry.session === session,
        );
      if (
        !launch ||
        (await this.deps.userMayAct(launch.session).catch(() => true))
      )
        launch = undefined;
    } finally {
      if (!launch) this.telling.delete(told);
    }
    if (!launch) return;
    const target = keyOf(project, launch.conductor);
    const list = this.reports.get(target) ?? [];
    list.push({
      launch,
      error: null,
      cut: false,
      // NOTE: Never set on the launch: `flush` clears only what is.
      owed: { error: null, cut: false, since: Date.now() },
      waiting: waitingOf(request),
    });
    this.reports.set(target, list);
    void this.flush(project, launch.conductor);
  }

  /** A request's key in {@link told} and {@link telling}. */
  private toldKey(launch: Launch, requestId: string): string {
    return `${keyOf(launch.project, launch.session)}\0${requestId}`;
  }

  /**
   * The report is still news: a turn's end always is; a request only while
   * the session waits on it and the user still cannot answer it.
   */
  private async stillOwed(report: Report): Promise<boolean> {
    const { launch, waiting } = report;
    if (!waiting) return true;
    const pending = this.deps
      .engines()
      .permissions(launch.project, this.newest(launch.session))
      .some((entry) => entry.id === waiting.requestId);
    return (
      pending && !(await this.deps.userMayAct(launch.session).catch(() => true))
    );
  }

  private onState(
    project: string,
    conversation: string,
    engine: EngineState,
  ): void {
    const key = keyOf(project, conversation);
    // A stopped conductor that runs again was sent a message: what it is
    // owed goes when that turn ends.
    if (engine.state === "running" || engine.state === "starting")
      this.held.delete(key);
    const watch = this.watches.get(key);
    // The memory hears every turn end of a session a conductor started,
    // watched or not.
    const launch = watch?.launch ?? this.known(project, conversation);
    if (launch) {
      if (engine.state === "running" || engine.state === "starting")
        this.running.add(key);
      else if (engine.state === "terminal") this.running.delete(key);
      else if (this.running.delete(key) || watch?.started)
        void this.noteEnd(launch);
    }
    if (watch) {
      if (engine.state === "running" || engine.state === "starting") {
        if (!watch.started) {
          watch.started = true;
          // Saved once, as it flips: not on every state event.
          if (watch.launch.notify) {
            watch.launch.notify.started = true;
            void this.save();
          }
        }
      } else if (engine.state === "terminal") this.unwatch(key);
      else if (watch.started) {
        this.watches.delete(key);
        const { launch } = watch;
        launch.notify = null;
        this.owe(
          launch,
          engine.state === "error" ? engine.message : null,
          false,
        );
        void this.flush(launch.project, launch.conductor);
      }
    }
    if (
      (engine.state === "idle" || engine.state === "error") &&
      this.reports.has(key)
    )
      void this.flush(project, conversation);
  }

  /**
   * Pick up, once at startup, what the app owed when it last quit (FE-133):
   * every saved report goes back in line, and every saved watch is armed
   * again. A watched session no longer running had its turn end, or cut,
   * while the app was down: it is reported as cut off. One older than
   * {@link OWED_MAX_AGE_MS}, or whose conductor is gone, is dropped. Then
   * each conductor concerned hears, if it is idle.
   *
   * Main runs it after {@link adopt}, once the engines answer state.
   */
  restore(): Promise<void> {
    this.restoring ??= (async () => {
      await this.adopt();
      const engines = this.deps.engines();
      const now = Date.now();
      const conductors = new Map<
        string,
        { project: string; conductor: string }
      >();
      let moved = false;
      for (const launch of [...(await this.all())]) {
        if (!launch.notify && !launch.owed) continue;
        const fresh = (since: number) => now - since <= OWED_MAX_AGE_MS;
        if (launch.notify && !fresh(launch.notify.since)) {
          launch.notify = null;
          moved = true;
        }
        if (launch.owed && !fresh(launch.owed.since)) {
          launch.owed = null;
          moved = true;
        }
        if (!launch.notify && !launch.owed) continue;
        // NOTE: The conductor must still exist and still hold the
        // conversation the report goes to; a Reset since then hands the
        // session to its new conversation, which reads it with
        // sessions.list.
        const id = launch.conductorId
          ? await this.deps
              .conductorOf(
                launch.project,
                launch.conductorAgent,
                launch.conductor,
              )
              .catch(() => null)
          : null;
        if (!id || id !== launch.conductorId) {
          launch.notify = null;
          launch.owed = null;
          moved = true;
          continue;
        }
        const target = keyOf(launch.project, launch.conductor);
        if (launch.owed) {
          const { owed } = launch;
          const list = this.reports.get(target) ?? [];
          list.push({ launch, error: owed.error, cut: owed.cut, owed });
          this.reports.set(target, list);
          conductors.set(target, {
            project: launch.project,
            conductor: launch.conductor,
          });
        }
        if (!launch.notify) continue;
        const key = keyOf(launch.project, launch.session);
        const state = await engines
          .state(launch.project, launch.session)
          .catch(() => null);
        if (state?.state === "running" || state?.state === "starting") {
          this.arm(launch, true, launch.notify.since);
          this.running.add(key);
        } else {
          // NOTE: Its end was never seen: the app was down when it came, or
          // the restart cut the turn. Open in a terminal, it is the user's
          // now, and a watch that sees `terminal` is dropped as ever.
          launch.notify = null;
          moved = true;
          if (state && state.state !== "terminal") {
            this.owe(
              launch,
              state.state === "error" ? state.message : null,
              true,
            );
            conductors.set(target, {
              project: launch.project,
              conductor: launch.conductor,
            });
          }
        }
        // NOTE: Its ledger entry may still read `working` from before the
        // restart.
        await this.noteEnd(launch);
      }
      if (moved) await this.save();
      for (const { project, conductor } of conductors.values())
        await this.flush(project, conductor);
    })();
    return this.restoring;
  }

  /** A session some conductor started, once the launches were read. */
  private known(project: string, session: string): Launch | undefined {
    return this.launches?.find(
      (launch) => launch.project === project && launch.session === session,
    );
  }

  // ── Memory ──

  /**
   * Write a session's ledger entry in its conductor's memory. A launch no
   * conductor can be found for is left out; a failed write is logged.
   */
  private async note(
    launch: Launch,
    status: SessionStatus,
    summary: string,
  ): Promise<void> {
    if (!launch.conductorId) await this.adopt();
    if (!launch.conductorId) return;
    await this.deps.memory
      .record(launch.project, launch.conductorId, {
        sessionId: launch.session,
        title: launch.title,
        agent: launch.agent,
        model: launch.model,
        ...(launch.taskId ? { taskId: launch.taskId } : {}),
        status,
        summary,
      })
      .catch((error: unknown) =>
        console.error("Unable to update a conductor's memory", error),
      );
  }

  /** A session's turn ended: note where it stands and its last reply. */
  private async noteEnd(launch: Launch): Promise<void> {
    try {
      const turns = await this.turnsOf(launch).catch(() => []);
      const last = [...turns].reverse().find((turn) => replyOf(turn));
      const summary = last
        ? cut(replyOf(last), MEMORY_SUMMARY_MAX - 1, true)
        : "";
      await this.note(
        launch,
        await this.status(launch.project, launch.session),
        summary,
      );
    } catch (error) {
      console.error("Unable to update a conductor's memory", error);
    }
  }

  /** Tell an idle conductor what its sessions did; a busy one hears later. */
  private async flush(project: string, conductor: string): Promise<void> {
    const key = keyOf(project, conductor);
    const owed = this.reports.get(key);
    if (!owed?.length || this.sending.has(key) || this.held.has(key)) return;
    this.sending.add(key);
    try {
      const engines = this.deps.engines();
      const state = await engines.state(project, conductor);
      if (state.state !== "idle" && state.state !== "error") return;
      // NOTE: Taken out of line before anything is awaited: a report owed
      // meanwhile starts a new line, never one dropped here.
      const due = owed.splice(0);
      this.reports.delete(key);
      // A request answered, or one the user may answer now, is not news.
      const taken: Report[] = [];
      for (const report of due) {
        if (await this.stillOwed(report)) taken.push(report);
        else if (report.waiting)
          this.telling.delete(
            this.toldKey(report.launch, report.waiting.requestId),
          );
      }
      if (!taken.length) return;
      const agent = taken[0]?.launch.conductorAgent ?? "claude";
      try {
        const next = await engines.send(
          project,
          conductor,
          await this.deps.folderOf(project),
          outgoing(
            await this.reportTurn(taken),
            await this.settingsOf(conductor, agent),
          ),
          agent,
        );
        if (next.state === "terminal")
          throw new Error("its conversation is open in a terminal");
        // NOTE: Handed over: never delivered again, after a restart either.
        // A report owed since by the same launch is left alone.
        for (const report of taken) {
          if (report.launch.owed === report.owed) report.launch.owed = null;
          if (!report.waiting) continue;
          const told = this.toldKey(report.launch, report.waiting.requestId);
          this.telling.delete(told);
          this.told.add(told);
          if (this.told.size > TOLD_MAX)
            this.told.delete(this.told.values().next().value as string);
        }
        await this.save();
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
    const cli = `"$${SESSIONS_ENV.cli}"`;
    const parts: string[] = [];
    const ended = reports.filter((report) => !report.waiting);
    if (ended.length) parts.push(await this.endedPart(ended, cli));
    const waiting = reports.filter((report) => report.waiting);
    if (waiting.length) parts.push(this.waitingPart(waiting, cli));
    return `<${SESSIONS_TAG}>
Lanework adds this note: the user did not write it and does not see it. ${parts.join("\n")}
Use the lanework_control MCP tools (sessions_*, memory_read, memory_append, memory_write); if they are listed by name only, load them first (Claude: ToolSearch). Run ${cli} with the matching action (sessions.read, memory.append, …) only when those tools are truly unavailable. To keep one new fact, prefer memory_append; use memory_write only to rewrite your notes in full.
</${SESSIONS_TAG}>`;
  }

  /** The sessions waiting on a permission, one line each. */
  private waitingPart(reports: readonly Report[], cli: string): string {
    const bySession = new Map<string, { launch: Launch; tools: string[] }>();
    for (const { launch, waiting } of reports) {
      const entry = bySession.get(launch.session) ?? { launch, tools: [] };
      if (waiting) entry.tools.push(cut(waiting.tool, 80));
      bySession.set(launch.session, entry);
    }
    const lines = [...bySession.values()].map(
      ({ launch, tools }) =>
        `- ${launch.session} "${launch.title}": waits on ${tools.length === 1 ? "a permission request" : `${tools.length} permission requests`} (${[...new Set(tools)].join(", ")})`,
    );
    return `${lines.length === 1 ? "A session you started waits" : "Sessions you started wait"} on you for a permission; the user has no access, so only you can answer:
${lines.join("\n")}
Read what each asks with sessions_read (or ${cli} sessions.read), then answer it with sessions_answer (or ${cli} sessions.answer): allow only what its task needs, deny with a reason otherwise. A question cannot be allowed: deny it, or give the user access with sessions_access.`;
  }

  /** The sessions whose turn ended, with their last reply. */
  private async endedPart(
    reports: readonly Report[],
    cli: string,
  ): Promise<string> {
    const lines: string[] = [];
    for (const { launch, error, cut: wasCut } of reports) {
      const turns = await this.turnsOf(launch).catch(() => []);
      const last = [...turns].reverse().find((turn) => replyOf(turn));
      const reply = last ? cut(replyOf(last), REPORT_REPLY_MAX, true) : "";
      lines.push(
        `- ${launch.session} "${launch.title}": ${wasCut ? `stopped: the app restarted while it ran; its last turn may be incomplete${error ? ` (${cut(error, 300)})` : ""}` : error ? `failed: ${cut(error, 300)}` : "finished its turn"}`,
        reply
          ? `  Its last reply:\n<session_reply>\n${reply}\n</session_reply>`
          : "  It wrote no reply.",
      );
    }
    return `${reports.length === 1 ? "A session you started has" : "Sessions you started have"} stopped:
${lines.join("\n")}
Review the result (sessions_read, or ${cli} sessions.read, for more), then tell the user in a few lines what was done and what is left. Do not start more work unless they asked for it.`;
  }

  // ── Storage ──

  private async all(): Promise<Launch[]> {
    if (this.launches) return this.launches;
    this.loading ??= readFile(this.deps.file, "utf8")
      .then((text) => {
        const data = JSON.parse(text) as { v?: unknown; launches?: unknown };
        return data?.v === 1 && Array.isArray(data.launches)
          ? (data.launches as (Launch & { workspace?: unknown })[])
              // NOTE: A launch saved before FE-107 names its project
              // `workspace`; it is read as `project` and saved that way.
              .map((raw) => {
                if (!raw || typeof raw !== "object") return raw;
                const { workspace, ...entry } = raw;
                // NOTE: A launch saved before FE-128 has no conductorId:
                // `adopt` finds it.
                if (
                  entry.conductorId !== undefined &&
                  (typeof entry.conductorId !== "string" ||
                    !LEAD_REF_PATTERN.test(entry.conductorId))
                )
                  delete entry.conductorId;
                if (
                  entry.taskId !== undefined &&
                  typeof entry.taskId !== "string"
                )
                  delete entry.taskId;
                // NOTE: A launch saved before FE-133 has neither: nothing
                // is watched or owed. A malformed one is read the same.
                if (!isNotify(entry.notify)) delete entry.notify;
                if (!isOwed(entry.owed)) delete entry.owed;
                return entry.project === undefined &&
                  typeof workspace === "string"
                  ? { ...entry, project: workspace }
                  : entry;
              })
              .filter(
                (entry) =>
                  typeof entry?.session === "string" &&
                  typeof entry.conductor === "string" &&
                  typeof entry.project === "string",
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
    await this.save();
  }

  /** Write every launch as it stands now, after any write before it. */
  private async save(): Promise<void> {
    const all = await this.all();
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
