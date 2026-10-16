// The main process's side of the conversation view (FE-62): a Claude
// conversation read as a chat, and the composer's headless engine.
//
// ⚠️ As with the terminal, the page names a WORKSPACE and a conversation id,
// never a folder or a command: the folder is the one main wrote down for the
// workspace (`terminalFolder`), the id a UUID whose transcript is in Claude's
// folder for it, and settings come from the fixed lists.
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, shell } from "electron";
import {
  ANSWER_MAX,
  ANSWERS_MAX,
  type ComposerSettings,
  type Conversation,
  conversationChannels,
  type EngineState,
  isOpenableUrl,
  isPermission,
  type LinkPreview,
  type PermissionAnswer,
  type Suggestion,
} from "../../../shared/conversation";
import { isAgentSessionId } from "../../../shared/terminal";
import { broadcast, handle } from "../ipc";
import { onRunningChanged } from "../terminal";
import { terminalFolder } from "../workspaces";
import { createClaudeCli } from "./claude-cli";
import { createEngines } from "./engine";
import { forkConversation } from "./fork";
import { createLinkPreviews } from "./link-preview";
import { claudePidsOn } from "./live-claude";
import { contentOf, sendRequest } from "./outgoing";
import { createSettingsStore } from "./settings-store";
import { suggestCommands, suggestFiles } from "./suggest";
import { readConversation, transcriptPath } from "./transcript";

/**
 * How the composer finds and stops a pty running Claude on a conversation
 * (FE-62/D3). The terminal's own list is the exact answer; until it is
 * wired in, Claude's pid files are (`live-claude.ts`).
 */
export interface TerminalBridge {
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

/** Any live Claude on the conversation, by pid — `pid:<n>` as its id. */
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

function key(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error(`A valid ${what} is required`);
  return value;
}

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

async function folderOf(workspace: string): Promise<string> {
  const folder = await terminalFolder(workspace);
  if (!folder) throw new Error("This project has no folder here.");
  return folder;
}

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
  const engines = createEngines({
    cli: createClaudeCli(() =>
      testing ? process.env.LANEWORK_CLAUDE_BIN : undefined,
    ),
    emit: (event) => broadcast(conversationChannels.event, event),
    terminalOn: bridge.terminalOn,
    killTerminal: bridge.kill,
    remember: (id, settings) => void store.remember(id, settings),
  });

  /**
   * Conversations last answered `terminal`: when a tab stops, the composer
   * hears it may write again, without polling.
   */
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
      if (args.length !== 2)
        throw new Error("A workspace and a conversation are required");
      const { workspace, conversation } = conversationOf(args);
      const folder = await folderOf(workspace);
      const file = transcriptPath(agentHome(), folder, conversation);
      // A conversation started here whose first line the CLI has not
      // written yet: what its engine holds so far.
      const pending = (await stat(file).catch(() => null))?.isFile()
        ? null
        : engines.pending(workspace, conversation);
      if (pending)
        return {
          id: conversation,
          cwd: folder,
          branch: null,
          turns: pending.turns,
          working: pending.working,
          card: null,
          settings: await store.of(conversation),
          truncated: false,
        };
      const read = await readConversation(agentHome(), folder, conversation);
      return { ...read, settings: await store.of(conversation) };
    },
  );

  handle(
    conversationChannels.start,
    devUrl,
    async (args): Promise<{ conversation: string; engine: EngineState }> => {
      if (args.length !== 1) throw new Error("A request is required");
      // ⚠️ The id is main's own, never the page's: a new one cannot name a
      // conversation that already exists.
      const conversation = randomUUID();
      const request = sendRequest({
        ...((args[0] ?? {}) as object),
        conversation,
      });
      if (!request.text.trim() && request.attachments.length === 0)
        throw new Error("Write something first.");
      const folder = await folderOf(request.workspace);
      const content = await contentOf(request.text, request.attachments);
      const engine = await engines.start(
        request.workspace,
        conversation,
        folder,
        { content, settings: request.settings },
      );
      return { conversation, engine };
    },
  );

  handle(
    conversationChannels.send,
    devUrl,
    async (args): Promise<EngineState> => {
      if (args.length !== 1) throw new Error("A request is required");
      const request = sendRequest(args[0]);
      const folder = await folderOf(request.workspace);
      // ⚠️ Only a conversation this folder has: its transcript is where the
      // CLI keeps this folder's, under the id it was asked for.
      const file = transcriptPath(agentHome(), folder, request.conversation);
      if (
        !(await stat(file).catch(() => null))?.isFile() &&
        !engines.pending(request.workspace, request.conversation)
      )
        throw new Error("That conversation is not in this project.");
      const content = await contentOf(request.text, request.attachments);
      return noted(
        request.workspace,
        request.conversation,
        engines.send(request.workspace, request.conversation, folder, {
          content,
          settings: request.settings,
        }),
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
    async (args): Promise<void> => {
      if (args.length !== 2)
        throw new Error("A workspace and a conversation are required");
      const { workspace, conversation } = conversationOf(args);
      engines.clearQueue(workspace, conversation);
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
    conversationChannels.lastSettings,
    devUrl,
    async (args): Promise<ComposerSettings> => {
      if (args.length !== 0) throw new Error("No arguments are taken");
      return store.last();
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
