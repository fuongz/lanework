// The main process's side of the conversation view: an agent conversation
// read as a chat, and the composer's headless engine.
//
// NOTE: As with the terminal, the page names a WORKSPACE and a conversation
// id, never a folder or a command:
// - the folder is the one main wrote down for the workspace
//   (`terminalFolder`);
// - the id is a UUID whose transcript is in the CLI's folder for it;
// - settings come from the fixed lists.
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { app, shell } from "electron";
import {
  type AgentModel,
  ANSWER_MAX,
  ANSWERS_MAX,
  agentOfModel,
  type ComposerSettings,
  type Conversation,
  type ConversationAgent,
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
} from "../../../shared/conversation";
import { isAgentSessionId } from "../../../shared/terminal";
import { broadcast, handle } from "../ipc";
import { onRunningChanged } from "../terminal";
import { terminalFolder } from "../workspaces";
import { createAgentCli, createClaudeCli } from "./claude-cli";
import { claudeJsonFor, isClaudeTrusted } from "./claude-trust";
import { createCodexModels } from "./codex-models";
import { codexRolloutPath, readCodexConversation } from "./codex-transcript";
import { createEngines } from "./engine";
import { forkConversation } from "./fork";
import { type ImageScope, openableImage, previewImage } from "./image-preview";
import { createLinkPreviews } from "./link-preview";
import { claudePidsOn } from "./live-claude";
import { contentOf, isMessageId, sendRequest } from "./outgoing";
import type { Outgoing } from "./queue";
import { createSettingsStore } from "./settings-store";
import { suggestCommands, suggestFiles, workspaceFiles } from "./suggest";
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
}

/**
 * Where Claude keeps its conversations, with the terminal's test seam
 * (`LANEWORK_TEST_AGENT_HOME`, unpackaged only).
 */
function agentHome(): string {
  return (!app.isPackaged && process.env.LANEWORK_TEST_AGENT_HOME) || homedir();
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
  if (!isAgentSessionId(args[1]))
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
 * Claude's when its file is in Claude's folder for it, Codex's when a
 * rollout of that folder has the id.
 *
 * @returns null when neither CLI has written it down.
 */
async function agentOf(
  folder: string,
  id: string,
): Promise<ConversationAgent | null> {
  const file = transcriptPath(agentHome(), folder, id);
  if ((await stat(file).catch(() => null))?.isFile()) return "claude";
  if (await codexRolloutPath(agentHome(), folder, id).catch(() => null))
    return "codex";
  return null;
}

/** Conversation `id` of `folder`, read from whichever CLI wrote it. */
async function readAny(folder: string, id: string): Promise<Conversation> {
  return (await agentOf(folder, id)) === "codex"
    ? readCodexConversation(agentHome(), folder, id)
    : readConversation(agentHome(), folder, id);
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
  const ready = codexModels();
  const engines = createEngines({
    cli: createClaudeCli(() =>
      testing ? process.env.LANEWORK_CLAUDE_BIN : undefined,
    ),
    codexCli: createAgentCli("codex", () =>
      testing ? process.env.LANEWORK_CODEX_BIN : undefined,
    ),
    emit: (event) => broadcast(conversationChannels.event, event),
    terminalOn: bridge.terminalOn,
    killTerminal: bridge.kill,
    remember: (id, settings) => void store.remember(id, settings),
    // FE-77/D3: Claude's trust record, under the test seam's home too.
    trusted: (folder, env) =>
      isClaudeTrusted(folder, claudeJsonFor(env, agentHome())),
  });

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
  onRunningChanged(() => {
    for (const [id, which] of [...paused]) {
      void engines.state(which.workspace, which.conversation).then((engine) => {
        if (engine.state === "terminal") return;
        paused.delete(id);
        broadcast(conversationChannels.event, {
          type: "state",
          ...which,
          engine,
        });
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
      const folder = await folderOf(workspace);
      const agent = await agentOf(folder, conversation);
      // A conversation started here whose first line the CLI has not
      // written yet: what its engine holds so far.
      const pending = agent ? null : engines.pending(workspace, conversation);
      if (pending)
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
      return { ...read, settings: await store.of(conversation) };
    },
  );

  handle(
    conversationChannels.start,
    devUrl,
    async (args): Promise<{ conversation: string; engine: EngineState }> => {
      // A model Codex listed since the last read is known now.
      await codexModels();
      if (args.length !== 1) throw new Error("A request is required");
      // NOTE: The id is main's own, never the page's, so a new one cannot
      // name a conversation that already exists.
      const conversation = randomUUID();
      const request = sendRequest({
        ...((args[0] ?? {}) as object),
        conversation,
      });
      if (!request.text.trim() && request.attachments.length === 0)
        throw new Error("Write something first.");
      const folder = await folderOf(request.workspace);
      const out = await outgoingOf(request);
      // The model picks the CLI: Codex names its conversation itself.
      if (agentOfModel(request.settings.model) === "codex")
        return engines.startCodex(request.workspace, folder, out);
      const engine = await engines.start(
        request.workspace,
        conversation,
        folder,
        out,
      );
      return { conversation, engine };
    },
  );

  handle(
    conversationChannels.send,
    devUrl,
    async (args): Promise<EngineState> => {
      await codexModels();
      if (args.length !== 1) throw new Error("A request is required");
      const request = sendRequest(args[0]);
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
          `Pick a ${agent === "codex" ? "Codex" : "Claude"} model for this conversation.`,
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
    if ((await agentOf(folder, conversation)) === "codex")
      throw new Error("A Codex conversation cannot be forked here yet.");
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
      if (args.length !== 3)
        throw new Error("A workspace, a kind and a query are required");
      const workspace = key(args[0], "workspace");
      const [, kind, query] = args;
      if (typeof query !== "string" || query.length > 200)
        throw new Error("A valid query is required");
      if (kind === "command")
        return suggestCommands(
          agentHome(),
          await terminalFolder(workspace),
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
