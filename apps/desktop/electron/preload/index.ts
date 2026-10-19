import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import {
  agentConfigChannels,
  type DesktopAgentConfigApi,
} from "../../shared/agent-config";
import {
  agentSetupChannels,
  type DesktopAgentSetupApi,
} from "../../shared/agent-setup";
import {
  authChannels,
  type DesktopAuthApi,
  type DesktopLaneworkMcpApi,
  laneworkMcpChannels,
} from "../../shared/auth";
import {
  type ConversationEvent,
  conversationChannels,
  type DesktopConversationApi,
} from "../../shared/conversation";
import { channels, type DesktopApi } from "../../shared/desktop";
import { type DesktopGitApi, gitChannels } from "../../shared/git";
import { type DesktopHandoffApi, handoffChannels } from "../../shared/handoff";
import {
  type DesktopHarnessApi,
  type HarnessInfo,
  harnessChannels,
} from "../../shared/harness";
import {
  type DesktopInstructionsApi,
  type InstructionChange,
  instructionChannels,
} from "../../shared/instructions";
import {
  type DesktopMemoryApi,
  type MemoryChange,
  memoryChannels,
} from "../../shared/memory";
import {
  type DesktopReadinessApi,
  readinessChannels,
} from "../../shared/readiness";
import {
  type DesktopTerminalApi,
  type TerminalClientMessage,
  type TerminalCommand,
  type TerminalHostMessage,
  type TerminalViewHandlers,
  terminalChannels,
} from "../../shared/terminal";
import { workspaceChannels } from "../../shared/workspaces";
import {
  type DesktopWorktreeApi,
  worktreeChannels,
} from "../../shared/worktree";

/** Subscribe to a main→renderer channel, returning an unsubscribe function. */
function subscribe<T>(
  channel: string,
  listener: (payload: T) => void,
): () => void {
  const handler = (_event: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.off(channel, handler);
  };
}

/**
 * The auth surface. Every method is a named operation on a fixed channel —
 * there is no way to reach an arbitrary channel from here, and nothing on this
 * object can return the credential: `main` only ever sends a redacted session.
 */
const auth: DesktopAuthApi = {
  getSession: () => ipcRenderer.invoke(authChannels.session),
  signIn: (mode) => ipcRenderer.invoke(authChannels.signIn, mode),
  signOut: () => ipcRenderer.invoke(authChannels.signOut),
  cancelSignIn: () => ipcRenderer.invoke(authChannels.cancel),
  enterLocalMode: () => ipcRenderer.invoke(authChannels.enterLocal),
  onSessionChange: (listener) => subscribe(authChannels.changed, listener),
  onSignInProgress: (listener) => subscribe(authChannels.progress, listener),
};

/**
 * The local-repository surface (FE-22).
 *
 * ⚠️ Every call names a project, never a folder; main resolves it. Paths are
 * the ones `status` answered, and main re-checks them against a fresh status
 * before it acts.
 */
const worktree: DesktopWorktreeApi = {
  files: (slug) => ipcRenderer.invoke(worktreeChannels.files, slug),
  dir: (slug, path) => ipcRenderer.invoke(worktreeChannels.dir, slug, path),
  view: (slug, path) => ipcRenderer.invoke(worktreeChannels.view, slug, path),
  reveal: (slug, path) =>
    ipcRenderer.invoke(worktreeChannels.reveal, slug, path),
  locate: (slug, path) =>
    ipcRenderer.invoke(worktreeChannels.locate, slug, path),
  openDefault: (slug, path) =>
    ipcRenderer.invoke(worktreeChannels.openDefault, slug, path),
  status: (slug) => ipcRenderer.invoke(worktreeChannels.status, slug),
  patch: (slug) => ipcRenderer.invoke(worktreeChannels.patch, slug),
  fileText: (slug, path, side) =>
    ipcRenderer.invoke(worktreeChannels.fileText, slug, path, side),
  stage: (slug, paths) =>
    ipcRenderer.invoke(worktreeChannels.stage, slug, paths),
  unstage: (slug, paths) =>
    ipcRenderer.invoke(worktreeChannels.unstage, slug, paths),
  restore: (slug, paths) =>
    ipcRenderer.invoke(worktreeChannels.restore, slug, paths),
  commit: (slug, message, mode) =>
    ipcRenderer.invoke(worktreeChannels.commit, slug, message, mode),
  sync: (slug, action, remote) =>
    ipcRenderer.invoke(worktreeChannels.sync, slug, action, remote),
  log: (slug, skip) => ipcRenderer.invoke(worktreeChannels.log, slug, skip),
  show: (slug, sha) => ipcRenderer.invoke(worktreeChannels.show, slug, sha),
  branches: (slug) => ipcRenderer.invoke(worktreeChannels.branches, slug),
  switchBranch: (slug, name) =>
    ipcRenderer.invoke(worktreeChannels.switchBranch, slug, name),
};

/**
 * The GitHub surface.
 *
 * ⚠️ Nothing here can return the token, and nothing here takes a repository to
 * fetch from. Every read names a PROJECT; main resolves that to the repo it
 * wrote down itself. `linkRepo` is the single exception and it takes the raw
 * string a human typed, which main parses before it becomes part of any URL.
 */
/** Settings → Agents (FE-28): the checkpoint hook, on and off. */
const handoff: DesktopHandoffApi = {
  status: () => ipcRenderer.invoke(handoffChannels.status),
  enable: (agent) => ipcRenderer.invoke(handoffChannels.enable, agent),
  disable: (agent) => ipcRenderer.invoke(handoffChannels.disable, agent),
  setPushWip: (on) => ipcRenderer.invoke(handoffChannels.setPushWip, on),
};

/**
 * The conversation view (FE-62). Every call names a workspace and a
 * conversation id, never a folder or a command; main checks the settings
 * against its own lists before any of them becomes a flag.
 */
const conversation: DesktopConversationApi = {
  read: (workspace, id) =>
    ipcRenderer.invoke(conversationChannels.read, workspace, id),
  start: (request) => ipcRenderer.invoke(conversationChannels.start, request),
  send: (request) => ipcRenderer.invoke(conversationChannels.send, request),
  stop: (workspace, id) =>
    ipcRenderer.invoke(conversationChannels.stop, workspace, id),
  clearQueue: (workspace, id) =>
    ipcRenderer.invoke(conversationChannels.clearQueue, workspace, id),
  answerPermission: (workspace, id, request, answer) =>
    ipcRenderer.invoke(
      conversationChannels.answerPermission,
      workspace,
      id,
      request,
      answer,
    ),
  fork: (workspace, id) =>
    ipcRenderer.invoke(conversationChannels.fork, workspace, id),
  takeOver: (workspace, id) =>
    ipcRenderer.invoke(conversationChannels.takeOver, workspace, id),
  release: (workspace, id) =>
    ipcRenderer.invoke(conversationChannels.release, workspace, id),
  close: (workspace, id) =>
    ipcRenderer.invoke(conversationChannels.close, workspace, id),
  alive: (workspace) =>
    ipcRenderer.invoke(conversationChannels.alive, workspace),
  engineState: (workspace, id) =>
    ipcRenderer.invoke(conversationChannels.engineState, workspace, id),
  permissions: (workspace, id) =>
    ipcRenderer.invoke(conversationChannels.permissions, workspace, id),
  lastSettings: () => ipcRenderer.invoke(conversationChannels.lastSettings),
  codexModels: () => ipcRenderer.invoke(conversationChannels.codexModels),
  linkPreview: (url) =>
    ipcRenderer.invoke(conversationChannels.linkPreview, url),
  suggest: (workspace, kind, query) =>
    ipcRenderer.invoke(conversationChannels.suggest, workspace, kind, query),
  openLink: (url) => ipcRenderer.invoke(conversationChannels.openLink, url),
  image: (workspace, id, path) =>
    ipcRenderer.invoke(conversationChannels.image, workspace, id, path),
  openImage: (workspace, id, path) =>
    ipcRenderer.invoke(conversationChannels.openImage, workspace, id, path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onEvent: (listener) =>
    subscribe<ConversationEvent>(conversationChannels.event, listener),
};

/** Whether a project's folder is ready for an agent (FE-30). A slug, never a path. */
const harness: DesktopHarnessApi = {
  list: () => ipcRenderer.invoke(harnessChannels.list),
  check: () => ipcRenderer.invoke(harnessChannels.check),
  update: (agent) => ipcRenderer.invoke(harnessChannels.update, agent),
  dismiss: (agent, version) =>
    ipcRenderer.invoke(harnessChannels.dismiss, agent, version),
  openInTerminal: (agent) =>
    ipcRenderer.invoke(harnessChannels.openInTerminal, agent),
  onChanged: (listener) =>
    subscribe<HarnessInfo[]>(harnessChannels.changed, listener),
};

const readiness: DesktopReadinessApi = {
  check: (slug) => ipcRenderer.invoke(readinessChannels.check, slug),
  preview: (slug, fix) =>
    ipcRenderer.invoke(readinessChannels.preview, slug, fix),
  apply: (slug, fix, before) =>
    ipcRenderer.invoke(readinessChannels.apply, slug, fix, before),
};

/** What Claude remembers about a project (FE-36): read-only, by file NAME. */
const memory: DesktopMemoryApi = {
  list: (workspace) => ipcRenderer.invoke(memoryChannels.list, workspace),
  read: (workspace, file) =>
    ipcRenderer.invoke(memoryChannels.read, workspace, file),
  reveal: (workspace) => ipcRenderer.invoke(memoryChannels.reveal, workspace),
  onChange: (listener) =>
    subscribe<MemoryChange>(memoryChannels.changed, listener),
};

/** What a project's agents are told (FE-37): read-only, by an id main minted. */
const instructions: DesktopInstructionsApi = {
  list: (workspace) => ipcRenderer.invoke(instructionChannels.list, workspace),
  read: (workspace, id) =>
    ipcRenderer.invoke(instructionChannels.read, workspace, id),
  effective: (workspace, agent) =>
    ipcRenderer.invoke(instructionChannels.effective, workspace, agent),
  reveal: (workspace, id) =>
    ipcRenderer.invoke(instructionChannels.reveal, workspace, id),
  onChange: (listener) =>
    subscribe<InstructionChange>(instructionChannels.changed, listener),
};

/** A project's agent setup (FE-40): read-only, a slug and an id, never a path. */
const agentConfig: DesktopAgentConfigApi = {
  list: () => ipcRenderer.invoke(agentConfigChannels.list),
  read: (id) => ipcRenderer.invoke(agentConfigChannels.read, id),
  write: (id, text, baseHash) =>
    ipcRenderer.invoke(agentConfigChannels.write, id, text, baseHash),
  reveal: (id) => ipcRenderer.invoke(agentConfigChannels.reveal, id),
};

const agentSetup: DesktopAgentSetupApi = {
  read: (slug) => ipcRenderer.invoke(agentSetupChannels.read, slug),
  open: (slug, id) => ipcRenderer.invoke(agentSetupChannels.open, slug, id),
  reveal: (slug, id) => ipcRenderer.invoke(agentSetupChannels.reveal, slug, id),
};

const laneworkMcp: DesktopLaneworkMcpApi = {
  status: () => ipcRenderer.invoke(laneworkMcpChannels.status),
  install: (agent) => ipcRenderer.invoke(laneworkMcpChannels.install, agent),
  remove: (agent) => ipcRenderer.invoke(laneworkMcpChannels.remove, agent),
  auth: (agent) => ipcRenderer.invoke(laneworkMcpChannels.auth, agent),
  login: (agent) => ipcRenderer.invoke(laneworkMcpChannels.login, agent),
};

const git: DesktopGitApi = {
  account: () => ipcRenderer.invoke(gitChannels.account),
  connect: () => ipcRenderer.invoke(gitChannels.connect),
  cancelConnect: () => ipcRenderer.invoke(gitChannels.connectCancel),
  disconnect: () => ipcRenderer.invoke(gitChannels.disconnect),
  onConnectProgress: (listener) =>
    subscribe(gitChannels.connectProgress, listener),
  onAccountChange: (listener) =>
    subscribe(gitChannels.accountChanged, listener),
  repo: (slug) => ipcRenderer.invoke(gitChannels.repo, slug),
  repoOptions: () => ipcRenderer.invoke(gitChannels.repoOptions),
  appAccess: () => ipcRenderer.invoke(gitChannels.appAccess),
  // ⚠️ An installation id or null — never a URL. See `DesktopGitApi`.
  openAppConfig: (installationId) =>
    ipcRenderer.invoke(gitChannels.openAppConfig, installationId),
  linkRepo: (slug, raw) => ipcRenderer.invoke(gitChannels.linkRepo, slug, raw),
  unlinkRepo: (slug) => ipcRenderer.invoke(gitChannels.unlinkRepo, slug),
  // ⚠️ `refresh` is passed through as a boolean rather than omitted: the
  // handler validates on argument COUNT, the same rule `board.move` follows.
  pulls: (slug, status, refresh) =>
    ipcRenderer.invoke(gitChannels.pulls, slug, status, refresh === true),
  pull: (slug, number) => ipcRenderer.invoke(gitChannels.pull, slug, number),
  commits: (slug, number) =>
    ipcRenderer.invoke(gitChannels.commits, slug, number),
  commitDiff: (slug, sha) =>
    ipcRenderer.invoke(gitChannels.commitDiff, slug, sha),
  fileText: (slug, path, sha) =>
    ipcRenderer.invoke(gitChannels.fileText, slug, path, sha),
  merge: (slug, number, method, headSha) =>
    ipcRenderer.invoke(gitChannels.merge, slug, number, method, headSha),
  review: (slug, number, verdict, body) =>
    ipcRenderer.invoke(gitChannels.review, slug, number, verdict, body),
  activity: (slug, number) =>
    ipcRenderer.invoke(gitChannels.activity, slug, number),
  comment: (slug, number, body) =>
    ipcRenderer.invoke(gitChannels.comment, slug, number, body),
};

/**
 * The terminal surface (FE-19).
 *
 * ⚠️ The port to the pty host lives HERE and never crosses into the page. The
 * page gets named operations — attach this session, type this, resize to that
 * — and callbacks; it cannot post an arbitrary message to the host, and it
 * cannot reach another channel through the port.
 *
 * ⚠️ Connected on first use, and again after the host goes away: main says so
 * on `hostExited`, and the next call asks for a fresh port.
 */
function createTerminal(): DesktopTerminalApi {
  const commandListeners = new Set<(command: TerminalCommand) => void>();
  let pendingFocus: Extract<TerminalCommand, { type: "focus" }> | null = null;
  // A newly reopened window receives native navigation before React mounts.
  subscribe<TerminalCommand>(terminalChannels.command, (command) => {
    if (!commandListeners.size && typeof command === "object")
      pendingFocus = command;
    else for (const listener of commandListeners) listener(command);
  });
  let port: MessagePort | null = null;
  let connecting: Promise<MessagePort> | null = null;
  const views = new Map<string, TerminalViewHandlers>();
  const changeListeners = new Set<(workspace: string) => void>();

  const notify = (workspace: string) => {
    for (const listener of changeListeners) listener(workspace);
  };

  const route = (event: MessageEvent) => {
    const message = event.data as TerminalHostMessage | null;
    if (!message || typeof message !== "object") return;
    if (message.t === "changed") return notify(message.workspace);
    const view = views.get(message.id);
    if (!view) return;
    if (message.t === "snapshot") view.onSnapshot(message.data);
    else if (message.t === "data") view.onData(message.data);
    else if (message.t === "exit") view.onExit(message.code, message.signal);
  };

  const connect = (): Promise<MessagePort> => {
    if (port) return Promise.resolve(port);
    if (connecting) return connecting;
    connecting = new Promise<MessagePort>((resolve, reject) => {
      const onPort = (event: Electron.IpcRendererEvent) => {
        ipcRenderer.off(terminalChannels.port, onPort);
        const [received] = event.ports;
        if (!received) return reject(new Error("No terminal port"));
        received.onmessage = route;
        received.start();
        port = received;
        resolve(received);
      };
      ipcRenderer.on(terminalChannels.port, onPort);
      ipcRenderer.invoke(terminalChannels.connect).catch((error: unknown) => {
        ipcRenderer.off(terminalChannels.port, onPort);
        reject(error);
      });
    }).finally(() => {
      connecting = null;
    });
    return connecting;
  };

  ipcRenderer.on(terminalChannels.hostExited, () => {
    port?.close();
    port = null;
    // The sessions went with the host; the panel re-lists and drops them.
    views.clear();
    notify("*");
  });

  // ⚠️ Every message waits on the same connection, so they leave in the order
  // they were posted even while the port is still being set up.
  const post = (message: TerminalClientMessage) => {
    void connect()
      .then((ready) => ready.postMessage(message))
      .catch(() => undefined);
  };

  return {
    list: (workspace) => ipcRenderer.invoke(terminalChannels.list, workspace),
    spawn: (workspace, cols, rows, kind = "shell", resume, card) => {
      const args: unknown[] = [workspace, cols, rows, kind];
      // ⚠️ A card goes sixth, behind an explicit `null` resume: main counts
      // its arguments, and a hole would read as a resume of `undefined`.
      if (card !== undefined) args.push(resume ?? null, card);
      else if (resume !== undefined) args.push(resume);
      return ipcRenderer.invoke(terminalChannels.spawn, ...args);
    },
    agentSessions: (workspace) =>
      ipcRenderer.invoke(terminalChannels.agentSessions, workspace),
    renameAgentSession: (workspace, agent, id, name) =>
      ipcRenderer.invoke(
        terminalChannels.agentSessionRename,
        workspace,
        agent,
        id,
        name,
      ),
    pinAgentSession: (workspace, agent, id, pinned) =>
      ipcRenderer.invoke(
        terminalChannels.agentSessionPin,
        workspace,
        agent,
        id,
        pinned,
      ),
    deleteAgentSession: (workspace, agent, id) =>
      ipcRenderer.invoke(
        terminalChannels.agentSessionDelete,
        workspace,
        agent,
        id,
      ),
    agentSubagent: (workspace, agent, conversation, sub) =>
      ipcRenderer.invoke(
        terminalChannels.agentSubagent,
        workspace,
        agent,
        conversation,
        sub,
      ),
    agentBackgroundTasks: (workspace, conversation) =>
      ipcRenderer.invoke(
        terminalChannels.agentBackgroundTasks,
        workspace,
        conversation,
      ),
    agentTaskOutput: (workspace, conversation, task) =>
      ipcRenderer.invoke(
        terminalChannels.agentTaskOutput,
        workspace,
        conversation,
        task,
      ),
    agentStopTask: (workspace, conversation, task) =>
      ipcRenderer.invoke(
        terminalChannels.agentStopTask,
        workspace,
        conversation,
        task,
      ),
    agentFiles: (workspace, agent, id) =>
      ipcRenderer.invoke(terminalChannels.agentFiles, workspace, agent, id),
    agentFilesForWorktree: (workspace) =>
      ipcRenderer.invoke(terminalChannels.agentFilesForWorktree, workspace),
    onAgentActivity: (listener) =>
      subscribe(terminalChannels.agentActivity, listener),
    codexUsage: (workspace) =>
      ipcRenderer.invoke(terminalChannels.codexUsage, workspace),
    refreshClaudeUsage: () =>
      ipcRenderer.invoke(terminalChannels.refreshClaudeUsage),
    agentFacts: (workspace, agent, id) =>
      ipcRenderer.invoke(terminalChannels.agentFacts, workspace, agent, id),
    agentUsage: (workspace) =>
      ipcRenderer.invoke(terminalChannels.agentUsage, workspace),
    onAgentWritten: (listener) =>
      subscribe(terminalChannels.agentWritten, listener),
    agents: () => ipcRenderer.invoke(terminalChannels.agents),
    kill: (id) => ipcRenderer.invoke(terminalChannels.kill, id),
    reorder: (workspace, ids) =>
      ipcRenderer.invoke(terminalChannels.reorder, workspace, ids),
    attach: (id, cols, rows, handlers) => {
      views.set(id, handlers);
      post({ t: "attach", id, cols, rows });
      return () => {
        if (views.get(id) !== handlers) return;
        views.delete(id);
        post({ t: "detach", id });
      };
    },
    input: (id, data) => post({ t: "input", id, data }),
    pathForFile: (file) => webUtils.getPathForFile(file),
    resize: (id, cols, rows) => post({ t: "resize", id, cols, rows }),
    onChange: (listener) => {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    onCommand: (listener) => {
      commandListeners.add(listener);
      if (pendingFocus) {
        const command = pendingFocus;
        pendingFocus = null;
        queueMicrotask(() => {
          if (commandListeners.has(listener)) listener(command);
          else pendingFocus = command;
        });
      }
      return () => {
        commandListeners.delete(listener);
      };
    },
  };
}

const desktop: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(channels.appInfo),
  setTheme: (source) => ipcRenderer.invoke(channels.setTheme, source),
  onThemeChange: (listener) => subscribe(channels.themeChanged, listener),
  onViewCommand: (listener) => subscribe(channels.viewCommand, listener),
  zoomFactor: () => webFrame.getZoomFactor(),
  auth,
  workspaces: {
    load: () => ipcRenderer.invoke(workspaceChannels.load),
    // ⚠️ The cloud workspace id, not the slug: every board call is addressed by
    // it.
    select: (id) => ipcRenderer.invoke(workspaceChannels.select, id),
    icon: (workspaceId, iconKey) =>
      ipcRenderer.invoke(workspaceChannels.icon, workspaceId, iconKey),
    // The NAME a human typed; main derives the slug the service demands. The
    // folders are pick IDS, primary first — main resolves them to paths it
    // handed out itself, so no path ever travels this way.
    create: (name, folders) =>
      ipcRenderer.invoke(
        workspaceChannels.createWorkspace,
        name,
        folders ?? [],
      ),
    // ⚠️ By ID, unlike `remove` right below — the two keys are not
    // interchangeable and a uuid matches the service's slug shape, so a mix-up
    // is caught by the service rather than by anything here.
    rename: (id, name) =>
      ipcRenderer.invoke(workspaceChannels.renameWorkspace, id, name),
    reorder: (ids) =>
      ipcRenderer.invoke(workspaceChannels.reorderWorkspaces, ids),
    // ⚠️ By ID for the service and by SLUG for this machine, and both have to
    // travel: the machine surface deletes by cloud id — it refuses a slug with a
    // 400 — while the folder link main has to drop afterwards is keyed by slug.
    remove: (id, slug) =>
      ipcRenderer.invoke(workspaceChannels.deleteWorkspace, id, slug),
    syncToCloud: (localId) =>
      ipcRenderer.invoke(workspaceChannels.syncToCloud, localId),
    onLocalChange: (listener) =>
      subscribe(workspaceChannels.localChanged, listener),
    board: {
      load: (workspaceId, query) =>
        ipcRenderer.invoke(workspaceChannels.board, workspaceId, query),
      more: (workspaceId, query, group, cursor) =>
        ipcRenderer.invoke(
          workspaceChannels.more,
          workspaceId,
          query,
          group,
          cursor,
        ),
      stats: (workspaceId, query) =>
        ipcRenderer.invoke(workspaceChannels.stats, workspaceId, query),
      presence: (workspaceId) =>
        ipcRenderer.invoke(workspaceChannels.presence, workspaceId),
      checkpoint: (workspaceId, cardId) =>
        ipcRenderer.invoke(workspaceChannels.checkpoint, workspaceId, cardId),
      card: (workspaceId, cardId) =>
        ipcRenderer.invoke(workspaceChannels.card, workspaceId, cardId),
      lookup: (workspaceId, taskId) =>
        ipcRenderer.invoke(workspaceChannels.lookup, workspaceId, taskId),
      search: (workspaceId, query) =>
        ipcRenderer.invoke(workspaceChannels.search, workspaceId, query),
      update: (workspaceId, cardId, patch, revision) =>
        ipcRenderer.invoke(
          workspaceChannels.update,
          workspaceId,
          cardId,
          patch,
          revision,
        ),
      // ⚠️ `placement` is passed through as `null` when absent rather than
      // omitted: the handler validates on argument COUNT, and a call that
      // sometimes sends four arguments and sometimes five is one the sender
      // check cannot state a rule about.
      move: (workspaceId, cardId, columnKey, placement) =>
        ipcRenderer.invoke(
          workspaceChannels.move,
          workspaceId,
          cardId,
          columnKey,
          placement ?? null,
        ),
      changes: (workspaceId, since) =>
        ipcRenderer.invoke(workspaceChannels.changes, workspaceId, since),
      toggle: (workspaceId, cardId, key, checked, revision) =>
        ipcRenderer.invoke(
          workspaceChannels.toggle,
          workspaceId,
          cardId,
          key,
          checked,
          revision,
        ),
      setChecklist: (workspaceId, cardId, items, revision) =>
        ipcRenderer.invoke(
          workspaceChannels.setChecklist,
          workspaceId,
          cardId,
          items,
          revision,
        ),
      // ⚠️ `cursor` is passed through as `null` when absent rather than
      // omitted, for the same reason `move` sends a null placement: the handler
      // validates on argument COUNT.
      activity: (workspaceId, cardId, cursor) =>
        ipcRenderer.invoke(
          workspaceChannels.activity,
          workspaceId,
          cardId,
          cursor ?? null,
        ),
      comment: (workspaceId, cardId, body) =>
        ipcRenderer.invoke(
          workspaceChannels.comment,
          workspaceId,
          cardId,
          body,
        ),
      editComment: (workspaceId, cardId, commentId, body) =>
        ipcRenderer.invoke(
          workspaceChannels.commentEdit,
          workspaceId,
          cardId,
          commentId,
          body,
        ),
      deleteComment: (workspaceId, cardId, commentId) =>
        ipcRenderer.invoke(
          workspaceChannels.commentDelete,
          workspaceId,
          cardId,
          commentId,
        ),
      subscribe: (workspaceId, cardId, subscribed) =>
        ipcRenderer.invoke(
          workspaceChannels.subscribe,
          workspaceId,
          cardId,
          subscribed,
        ),
      favorite: (workspaceId, cardId, favorite) =>
        ipcRenderer.invoke(
          workspaceChannels.favorite,
          workspaceId,
          cardId,
          favorite,
        ),
      // ⚠️ A file REFERENCE — a path or a URL — never bytes and never a handle.
      // Main does not open what is named here; the service stores the string.
      attach: (workspaceId, cardId, file) =>
        ipcRenderer.invoke(workspaceChannels.attach, workspaceId, cardId, file),
      detach: (workspaceId, cardId, attachmentId) =>
        ipcRenderer.invoke(
          workspaceChannels.detach,
          workspaceId,
          cardId,
          attachmentId,
        ),
      create: (workspaceId, draft) =>
        ipcRenderer.invoke(workspaceChannels.create, workspaceId, draft),
      archive: (workspaceId, cardId) =>
        ipcRenderer.invoke(workspaceChannels.archive, workspaceId, cardId),
      purge: (workspaceId, slug) =>
        ipcRenderer.invoke(workspaceChannels.purge, workspaceId, slug),
      importPreview: (workspaceId) =>
        ipcRenderer.invoke(workspaceChannels.importPreview, workspaceId),
      importRun: (workspaceId) =>
        ipcRenderer.invoke(workspaceChannels.importRun, workspaceId),
      importSeal: (workspaceId) =>
        ipcRenderer.invoke(workspaceChannels.importSeal, workspaceId),
    },
    // ⚠️ Keyed by SLUG, not by the workspace id: the id is absent on a service
    // that predates it, which is the very screen this surface serves.
    folder: {
      state: (slug) => ipcRenderer.invoke(workspaceChannels.folderState, slug),
      choose: () => ipcRenderer.invoke(workspaceChannels.folderChoose),
      list: (slug) => ipcRenderer.invoke(workspaceChannels.folderList, slug),
      link: (slug, folders) =>
        ipcRenderer.invoke(workspaceChannels.folderLink, slug, folders),
      pick: (slug) => ipcRenderer.invoke(workspaceChannels.folderPick, slug),
      forget: (slug) =>
        ipcRenderer.invoke(workspaceChannels.folderForget, slug),
      reveal: (slug) =>
        ipcRenderer.invoke(workspaceChannels.folderReveal, slug),
    },
  },
  git,
  worktree,
  terminal: createTerminal(),
  conversation,
  handoff,
  readiness,
  harness,
  memory,
  instructions,
  agentSetup,
  agentConfig,
  laneworkMcp,
};
contextBridge.exposeInMainWorld("desktop", desktop);
