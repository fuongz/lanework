// The main process's side of the conversation view: an agent conversation
// read as a chat, and the composer's headless engine.
//
// NOTE: As with the terminal, the page names a WORKSPACE and a conversation
// id, never a folder or a command:
// - the folder is the one main wrote down for the workspace
//   (`terminalFolder`);
// - the id is a UUID whose transcript is in the CLI's folder for it, or an
//   OpenCode `ses_` id its database has for that folder (FE-104);
// - settings come from the fixed lists.
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { app, shell } from "electron";
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
  type Awaiting,
  agentOfModel,
  type ComposerSettings,
  type Conversation,
  type ConversationAgent,
  type ConversationEvent,
  conversationChannels,
  type EngineState,
  type ImagePreview,
  isOpenableUrl,
  isPermission,
  type LinkPreview,
  type OutgoingAttachment,
  type PermissionAnswer,
  type PermissionRequest,
  type SendRequest,
  type Suggestion,
  setCodexModels,
  setOpenCodeModels,
  type Turn,
} from "../../../shared/conversation";
import { LEAD_REF_PATTERN } from "../../../shared/orchestration";
import { isAgentSessionId, isAgentSessionIdOf } from "../../../shared/terminal";
import { controlCliPath } from "../../control/install";
import { broadcast, handle } from "../ipc";
import { notify } from "../notifications";
import {
  controlEndpoint,
  isWorkerConversation,
  isWorkerFolder,
  workerFolderOf,
} from "../orchestration";
import { setSessionsEnv } from "../orchestration/engine-tap";
import {
  bindConductorConversation,
  conductorOfConversation,
  nameConversation,
} from "../terminal";
import { opencodeDataDir } from "../terminal/opencode-sessions";
import {
  opencodeGoKey,
  opencodeServiceUsage,
} from "../terminal/opencode-usage";
import { agentHomeDir } from "../test-seams";
import { knownWorkspace, terminalFolder } from "../workspaces";
import { awaitingNotice, createAwaitingLedger } from "./awaiting";
import { createAgentCli, createClaudeCli } from "./claude-cli";
import { claudeJsonFor, isClaudeTrusted } from "./claude-trust";
import { createCodexModels } from "./codex-models";
import { codexRolloutPath, readCodexConversation } from "./codex-transcript";
import { ConductorSessions } from "./conductor-sessions";
import { createEngines } from "./engine";
import { forkConversation } from "./fork";
import { type ImageScope, openableImage, previewImage } from "./image-preview";
import { createLinkPreviews } from "./link-preview";
import { claudePidsOn } from "./live-claude";
import { openCodeClient } from "./opencode-client";
import { createOpenCodeModels } from "./opencode-models";
import { createOpenCodeService } from "./opencode-service";
import {
  isOpenCodeConversation,
  readOpenCodeConversation,
} from "./opencode-transcript";
import { contentOf, isMessageId, sendRequest } from "./outgoing";
import type { Outgoing } from "./queue";
import { createSettingsStore } from "./settings-store";
import {
  listCommands,
  rankCommands,
  suggestFiles,
  workspaceFiles,
} from "./suggest";
import { readConversation, transcriptPath } from "./transcript";

/**
 * How the composer finds and stops a pty running Claude on a conversation.
 *
 * The terminal's own list is the exact answer; Claude's pid files
 * (`live-claude.ts`) catch a Claude in any other terminal app (FE-62/D3).
 */
interface TerminalBridge {
  terminalOn: (
    workspace: string,
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

/** A conductor's sessions, once the conversation view registered. */
let sessions: ConductorSessions | null = null;

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

/** The last `/` commands read, by workspace. */
const commandCache = new Map<
  string,
  { at: number; all: Promise<Suggestion[]> }
>();

/**
 * Every `/` command `workspace` offers, for each key the composer sends.
 *
 * Read once and kept (FE-92): finding the project's folder may wait on the
 * network, and `/` must open at once. Older than {@link COMMANDS_MS}, the
 * list kept still answers while a new one is read behind it.
 */
function commandsOf(
  workspace: string,
  agent: ConversationAgent = "claude",
): Promise<Suggestion[]> {
  const read = () =>
    terminalFolder(workspace).then((folder) =>
      listCommands(agentHome(), folder, agent),
    );
  // By agent too: OpenCode's list is not Claude's (FE-105/D3).
  const cacheKey = `${workspace}\0${agent}`;
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
    async terminalOn(_workspace, conversation, ours) {
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
  workspace: string;
  conversation: string;
} {
  if (args.length < 2)
    throw new Error("A workspace and a conversation are required");
  const workspace = key(args[0], "workspace");
  if (!isConversationId(args[1]))
    throw new Error("A valid conversation is required");
  return { workspace, conversation: args[1] };
}

/**
 * A queued message's address: its conversation, and its own id.
 *
 * @throws When the call does not have exactly those three arguments.
 */
function queuedOf(args: unknown[]): {
  workspace: string;
  conversation: string;
  message: string;
} {
  if (args.length !== 3)
    throw new Error("A workspace, a conversation and a message are required");
  const { workspace, conversation } = conversationOf(args);
  if (!isMessageId(args[2])) throw new Error("A valid message is required");
  return { workspace, conversation, message: args[2] };
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
 * The folder main wrote down for `workspace`.
 *
 * @throws When the workspace has no folder on this machine.
 */
async function folderOf(workspace: string): Promise<string> {
  const folder = await terminalFolder(workspace);
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
 * The scope is the workspace's folder, the images attached to the
 * conversation, and the files its tool calls read or wrote by absolute path
 * (a screenshot under `/tmp`). They are read from its transcript here, never
 * taken from the page; `openableImage` still keeps only images.
 *
 * @throws When the arguments are not a conversation and a valid path.
 */
async function imageScope(args: unknown[]): Promise<{
  path: string;
  scope: ImageScope;
}> {
  if (args.length !== 3)
    throw new Error("A workspace, a conversation and a path are required");
  const { workspace, conversation } = conversationOf(args);
  const path = args[2];
  if (
    typeof path !== "string" ||
    !path.trim() ||
    path.length > 1024 ||
    path.includes("\0")
  )
    throw new Error("A valid path is required");
  const folder = await folderOf(workspace);
  const read = await readAny(folder, conversation).catch(() => null);
  const attachments = (read?.turns ?? []).flatMap((turn) =>
    turn.role === "user"
      ? turn.attachments.flatMap((entry) => (entry.path ? [entry.path] : []))
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
    scope: { folder, attachments, files: () => workspaceFiles(folder) },
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
  const previews = createLinkPreviews({
    dir: join(app.getPath("userData"), "link-previews"),
  });
  const testing =
    !app.isPackaged && Boolean(process.env.LANEWORK_TEST_USER_DATA);
  // NOTE: Read before any settings are checked. A Codex model is only known
  // once its list is, and a stored one not on the fallback would be dropped.
  const readCodexModels = createCodexModels(agentHome);
  const codexModels = async (): Promise<AgentModel[]> => {
    const models = await readCodexModels().catch(() => []);
    setCodexModels(models);
    return models;
  };
  // FE-104: OpenCode's models are its service's. Found through the user's
  // own `opencode`; LANEWORK_OPENCODE_BIN is the test seam.
  const opencode = createOpenCodeService(
    createAgentCli("opencode", () =>
      testing ? process.env.LANEWORK_OPENCODE_BIN : undefined,
    ),
  );
  // Go puts OpenCode Go's models first: the subscription the user pays for.
  // The account signed in on opencode.ai has it when the service's limits
  // name `go` (it has no key of its own, FE-105); else a Go key. Only the
  // real home's counts, as for the usage it gates.
  const realHome = () => agentHomeDir() === homedir();
  const readOpenCodeModels = createOpenCodeModels(
    async () => openCodeClient(await opencode.service(), null),
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
    codexModels(),
    Promise.race([
      opencodeModels(),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]),
  ]);
  // FE-97: what every engine waits on the person for, followed from the
  // same events the page gets.
  const awaiting = createAwaitingLedger();
  const tell = (event: ConversationEvent) => {
    broadcast(conversationChannels.event, event);
    sessions?.onEvent(event);
    // Read once the event's other listeners ran: orchestration learns a new
    // Codex worker's id from this same event (FE-100/O1).
    queueMicrotask(() => {
      // A worker of an orchestration run asks its lead, never the person:
      // no island, no notification, no ping (FE-100/O1).
      if (
        typeof event.conversation === "string" &&
        isWorkerConversation(event.workspace, event.conversation)
      ) {
        awaiting.clear(event.workspace, event.conversation);
        return;
      }
      const asked = awaiting.apply(
        event,
        () =>
          engines.pending(event.workspace, event.conversation)?.agent ??
          "claude",
      );
      if (asked && event.type === "permission")
        void notifyAsked(event.workspace, event.conversation, asked);
    });
  };
  /**
   * Tell the person an agent waits on them. A click opens its conversation;
   * a focused window already on it is not told.
   */
  const notifyAsked = async (
    workspace: string,
    conversation: string,
    request: PermissionRequest,
  ): Promise<void> => {
    const { workspace: project } = await knownWorkspace(workspace).catch(
      () => ({ workspace: null }),
    );
    // Answered, or the engine closed, while the project was looked up.
    const still = awaiting
      .list()
      .find(
        (entry) =>
          entry.workspace === workspace && entry.conversation === conversation,
      );
    if (!project || !still?.requests.some((entry) => entry.id === request.id))
      return;
    await notify({
      kind: "input",
      ...awaitingNotice(still.agent, request),
      target: { kind: "session", slug: project.slug, conversation },
    }).catch(() => {});
  };
  const engines = createEngines({
    cli: createClaudeCli(() =>
      testing ? process.env.LANEWORK_CLAUDE_BIN : undefined,
    ),
    codexCli: createAgentCli("codex", () =>
      testing ? process.env.LANEWORK_CODEX_BIN : undefined,
    ),
    emit: tell,
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
  });

  sessions = new ConductorSessions({
    engines: () => engines,
    folderOf,
    agentOf,
    read: readAny,
    storedSettings: (conversation) => store.of(conversation),
    conductorOf: conductorOfConversation,
    name: nameConversation,
    isWorkerFolder,
    endpoint: controlEndpoint,
    cliPath: controlCliPath(),
    file: join(app.getPath("userData"), "conductor-sessions.json"),
  });
  const conductors = sessions;
  setSessionsEnv((target) => conductors.envFor(target));

  // The conversations whose engine last answered `terminal`: when a tab
  // stops, the composer hears it may write again, without polling.
  const paused = new Map<string, { workspace: string; conversation: string }>();
  const noted = async (
    workspace: string,
    conversation: string,
    state: Promise<EngineState>,
  ): Promise<EngineState> => {
    const now = await state;
    const id = `${workspace}\0${conversation}`;
    if (now.state === "terminal") {
      paused.set(id, { workspace, conversation });
      if (paused.size > 64) paused.delete(paused.keys().next().value as string);
    } else paused.delete(id);
    return now;
  };
  bridge.onRunningChanged?.(() => {
    for (const [id, which] of [...paused]) {
      void engines.state(which.workspace, which.conversation).then((engine) => {
        if (engine.state === "terminal") return;
        paused.delete(id);
        tell({ type: "state", ...which, engine });
      });
    }
  });

  handle(
    conversationChannels.read,
    devUrl,
    async (args): Promise<Conversation> => {
      await ready;
      if (args.length !== 2)
        throw new Error("A workspace and a conversation are required");
      const { workspace, conversation } = conversationOf(args);
      // A worker of an orchestration run (FE-87) keeps its transcript under
      // its own worktree, not the project's folder.
      const folder =
        workerFolderOf(workspace, conversation) ?? (await folderOf(workspace));
      const agent = await agentOf(folder, conversation);
      // A conversation started here whose first line the CLI has not
      // written yet: what its engine holds so far.
      const pending = engines.pending(workspace, conversation);
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
      const read = await readAny(folder, conversation);
      // OpenCode's running turn, newer than its database (FE-104).
      if (agent === "opencode" && pending?.working)
        return {
          ...read,
          turns: withLive(read.turns, pending.turns),
          working: true,
          settings: await store.of(conversation),
        };
      return { ...read, settings: await store.of(conversation) };
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
      const folder = await folderOf(request.workspace);
      const out = await outgoingOf(request);
      // The model picks the CLI: Codex and OpenCode name their conversation
      // themselves.
      const agent = agentOfModel(request.settings.model);
      const started =
        agent !== "claude"
          ? await engines.startNamed(agent, request.workspace, folder, out)
          : {
              conversation,
              engine: await engines.start(
                request.workspace,
                conversation,
                folder,
                out,
              ),
            };
      if (conductor)
        await bindConductorConversation(
          request.workspace,
          agent,
          started.conversation,
          conductor,
        );
      return started;
    },
  );

  handle(
    conversationChannels.send,
    devUrl,
    async (args): Promise<EngineState> => {
      await codexModels();
      if (args.length !== 1) throw new Error("A request is required");
      await knowModel(
        (args[0] as { settings?: { model?: unknown } } | null)?.settings?.model,
      );
      const request = sendRequest(args[0]);
      // A worker is the lead's to talk to; a send from here would start a
      // second engine on its conversation in the project's folder (FE-87).
      if (workerFolderOf(request.workspace, request.conversation))
        throw new Error(
          "This conversation is a worker of an orchestration run. Message it through its lead.",
        );
      const folder = await folderOf(request.workspace);
      // NOTE: Only a conversation this folder has: its transcript is where
      // the CLI keeps this folder's, under the id it was asked for.
      const agent =
        (await agentOf(folder, request.conversation)) ??
        engines.pending(request.workspace, request.conversation)?.agent;
      if (!agent) throw new Error("That conversation is not in this project.");
      // A conversation stays on the CLI that wrote it.
      if (agentOfModel(request.settings.model) !== agent)
        throw new Error(
          `Pick ${agent === "opencode" ? "an" : "a"} ${AGENT_LABELS[agent]} model for this conversation.`,
        );
      return noted(
        request.workspace,
        request.conversation,
        engines.send(
          request.workspace,
          request.conversation,
          folder,
          await outgoingOf(request),
          agent,
        ),
      );
    },
  );

  handle(conversationChannels.stop, devUrl, async (args): Promise<void> => {
    if (args.length !== 2)
      throw new Error("A workspace and a conversation are required");
    const { workspace, conversation } = conversationOf(args);
    await engines.stop(workspace, conversation);
  });

  handle(
    conversationChannels.clearQueue,
    devUrl,
    async (args): Promise<number> => {
      if (args.length !== 2)
        throw new Error("A workspace and a conversation are required");
      const { workspace, conversation } = conversationOf(args);
      return engines.clearQueue(workspace, conversation);
    },
  );

  handle(
    conversationChannels.takeQueued,
    devUrl,
    async (
      args,
    ): Promise<{ text: string; attachments: OutgoingAttachment[] } | null> => {
      const { workspace, conversation, message } = queuedOf(args);
      const taken = engines.takeQueued(workspace, conversation, message);
      return taken
        ? { text: taken.text, attachments: taken.attachments }
        : null;
    },
  );

  handle(
    conversationChannels.removeQueued,
    devUrl,
    async (args): Promise<boolean> => {
      const { workspace, conversation, message } = queuedOf(args);
      return engines.takeQueued(workspace, conversation, message) !== null;
    },
  );

  handle(
    conversationChannels.resumeQueue,
    devUrl,
    async (args): Promise<void> => {
      if (args.length !== 2)
        throw new Error("A workspace and a conversation are required");
      const { workspace, conversation } = conversationOf(args);
      engines.resumeQueue(workspace, conversation);
    },
  );

  handle(
    conversationChannels.answerPermission,
    devUrl,
    async (args): Promise<void> => {
      if (args.length !== 4)
        throw new Error("A conversation, a request and an answer are required");
      const { workspace, conversation } = conversationOf(args);
      const id = key(args[2], "request");
      engines.answer(workspace, conversation, id, permissionAnswer(args[3]));
    },
  );

  handle(conversationChannels.fork, devUrl, async (args): Promise<string> => {
    if (args.length !== 2)
      throw new Error("A workspace and a conversation are required");
    const { workspace, conversation } = conversationOf(args);
    const folder = await folderOf(workspace);
    const agent = await agentOf(folder, conversation);
    if (agent === "codex" || agent === "opencode")
      throw new Error(
        `${agent === "opencode" ? "An" : "A"} ${AGENT_LABELS[agent]} conversation cannot be forked here yet.`,
      );
    const fork = await forkConversation(agentHome(), folder, conversation);
    const settings = await store.of(conversation);
    if (settings) await store.remember(fork, settings);
    return fork;
  });

  handle(
    conversationChannels.takeOver,
    devUrl,
    async (args): Promise<EngineState> => {
      if (args.length !== 2)
        throw new Error("A workspace and a conversation are required");
      const { workspace, conversation } = conversationOf(args);
      await folderOf(workspace);
      return noted(
        workspace,
        conversation,
        engines.takeOver(workspace, conversation),
      );
    },
  );

  handle(conversationChannels.close, devUrl, async (args): Promise<void> => {
    if (args.length !== 2)
      throw new Error("A workspace and a conversation are required");
    const { workspace, conversation } = conversationOf(args);
    await engines.close(workspace, conversation);
    awaiting.clear(workspace, conversation);
  });

  handle(
    conversationChannels.alive,
    devUrl,
    async (args): Promise<string[]> => {
      if (args.length !== 1) throw new Error("A workspace is required");
      return engines.alive(key(args[0], "workspace"));
    },
  );

  handle(conversationChannels.release, devUrl, async (args): Promise<void> => {
    if (args.length !== 2)
      throw new Error("A workspace and a conversation are required");
    const { workspace, conversation } = conversationOf(args);
    await engines.release(workspace, conversation);
    awaiting.clear(workspace, conversation);
  });

  handle(
    conversationChannels.engineState,
    devUrl,
    async (args): Promise<EngineState> => {
      if (args.length !== 2)
        throw new Error("A workspace and a conversation are required");
      const { workspace, conversation } = conversationOf(args);
      return noted(
        workspace,
        conversation,
        engines.state(workspace, conversation),
      );
    },
  );

  handle(
    conversationChannels.permissions,
    devUrl,
    async (args): Promise<PermissionRequest[]> => {
      if (args.length !== 2)
        throw new Error("A workspace and a conversation are required");
      const { workspace, conversation } = conversationOf(args);
      return engines.permissions(workspace, conversation);
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
      const { path, scope } = await imageScope(args);
      return previewImage(path, scope);
    },
  );

  handle(
    conversationChannels.openImage,
    devUrl,
    async (args): Promise<void> => {
      const { path, scope } = await imageScope(args);
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
        throw new Error("A workspace, a kind and a query are required");
      const workspace = key(args[0], "workspace");
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
          await commandsOf(workspace, agent ?? undefined),
          query,
        );
      if (kind === "file")
        return suggestFiles(await folderOf(workspace), query);
      throw new Error("Unknown kind");
    },
  );

  app.on("will-quit", () => engines.killAll());
  if (!app.isPackaged) process.once("SIGTERM", () => engines.killAll());
}
