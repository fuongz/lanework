// The main process's side of the conversation view: an agent conversation
// read as a chat, and the composer's headless engine.
//
// NOTE: As with the terminal, the page names a PROJECT and a conversation
// id, never a folder or a command:
// - the folder is the one main wrote down for the project
//   (`terminalFolder`);
// - the id is a UUID whose transcript is in the CLI's folder for it, or an
//   OpenCode `ses_` id its database has for that folder (FE-104);
// - settings come from the fixed lists.
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { app, shell, type WebContents } from "electron";
import type {
  SessionAction,
  SessionCall,
  SessionResults,
} from "../../../shared/conductor-sessions";
import {
  AGENT_LABELS,
  type AgentModel,
  ANSWER_MAX,
  ANSWERS_MAX,
  type AssistantTurn,
  type Awaiting,
  agentOfModel,
  allModels,
  CONVERSATION_PAGE_TURNS_MAX,
  CONVERSATION_STATUS_MS,
  CONVERSATION_WINDOW_BYTES,
  CONVERSATION_WINDOW_TURNS,
  type ComposerSettings,
  type Conversation,
  type ConversationAgent,
  type ConversationEvent,
  type ConversationFacts,
  type ConversationHandoff,
  type ConversationHandoffLinks,
  type ConversationPage,
  type ConversationReplay,
  type ConversationSummary,
  type CustomModel,
  checkSettings,
  conversationChannels,
  type EarlierProposal,
  type EngineState,
  type HandoffTurn,
  type ImagePreview,
  isOpenableUrl,
  isPermission,
  type LinkPreview,
  limitOver,
  type OutgoingAttachment,
  type PermissionAnswer,
  type PermissionRequest,
  type PowerSettings,
  type SendRequest,
  type Suggestion,
  type SwitchAgentRequest,
  setClaudeModels,
  setCodexModels,
  setCustomModels,
  setOpenCodeModels,
  type ToolOutput,
  type Turn,
  type TurnSession,
  turnBytes,
  type UsageLimitsState,
  webSourcesOf,
  windowStart,
} from "../../../shared/conversation";
import {
  LEAD_REF_PATTERN,
  parseTeamLead,
  type TeamLead,
} from "../../../shared/orchestration";
import {
  deriveProposals,
  latestReadyProposal,
  readConductorEnvelope,
  readEnvelope,
} from "../../../shared/orchestration-proposals";
import { isAgentSessionId, isAgentSessionIdOf } from "../../../shared/terminal";
import { controlCliPath } from "../../control/install";
import { agentHome as agentHomeAt } from "../agent-home";
import { connectorInventory } from "../connectors/inventory";
import { belowMinimumNow } from "../harness/minimums";
import { broadcast, handle, hearInMain, sendTo, windowContents } from "../ipc";
import { setLwkMode } from "../lwk-serve";
import { notify } from "../notifications";
import {
  controlEndpoint,
  isWorkerConversation,
  isWorkerFolder,
  workerFolderOf,
} from "../orchestration";
import {
  setConnectorSource,
  setSessionsEnv,
} from "../orchestration/engine-tap";
import {
  createConductor,
  onTeamLeadsChanged,
  teamLeadOf,
} from "../orchestration/leads";
import { conductorMemoryFile } from "../paths";
import { setPermissionConductors } from "../permissions/gate";
import { knownProject, terminalFolder } from "../projects";
import { accountDir, isSlug } from "../projects/store";
import {
  bindConductorConversation,
  conductorOfConversation,
  doneLaunching,
  launcherOfConversation,
  managerOf,
  managerOfConversation,
  nameConversation,
  noteLaunching,
  registerAgentSession,
  setRailThreads,
  setSessionUserAccess,
  settleOpencodeSession,
  threadsChanged,
} from "../terminal";
import { opencodeDataDir } from "../terminal/opencode-sessions";
import {
  opencodeGoKey,
  opencodeServiceUsage,
} from "../terminal/opencode-usage";
import { onCodexReset, usageWindowsOf } from "../terminal/usage";
import { agentHomeDir } from "../test-seams";
import { markTurnCut } from "../transcripts/activity";
import { awaitingNotice, createAwaitingLedger } from "./awaiting";
import { createAgentCli, createClaudeCli } from "./claude-cli";
import { createClaudeModels } from "./claude-models";
import { claudeJsonFor, isClaudeTrusted } from "./claude-trust";
import { createCodexModels } from "./codex-models";
import {
  codexFacts,
  codexRolloutPath,
  latestCodexProposal,
  readCodexConversation,
} from "./codex-transcript";
import { ConductorMemoryStore } from "./conductor-memory";
import { ConductorSessions } from "./conductor-sessions";
import type { ConductorStopDeps } from "./conductor-stop";
import { createEngines } from "./engine";
import { forkConversation } from "./fork";
import {
  buildHandoff,
  type ChainSession,
  createHandoffStore,
  handoffBudget,
  handoffTitle,
} from "./handoff";
import { type ImageScope, openableImage, previewImage } from "./image-preview";
import { createLinkPreviews } from "./link-preview";
import { claudePidsOn } from "./live-claude";
import {
  boardFor,
  codexHasDeveloperInstructions,
  codexHasLaneworkTable,
  localMcpFor,
} from "./mcp-binding";
import { openCodeClient } from "./opencode-client";
import { createOpenCodeModels, openCodeModelsOfIds } from "./opencode-models";
import {
  createOpenCodeService,
  listOpenCodeModelIds,
} from "./opencode-service";
import {
  isOpenCodeConversation,
  readOpenCodeConversation,
} from "./opencode-transcript";
import { contentOf, isMessageId, sendRequest } from "./outgoing";
import {
  idleLimitMs,
  readPowerSettings,
  warmCap,
  writePowerSettings,
} from "./power";
import type { Outgoing } from "./queue";
import { createSettingsStore } from "./settings-store";
import {
  listCommands,
  projectFiles,
  rankCommands,
  suggestFiles,
} from "./suggest";
import { indexTurns, readThread, type ThreadSession } from "./thread-read";
import {
  claudeFacts,
  latestClaudeProposal,
  readConversation,
  readToolOutput,
  transcriptPath,
} from "./transcript";
import { createUsageLimits } from "./usage-limits";

/**
 * How the composer finds and stops a pty running Claude on a conversation.
 *
 * The terminal's own list is the exact answer; Claude's pid files
 * (`live-claude.ts`) catch a Claude in any other terminal app (FE-62/D3).
 */
interface TerminalBridge {
  terminalOn: (
    project: string,
    conversation: string,
    ours: ReadonlySet<number>,
  ) => Promise<string | null>;
  kill: (terminalId: string) => Promise<void>;
  /**
   * Calls `listener` whenever a terminal starts or stops, until the returned
   * function is called. Injected (FE-80, AM-10) so this feature does not
   * import the terminal's; the pid-file bridge has no terminals to watch.
   */
  onRunningChanged?: (listener: () => void) => () => void;
}

/**
 * Where Claude keeps its conversations, with the terminal's test seam
 * (`agentHomeDir`, unpackaged only).
 */
function agentHome(): string {
  return agentHomeDir();
}

/**
 * Where OpenCode keeps its database, under the test seam's home too.
 *
 * NOTE: OpenCode's own variables count only for the real home, as the rail
 * reads them (`terminal/agent-sessions.ts`).
 */
function opencodeData(): string {
  const home = agentHome();
  return opencodeDataDir(home, process.env, home === homedir());
}

/** A conversation id of any CLI: a UUID, or OpenCode's `ses_` (FE-104). */
function isConversationId(value: unknown): value is string {
  return isAgentSessionId(value) || isAgentSessionIdOf("opencode", value);
}

/**
 * The transcript's turns with the engine's running ones over them.
 *
 * OpenCode writes a step to its database only as the step ends: mid-turn,
 * what the engine drew from its events is newer. From the first turn the
 * engine holds, its turns stand in for the database's.
 */
function withLive(turns: Turn[], live: Turn[]): Turn[] {
  if (!live.length) return turns;
  const ids = new Set(live.map((turn) => turn.id));
  const first = turns.findIndex((turn) => ids.has(turn.id));
  const kept = first >= 0 ? turns.slice(0, first) : turns;
  return [...kept.filter((turn) => !ids.has(turn.id)), ...live];
}

/** The most team leads one ask for a latest proposal may carry. */
const PROPOSAL_LEADS_MAX = 256;

/**
 * The team leads the page sent with an ask for a latest proposal: each
 * checked as a lead from the page is, and one that fails left out (its
 * proposal is then checked against the whole catalog, as the card does
 * while the list is still being read).
 *
 * @throws When `value` is not a list.
 */
function proposalLeads(value: unknown): TeamLead[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PROPOSAL_LEADS_MAX)
    throw new Error("A list of team leads is required");
  const out: TeamLead[] = [];
  for (const lead of value) {
    const source = (lead as { source?: unknown } | null)?.source;
    try {
      out.push(parseTeamLead(lead, source === "repo" ? "repo" : "personal"));
    } catch {
      // Not a lead this app wrote: never trusted.
    }
  }
  return out;
}

/** A conductor's sessions, once the conversation view registered. */
let sessions: ConductorSessions | null = null;

/**
 * What a conductor's Stop asks of the chat's engines, once the conversation
 * view registered.
 */
let stoppable: Omit<ConductorStopDeps, "runsOf" | "stopRun"> | null = null;

/**
 * The chat's side of a conductor's Stop: its engines, its sessions, its
 * held reports. The runs are orchestration's, added by `main/index.ts`.
 * Refused before the conversation view registered.
 */
export const conductorEngines: Omit<ConductorStopDeps, "runsOf" | "stopRun"> = {
  alive: (project) => ready().alive(project),
  working: (project, conversation) => ready().working(project, conversation),
  conductorOf: (project, conversation) =>
    ready().conductorOf(project, conversation),
  sessionsOf: (project, lead) => ready().sessionsOf(project, lead),
  hold: (project, lead, conversations) =>
    ready().hold(project, lead, conversations),
  close: (project, conversation) => ready().close(project, conversation),
};

function ready(): Omit<ConductorStopDeps, "runsOf" | "stopRun"> {
  if (!stoppable) throw new Error("Conversations are not ready yet.");
  return stoppable;
}

/** A card a conversation shows now, with where it runs (FE-165). */
export interface PendingPermissionCard {
  /** The project and native session the card belongs to. */
  project: string;
  conversation: string;
  agent: ConversationAgent;
  /** Its checkout: a worker's own worktree. */
  folder: string;
  request: PermissionRequest;
}

let pendingCards:
  | ((
      project: unknown,
      conversation: unknown,
      id: string,
    ) => Promise<PendingPermissionCard | null>)
  | null = null;

/**
 * Card `id` of conversation `conversation` (a thread's head names its newest
 * session), for "Always allow"; null when it is no longer shown.
 *
 * @throws When the conversation view has not registered yet, or the
 *   project or conversation is not valid.
 */
export function pendingPermission(
  project: unknown,
  conversation: unknown,
  id: string,
): Promise<PendingPermissionCard | null> {
  if (!pendingCards) throw new Error("Conversations are not ready yet.");
  return pendingCards(project, conversation, id);
}

/** The most conversations {@link registerConversation} remembers a conductor of. */
const CONDUCTOR_SEEN_MAX = 256;
/** The most permission requests remembered as notified to the person. */
const NOTIFIED_ASKS_MAX = 500;
/**
 * What a switch of a thread carries when its newest session was handed a
 * block that named its turns (BE-04): only that session's turns, and the
 * earlier sessions with their turn counts for the pointer to `thread.read`.
 * Null for a lone conversation, or a thread whose last link is older than
 * that (rebuilt whole, BE-04/D2).
 *
 * @param turns The whole thread's, stitched (`readWhole`).
 * @param newest The newest session, the source of the switch.
 */
function deltaOf(
  chain: readonly ChainSession[],
  turns: readonly Turn[],
  newest: string,
): {
  turns: Turn[];
  earlier: { conversation: string; agent: ConversationAgent; turns: number }[];
} | null {
  if (chain.length < 2 || !chain.at(-1)?.link?.carried.through) return null;
  const counts = new Map<string, number>();
  for (const entry of indexTurns(turns, newest))
    if (entry) counts.set(entry.session, entry.index + 1);
  return {
    turns: turns.filter(
      (turn) =>
        turn.role !== "handoff" &&
        (turn.session?.conversation ?? newest) === newest,
    ),
    earlier: chain
      .filter((entry) => entry.conversation !== newest)
      .map((entry) => ({
        conversation: entry.conversation,
        agent: entry.agent,
        turns: counts.get(entry.conversation) ?? 0,
      })),
  };
}

/**
 * The most context, in tokens, an earlier session may hold to be forked
 * for a switch back to its CLI (BE-05/D3): its last turn's size plus the
 * turns since. Conservative, as the app knows no model's window; a session
 * past it gets a fresh one and the handoff block, as before.
 */
const FORK_CONTEXT_MAX = 150_000;

/**
 * A session's own turns: a fork's (BE-05) without the copy of the earlier
 * session it starts with, which the thread reads under that one.
 *
 * @param link The handoff that started the session; null for the head.
 */
function ownTurns(
  link: ConversationHandoff | null | undefined,
  turns: Turn[],
): Turn[] {
  const forked = link?.forked;
  if (!forked) return turns;
  const at = forked.lastTurn
    ? turns.findIndex((turn) => turn.id === forked.lastTurn)
    : -1;
  return turns.slice(at >= 0 ? at + 1 : Math.min(forked.turns, turns.length));
}

/**
 * About how many tokens of context `turns` hold: the last answer's usage
 * (its input, cached and output), else their text at 4 bytes a token.
 */
function contextOf(turns: readonly Turn[]): number {
  for (let at = turns.length - 1; at >= 0; at--) {
    const turn = turns[at];
    if (turn?.role === "assistant" && turn.usage)
      return turn.usage.input + turn.usage.cached + turn.usage.output;
  }
  return Math.ceil(Buffer.byteLength(JSON.stringify(turns)) / 4);
}

/** The most sessions `thread.read` follows back through handoffs (BE-03). */
const THREAD_SESSIONS_MAX = 16;

/**
 * Where conductor `conductorId` keeps its memory of `project` (FE-128): in
 * the project's own folder under `<home>/projects`, as `projects/store.ts`
 * names it.
 */
async function conductorMemoryPath(
  project: string,
  conductorId: string,
): Promise<string> {
  const { record, project: found } = await knownProject(project);
  if (!isSlug(found.slug)) throw new Error("That project key is not valid.");
  return conductorMemoryFile(join(accountDir(record), found.slug), conductorId);
}

/**
 * Every conductor's memory, one store for the conductor's own calls and the
 * page's (`leads.memory`, `leads.saveMemoryNotes`): writes to one file never
 * cross.
 */
export const conductorMemory = new ConductorMemoryStore({
  fileOf: conductorMemoryPath,
});

/**
 * What the control server asks of a conductor's sessions: who a token is,
 * and one call for it. Refused before the conversation view registered.
 */
export const conductorSessionsControl = {
  callerOf: (token: string) => sessions?.callerOf(token) ?? null,
  call: (
    caller: NonNullable<ReturnType<ConductorSessions["callerOf"]>>,
    call: SessionCall,
    requestId: string,
  ): Promise<SessionResults[SessionAction]> => {
    if (!sessions) throw new Error("Conversations are not ready yet.");
    return sessions.call(caller, call, requestId);
  },
};

/** How long a project's `/` commands are reused before they are read again. */
const COMMANDS_MS = 30_000;

/** The last `/` commands read, by project. */
const commandCache = new Map<
  string,
  { at: number; all: Promise<Suggestion[]> }
>();

/**
 * Every `/` command `project` offers, for each key the composer sends.
 *
 * Read once and kept (FE-92): finding the project's folder may wait on the
 * network, and `/` must open at once. Older than {@link COMMANDS_MS}, the
 * list kept still answers while a new one is read behind it.
 */
function commandsOf(
  project: string,
  agent: ConversationAgent = "claude",
): Promise<Suggestion[]> {
  const read = () =>
    terminalFolder(project).then((folder) =>
      listCommands(agentHome(), folder, agent),
    );
  // By agent too: OpenCode's list is not Claude's (FE-105/D3).
  const cacheKey = `${project}\0${agent}`;
  const cached = commandCache.get(cacheKey);
  if (!cached) {
    const all = read();
    commandCache.set(cacheKey, { at: Date.now(), all });
    all.catch(() => commandCache.delete(cacheKey));
    if (commandCache.size > 16)
      commandCache.delete(commandCache.keys().next().value as string);
    return all;
  }
  if (Date.now() - cached.at > COMMANDS_MS) {
    cached.at = Date.now();
    const next = read();
    next
      .then(() => commandCache.set(cacheKey, { at: Date.now(), all: next }))
      .catch(() => {});
  }
  return cached.all;
}

/**
 * A {@link TerminalBridge} that finds any live Claude on the conversation by
 * its pid file, with `pid:<n>` as its id.
 */
export function pidFileBridge(): TerminalBridge {
  return {
    async terminalOn(_project, conversation, ours) {
      const [pid] = await claudePidsOn(agentHome(), conversation, ours);
      return pid ? `pid:${pid}` : null;
    },
    async kill(terminalId) {
      const pid = Number(/^pid:(\d+)$/.exec(terminalId)?.[1]);
      if (!Number.isInteger(pid) || pid <= 0) return;
      try {
        // What a pty's own kill sends.
        process.kill(pid, "SIGHUP");
      } catch {
        // Gone already.
      }
    },
  };
}

/**
 * A short non-empty string the page sent, checked.
 *
 * @param what Names the value in the error.
 * @throws When `value` is not a non-empty string of at most 200 characters.
 */
function key(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error(`A valid ${what} is required`);
  return value;
}

/**
 * A conversation's address from an IPC call's first two arguments.
 *
 * @throws When either is missing or invalid.
 */
function conversationOf(args: unknown[]): {
  project: string;
  conversation: string;
} {
  if (args.length < 2)
    throw new Error("A project and a conversation are required");
  const project = key(args[0], "project");
  if (!isConversationId(args[1]))
    throw new Error("A valid conversation is required");
  return { project, conversation: args[1] };
}

/**
 * A queued message's address: its conversation, and its own id.
 *
 * @throws When the call does not have exactly those three arguments.
 */
function queuedOf(args: unknown[]): {
  project: string;
  conversation: string;
  message: string;
} {
  if (args.length !== 3)
    throw new Error("A project, a conversation and a message are required");
  const { project, conversation } = conversationOf(args);
  if (!isMessageId(args[2])) throw new Error("A valid message is required");
  return { project, conversation, message: args[2] };
}

/**
 * A `seq` the page sent to replay from: null for none.
 *
 * @throws When it is neither null nor a whole number from 0.
 */
function afterOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("A valid seq is required");
  return value;
}

/** How many of a conversation's latest events main keeps to replay. */
const REPLAY_EVENTS = 128;
/** How many conversations' events are kept; the longest quiet goes first. */
const REPLAY_CONVERSATIONS = 32;

/** An event as it goes out: numbered. */
type Numbered = ConversationEvent & { seq: number };

/**
 * Where conversation events go: in full to the windows subscribed to their
 * conversation, as status to the others.
 *
 * NOTE: Sent to every window, each `delta` and each `turn` (a whole turn,
 * structured-cloned per line) of every running conversation reaches the
 * rail and every window on another chat, only to be filtered there. So
 * only a window whose page shows the conversation (`subscribe`) gets
 * those; the rest hear its status, which is all the rail, the island and
 * the stores use ({@link ConversationEvent}).
 *
 * NOTE: Each event is numbered per conversation (`seq`) and the last
 * {@link REPLAY_EVENTS} are kept, so a page that skipped some (it
 * resubscribed, or one went missing) is sent just those, not the whole
 * conversation again; past them it reads the conversation anew.
 */
function createConversationStream(channel: string) {
  const keyOf = (project: string, conversation: string) =>
    `${project}\0${conversation}`;
  /** Each conversation's last `seq`. Never dropped: a page may still hold one. */
  const seqs = new Map<string, number>();
  /** The last events of the most recently active conversations, oldest first. */
  const rings = new Map<string, Numbered[]>();
  /** The pages subscribed to each conversation, each with its count. */
  const subscribed = new Map<string, Map<WebContents, number>>();
  /** The conversations each page subscribed to, to let go of it at once. */
  const byPage = new Map<WebContents, Set<string>>();
  /** The pages main listens to for going away. */
  const hooked = new WeakSet<WebContents>();
  /** What waits to go to the windows not subscribed, per conversation. */
  const pending = new Map<
    string,
    {
      state?: Numbered;
      moved?: Numbered;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** The `engine.state` those windows last heard, per conversation. */
  const heard = new Map<string, EngineState["state"]>();

  const remember = (key: string, event: Numbered) => {
    const ring = rings.get(key) ?? [];
    // NOTE: Re-set, so the Map's order stays most recently active last.
    rings.delete(key);
    rings.set(key, ring);
    // NOTE: One whole turn per turn id: each line of a running turn sends
    // all of it again, and 128 copies of a long turn are megabytes. An
    // older copy becomes a `moved` under its own `seq`, so the numbers stay
    // whole; the newest copy, replayed after it, is what the page keeps.
    if (event.type === "turn")
      for (let at = 0; at < ring.length; at++) {
        const old = ring[at];
        if (old?.type === "turn" && old.turn.id === event.turn.id)
          ring[at] = {
            type: "moved",
            project: old.project,
            conversation: old.conversation,
            seq: old.seq,
          };
      }
    ring.push(event);
    if (ring.length > REPLAY_EVENTS) ring.shift();
    if (rings.size > REPLAY_CONVERSATIONS)
      rings.delete(rings.keys().next().value as string);
  };

  /** Send to every window but those subscribed to `key`. */
  const toOthers = (key: string, event: Numbered) => {
    const pages = subscribed.get(key);
    for (const contents of windowContents())
      if (!pages?.has(contents)) sendTo(contents, channel, event);
  };

  /** Send what waits for `key` now, oldest first; `drop` the state waiting. */
  const flush = (key: string, drop = false) => {
    const waiting = pending.get(key);
    if (!waiting) return;
    pending.delete(key);
    clearTimeout(waiting.timer);
    const out = [drop ? undefined : waiting.state, waiting.moved]
      .filter((event): event is Numbered => event !== undefined)
      .sort((a, b) => a.seq - b.seq);
    for (const event of out) toOthers(key, event);
  };

  const later = (key: string, slot: "state" | "moved", event: Numbered) => {
    const waiting = pending.get(key);
    if (waiting) {
      waiting[slot] = event;
      return;
    }
    pending.set(key, {
      [slot]: event,
      timer: setTimeout(() => flush(key), CONVERSATION_STATUS_MS),
    });
  };

  /**
   * The event's status, to the windows not subscribed.
   *
   * NOTE: A change of `engine.state` (running to idle, starting, error) and
   * a permission asked or answered go at once: the rail's dot, the island
   * and a notification follow them. A `state` that changes only the queue
   * waits, and so does a summary of `turn`s and `moved`s (a `moved`: read it
   * again), at most one of each per {@link CONVERSATION_STATUS_MS}. A
   * `delta` is never status.
   */
  const status = (key: string, event: Numbered) => {
    switch (event.type) {
      case "delta":
        return;
      case "turn":
      case "moved":
        later(key, "moved", {
          type: "moved",
          project: event.project,
          conversation: event.conversation,
          seq: event.seq,
        });
        return;
      case "state":
        if (heard.get(key) === event.engine.state) {
          later(key, "state", event);
          return;
        }
        heard.set(key, event.engine.state);
        // The state waiting is older than this one: dropped, not sent.
        flush(key, true);
        toOthers(key, event);
        return;
      default:
        flush(key);
        toOthers(key, event);
    }
  };

  /** Main's `seq` for `key`, and the events after `after` when it has them. */
  const replayOf = (key: string, after: number | null): ConversationReplay => {
    const seq = seqs.get(key) ?? 0;
    if (after === null || after > seq) return { seq, events: null };
    if (after === seq) return { seq, events: [] };
    const ring = rings.get(key) ?? [];
    const first = ring[0]?.seq;
    if (first === undefined || first > after + 1) return { seq, events: null };
    return { seq, events: ring.filter((event) => event.seq > after) };
  };

  /** Let go of everything `contents` subscribed to. */
  const forget = (contents: WebContents) => {
    const keys = byPage.get(contents);
    byPage.delete(contents);
    for (const key of keys ?? []) {
      const pages = subscribed.get(key);
      pages?.delete(contents);
      if (pages?.size === 0) subscribed.delete(key);
    }
  };

  const hook = (contents: WebContents) => {
    if (hooked.has(contents)) return;
    hooked.add(contents);
    // NOTE: A page that goes away never unsubscribes: a closed window, a
    // crashed or reloaded renderer; the new page subscribes for itself.
    // `did-navigate`, not `did-start-navigation`: the window refuses an
    // untrusted link in `will-navigate`, after a start was already told,
    // and the page that stays must keep its subscriptions. In-page
    // (router) moves are `did-navigate-in-page`.
    contents.once("destroyed", () => forget(contents));
    contents.on("render-process-gone", () => forget(contents));
    contents.on("did-navigate", () => forget(contents));
  };

  return {
    /** Number `event`, keep it, and send it where it goes; answers it numbered. */
    publish(event: ConversationEvent): Numbered {
      const key = keyOf(event.project, event.conversation);
      const seq = (seqs.get(key) ?? 0) + 1;
      seqs.set(key, seq);
      const numbered = { ...event, seq } as Numbered;
      remember(key, numbered);
      hearInMain(channel, numbered);
      for (const contents of subscribed.get(key)?.keys() ?? [])
        sendTo(contents, channel, numbered);
      status(key, numbered);
      return numbered;
    },
    /** The conversation's last `seq`, 0 before its first event. */
    seq: (project: string, conversation: string): number =>
      seqs.get(keyOf(project, conversation)) ?? 0,
    subscribe(
      contents: WebContents,
      project: string,
      conversation: string,
      after: number | null,
    ): ConversationReplay {
      const key = keyOf(project, conversation);
      const pages = subscribed.get(key) ?? new Map<WebContents, number>();
      pages.set(contents, (pages.get(contents) ?? 0) + 1);
      subscribed.set(key, pages);
      const keys = byPage.get(contents) ?? new Set<string>();
      keys.add(key);
      byPage.set(contents, keys);
      hook(contents);
      return replayOf(key, after);
    },
    unsubscribe(contents: WebContents, project: string, conversation: string) {
      const key = keyOf(project, conversation);
      const pages = subscribed.get(key);
      const count = pages?.get(contents) ?? 0;
      if (!pages || count === 0) return;
      if (count > 1) {
        pages.set(contents, count - 1);
        return;
      }
      pages.delete(contents);
      if (pages.size === 0) subscribed.delete(key);
      byPage.get(contents)?.delete(key);
    },
    replay: (project: string, conversation: string, after: number | null) =>
      replayOf(keyOf(project, conversation), after),
  };
}

/** A checked request as the message an engine sends, or holds. */
async function outgoingOf(request: SendRequest): Promise<Outgoing> {
  return {
    id: request.id ?? randomUUID(),
    text: request.text,
    attachments: request.attachments,
    content: await contentOf(request.text, request.attachments),
    settings: request.settings,
  };
}

/**
 * The proposals planned before each windowed conversation's window, kept
 * while the turns they were read from are the same objects.
 *
 * NOTE: Deriving them reads every reply's text before the window, on every
 * read. A Claude transcript's turns are its fold's own objects, the same
 * from one read to the next until a line changes them, so the last turn
 * before the window and the count tell when the answer still holds. Codex's
 * and OpenCode's turns are read anew each time and never match.
 */
const earlierProposals = new Map<
  string,
  {
    last: Turn;
    count: number;
    proposals: EarlierProposal[];
    anchor: Turn[];
  }
>();

/** The most of {@link ConversationSummary.anchor}, by `turnBytes`. */
const ANCHOR_BYTES = CONVERSATION_WINDOW_BYTES / 4;

/**
 * The turns proposal `id` is read from in `turns`: its planning turn, any
 * repair of it, and the replies after each, those with their text only.
 *
 * @returns Empty past {@link ANCHOR_BYTES}: its card is then shown once
 *   paged in, as before.
 */
function anchorOf(turns: readonly Turn[], id: string): Turn[] {
  const out: Turn[] = [];
  let bytes = 0;
  for (let at = 0; at < turns.length; at++) {
    const turn = turns[at];
    if (turn?.role !== "user") continue;
    const envelope =
      readEnvelope(turn.text) ?? readConductorEnvelope(turn.text);
    if (envelope?.id !== id) continue;
    out.push(turn);
    bytes += turnBytes(turn);
    for (let next = at + 1; next < turns.length; next++) {
      const reply = turns[next];
      if (reply?.role !== "assistant") break;
      // `deriveProposals` reads a reply's text and whether it is open.
      const slim: Turn = {
        ...reply,
        blocks: reply.blocks.filter((block) => block.type === "text"),
      };
      out.push(slim);
      bytes += turnBytes(slim);
    }
    if (bytes > ANCHOR_BYTES) return [];
  }
  return out;
}
const EARLIER_PROPOSALS_MAX = 32;

/**
 * What a chat holding only `turns[start…]` would miss of the rest: see
 * {@link ConversationSummary}.
 */
function summaryOf(
  conversation: string,
  turns: readonly Turn[],
  start: number,
): ConversationSummary {
  let conductorContext: string | null = null;
  let model: string | null = null;
  for (let at = turns.length - 1; at >= 0; at--) {
    const turn = turns[at];
    if (conductorContext === null && turn?.role === "user")
      conductorContext = readConductorEnvelope(turn.text)?.context ?? null;
    else if (model === null && turn?.role === "assistant" && turn.model)
      model = turn.model;
    if (conductorContext !== null && model !== null) break;
  }
  // A planning turn's replies run up to the next prompt: a window cut by
  // its size alone may start inside them.
  let end = start;
  while (end < turns.length && turns[end]?.role === "assistant") end++;
  const last = turns[end - 1] as Turn;
  const known = earlierProposals.get(conversation);
  let proposals: EarlierProposal[];
  let anchor: Turn[];
  if (known && known.last === last && known.count === end) {
    proposals = known.proposals;
    anchor = known.anchor;
  } else {
    // NOTE: Not working, and no leads: only an id, a title and a place are
    // kept of each, for its run. The newest goes as its turns too
    // (`anchor`): it may be the conversation's latest proposal, whose card
    // the chat draws whole, checked against the page's own leads.
    const before = turns.slice(0, end);
    const derived = deriveProposals(before, false);
    proposals = derived.map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      afterTurn: proposal.afterTurn,
    }));
    const newest = derived.at(-1);
    // A repair of it inside the window is one the page holds already.
    anchor = newest ? anchorOf(before, newest.id) : [];
    earlierProposals.delete(conversation);
    earlierProposals.set(conversation, {
      last,
      count: end,
      proposals,
      anchor,
    });
    if (earlierProposals.size > EARLIER_PROPOSALS_MAX)
      earlierProposals.delete(earlierProposals.keys().next().value as string);
  }
  return { conductorContext, model, proposals, anchor };
}

/**
 * How `read` was asked to read: nothing, or `{ full: true }`.
 *
 * @throws When it is something else.
 */
function readOptions(value: unknown): { full: boolean } {
  if (value === undefined || value === null) return { full: false };
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Valid read options are required");
  const full = (value as { full?: unknown }).full;
  if (full !== undefined && typeof full !== "boolean")
    throw new Error("Valid read options are required");
  return { full: full === true };
}

/**
 * A turn's or a tool call's id as the page sent it.
 *
 * @throws When it is not a short string.
 */
function turnRef(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    value.includes("\0")
  )
    throw new Error("A valid turn is required");
  return value;
}

/**
 * How many user turns a `readBefore` page may hold.
 *
 * @throws When it is neither absent nor a whole number in range.
 */
function pageLimit(value: unknown): number {
  if (value === undefined || value === null) return CONVERSATION_WINDOW_TURNS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > CONVERSATION_PAGE_TURNS_MAX
  )
    throw new Error("A valid page size is required");
  return value;
}

/**
 * The tool names `readToolCalls` was asked for.
 *
 * @throws When they are not 1 to 32 short strings.
 */
function toolNames(value: unknown): Set<string> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some((name) => typeof name !== "string" || !name || name.length > 128)
  )
    throw new Error("Valid tool names are required");
  return new Set(value as string[]);
}

/**
 * The folder main wrote down for `project`.
 *
 * @throws When the project has no folder on this machine.
 */
async function folderOf(project: string): Promise<string> {
  const folder = await terminalFolder(project);
  if (!folder) throw new Error("This project has no folder here.");
  return folder;
}

/**
 * Which CLI wrote conversation `id` of `folder`.
 *
 * OpenCode's when it is a `ses_` id OpenCode's database has for that folder;
 * else Claude's when its file is in Claude's folder for it, Codex's when a
 * rollout of that folder has the id.
 *
 * @returns null when no CLI has written it down.
 */
async function agentOf(
  folder: string,
  id: string,
): Promise<ConversationAgent | null> {
  if (isAgentSessionIdOf("opencode", id))
    return (await isOpenCodeConversation(opencodeData(), folder, id))
      ? "opencode"
      : null;
  if (!isAgentSessionId(id)) return null;
  const file = transcriptPath(agentHome(), folder, id);
  if ((await stat(file).catch(() => null))?.isFile()) return "claude";
  if (await codexRolloutPath(agentHome(), folder, id).catch(() => null))
    return "codex";
  return null;
}

/** Conversation `id` of `folder`, read from whichever CLI wrote it. */
async function readAny(folder: string, id: string): Promise<Conversation> {
  switch (await agentOf(folder, id)) {
    case "opencode":
      return readOpenCodeConversation(opencodeData(), folder, id);
    case "codex":
      return readCodexConversation(agentHome(), folder, id);
    default:
      return readConversation(agentHome(), folder, id);
  }
}

/**
 * The path a chat badge names, and what its image may be read from.
 *
 * The scope is the project's folder, the images attached to the
 * conversation, and the files its tool calls read or wrote by absolute path
 * (a screenshot under `/tmp`). They are read from its transcript here, never
 * taken from the page; `openableImage` still keeps only images.
 *
 * @throws When the arguments are not a conversation and a valid path.
 */
async function imageScope(
  args: unknown[],
  turnsOf: (project: string, conversation: string) => Promise<Turn[]>,
): Promise<{
  path: string;
  scope: ImageScope;
}> {
  if (args.length !== 3)
    throw new Error("A project, a conversation and a path are required");
  const { project, conversation } = conversationOf(args);
  const path = args[2];
  if (
    typeof path !== "string" ||
    !path.trim() ||
    path.length > 1024 ||
    path.includes("\0")
  )
    throw new Error("A valid path is required");
  const folder = await folderOf(project);
  // NOTE: A thread's every session: an image attached before a handoff is
  // still the conversation's own.
  const turns = await turnsOf(project, conversation).catch(() => []);
  const attachments = turns.flatMap((turn) =>
    turn.role === "user"
      ? turn.attachments.flatMap((entry) => (entry.path ? [entry.path] : []))
      : turn.role === "compaction" || turn.role === "handoff"
        ? []
        : turn.blocks.flatMap((block) =>
            block.type === "tools"
              ? block.calls.flatMap((call) =>
                  call.filePath && isAbsolute(call.filePath)
                    ? [call.filePath]
                    : [],
                )
              : [],
          ),
  );
  return {
    path: path.trim(),
    scope: { folder, attachments, files: () => projectFiles(folder) },
  };
}

/**
 * A permission answer the page sent, checked.
 *
 * @throws When it is neither a valid allow nor a valid deny.
 */
function permissionAnswer(value: unknown): PermissionAnswer {
  const v = (value ?? {}) as Record<string, unknown>;
  if (v.behavior === "allow") {
    if (v.answers !== undefined) {
      const answers = v.answers as Record<string, unknown> | null;
      if (!answers || typeof answers !== "object" || Array.isArray(answers))
        throw new Error("Answers must be an object");
      const entries = Object.entries(answers);
      if (
        entries.length > ANSWERS_MAX ||
        entries.some(
          ([question, value]) =>
            question.length > ANSWER_MAX ||
            typeof value !== "string" ||
            value.length > ANSWER_MAX,
        )
      )
        throw new Error("Answers are too long");
      return {
        behavior: "allow",
        answers: Object.fromEntries(entries) as Record<string, string>,
      };
    }
    if (v.mode === undefined) return { behavior: "allow" };
    if (!isPermission(v.mode)) throw new Error("Unknown mode");
    return { behavior: "allow", mode: v.mode };
  }
  if (v.behavior === "deny") {
    if (v.message === undefined) return { behavior: "deny" };
    if (typeof v.message !== "string" || v.message.length > 2000)
      throw new Error("A valid message is required");
    return { behavior: "deny", message: v.message };
  }
  throw new Error("Allow or deny");
}

/**
 * Register the conversation view's IPC handlers.
 *
 * @param bridge How a pty running Claude on a conversation is found and
 *   stopped; by default, by Claude's pid files only.
 */
export function registerConversation(
  devUrl?: string,
  bridge: TerminalBridge = pidFileBridge(),
): void {
  const store = createSettingsStore(
    join(app.getPath("userData"), "conversation-settings.json"),
  );
  // Beside the settings: the links old -> new of every handoff made here.
  const handoffs = createHandoffStore(
    join(app.getPath("userData"), "conversation-handoffs.json"),
  );
  // Read at once: an event's thread is looked up without waiting
  // (`placeNow`), and the rail folds threads from what is loaded
  // (`setRailThreads` below).
  void handoffs.ready().catch(() => undefined);
  /**
   * The conductor whose own conversation native session `conversation` is,
   * or null. A conductor is bound to its thread's head: after an in-place
   * handoff (`switchAgent`) its engine runs a newer session, under another
   * id and maybe another agent, that is still the conductor's own.
   */
  const conductorOfThread = async (
    project: string,
    agent: ConversationAgent,
    conversation: string,
  ): Promise<string | null> => {
    const own = await conductorOfConversation(
      project,
      agent,
      conversation,
    ).catch(() => null);
    if (own) return own;
    const head = (await handoffs.chainOf(project, conversation))[0];
    if (!head || head.conversation === conversation) return null;
    return conductorOfConversation(project, head.agent, head.conversation);
  };
  const previews = createLinkPreviews({
    dir: join(app.getPath("userData"), "link-previews"),
  });
  const testing =
    !app.isPackaged && Boolean(process.env.LANEWORK_TEST_USER_DATA);
  const claudeCli = createClaudeCli(() =>
    testing ? process.env.LANEWORK_CLAUDE_BIN : undefined,
  );
  // FE-135: Claude's models as its own CLI lists them, kept between runs.
  // Never asked under test: the specs run on the fixed list.
  const claudeList = createClaudeModels({
    file: join(app.getPath("userData"), "claude-models.json"),
    cli: claudeCli,
    onChange: setClaudeModels,
  });
  const claudeModels = async (): Promise<AgentModel[]> => {
    if (!testing) {
      const models = await claudeList.read();
      if (models) setClaudeModels(models);
    }
    return allModels().filter((entry) => entry.agent === "claude");
  };
  // NOTE: Read before any settings are checked. A Codex model is only known
  // once its list is, and a stored one not on the fallback would be dropped.
  // So is a Claude one: the kept list is only a file read away, and asking
  // the CLI again happens behind it.
  const readCodexModels = createCodexModels(agentHome);
  const codexModels = async (): Promise<AgentModel[]> => {
    const models = await readCodexModels().catch(() => []);
    setCodexModels(models);
    return models;
  };
  // FE-104: OpenCode's models are its service's. Found through the user's
  // own `opencode`; LANEWORK_OPENCODE_BIN is the test seam.
  const opencodeCli = createAgentCli("opencode", () =>
    testing ? process.env.LANEWORK_OPENCODE_BIN : undefined,
  );
  const opencode = createOpenCodeService(opencodeCli);
  // Go puts OpenCode Go's models first: the subscription the user pays for.
  // The account signed in on opencode.ai has it when the service's limits
  // name `go` (it has no key of its own, FE-105); else a Go key. Only the
  // real home's counts, as for the usage it gates.
  const realHome = () => agentHomeDir() === homedir();
  const readOpenCodeModels = createOpenCodeModels(
    // NOTE: Never started for the menu: only a chat on OpenCode starts it.
    async () =>
      openCodeClient(await opencode.service(false, { start: false }), null),
    async (client) => {
      if (!realHome()) return false;
      const limits = await client
        .request("GET", "/api/experimental/usage/limits", undefined, 5_000)
        .catch(() => null);
      if (opencodeServiceUsage(limits)) return true;
      return Boolean(
        await opencodeGoKey(opencodeDataDir(agentHomeDir(), process.env, true)),
      );
    },
    30_000,
    // Its service down: the ids from a private server that exits at once.
    async () => openCodeModelsOfIds(await listOpenCodeModelIds(opencodeCli)),
  );
  const opencodeModels = async (fresh = false): Promise<AgentModel[]> => {
    const models = await readOpenCodeModels(fresh);
    setOpenCodeModels(models);
    return models;
  };
  /**
   * OpenCode's models, asked again only when `model` looks like one of
   * OpenCode's (`provider/model`) that is not listed yet: a send on any
   * other CLI never waits on OpenCode's service.
   */
  const knowModel = async (model: unknown): Promise<void> => {
    if (
      typeof model === "string" &&
      model.includes("/") &&
      !(await readOpenCodeModels()).some((entry) => entry.id === model)
    )
      await opencodeModels(true);
  };
  // NOTE: A stored OpenCode model is only known once its list is. A missing
  // or slow OpenCode does not hold the first read up for long.
  const ready = Promise.all([
    claudeModels(),
    codexModels(),
    Promise.race([
      opencodeModels(),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]),
  ]);
  // FE-97: what every engine waits on the person for, followed from the
  // same events the page gets.
  const awaiting = createAwaitingLedger();
  /**
   * The conductor each conversation was seen running for, by project and
   * id. A Reset lets a conversation go from its conductor, not its engine:
   * the conductor's Stop still ends it.
   */
  const conductorSeen = new Map<string, string>();
  const seenKey = (project: string, conversation: string) =>
    `${project}\0${conversation}`;
  const sawConductor = (
    project: string,
    conversation: string,
    conductor: string,
  ) => {
    const key = seenKey(project, conversation);
    conductorSeen.delete(key);
    conductorSeen.set(key, conductor);
    if (conductorSeen.size > CONDUCTOR_SEEN_MAX)
      conductorSeen.delete(conductorSeen.keys().next().value as string);
  };
  /** The conductor whose own conversation this is now, or null. */
  const conductorNow = (project: string, conversation: string) =>
    conductorOfThread(
      project,
      engines.pending(project, conversation)?.agent ?? "claude",
      conversation,
    ).catch(() => null);
  /** Note the conductor a conversation runs for, the first time it is seen. */
  const learnConductor = async (project: string, conversation: string) => {
    if (conductorSeen.has(seenKey(project, conversation))) return;
    const conductor = await conductorNow(project, conversation);
    if (conductor) sawConductor(project, conversation, conductor);
  };
  const stream = createConversationStream(conversationChannels.event);

  // ─── Threads ──────────────────────────────────────────────────────────────
  //
  // NOTE: A thread is the chain head -> ... -> newest of native sessions an
  // in-place handoff (`switchAgent`) joined. The page names it by its
  // head's id (the first session's) everywhere; main reads it as all its
  // sessions stitched in order, and sends, stops, answers and reads the
  // engine of its NEWEST session. An engine only ever knows its own native
  // session: the id is swapped at this boundary, on the way in (`threadOf`)
  // and out (`placeNow`), so nothing below it changes.

  /**
   * Sessions a `switchAgent` is starting, by native id, before their link
   * is recorded: their first events already belong to the thread.
   */
  const joining = new Map<
    string,
    {
      head: string;
      session: TurnSession;
      /** The thread with it, head first, as the rail folds it. */
      rail: { conversation: string; agent: ConversationAgent }[];
    }
  >();
  // NOTE: A session still joining (its link not written yet) is already
  // its thread's on the rail: its first prompt may list it before then.
  setRailThreads({
    chainOf: (id) => joining.get(id)?.rail ?? handoffs.now.chainOf(id),
  });
  /** Threads a `switchAgent` is running on, by head: one at a time. */
  const switching = new Set<string>();
  const tagOf = (session: ChainSession): TurnSession => ({
    conversation: session.conversation,
    agent: session.agent,
    model: session.model,
  });

  /**
   * Where native session `conversation`'s events go: its thread's head,
   * whether it is the newest session (only its state is the thread's), and
   * the tag its turns carry; null for a session in no thread.
   */
  const placeNow = (
    conversation: string,
  ): { head: string; newest: boolean; session: TurnSession } | null => {
    const starting = joining.get(conversation);
    if (starting)
      return { head: starting.head, newest: true, session: starting.session };
    const chain = handoffs.now.chainOf(conversation);
    const at = chain.findIndex((entry) => entry.conversation === conversation);
    const head = chain[0];
    const me = chain[at];
    if (!head || !me) return null;
    return {
      head: head.conversation,
      // While a session joins, the one before it is no longer the newest.
      newest: at === chain.length - 1 && !switching.has(head.conversation),
      session: tagOf(me),
    };
  };

  /**
   * `event` as the thread's page hears it: named by the head, its turn
   * tagged; null for a state of a session that is no longer the newest
   * (its engine closing must not read as the thread's).
   */
  const threadEvent = (event: ConversationEvent): ConversationEvent | null => {
    if (typeof event.conversation !== "string") return event;
    const place = placeNow(event.conversation);
    if (!place) return event;
    if (event.type === "state" && !place.newest) return null;
    if (event.type === "turn")
      return {
        ...event,
        conversation: place.head,
        turn: { ...event.turn, session: place.session },
      };
    return { ...event, conversation: place.head };
  };

  /**
   * The thread page id `id` names: its head, its newest session, and its
   * sessions head first (empty for a conversation in no thread, whose head
   * and newest are `id` itself). Any session's id names its thread.
   */
  const threadOf = async (
    project: string,
    id: string,
  ): Promise<{ head: string; newest: string; chain: ChainSession[] }> => {
    const chain = await handoffs.chainOf(project, id);
    const head = chain[0]?.conversation ?? id;
    const newest = chain.at(-1)?.conversation ?? id;
    return { head, newest, chain };
  };
  /** A conversation's address from IPC arguments, named by its newest session. */
  const nativeOf = async (
    args: unknown[],
  ): Promise<{ project: string; conversation: string; head: string }> => {
    const { project, conversation } = conversationOf(args);
    const thread = await threadOf(project, conversation);
    return { project, conversation: thread.newest, head: thread.head };
  };
  /**
   * Refuse the user's own call on a thread a conductor started and did not
   * let them work in (`sessions.access`). Its head and its newest session
   * are asked: either one may be the session `sessions.start` marked. One
   * whose conductor is gone is the user's again (`managerOf`).
   *
   * NOTE: The page's IPC only. The conductor's `sessions.send` and every
   * orchestration path reach the engines without passing here.
   */
  const assertUserMayAct = async (thread: {
    head: string;
    newest: string;
  }): Promise<void> => {
    for (const id of new Set([thread.head, thread.newest])) {
      if (await managerOfConversation(id))
        throw new Error(
          "A conductor manages this session: it takes its instructions from the conductor. Ask the conductor, or ask it to give you access.",
        );
    }
  };
  /**
   * As {@link nativeOf}, for a call the user makes on the conversation:
   * refused on a session a conductor manages ({@link assertUserMayAct}).
   */
  const userNativeOf = async (
    args: unknown[],
  ): Promise<{ project: string; conversation: string; head: string }> => {
    const native = await nativeOf(args);
    await assertUserMayAct({ head: native.head, newest: native.conversation });
    return native;
  };
  /**
   * The native session `id`'s thread sends to and stops, its newest, for a
   * call the user makes: refused as {@link userNativeOf} is.
   */
  const userNewestOf = async (project: string, id: string): Promise<string> => {
    const thread = await threadOf(project, id);
    await assertUserMayAct(thread);
    return thread.newest;
  };
  /** A conversation's address from IPC arguments, named by its thread. */
  const headOf = async (
    args: unknown[],
  ): Promise<{ project: string; conversation: string }> => {
    const { project, conversation } = conversationOf(args);
    return {
      project,
      conversation: (await threadOf(project, conversation)).head,
    };
  };

  const tell = (event: ConversationEvent) => {
    // NOTE: Numbered on the thread's own counter (its head's key), so `seq`
    // stays monotonic across every session of the thread.
    const shown = threadEvent(event);
    if (shown) stream.publish(shown);
    sessions?.onEvent(event);
    if (event.type === "state" && typeof event.conversation === "string")
      void learnConductor(event.project, event.conversation);
    // An OpenCode turn that ended is read in now: the rail must not wait on
    // a database write its watch may never hear (FE-128).
    if (
      event.type === "state" &&
      event.engine.state !== "running" &&
      event.engine.state !== "starting"
    )
      void settleOpencodeSession(event.project, event.conversation).catch(
        () => undefined,
      );
    // Read once the event's other listeners ran: orchestration learns a new
    // Codex worker's id from this same event (FE-100/O1).
    queueMicrotask(() => {
      // A worker of an orchestration run asks its lead, never the person:
      // no island, no notification, no ping (FE-100/O1).
      if (
        typeof event.conversation === "string" &&
        isWorkerConversation(event.project, event.conversation)
      ) {
        awaiting.clear(event.project, event.conversation);
        return;
      }
      // What waits on the person is the thread's: the island and a
      // notification open the thread, and its answer goes to the newest.
      if (!shown) return;
      const asked = awaiting.apply(
        shown,
        () =>
          engines.pending(event.project, event.conversation)?.agent ?? "claude",
      );
      if (asked && shown.type === "permission")
        void notifyAsked(shown.project, shown.conversation, asked);
    });
  };
  /**
   * Tell the person an agent waits on them. A click opens its conversation;
   * a focused window already on it is not told.
   */
  const notifyAsked = async (
    project: string,
    conversation: string,
    request: PermissionRequest,
  ): Promise<void> => {
    const asked = `${project}\0${conversation}\0${request.id}`;
    if (notifiedAsks.has(asked)) return;
    const { project: found } = await knownProject(project).catch(() => ({
      project: null,
    }));
    // Answered, or the engine closed, while the project was looked up.
    const still = awaiting
      .list()
      .find(
        (entry) =>
          entry.project === project && entry.conversation === conversation,
      );
    if (!found || !still?.requests.some((entry) => entry.id === request.id))
      return;
    // A session its conductor manages waits on that conductor, which is
    // told itself: the user could not answer it. Not marked: once handed
    // back ({@link notifyHandedBack}), the user is told.
    if (await managerOfConversation(conversation)) return;
    if (notifiedAsks.has(asked)) return;
    notifiedAsks.add(asked);
    if (notifiedAsks.size > NOTIFIED_ASKS_MAX)
      notifiedAsks.delete(notifiedAsks.values().next().value as string);
    await notify({
      kind: "input",
      ...awaitingNotice(still.agent, request),
      target: { kind: "session", slug: found.slug, conversation },
    }).catch(() => {});
  };
  /**
   * Requests the person was notified of, by project, conversation and id:
   * one {@link notifyHandedBack} goes over again is not notified twice.
   */
  const notifiedAsks = new Set<string>();
  /**
   * Notify the person of what waits on them that a conductor kept until
   * now: it let them in (`sessions.access`), or it was deleted. Every
   * window holds the request already (a permission event goes to all of
   * them), and the island and the page show it once the rail row says
   * `managed: false`; only the desktop notification was never sent.
   *
   * @param project Null for every project.
   * @param conversation One thread only, named by its head.
   */
  const notifyHandedBack = (
    project: string | null,
    conversation?: string,
  ): void => {
    for (const entry of awaiting.list()) {
      if (project !== null && entry.project !== project) continue;
      if (conversation && entry.conversation !== conversation) continue;
      const native = handoffs.now.newestOf(entry.conversation);
      for (const request of engines.permissions(entry.project, native))
        void notifyAsked(entry.project, entry.conversation, request);
    }
  };
  onTeamLeadsChanged((project) => notifyHandedBack(project));
  // Usage limits: a turn refused for one stops every running turn of that
  // agent, and an opted-in conversation continues once it resets.
  /**
   * The limits' state as the page knows conversations: by thread.
   *
   * NOTE: The limits keep native sessions (an engine's turn is what a limit
   * stops), so each is named by its thread's head here; an opt-in left on
   * a session the thread has moved on from is not the thread's.
   */
  const threadLimits = (state: UsageLimitsState): UsageLimitsState => ({
    ...state,
    stopped: state.stopped.map((entry) => ({
      ...entry,
      conversation: handoffs.now.headOf(entry.conversation),
    })),
    autoContinue: state.autoContinue.flatMap((entry) =>
      handoffs.now.newestOf(entry.conversation) === entry.conversation
        ? [{ ...entry, conversation: handoffs.now.headOf(entry.conversation) }]
        : [],
    ),
  });
  const limits = createUsageLimits({
    emit: (state) =>
      broadcast(conversationChannels.usageLimitsEvent, threadLimits(state)),
    running: (agent) => engines.running(agent),
    stop: (project, conversation) => engines.stop(project, conversation),
    send: async (project, conversation, text) => {
      const settings =
        engines.settingsOf(conversation) ??
        (await store.of(conversation)) ??
        (await store.last());
      await sendTo(
        sendRequest({ project, conversation, text, attachments: [], settings }),
      );
    },
    windows: usageWindowsOf,
    // Beside the settings: a continue planned before a quit still goes.
    file: join(app.getPath("userData"), "usage-limits.json"),
  });
  // A banked reset spent: Codex runs again now, not at the old reset time.
  onCodexReset(() => limits.lifted("codex"));
  const engines = createEngines({
    cli: claudeCli,
    codexCli: createAgentCli("codex", () =>
      testing ? process.env.LANEWORK_CODEX_BIN : undefined,
    ),
    emit: tell,
    // FE-126: Settings → Power saver.
    idleLimit: idleLimitMs,
    warmCap,
    terminalOn: bridge.terminalOn,
    killTerminal: bridge.kill,
    remember: (id, settings) => void store.remember(id, settings),
    // FE-104: a service that moved or restarted is asked for again.
    opencode: (fresh) => {
      if (fresh) opencode.forget();
      return opencode.service(fresh);
    },
    // FE-77/D3: Claude's trust record, under the test seam's home too.
    trusted: (folder, env) =>
      isClaudeTrusted(folder, claudeJsonFor(env, agentHome())),
    // FE-121/D9: a local project's chat reaches its local board, signed in.
    localMcp: localMcpFor,
    board: boardFor,
    codexLanework: codexHasLaneworkTable,
    codexInstructions: codexHasDeveloperInstructions,
    // A turn the CLI died in (a crash, a kill after an unanswered Stop) left
    // its transcript open: recorded as cut off, so every "working" read lets
    // it go; the watchers hear it, and the chat reads again at once.
    processEnded: (agent, project, folder, conversation) =>
      void (async () => {
        const file =
          agent === "codex"
            ? await codexRolloutPath(agentHome(), folder, conversation)
            : transcriptPath(agentHome(), folder, conversation);
        if (file && (await markTurnCut(file, agent)))
          tell({ type: "moved", project, conversation });
      })().catch(() => {}),
    outcome: (outcome) => limits.report(outcome),
  });

  sessions = new ConductorSessions({
    engines: () => engines,
    folderOf,
    agentOf,
    read: readAny,
    storedSettings: (conversation) => store.of(conversation),
    conductorOf: conductorOfThread,
    name: nameConversation,
    register: (project, agent, id, folder, launchedBy) =>
      registerAgentSession(project, agent, id, folder, null, launchedBy),
    launching: (id, launchedBy) =>
      launchedBy ? noteLaunching(id, launchedBy) : doneLaunching(id),
    setUserAccess: setSessionUserAccess,
    // A request the conductor kept from the user is theirs now: the rail
    // hears from `setSessionUserAccess`, the desktop notification here.
    accessChanged: (project, session, userAccess) => {
      if (userAccess) notifyHandedBack(project, session);
    },
    // NOTE: The page's own gate (`assertUserMayAct`), so a request is the
    // user's or the conductor's to answer, never both or neither.
    userMayAct: async (id) => !(await managerOfConversation(id)),
    newestOf: (id) => handoffs.now.newestOf(id),
    headOf: (id) => handoffs.now.headOf(id),
    isWorkerFolder,
    endpoint: controlEndpoint,
    cliPath: controlCliPath(),
    file: join(app.getPath("userData"), "conductor-sessions.json"),
    createConductor,
    memory: conductorMemory,
    leadOf: (project, id) => teamLeadOf(project, id).catch(() => null),
    readThread: async (project, conversation, input) => {
      const sessions = await threadSessions(project, conversation);
      return readThread(
        {
          sessions: async () => sessions,
          turns: async (id) =>
            ownTurns(
              sessions.find((session) => session.conversation === id)?.link,
              (await readSession(project, id)).turns,
            ),
        },
        input,
      );
    },
    knowModels: async (agent, model) => {
      await ready.catch(() => {});
      if (agent === "codex") await codexModels();
      else if (agent === "opencode")
        await (model ? knowModel(model) : opencodeModels());
    },
  });
  const conductors = sessions;
  /**
   * The sessions `thread.read` lets `conversation` read, oldest first: its
   * thread's, and those of every conversation handed off into it (a
   * handoff to a NEW conversation is no thread's), followed back.
   */
  const threadSessions = async (
    project: string,
    conversation: string,
  ): Promise<(ThreadSession & { link?: ConversationHandoff | null })[]> => {
    const folder = await folderOf(project);
    const seen = new Set<string>();
    const out: (ThreadSession & { link?: ConversationHandoff | null })[] = [];
    let at: string | null = conversation;
    while (at && !seen.has(at) && out.length < THREAD_SESSIONS_MAX) {
      const chain = await handoffs.chainOf(project, at);
      const sessions: (ThreadSession & {
        link?: ConversationHandoff | null;
      })[] = chain.length
        ? chain.map((entry) => ({
            conversation: entry.conversation,
            agent: entry.agent,
            model: entry.model,
            link: entry.link,
          }))
        : [
            {
              conversation: at,
              agent:
                (await agentOf(folder, at).catch(() => null)) ??
                engines.pending(project, at)?.agent ??
                "claude",
              model: null,
            },
          ];
      for (const session of sessions) seen.add(session.conversation);
      out.unshift(...sessions);
      const head: string = sessions[0]?.conversation ?? at;
      const { from } = await handoffs.links(project, head);
      at = from && !from.thread ? from.from.conversation : null;
    }
    return out;
  };
  setSessionsEnv((target) => conductors.envFor(target));
  // FE-166: the connectors a process starts without. Read at each start from
  // stored names; nothing scans, polls or watches here.
  setConnectorSource({
    // A conductor's own conversation, or a session one started (found by
    // `launchedBy`): both are in-memory lookups, so a conversation no
    // conductor owns costs nothing. The lead is read only for those.
    disabled: async (target, agent) => {
      const conversation = target.conversation ?? target.named?.() ?? null;
      if (!conversation) return [];
      const id =
        launcherOfConversation(conversation)?.conductor ??
        (await conductorOfThread(target.project, agent, conversation));
      if (!id) return [];
      const lead = await teamLeadOf(target.project, id).catch(() => null);
      return lead?.connectors?.disabled ?? [];
    },
    // A run worker: the project's cached connectors, Lanework's left out.
    all: async (project, agent) => {
      const folder = await terminalFolder(project).catch(() => null);
      if (!folder) return [];
      const inventory = await connectorInventory(
        folder,
        agent,
        agentHomeAt(agentHomeDir()),
      );
      return inventory.connectors
        .filter((entry) => !entry.lanework)
        .map((entry) => entry.name);
    },
  });
  // FE-165: a rule's `conductor`, and the card "Always allow" reads.
  setPermissionConductors((project, agent, conversation) =>
    conductorOfThread(project, agent, conversation).catch(() => null),
  );
  pendingCards = async (project, conversation, id) => {
    const native = await nativeOf([project, conversation]);
    const request = engines
      .permissions(native.project, native.conversation)
      .find((entry) => entry.id === id);
    if (!request) return null;
    return {
      project: native.project,
      conversation: native.conversation,
      agent:
        engines.pending(native.project, native.conversation)?.agent ?? "claude",
      folder:
        workerFolderOf(native.project, native.conversation) ??
        (await folderOf(native.project)),
      request,
    };
  };
  stoppable = {
    alive: (project) =>
      engines.alive(project).filter((id) => !isWorkerConversation(project, id)),
    working: (project, conversation) =>
      engines.pending(project, conversation)?.working ?? false,
    conductorOf: async (project, conversation) =>
      (await conductorNow(project, conversation)) ??
      conductorSeen.get(seenKey(project, conversation)) ??
      null,
    sessionsOf: (project, lead) => conductors.sessionsOf(project, lead),
    hold: (project, lead, conversations) =>
      conductors.hold(project, lead, conversations),
    // As `conversation.close`.
    close: async (project, conversation) => {
      await engines.close(project, conversation);
      awaiting.clear(project, conversation);
    },
  };
  // Launches saved before FE-128 go to their conductor while its
  // conversation is still bound, before a Reset could let it go.
  void conductors
    .adopt()
    .catch((error: unknown) =>
      console.error("Unable to place a conductor's old sessions", error),
    )
    // FE-133: the reports owed when the app last quit, and the sessions it
    // still watched, once the launches are placed.
    .then(() => conductors.restore())
    .catch((error: unknown) =>
      console.error("Unable to restore a conductor's owed reports", error),
    );

  // The conversations whose engine last answered `terminal`: when a tab
  // stops, the composer hears it may write again, without polling.
  const paused = new Map<string, { project: string; conversation: string }>();
  const noted = async (
    project: string,
    conversation: string,
    state: Promise<EngineState>,
  ): Promise<EngineState> => {
    const now = await state;
    const id = `${project}\0${conversation}`;
    if (now.state === "terminal") {
      paused.set(id, { project, conversation });
      if (paused.size > 64) paused.delete(paused.keys().next().value as string);
    } else paused.delete(id);
    return now;
  };
  bridge.onRunningChanged?.(() => {
    for (const [id, which] of [...paused]) {
      void engines.state(which.project, which.conversation).then((engine) => {
        if (engine.state === "terminal") return;
        paused.delete(id);
        tell({ type: "state", ...which, engine });
      });
    }
  });

  /**
   * Native session `conversation` of `project` with every turn main holds:
   * one session of a thread, or a conversation in none.
   */
  const readSession = async (
    project: string,
    conversation: string,
  ): Promise<Conversation> => {
    // A worker of an orchestration run (FE-87) keeps its transcript under
    // its own worktree, not the project's folder.
    const folder =
      workerFolderOf(project, conversation) ?? (await folderOf(project));
    const agent = await agentOf(folder, conversation);
    // A conversation started here whose first line the CLI has not
    // written yet: what its engine holds so far.
    const pending = engines.pending(project, conversation);
    if (pending && !agent)
      return {
        id: conversation,
        agent: pending.agent,
        cwd: folder,
        branch: null,
        turns: pending.turns,
        working: pending.working,
        card: null,
        settings: await store.of(conversation),
        truncated: false,
      };
    // NOTE: The settings first, the read last: a Claude read shares its
    // turns with the fold kept for the next one (`readConversation`), and
    // nothing may wait between the read and the answer going out, or a
    // read of new lines would change what this one answers.
    const settings = await store.of(conversation);
    const read = await readAny(folder, conversation);
    // OpenCode's running turn, newer than its database (FE-104).
    if (agent === "opencode" && pending?.working)
      return {
        ...read,
        turns: withLive(read.turns, pending.turns),
        working: true,
        settings,
      };
    return { ...read, settings };
  };

  // NOTE: The same tagged copy of the same turn object, read after read: a
  // Claude transcript's turns are its fold's own objects until a line
  // changes them, and `summaryOf` keeps its answer while they are the same.
  const tagged = new WeakMap<Turn, Turn>();
  const tag = (turn: Turn, session: TurnSession): Turn => {
    const known = tagged.get(turn);
    if (known?.session?.conversation === session.conversation) return known;
    const out = { ...turn, session } as Turn;
    tagged.set(turn, out);
    return out;
  };
  const markers = new WeakMap<object, HandoffTurn>();
  /** The `handoff` turn drawn before session `chain[at]` (at >= 1). */
  const markerOf = (chain: ChainSession[], at: number): HandoffTurn | null => {
    const session = chain[at];
    const link = session?.link;
    if (!session || !link) return null;
    const known = markers.get(link);
    if (known) return known;
    const side = (entry: ChainSession) => ({
      conversation: entry.conversation,
      agent: entry.agent,
      model: entry.model,
    });
    const marker: HandoffTurn = {
      role: "handoff",
      id: `handoff:${session.conversation}`,
      from: chain.slice(0, at).map(side),
      to: side(session),
      at: link.at,
      carried: link.carried,
      session: tagOf(session),
    };
    markers.set(link, marker);
    return marker;
  };

  /**
   * Conversation `conversation` of `project` with every turn main holds: what
   * `read` answers with `{ full: true }`, and what its window and pages are
   * cut from.
   *
   * For a thread: every session's turns in order, each tagged with its
   * session, a `handoff` turn before each later session; named by its head,
   * and its agent, working, settings and the rest its newest session's.
   */
  const readWhole = async (
    project: string,
    conversation: string,
  ): Promise<Conversation> => {
    const { chain } = await threadOf(project, conversation);
    const newest = chain.at(-1);
    const head = chain[0];
    if (!head || !newest) return readSession(project, conversation);
    const turns: Turn[] = [];
    let truncated = false;
    for (let at = 0; at < chain.length - 1; at++) {
      const session = chain[at] as ChainSession;
      if (at > 0) {
        const marker = markerOf(chain, at);
        if (marker) turns.push(marker);
      }
      // NOTE: A session whose transcript is gone (deleted, archived, or a
      // start that never wrote a line) leaves its marker only: the thread
      // still reads, without what it said.
      const read = await readSession(project, session.conversation).catch(
        () => null,
      );
      if (!read) continue;
      truncated ||= read.truncated;
      const sessionTag = tagOf(session);
      for (const turn of ownTurns(session.link, read.turns))
        turns.push(tag(turn, sessionTag));
    }
    const marker = markerOf(chain, chain.length - 1);
    if (marker) turns.push(marker);
    // NOTE: The newest session last, with nothing awaited after it, as
    // `readSession` reads its own transcript (see its NOTE).
    const last = await readSession(project, newest.conversation);
    const newestTag = tagOf(newest);
    for (const turn of ownTurns(newest.link, last.turns))
      turns.push(tag(turn, newestTag));
    return {
      ...last,
      id: head.conversation,
      turns,
      truncated: truncated || last.truncated,
    };
  };

  /** Every turn an image badge may name, a thread's every session's. */
  const imageTurns = async (project: string, conversation: string) =>
    (await readWhole(project, conversation)).turns;

  // NOTE: The newest turns only, unless asked for all (`windowStart`): the
  // answer is structured-cloned into the page on every read, after every
  // turn, and a long conversation's turns are megabytes. The rest comes a
  // page at a time (`readBefore`), from the same fold.
  handle(
    conversationChannels.read,
    devUrl,
    async (args): Promise<Conversation> => {
      await ready;
      if (args.length !== 2 && args.length !== 3)
        throw new Error("A project and a conversation are required");
      const full = readOptions(args[2]).full;
      // A thread's id is its head's, and so is its counter.
      const { project, conversation } = await headOf(args);
      // Who started it, and whether that conductor keeps the user out now
      // (`managerOf`, the rule the rail rows carry too): the page knows a
      // managed session from its first read, before the rail lists it.
      // Asked before the read: nothing may be awaited after `seq`.
      const launchedBy = launcherOfConversation(conversation);
      const managed = (await managerOf(launchedBy)) !== null;
      const read = await readWhole(project, conversation);
      // NOTE: Taken once read, with nothing awaited after: every event up to
      // it went out before this answer (one pipe, in order), so a page drops
      // a replayed one at or below it that the read already holds.
      const seq = stream.seq(project, conversation);
      if (full) return { ...read, earlier: 0, seq, launchedBy, managed };
      const start = windowStart(read.turns);
      return start > 0
        ? {
            ...read,
            turns: read.turns.slice(start),
            earlier: start,
            summary: summaryOf(conversation, read.turns, start),
            seq,
            launchedBy,
            managed,
          }
        : { ...read, earlier: 0, seq, launchedBy, managed };
    },
  );

  // A page that shows a conversation takes its events in full; every other
  // window hears its status only (`createConversationStream`).
  handle(
    conversationChannels.subscribe,
    devUrl,
    async (args, sender): Promise<ConversationReplay> => {
      if (args.length !== 3)
        throw new Error("A project, a conversation and a seq are required");
      const after = afterOf(args[2]);
      // A thread's events are all its head's (`tell`).
      const { project, conversation } = await headOf(args);
      return stream.subscribe(sender, project, conversation, after);
    },
  );

  handle(
    conversationChannels.unsubscribe,
    devUrl,
    async (args, sender): Promise<void> => {
      if (args.length !== 2)
        throw new Error("A project and a conversation are required");
      const { project, conversation } = await headOf(args);
      stream.unsubscribe(sender, project, conversation);
    },
  );

  handle(
    conversationChannels.replay,
    devUrl,
    async (args): Promise<ConversationReplay> => {
      if (args.length !== 3)
        throw new Error("A project, a conversation and a seq are required");
      const after = afterOf(args[2]);
      const { project, conversation } = await headOf(args);
      return stream.replay(project, conversation, after);
    },
  );

  handle(
    conversationChannels.readBefore,
    devUrl,
    async (args): Promise<ConversationPage> => {
      await ready;
      if (args.length !== 3 && args.length !== 4)
        throw new Error("A project, a conversation and a turn are required");
      const { project, conversation } = conversationOf(args);
      const before = turnRef(args[2]);
      const limit = pageLimit(args[3]);
      const { turns } = await readWhole(project, conversation);
      // From the end: the turn asked from is the oldest the page holds,
      // nearer the end than the start.
      let end = turns.length - 1;
      while (end >= 0 && turns[end]?.id !== before) end--;
      if (end < 0)
        throw new Error(
          "That part of the conversation changed. Read it again.",
        );
      const start = windowStart(turns, end, limit);
      return { turns: turns.slice(start, end), earlier: start };
    },
  );

  // A summary for a panel that looks through the whole conversation for some
  // tool calls (the web pages it read): only those go out, not the turns.
  handle(
    conversationChannels.readToolCalls,
    devUrl,
    async (args): Promise<AssistantTurn[]> => {
      await ready;
      if (args.length !== 3)
        throw new Error("A project, a conversation and tools are required");
      const { project, conversation } = conversationOf(args);
      const tools = toolNames(args[2]);
      const { turns } = await readWhole(project, conversation);
      const out: AssistantTurn[] = [];
      for (const turn of turns) {
        if (turn.role !== "assistant") continue;
        const calls = turn.blocks.flatMap((block) =>
          block.type === "tools"
            ? block.calls.filter((call) => tools.has(call.tool))
            : [],
        );
        if (calls.length)
          out.push({ ...turn, blocks: [{ type: "tools", calls }] });
      }
      return out;
    },
  );

  // Small facts of the whole conversation, for a panel that wants only them
  // (the web pages it read): from the fold `read` keeps, and kept with it.
  // NOTE: Never the turns over IPC, and for a Claude or Codex transcript
  // never a read of the file either when nothing was written since.
  handle(
    conversationChannels.summary,
    devUrl,
    async (args): Promise<ConversationFacts> => {
      await ready;
      if (args.length !== 2)
        throw new Error("A project and a conversation are required");
      const { project, conversation } = conversationOf(args);
      // NOTE: A thread's facts are every session's: read stitched, without
      // the per-transcript fold a lone conversation keeps its answer in.
      if ((await threadOf(project, conversation)).chain.length)
        return {
          web: webSourcesOf((await readWhole(project, conversation)).turns),
        };
      const folder =
        workerFolderOf(project, conversation) ?? (await folderOf(project));
      const agent = await agentOf(folder, conversation);
      const pending = engines.pending(project, conversation);
      if (pending && !agent) return { web: webSourcesOf(pending.turns) };
      switch (agent) {
        case "opencode": {
          // No file to fold: the database is read, as `read` does.
          const read = await readOpenCodeConversation(
            opencodeData(),
            folder,
            conversation,
          );
          return {
            web: webSourcesOf(
              pending?.working
                ? withLive(read.turns, pending.turns)
                : read.turns,
            ),
          };
        }
        case "codex":
          return codexFacts(agentHome(), folder, conversation);
        default:
          return claudeFacts(agentHome(), folder, conversation);
      }
    },
  );

  handle(
    conversationChannels.toolOutput,
    devUrl,
    async (args): Promise<ToolOutput> => {
      await ready;
      if (args.length !== 3)
        throw new Error("A project, a conversation and a call are required");
      const { project, conversation } = conversationOf(args);
      const call = turnRef(args[2]);
      const folder =
        workerFolderOf(project, conversation) ?? (await folderOf(project));
      // NOTE: In a thread the call is one session's: the newest first (the
      // likeliest), then back. Each is asked of its own transcript.
      const { chain } = await threadOf(project, conversation);
      const candidates = chain.length
        ? chain.map((entry) => entry.conversation).reverse()
        : [conversation];
      for (const session of candidates) {
        // Only a Claude transcript says where a long result lies (`outputCut`).
        if ((await agentOf(folder, session)) !== "claude") continue;
        if (candidates.length === 1)
          return readToolOutput(agentHome(), folder, session, call);
        const found = await readToolOutput(
          agentHome(),
          folder,
          session,
          call,
        ).catch(() => null);
        if (found) return found;
      }
      throw new Error("That tool result is not in the transcript.");
    },
  );

  // The rail's dot (FE-95/D4): only the id of the latest proposal that
  // waits on the user, never the conversation. NOTE: Reads what `read`
  // answers (a pending start's turns, OpenCode's live ones), but a Claude
  // transcript from the fold `read` keeps too, and a Codex rollout from its
  // own fold: the rail asks after every turn of every conductor.
  handle(
    conversationChannels.latestProposal,
    devUrl,
    async (args): Promise<string | null> => {
      await ready;
      if (args.length !== 2 && args.length !== 3)
        throw new Error("A project and a conversation are required");
      const { project, conversation } = conversationOf(args);
      const leads = proposalLeads(args[2]);
      // NOTE: A thread's proposals may be planned in one session and run in
      // the next: read stitched (no per-transcript fold for it).
      if ((await threadOf(project, conversation)).chain.length)
        return latestReadyProposal(
          (await readWhole(project, conversation)).turns,
          leads,
        );
      const folder =
        workerFolderOf(project, conversation) ?? (await folderOf(project));
      const agent = await agentOf(folder, conversation);
      const pending = engines.pending(project, conversation);
      if (pending && !agent) return latestReadyProposal(pending.turns, leads);
      switch (agent) {
        case "opencode": {
          const read = await readOpenCodeConversation(
            opencodeData(),
            folder,
            conversation,
          );
          return latestReadyProposal(
            pending?.working ? withLive(read.turns, pending.turns) : read.turns,
            leads,
          );
        }
        case "codex":
          return latestCodexProposal(agentHome(), folder, conversation, leads);
        default:
          return latestClaudeProposal(agentHome(), folder, conversation, leads);
      }
    },
  );

  handle(
    conversationChannels.start,
    devUrl,
    async (args): Promise<{ conversation: string; engine: EngineState }> => {
      // A model Codex or OpenCode listed since the last read is known now.
      await codexModels();
      if (args.length !== 1) throw new Error("A request is required");
      await knowModel(
        (args[0] as { settings?: { model?: unknown } } | null)?.settings?.model,
      );
      // NOTE: The id is main's own, never the page's, so a new one cannot
      // name a conversation that already exists.
      const conversation = randomUUID();
      const raw = (args[0] ?? {}) as { conductor?: unknown };
      const request = sendRequest({ ...raw, conversation });
      // The conductor whose own conversation this starts (FE-95).
      const conductor = raw.conductor ?? null;
      if (
        conductor !== null &&
        (typeof conductor !== "string" || !LEAD_REF_PATTERN.test(conductor))
      )
        throw new Error("A valid conductor is required");
      if (!request.text.trim() && request.attachments.length === 0)
        throw new Error("Write something first.");
      // Checked just above: a lead ref, or none.
      return startNew(request, conductor as string | null);
    },
  );

  /**
   * Start the NEW conversation `request.conversation` names (an id main
   * just made) with `request` as its first message: the page's start, a
   * handoff's, and a `switchAgent`'s new session.
   *
   * @param conductor Makes it that conductor's own conversation (FE-95).
   * @param named Told the native id as soon as the CLI named it, before
   *   anything else is awaited: a session joining a thread is placed in it
   *   before its next events go out.
   */
  async function startNew(
    request: SendRequest,
    conductor: string | null,
    named?: (conversation: string) => void,
  ): Promise<{ conversation: string; engine: EngineState }> {
    const folder = await folderOf(request.project);
    const out = await outgoingOf(request);
    // The model picks the CLI: Codex and OpenCode name their conversation
    // themselves.
    const agent = agentOfModel(request.settings.model);
    const started =
      agent !== "claude"
        ? await engines.startNamed(agent, request.project, folder, out)
        : {
            conversation: request.conversation,
            engine: await engines.start(
              request.project,
              request.conversation,
              folder,
              out,
            ),
          };
    named?.(started.conversation);
    // FE-112: listed without a Pull, once its first prompt is read in.
    await registerAgentSession(
      request.project,
      agent,
      started.conversation,
      folder,
    ).catch(() => undefined);
    if (conductor) {
      await bindConductorConversation(
        request.project,
        agent,
        started.conversation,
        conductor,
      );
      // Its first state events came before it was bound.
      sawConductor(request.project, started.conversation, conductor);
    }
    return started;
  }

  /**
   * The fork a switch of a thread to `target` starts from (BE-05), or null
   * for a fresh session: the target CLI's newest earlier session of the
   * thread, read whole (not truncated) and small enough with the turns
   * since (D3), Claude or Codex only (D2: OpenCode cannot fork by id). Its
   * block carries only the turns after that session.
   */
  async function forkPlan(
    project: string,
    source: Awaited<ReturnType<typeof handoffSource>>,
    from: string,
    target: ConversationAgent,
    text: string,
    budget: number,
    head: string,
  ): Promise<{
    prior: string;
    built: ReturnType<typeof buildHandoff>;
    forked: NonNullable<ConversationHandoff["forked"]>;
  } | null> {
    // FE-168/D2: an older CLI than Lanework's floor gets a fresh session.
    if (target === "opencode" || belowMinimumNow(target)) return null;
    const chain = source.thread.chain;
    let at = -1;
    for (let index = chain.length - 1; index >= 0; index--) {
      const entry = chain[index];
      if (entry && entry.conversation !== from && entry.agent === target) {
        at = index;
        break;
      }
    }
    const prior = chain[at];
    if (!prior) return null;
    // Its transcript as the fork copies it: every line, its own copy of an
    // earlier session included.
    const raw = await readSession(project, prior.conversation).catch(
      () => null,
    );
    if (!raw || raw.truncated) return null;
    const after = new Set(
      chain.slice(at + 1).map((entry) => entry.conversation),
    );
    const turns = source.turns.filter(
      (turn) =>
        turn.role !== "handoff" &&
        after.has(turn.session?.conversation ?? from),
    );
    const built = buildHandoff(
      {
        agent: source.from,
        conversation: from,
        model: source.model,
        turns,
        truncated: false,
        sessions: source.sessions,
        thread: head,
        resumed: prior.conversation,
      },
      text,
      budget,
    );
    if (
      contextOf(raw.turns) + Math.ceil(built.carried.bytes / 4) >
      FORK_CONTEXT_MAX
    )
      return null;
    return {
      prior: prior.conversation,
      built,
      forked: {
        from: prior.conversation,
        lastTurn: raw.turns.at(-1)?.id ?? null,
        turns: raw.turns.length,
      },
    };
  }

  /**
   * Start a switch's new session as a fork of `prior` (BE-05): Claude's by
   * copying its transcript to a new id main picks (`forkConversation`),
   * Codex's by `thread/fork`. `join` places it in the thread before its
   * first events go out.
   *
   * @throws When the CLI cannot fork it; the caller starts a fresh one.
   */
  async function startFork(
    request: SendRequest,
    prior: string,
    folder: string,
    join: (native: string) => void,
  ): Promise<{ conversation: string; engine: EngineState; forked: true }> {
    const agent = agentOfModel(request.settings.model);
    let started: { conversation: string; engine: EngineState };
    if (agent === "claude") {
      const fork = await forkConversation(agentHome(), folder, prior, {
        title: false,
      });
      join(fork);
      const out = await outgoingOf({ ...request, conversation: fork });
      started = {
        conversation: fork,
        engine: await engines.send(request.project, fork, folder, out, agent),
      };
    } else if (agent === "codex") {
      const out = await outgoingOf(request);
      started = await engines.startNamed(
        agent,
        request.project,
        folder,
        out,
        prior,
      );
      join(started.conversation);
    } else throw new Error("OpenCode cannot fork a session.");
    await registerAgentSession(
      request.project,
      agent,
      started.conversation,
      folder,
    ).catch(() => undefined);
    return { ...started, forked: true };
  }

  /**
   * What a handoff of `id` carries: its thread's turns (a lone
   * conversation's own), and who wrote its newest session.
   *
   * @throws When the conversation is not in this project.
   */
  async function handoffSource(project: string, id: string) {
    const folder = await folderOf(project);
    const thread = await threadOf(project, id);
    const newest = thread.newest;
    const pending = engines.pending(project, newest);
    const written = await agentOf(folder, newest);
    const from = written ?? pending?.agent;
    if (!from) throw new Error("That conversation is not in this project.");
    const before = await store.of(newest);
    const model = engines.settingsOf(newest)?.model ?? before?.model ?? null;
    // What `read` answers: a pending start's turns, OpenCode's live ones,
    // and for a thread every session's, stitched.
    let turns: Turn[];
    let truncated = false;
    if (thread.chain.length) {
      const read = await readWhole(project, id);
      turns = read.turns;
      truncated = read.truncated;
    } else if (pending && !written) turns = pending.turns;
    else {
      const read = await readAny(folder, newest);
      turns =
        from === "opencode" && pending?.working
          ? withLive(read.turns, pending.turns)
          : read.turns;
      truncated = read.truncated;
    }
    // The newest session's model as it runs now, the others' as handed to.
    const sessions = thread.chain.map((entry) => ({
      conversation: entry.conversation,
      agent: entry.agent,
      model:
        entry.conversation === newest ? (model ?? entry.model) : entry.model,
    }));
    return { folder, thread, from, before, model, turns, truncated, sessions };
  }

  /**
   * The settings a handoff's new session runs with, checked.
   *
   * @param before The newest session's last settings, for its permission.
   * @throws When they are not valid settings.
   */
  async function handoffSettings(
    raw: Record<string, unknown>,
    before: ComposerSettings | null,
  ): Promise<ComposerSettings> {
    if (raw.fast !== undefined && typeof raw.fast !== "boolean")
      throw new Error("Unknown settings");
    const settings = checkSettings({
      model: raw.model,
      effort: raw.effort,
      fast: raw.fast ?? false,
      permission:
        raw.permission ?? before?.permission ?? (await store.last()).permission,
    });
    if (!settings) throw new Error("Unknown settings");
    return settings;
  }

  // Handoff: continue a conversation in a new one on another agent, its
  // first message the source's context block and the person's text.
  // NOTE: Still a NEW conversation of its own, as before `switchAgent`: its
  // link is no thread's (`thread` unset), so both keep their own rows. Of
  // a thread, it carries the whole thread and links from its newest session.
  handle(
    conversationChannels.handoff,
    devUrl,
    async (args): Promise<string> => {
      await ready;
      // A model Codex or OpenCode listed since the last read is known now.
      await codexModels();
      if (args.length !== 1) throw new Error("A request is required");
      const raw = (args[0] ?? {}) as Record<string, unknown>;
      const { project, conversation } = conversationOf([
        raw.project,
        raw.conversation,
      ]);
      await knowModel(raw.model);
      // A worker's transcript is in its own worktree, and its lead talks
      // to it (FE-87): a new conversation in the project's folder is not
      // its continuation.
      if (workerFolderOf(project, conversation))
        throw new Error(
          "This conversation is a worker of an orchestration run. Hand off its lead instead.",
        );
      const target = raw.agent;
      if (target !== "claude" && target !== "codex" && target !== "opencode")
        throw new Error("A valid agent is required");
      const text = raw.text;
      if (typeof text !== "string" || !text.trim())
        throw new Error("Write something first.");
      if (raw.fast !== undefined && typeof raw.fast !== "boolean")
        throw new Error("Unknown settings");
      // Continued elsewhere on the user's say: their call to make only in a
      // session they may work in.
      await userNewestOf(project, conversation);
      const source = await handoffSource(project, conversation);
      const settings = await handoffSettings(raw, source.before);
      if (agentOfModel(settings.model) !== target)
        throw new Error(
          `Pick ${target === "opencode" ? "an" : "a"} ${AGENT_LABELS[target]} model to hand off to.`,
        );
      const from = source.thread.newest;
      // The person's own message and attachments, checked as a send's are
      // before anything is built on them.
      const { attachments } = sendRequest({
        project,
        conversation: from,
        text,
        attachments: raw.attachments ?? [],
        settings,
      });
      const built = buildHandoff(
        {
          agent: source.from,
          conversation: from,
          model: source.model,
          turns: source.turns,
          truncated: source.truncated,
          ...(source.sessions.length
            ? { sessions: source.sessions, thread: source.thread.head }
            : {}),
        },
        text,
        handoffBudget({ text, attachments }),
      );
      const request = sendRequest({
        project,
        conversation: randomUUID(),
        text: built.text,
        attachments,
        settings,
      });
      const started = await startNew(request, null);
      // Continued on another agent: the old conversation's continue after
      // its limit resets would run a second agent on the same work.
      limits.sent(project, from);
      await handoffs.record({
        project,
        from: { conversation: from, agent: source.from, model: source.model },
        to: {
          conversation: started.conversation,
          agent: target,
          model: settings.model,
        },
        at: new Date().toISOString(),
        carried: built.carried,
        limit: limitOver(limits.state().limits, source.from, source.model),
      });
      // Titled by the person's message, not the context block before it.
      const title = handoffTitle(text);
      if (title)
        await nameConversation(target, started.conversation, title).catch(
          () => undefined,
        );
      return started.conversation;
    },
  );

  // Switch agent: continue a thread on another agent IN PLACE. A new
  // native session starts with the whole thread's context block and the
  // person's text, and joins the thread as its newest session; the page
  // stays on the thread's id (its head's), which this answers.
  handle(
    conversationChannels.switchAgent,
    devUrl,
    async (args): Promise<string> => {
      await ready;
      // A model Codex or OpenCode listed since the last read is known now.
      await codexModels();
      if (args.length !== 3)
        throw new Error("A project, a conversation and a request are required");
      const { project, conversation } = conversationOf(args);
      const value = args[2];
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("A request is required");
      const raw = value as Partial<Record<keyof SwitchAgentRequest, unknown>>;
      await knowModel(raw.model);
      // A worker's transcript is in its own worktree, and its lead talks to
      // it (FE-87): never a thread of the project's folder.
      if (workerFolderOf(project, conversation))
        throw new Error(
          "This conversation is a worker of an orchestration run. Switch its lead instead.",
        );
      const text = raw.text;
      if (typeof text !== "string" || !text.trim())
        throw new Error("Write something first.");
      const thread = await threadOf(project, conversation);
      await assertUserMayAct(thread);
      const head = thread.head;
      // NOTE: One switch per thread at a time: two at once would both
      // start from the same newest session and fork the chain.
      if (switching.has(head))
        throw new Error("This conversation is already switching agents.");
      switching.add(head);
      /** The sessions placed in the thread before their link was written. */
      const joined: string[] = [];
      let done = false;
      try {
        const source = await handoffSource(project, conversation);
        const from = source.thread.newest;
        // NOTE: Not while its newest session runs a turn (or a terminal
        // runs it): the new agent would work beside it on the same files.
        const now = await engines.state(project, from);
        if (
          now.state === "running" ||
          now.state === "starting" ||
          now.state === "terminal" ||
          engines.pending(project, from)?.working
        )
          throw new Error("Stop the running turn first, then switch agents.");
        const settings = await handoffSettings(raw, source.before);
        const target = agentOfModel(settings.model);
        const { attachments } = sendRequest({
          project,
          conversation: from,
          text,
          attachments: raw.attachments ?? [],
          settings,
        });
        const sessions = source.sessions.length
          ? source.sessions
          : [{ conversation: from, agent: source.from, model: source.model }];
        const budget = handoffBudget({ text, attachments });
        // BE-05: back to a CLI the thread already ran on, its newest
        // session there is forked (its history whole) and told only what
        // came since; else a fresh session gets the block (BE-04 delta).
        const fork = await forkPlan(
          project,
          source,
          from,
          target,
          text,
          budget,
          head,
        );
        /** A fresh session's block: the delta, or the whole thread. */
        const freshBlock = () => {
          const delta = deltaOf(source.thread.chain, source.turns, from);
          return buildHandoff(
            {
              agent: source.from,
              conversation: from,
              model: source.model,
              turns: delta?.turns ?? source.turns,
              truncated: source.truncated,
              sessions,
              thread: head,
              ...(delta ? { earlier: delta.earlier } : {}),
            },
            text,
            budget,
          );
        };
        const join = (native: string) => {
          joined.push(native);
          joining.set(native, {
            head,
            session: {
              conversation: native,
              agent: target,
              model: settings.model,
            },
            rail: [
              ...sessions.map(({ conversation, agent }) => ({
                conversation,
                agent,
              })),
              { conversation: native, agent: target },
            ],
          });
        };
        const requestOf = (block: string) =>
          sendRequest({
            project,
            conversation: randomUUID(),
            text: block,
            attachments,
            settings,
          });
        const forkedStart = fork
          ? await startFork(
              requestOf(fork.built.text),
              fork.prior,
              source.folder,
              join,
            ).catch(() => null)
          : null;
        // NOTE: A fork that could not start gets the fresh block, never the
        // fork's: that one assumes the earlier session's history is held.
        const built = forkedStart && fork ? fork.built : freshBlock();
        const started =
          forkedStart ??
          (await (async () => {
            const request = requestOf(built.text);
            // Claude's id is main's own: its very first event is the
            // thread's. Codex and OpenCode name theirs, placed as soon as
            // they do.
            if (target === "claude") join(request.conversation);
            return startNew(request, null, (native) => {
              if (!joined.includes(native)) join(native);
            });
          })());
        const forked = forkedStart && fork ? fork.forked : null;
        await handoffs.record({
          project,
          from: { conversation: from, agent: source.from, model: source.model },
          to: {
            conversation: started.conversation,
            agent: target,
            model: settings.model,
          },
          at: new Date().toISOString(),
          carried: built.carried,
          limit: limitOver(limits.state().limits, source.from, source.model),
          thread: true,
          ...(forked ? { forked } : {}),
        });
        done = true;
        // The settings follow the newest session: a Codex or OpenCode
        // engine remembers none before it is named.
        await store.remember(started.conversation, settings);
        // Continued on another agent: the old session's continue after its
        // limit resets would run a second agent on the same work.
        limits.sent(project, from);
        // NOTE: Nothing addresses the old session any more (every call on
        // the thread goes to its newest), so its idle engine is let go of
        // now rather than at the idle limit. Its state is no longer the
        // thread's (`threadEvent`).
        void engines.close(project, from).catch(() => undefined);
        awaiting.clear(project, from);
        return head;
      } finally {
        switching.delete(head);
        for (const native of joined) joining.delete(native);
        if (!done) {
          // The old newest session's state went unheard while it switched.
          void engines
            .state(project, thread.newest)
            .then((engine) =>
              tell({
                type: "state",
                project,
                conversation: thread.newest,
                engine,
              }),
            )
            .catch(() => undefined);
        } else threadsChanged(project);
      }
    },
  );

  handle(
    conversationChannels.handoffLinks,
    devUrl,
    async (args): Promise<ConversationHandoffLinks> => {
      if (args.length !== 2)
        throw new Error("A project and a conversation are required");
      const { project, conversation } = conversationOf(args);
      const { chain } = await threadOf(project, conversation);
      if (!chain.length) return handoffs.links(project, conversation);
      // NOTE: A thread's links to and from other conversations: into its
      // head, and out of any of its sessions. Its own (in-place) links are
      // its `handoff` turns, not these.
      const all = await Promise.all(
        chain.map((entry) => handoffs.links(project, entry.conversation)),
      );
      return {
        from: all[0]?.from?.thread ? null : (all[0]?.from ?? null),
        to: all.flatMap((links) => links.to.filter((link) => !link.thread)),
      };
    },
  );

  /**
   * Send a checked request to an existing conversation: the page's send, and
   * the continue after a usage limit (`usage-limits.ts`).
   */
  async function sendTo(request: SendRequest): Promise<EngineState> {
    // A worker is the lead's to talk to; a send from here would start a
    // second engine on its conversation in the project's folder (FE-87).
    if (workerFolderOf(request.project, request.conversation))
      throw new Error(
        "This conversation is a worker of an orchestration run. Message it through its lead.",
      );
    const folder = await folderOf(request.project);
    // NOTE: Only a conversation this folder has: its transcript is where
    // the CLI keeps this folder's, under the id it was asked for.
    const agent =
      (await agentOf(folder, request.conversation)) ??
      engines.pending(request.project, request.conversation)?.agent;
    if (!agent) throw new Error("That conversation is not in this project.");
    // A conversation stays on the CLI that wrote it.
    if (agentOfModel(request.settings.model) !== agent)
      throw new Error(
        `Pick ${agent === "opencode" ? "an" : "a"} ${AGENT_LABELS[agent]} model for this conversation.`,
      );
    // FE-112: one Lanework resumes is one it lists. A row the store has is
    // left as it is.
    void registerAgentSession(
      request.project,
      agent,
      request.conversation,
      folder,
    ).catch(() => undefined);
    return noted(
      request.project,
      request.conversation,
      engines.send(
        request.project,
        request.conversation,
        folder,
        await outgoingOf(request),
        agent,
      ),
    );
  }

  handle(
    conversationChannels.send,
    devUrl,
    async (args): Promise<EngineState> => {
      await codexModels();
      if (args.length !== 1) throw new Error("A request is required");
      await knowModel(
        (args[0] as { settings?: { model?: unknown } } | null)?.settings?.model,
      );
      const asked = sendRequest(args[0]);
      // NOTE: A thread's turn goes to its newest session, the one whose
      // agent the composer shows (`read` answers its agent and settings).
      const request = {
        ...asked,
        conversation: await userNewestOf(asked.project, asked.conversation),
      };
      // The person wrote first: a continue waiting on a usage limit is not
      // needed any more.
      limits.sent(request.project, request.conversation);
      return sendTo(request);
    },
  );

  // NOTE: No arguments. The state names projects and conversations only,
  // never a message of theirs beyond the CLI's limit notice.
  handle(
    conversationChannels.usageLimits,
    devUrl,
    async (args): Promise<UsageLimitsState> => {
      if (args.length !== 0) throw new Error("No arguments are accepted");
      await handoffs.ready();
      return threadLimits(limits.state());
    },
  );

  handle(
    conversationChannels.setAutoContinue,
    devUrl,
    async (args): Promise<UsageLimitsState> => {
      if (args.length !== 3)
        throw new Error("A project, a conversation and a boolean are required");
      if (typeof args[2] !== "boolean")
        throw new Error("A boolean is required");
      // The thread's newest session is the one a continue would go to.
      const { project, conversation } = await userNativeOf(args);
      return threadLimits(
        limits.setAutoContinue(project, conversation, args[2]),
      );
    },
  );

  // NOTE: From here, every call on a conversation's engine is made on its
  // thread's newest session (`nativeOf`): the only one that still runs.
  handle(conversationChannels.stop, devUrl, async (args): Promise<void> => {
    if (args.length !== 2)
      throw new Error("A project and a conversation are required");
    const { project, conversation } = await userNativeOf(args);
    await engines.stop(project, conversation);
  });

  handle(
    conversationChannels.clearQueue,
    devUrl,
    async (args): Promise<number> => {
      if (args.length !== 2)
        throw new Error("A project and a conversation are required");
      const { project, conversation } = await userNativeOf(args);
      return engines.clearQueue(project, conversation);
    },
  );

  handle(
    conversationChannels.takeQueued,
    devUrl,
    async (
      args,
    ): Promise<{ text: string; attachments: OutgoingAttachment[] } | null> => {
      const { project, conversation, message } = queuedOf(args);
      const taken = engines.takeQueued(
        project,
        await userNewestOf(project, conversation),
        message,
      );
      return taken
        ? { text: taken.text, attachments: taken.attachments }
        : null;
    },
  );

  handle(
    conversationChannels.removeQueued,
    devUrl,
    async (args): Promise<boolean> => {
      const { project, conversation, message } = queuedOf(args);
      return (
        engines.takeQueued(
          project,
          await userNewestOf(project, conversation),
          message,
        ) !== null
      );
    },
  );

  handle(
    conversationChannels.resumeQueue,
    devUrl,
    async (args): Promise<void> => {
      if (args.length !== 2)
        throw new Error("A project and a conversation are required");
      const { project, conversation } = await userNativeOf(args);
      engines.resumeQueue(project, conversation);
    },
  );

  handle(
    conversationChannels.answerPermission,
    devUrl,
    async (args): Promise<void> => {
      if (args.length !== 4)
        throw new Error("A conversation, a request and an answer are required");
      const id = key(args[2], "request");
      const answer = permissionAnswer(args[3]);
      const { project, conversation } = await userNativeOf(args.slice(0, 2));
      engines.answer(project, conversation, id, answer);
    },
  );

  handle(conversationChannels.fork, devUrl, async (args): Promise<string> => {
    if (args.length !== 2)
      throw new Error("A project and a conversation are required");
    // NOTE: Of a thread, its newest session is forked: only its transcript
    // is the CLI's to copy. The fork is a conversation of its own.
    const { project, conversation } = await nativeOf(args);
    const folder = await folderOf(project);
    const agent = await agentOf(folder, conversation);
    if (agent === "codex" || agent === "opencode")
      throw new Error(
        `${agent === "opencode" ? "An" : "A"} ${AGENT_LABELS[agent]} conversation cannot be forked here yet.`,
      );
    const fork = await forkConversation(agentHome(), folder, conversation);
    const settings = await store.of(conversation);
    if (settings) await store.remember(fork, settings);
    // FE-112: the fork is Lanework's own, titled from the start, so it is
    // listed as soon as this answers.
    await registerAgentSession(project, "claude", fork, folder).catch(
      () => undefined,
    );
    return fork;
  });

  handle(
    conversationChannels.takeOver,
    devUrl,
    async (args): Promise<EngineState> => {
      if (args.length !== 2)
        throw new Error("A project and a conversation are required");
      const { project, conversation } = await userNativeOf(args);
      await folderOf(project);
      return noted(
        project,
        conversation,
        engines.takeOver(project, conversation),
      );
    },
  );

  handle(conversationChannels.close, devUrl, async (args): Promise<void> => {
    if (args.length !== 2)
      throw new Error("A project and a conversation are required");
    const { project, conversation, head } = await nativeOf(args);
    // A managed session's turn is the conductor's to stop: closing it then
    // would cut the turn off. Between turns, closing only frees its engine
    // (the rail does so before Archive or Delete).
    if (engines.pending(project, conversation)?.working)
      await assertUserMayAct({ head, newest: conversation });
    await engines.close(project, conversation);
    // What waits on the person is kept by thread (`tell`).
    awaiting.clear(project, head);
  });

  handle(
    conversationChannels.alive,
    devUrl,
    async (args): Promise<string[]> => {
      if (args.length !== 1) throw new Error("A project is required");
      await handoffs.ready();
      // By thread: a session that continues one is its head to the page.
      return [
        ...new Set(
          engines.alive(key(args[0], "project")).map(handoffs.now.headOf),
        ),
      ];
    },
  );

  handle(conversationChannels.keep, devUrl, async (args): Promise<void> => {
    if (args.length !== 3 || typeof args[2] !== "boolean")
      throw new Error("A project, a conversation and on or off are required");
    const { project, conversation } = await nativeOf(args.slice(0, 2));
    engines.keep(project, conversation, args[2]);
  });

  handle(conversationChannels.kept, devUrl, async (args): Promise<string[]> => {
    if (args.length !== 1) throw new Error("A project is required");
    await handoffs.ready();
    return [
      ...new Set(
        engines.kept(key(args[0], "project")).map(handoffs.now.headOf),
      ),
    ];
  });

  handle(
    conversationChannels.powerGet,
    devUrl,
    async (): Promise<PowerSettings> => readPowerSettings(),
  );

  handle(
    conversationChannels.powerSet,
    devUrl,
    async (args): Promise<PowerSettings> => {
      if (args.length !== 1) throw new Error("The settings are required");
      const saved = await writePowerSettings(args[0]);
      // FE-158: the search engine's mode applies at once, no restart.
      setLwkMode(saved.lwkMode);
      return saved;
    },
  );

  handle(conversationChannels.release, devUrl, async (args): Promise<void> => {
    if (args.length !== 2)
      throw new Error("A project and a conversation are required");
    // Released to a terminal, where the user would type into it.
    const { project, conversation, head } = await userNativeOf(args);
    await engines.release(project, conversation);
    awaiting.clear(project, head);
  });

  handle(
    conversationChannels.engineState,
    devUrl,
    async (args): Promise<EngineState> => {
      if (args.length !== 2)
        throw new Error("A project and a conversation are required");
      const { project, conversation } = await nativeOf(args);
      return noted(project, conversation, engines.state(project, conversation));
    },
  );

  handle(
    conversationChannels.permissions,
    devUrl,
    async (args): Promise<PermissionRequest[]> => {
      if (args.length !== 2)
        throw new Error("A project and a conversation are required");
      const { project, conversation } = await nativeOf(args);
      return engines.permissions(project, conversation);
    },
  );

  handle(
    conversationChannels.awaiting,
    devUrl,
    async (args): Promise<Awaiting[]> => {
      if (args.length !== 0) throw new Error("No arguments are taken");
      return awaiting.list();
    },
  );

  handle(
    conversationChannels.lastSettings,
    devUrl,
    async (args): Promise<ComposerSettings> => {
      await ready;
      if (args.length !== 0) throw new Error("No arguments are taken");
      return store.last();
    },
  );

  // The user's own models (FE-146). Each id is checked against its CLI's
  // shape in `setCustomModels`, as any model a turn is sent with is.
  handle(
    conversationChannels.customModels,
    devUrl,
    async (args): Promise<void> => {
      if (args.length !== 1 || !Array.isArray(args[0]))
        throw new Error("A list of models is required");
      setCustomModels(args[0] as CustomModel[]);
    },
  );

  handle(
    conversationChannels.claudeModels,
    devUrl,
    async (args): Promise<AgentModel[]> => {
      if (args.length !== 0) throw new Error("No arguments are taken");
      return claudeModels();
    },
  );

  handle(
    conversationChannels.codexModels,
    devUrl,
    async (args): Promise<AgentModel[]> => {
      if (args.length !== 0) throw new Error("No arguments are taken");
      return codexModels();
    },
  );

  handle(
    conversationChannels.opencodeModels,
    devUrl,
    async (args): Promise<AgentModel[]> => {
      if (args.length !== 0) throw new Error("No arguments are taken");
      return opencodeModels();
    },
  );

  handle(
    conversationChannels.linkPreview,
    devUrl,
    async (args): Promise<LinkPreview> => {
      if (args.length !== 1) throw new Error("A link is required");
      return previews(args[0]);
    },
  );

  handle(conversationChannels.openLink, devUrl, async (args): Promise<void> => {
    if (args.length !== 1 || !isOpenableUrl(args[0]))
      throw new Error("An http(s) link is required");
    await shell.openExternal(args[0]);
  });

  handle(
    conversationChannels.image,
    devUrl,
    async (args): Promise<ImagePreview> => {
      const { path, scope } = await imageScope(args, imageTurns);
      return previewImage(path, scope);
    },
  );

  handle(
    conversationChannels.openImage,
    devUrl,
    async (args): Promise<void> => {
      const { path, scope } = await imageScope(args, imageTurns);
      const file = await openableImage(path, scope);
      if (!file) throw new Error("The image is not there.");
      const failed = await shell.openPath(file);
      if (failed) throw new Error(failed);
    },
  );

  handle(
    conversationChannels.suggest,
    devUrl,
    async (args): Promise<Suggestion[]> => {
      if (args.length !== 3 && args.length !== 4)
        throw new Error("A project, a kind and a query are required");
      const project = key(args[0], "project");
      const [, kind, query, agent = null] = args;
      if (typeof query !== "string" || query.length > 200)
        throw new Error("A valid query is required");
      if (
        agent !== null &&
        agent !== "claude" &&
        agent !== "codex" &&
        agent !== "opencode"
      )
        throw new Error("A valid agent is required");
      if (kind === "command")
        return rankCommands(
          await commandsOf(project, agent ?? undefined),
          query,
        );
      if (kind === "file") return suggestFiles(await folderOf(project), query);
      throw new Error("Unknown kind");
    },
  );

  // NOTE: One quit listener for the whole conversation module: main's
  // modules already hold ten, Node's warning threshold.
  app.on("will-quit", () => {
    limits.dispose();
    engines.killAll();
  });
  if (!app.isPackaged) process.once("SIGTERM", () => engines.killAll());
}
