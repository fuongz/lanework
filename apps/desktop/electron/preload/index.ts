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
import {
  type DesktopDictationApi,
  type DictationEvent,
  dictationChannels,
} from "../../shared/dictation";
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
  type DesktopNotificationsApi,
  type NotificationTarget,
  notificationChannels,
} from "../../shared/notifications";
import {
  type DesktopJevApi,
  type DesktopLeadsApi,
  type DesktopOrchestrationApi,
  type JevState,
  jevChannels,
  type LeadsEvent,
  leadsChannels,
  type OrchestrationEvent,
  orchestrationChannels,
} from "../../shared/orchestration";
import {
  type DesktopProjectsApi,
  projectChannels,
} from "../../shared/projects";
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
import {
  type DesktopWorktreeApi,
  isHeldRead,
  READS_REFUSED_MESSAGE,
  READS_UNCHECKED_MESSAGE,
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
 * The auth surface.
 *
 * Every method is a named operation on a fixed channel, so nothing here can
 * reach an arbitrary channel. Nothing here can return the credential either:
 * `main` only ever sends a redacted session.
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
 * A worktree read, with a read the git gate held back turned back into an
 * error (FE-102): main answers it instead of throwing, so it is not logged.
 */
function read(channel: string, ...args: unknown[]): Promise<never> {
  return ipcRenderer.invoke(channel, ...args).then((value: unknown) => {
    if (isHeldRead(value))
      throw new Error(
        value.heldRead === "refused"
          ? READS_REFUSED_MESSAGE
          : READS_UNCHECKED_MESSAGE,
      );
    return value as never;
  });
}

/**
 * The local-repository surface.
 *
 * NOTE: Every call names a project, never a folder; main resolves it. Paths
 * are the ones `status` answered, and main re-checks them against a fresh
 * status before it acts.
 */
const worktree: DesktopWorktreeApi = {
  files: (slug, folder) => read(worktreeChannels.files, slug, folder),
  dir: (slug, path, folder) => read(worktreeChannels.dir, slug, path, folder),
  view: (slug, path, folder) => read(worktreeChannels.view, slug, path, folder),
  reveal: (slug, path, folder) =>
    read(worktreeChannels.reveal, slug, path, folder),
  locate: (slug, path) => read(worktreeChannels.locate, slug, path),
  openDefault: (slug, path, folder) =>
    read(worktreeChannels.openDefault, slug, path, folder),
  status: (slug, folder) => read(worktreeChannels.status, slug, folder),
  patch: (slug) => read(worktreeChannels.patch, slug),
  fileText: (slug, path, side) =>
    read(worktreeChannels.fileText, slug, path, side),
  stage: (slug, paths) => read(worktreeChannels.stage, slug, paths),
  unstage: (slug, paths) => read(worktreeChannels.unstage, slug, paths),
  restore: (slug, paths) => read(worktreeChannels.restore, slug, paths),
  commit: (slug, message, mode) =>
    read(worktreeChannels.commit, slug, message, mode),
  sync: (slug, action, remote) =>
    read(worktreeChannels.sync, slug, action, remote),
  log: (slug, skip) => read(worktreeChannels.log, slug, skip),
  show: (slug, sha) => read(worktreeChannels.show, slug, sha),
  branches: (slug) => read(worktreeChannels.branches, slug),
  switchBranch: (slug, name) => read(worktreeChannels.switchBranch, slug, name),
  repoTrust: (slug, folder) =>
    ipcRenderer.invoke(worktreeChannels.repoTrust, slug, folder),
  askAgain: (slug, folder) =>
    ipcRenderer.invoke(worktreeChannels.askAgain, slug, folder),
  restrict: (slug, folder) =>
    ipcRenderer.invoke(worktreeChannels.restrict, slug, folder),
};

/** Settings → Notifications, and where a clicked one leads. */
const notifications: DesktopNotificationsApi = {
  get: () => ipcRenderer.invoke(notificationChannels.get),
  set: (kind, delivery) =>
    ipcRenderer.invoke(notificationChannels.set, kind, delivery),
  test: () => ipcRenderer.invoke(notificationChannels.test),
  reportLocation: (path) => {
    void ipcRenderer
      .invoke(notificationChannels.location, path)
      .catch(() => {});
  },
  onOpen: (listener) =>
    subscribe<NotificationTarget>(notificationChannels.open, listener),
  unseenPulls: () => ipcRenderer.invoke(notificationChannels.unseenPulls),
  onUnseenPulls: (listener) =>
    subscribe<Record<string, number>>(
      notificationChannels.unseenPullsChanged,
      listener,
    ),
};

/** Settings → Agents: the checkpoint hook, on and off. */
const handoff: DesktopHandoffApi = {
  status: () => ipcRenderer.invoke(handoffChannels.status),
  enable: (agent) => ipcRenderer.invoke(handoffChannels.enable, agent),
  disable: (agent) => ipcRenderer.invoke(handoffChannels.disable, agent),
  setPushWip: (on) => ipcRenderer.invoke(handoffChannels.setPushWip, on),
  setPushWipUntracked: (on) =>
    ipcRenderer.invoke(handoffChannels.setPushWipUntracked, on),
};

/**
 * The conversation view.
 *
 * Every call names a project and a conversation id, never a folder or a
 * command. Main checks the settings against its own lists before any of them
 * becomes a flag.
 */
const conversation: DesktopConversationApi = {
  read: (project, id) =>
    ipcRenderer.invoke(conversationChannels.read, project, id),
  start: (request) => ipcRenderer.invoke(conversationChannels.start, request),
  send: (request) => ipcRenderer.invoke(conversationChannels.send, request),
  stop: (project, id) =>
    ipcRenderer.invoke(conversationChannels.stop, project, id),
  clearQueue: (project, id) =>
    ipcRenderer.invoke(conversationChannels.clearQueue, project, id),
  takeQueued: (project, id, message) =>
    ipcRenderer.invoke(conversationChannels.takeQueued, project, id, message),
  removeQueued: (project, id, message) =>
    ipcRenderer.invoke(conversationChannels.removeQueued, project, id, message),
  resumeQueue: (project, id) =>
    ipcRenderer.invoke(conversationChannels.resumeQueue, project, id),
  answerPermission: (project, id, request, answer) =>
    ipcRenderer.invoke(
      conversationChannels.answerPermission,
      project,
      id,
      request,
      answer,
    ),
  fork: (project, id) =>
    ipcRenderer.invoke(conversationChannels.fork, project, id),
  takeOver: (project, id) =>
    ipcRenderer.invoke(conversationChannels.takeOver, project, id),
  release: (project, id) =>
    ipcRenderer.invoke(conversationChannels.release, project, id),
  close: (project, id) =>
    ipcRenderer.invoke(conversationChannels.close, project, id),
  alive: (project) => ipcRenderer.invoke(conversationChannels.alive, project),
  engineState: (project, id) =>
    ipcRenderer.invoke(conversationChannels.engineState, project, id),
  permissions: (project, id) =>
    ipcRenderer.invoke(conversationChannels.permissions, project, id),
  awaiting: () => ipcRenderer.invoke(conversationChannels.awaiting),
  lastSettings: () => ipcRenderer.invoke(conversationChannels.lastSettings),
  codexModels: () => ipcRenderer.invoke(conversationChannels.codexModels),
  opencodeModels: () => ipcRenderer.invoke(conversationChannels.opencodeModels),
  linkPreview: (url) =>
    ipcRenderer.invoke(conversationChannels.linkPreview, url),
  suggest: (project, kind, query, agent) =>
    ipcRenderer.invoke(
      conversationChannels.suggest,
      project,
      kind,
      query,
      agent ?? null,
    ),
  openLink: (url) => ipcRenderer.invoke(conversationChannels.openLink, url),
  image: (project, id, path) =>
    ipcRenderer.invoke(conversationChannels.image, project, id, path),
  openImage: (project, id, path) =>
    ipcRenderer.invoke(conversationChannels.openImage, project, id, path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onEvent: (listener) =>
    subscribe<ConversationEvent>(conversationChannels.event, listener),
};

/** The agent CLIs on this machine: versions, accounts and updates. */
const harness: DesktopHarnessApi = {
  list: () => ipcRenderer.invoke(harnessChannels.list),
  accounts: () => ipcRenderer.invoke(harnessChannels.accounts),
  check: () => ipcRenderer.invoke(harnessChannels.check),
  update: (agent) => ipcRenderer.invoke(harnessChannels.update, agent),
  dismiss: (agent, version) =>
    ipcRenderer.invoke(harnessChannels.dismiss, agent, version),
  openInTerminal: (agent) =>
    ipcRenderer.invoke(harnessChannels.openInTerminal, agent),
  onChanged: (listener) =>
    subscribe<HarnessInfo[]>(harnessChannels.changed, listener),
};

/**
 * Orchestration runs (FE-87): a lead spawning workers.
 *
 * NOTE: The lead's CLI talks to main's control server, not to this. The page
 * only reads runs and asks for what the user does: approve, pause, resume,
 * stop, cancel a task, approve a task's wider write scope, clean up a
 * stopped run. Every call names a project slug and ids.
 */
const orchestration: DesktopOrchestrationApi = {
  runs: (project) => ipcRenderer.invoke(orchestrationChannels.runs, project),
  run: (project, runId) =>
    ipcRenderer.invoke(orchestrationChannels.run, project, runId),
  approve: (proposal) =>
    ipcRenderer.invoke(orchestrationChannels.approve, proposal),
  pause: (project, runId) =>
    ipcRenderer.invoke(orchestrationChannels.pause, project, runId),
  resume: (project, runId) =>
    ipcRenderer.invoke(orchestrationChannels.resume, project, runId),
  stop: (project, runId) =>
    ipcRenderer.invoke(orchestrationChannels.stop, project, runId),
  cancelTask: (project, runId, taskId) =>
    ipcRenderer.invoke(
      orchestrationChannels.cancelTask,
      project,
      runId,
      taskId,
    ),
  approveScope: (project, runId, taskId) =>
    ipcRenderer.invoke(
      orchestrationChannels.approveScope,
      project,
      runId,
      taskId,
    ),
  leftovers: (project, runId) =>
    ipcRenderer.invoke(orchestrationChannels.leftovers, project, runId),
  cleanUp: (project, runId) =>
    ipcRenderer.invoke(orchestrationChannels.cleanUp, project, runId),
  onChange: (listener) =>
    subscribe<OrchestrationEvent>(orchestrationChannels.changed, listener),
};

/**
 * Jev: the judge's settings, a test question, and its log.
 *
 * NOTE: The key goes one way, to main. `get` answers only whether one is kept.
 */
const jev: DesktopJevApi = {
  get: () => ipcRenderer.invoke(jevChannels.get),
  set: (config) => ipcRenderer.invoke(jevChannels.set, config),
  setKey: (key) => ipcRenderer.invoke(jevChannels.setKey, key),
  test: (request) => ipcRenderer.invoke(jevChannels.test, request),
  log: () => ipcRenderer.invoke(jevChannels.log),
  onChange: (listener) => subscribe<JevState>(jevChannels.changed, listener),
};

/**
 * Team lead presets (FE-88): built-in, personal and the project's repo
 * leads. The page writes only personal ones, by id.
 */
const leads: DesktopLeadsApi = {
  list: (project) => ipcRenderer.invoke(leadsChannels.list, project),
  savePersonal: (project, lead) =>
    ipcRenderer.invoke(leadsChannels.savePersonal, project, lead),
  removePersonal: (project, id) =>
    ipcRenderer.invoke(leadsChannels.removePersonal, project, id),
  setDefault: (project, id) =>
    ipcRenderer.invoke(leadsChannels.setDefault, project, id),
  pickContext: (project) =>
    ipcRenderer.invoke(leadsChannels.pickContext, project),
  inspectContext: (project, paths) =>
    ipcRenderer.invoke(leadsChannels.inspectContext, project, paths),
  onChange: (listener) =>
    subscribe<LeadsEvent>(leadsChannels.changed, listener),
};

/** Dictation in the composer: the helper's events, by session. */
const dictation: DesktopDictationApi = {
  supported: () => ipcRenderer.invoke(dictationChannels.supported),
  start: (locale, hints) =>
    ipcRenderer.invoke(dictationChannels.start, locale, hints),
  stop: (session) => ipcRenderer.invoke(dictationChannels.stop, session),
  cancel: (session) => ipcRenderer.invoke(dictationChannels.cancel, session),
  onEvent: (listener) =>
    subscribe<DictationEvent>(dictationChannels.event, listener),
};

/** Whether a project's folder is ready for an agent. A slug, never a path. */
const readiness: DesktopReadinessApi = {
  check: (slug) => ipcRenderer.invoke(readinessChannels.check, slug),
  preview: (slug, fix) =>
    ipcRenderer.invoke(readinessChannels.preview, slug, fix),
  apply: (slug, fix, before) =>
    ipcRenderer.invoke(readinessChannels.apply, slug, fix, before),
};

/** What Claude remembers about a project: read-only, by file NAME. */
const memory: DesktopMemoryApi = {
  list: (project) => ipcRenderer.invoke(memoryChannels.list, project),
  read: (project, file) =>
    ipcRenderer.invoke(memoryChannels.read, project, file),
  reveal: (project) => ipcRenderer.invoke(memoryChannels.reveal, project),
  onChange: (listener) =>
    subscribe<MemoryChange>(memoryChannels.changed, listener),
};

/** What a project's agents are told: read-only, by an id main minted. */
const instructions: DesktopInstructionsApi = {
  list: (project) => ipcRenderer.invoke(instructionChannels.list, project),
  read: (project, id) =>
    ipcRenderer.invoke(instructionChannels.read, project, id),
  effective: (project, agent) =>
    ipcRenderer.invoke(instructionChannels.effective, project, agent),
  reveal: (project, id) =>
    ipcRenderer.invoke(instructionChannels.reveal, project, id),
  onChange: (listener) =>
    subscribe<InstructionChange>(instructionChannels.changed, listener),
};

/**
 * The agents' config files, by an id main minted.
 *
 * A write carries the hash of the text it was based on, so it cannot
 * overwrite a change made since that read.
 */
const agentConfig: DesktopAgentConfigApi = {
  list: () => ipcRenderer.invoke(agentConfigChannels.list),
  read: (id) => ipcRenderer.invoke(agentConfigChannels.read, id),
  write: (id, text, baseHash) =>
    ipcRenderer.invoke(agentConfigChannels.write, id, text, baseHash),
  reveal: (id) => ipcRenderer.invoke(agentConfigChannels.reveal, id),
};

/** A project's agent setup: read-only, a slug and an id, never a path. */
const agentSetup: DesktopAgentSetupApi = {
  read: (slug) => ipcRenderer.invoke(agentSetupChannels.read, slug),
  readGlobal: () => ipcRenderer.invoke(agentSetupChannels.readGlobal),
  open: (slug, id) => ipcRenderer.invoke(agentSetupChannels.open, slug, id),
  reveal: (slug, id) => ipcRenderer.invoke(agentSetupChannels.reveal, slug, id),
  trust: (slug) => ipcRenderer.invoke(agentSetupChannels.trust, slug),
  setTrust: (slug, agent, on) =>
    ipcRenderer.invoke(agentSetupChannels.setTrust, slug, agent, on),
};

const laneworkMcp: DesktopLaneworkMcpApi = {
  status: () => ipcRenderer.invoke(laneworkMcpChannels.status),
  install: (agent) => ipcRenderer.invoke(laneworkMcpChannels.install, agent),
  remove: (agent) => ipcRenderer.invoke(laneworkMcpChannels.remove, agent),
  auth: (agent) => ipcRenderer.invoke(laneworkMcpChannels.auth, agent),
  login: (agent) => ipcRenderer.invoke(laneworkMcpChannels.login, agent),
  cancelLogin: (agent) =>
    ipcRenderer.invoke(laneworkMcpChannels.cancelLogin, agent),
};

/**
 * The GitHub surface, run through `gh` in main.
 *
 * Nothing here takes a repository. Every read names a PROJECT, and main
 * finds the repo from that project's folder.
 */
const git: DesktopGitApi = {
  account: () => ipcRenderer.invoke(gitChannels.account),
  check: () => ipcRenderer.invoke(gitChannels.check),
  onAccountChange: (listener) =>
    subscribe(gitChannels.accountChanged, listener),
  repo: (slug) => ipcRenderer.invoke(gitChannels.repo, slug),
  selectRepo: (slug, side) =>
    ipcRenderer.invoke(gitChannels.selectRepo, slug, side),
  // NOTE: `refresh` is sent as a boolean, never omitted: the handler validates
  // on argument COUNT, the same rule `board.move` follows.
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
  issues: (slug, refresh) =>
    ipcRenderer.invoke(gitChannels.issues, slug, refresh === true),
  issue: (slug, number) => ipcRenderer.invoke(gitChannels.issue, slug, number),
};

/**
 * The terminal surface.
 *
 * NOTE: The port to the pty host lives HERE and never crosses into the page.
 * The page gets named operations (attach this session, type this, resize to
 * that) and callbacks. It cannot post an arbitrary message to the host, nor
 * reach another channel through the port.
 *
 * The port connects on first use, and again after the host goes away: main
 * says so on `hostExited`, and the next call asks for a fresh port.
 */
function createTerminal(): DesktopTerminalApi {
  const commandListeners = new Set<(command: TerminalCommand) => void>();
  let pendingFocus: Extract<TerminalCommand, { type: "focus" }> | null = null;
  // A reopened window can receive native navigation before React mounts, so
  // a focus command with no listener yet is held for the first one.
  subscribe<TerminalCommand>(terminalChannels.command, (command) => {
    if (!commandListeners.size && typeof command === "object")
      pendingFocus = command;
    else for (const listener of commandListeners) listener(command);
  });
  let port: MessagePort | null = null;
  let connecting: Promise<MessagePort> | null = null;
  const views = new Map<string, TerminalViewHandlers>();
  const changeListeners = new Set<(project: string) => void>();

  const notify = (project: string) => {
    for (const listener of changeListeners) listener(project);
  };

  const route = (event: MessageEvent) => {
    const message = event.data as TerminalHostMessage | null;
    if (!message || typeof message !== "object") return;
    if (message.t === "changed") return notify(message.project);
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

  // Every message waits on the same connection, so messages leave in the
  // order they were posted, even while the port is still being set up.
  const post = (message: TerminalClientMessage) => {
    void connect()
      .then((ready) => ready.postMessage(message))
      .catch(() => undefined);
  };

  return {
    list: (project) => ipcRenderer.invoke(terminalChannels.list, project),
    spawn: (project, cols, rows, kind = "shell", resume, card) => {
      const args: unknown[] = [project, cols, rows, kind];
      // NOTE: A card goes sixth, behind an explicit `null` resume: main counts
      // its arguments, and a hole would read as a resume of `undefined`.
      if (card !== undefined) args.push(resume ?? null, card);
      else if (resume !== undefined) args.push(resume);
      return ipcRenderer.invoke(terminalChannels.spawn, ...args);
    },
    agentSessions: (project) =>
      ipcRenderer.invoke(terminalChannels.agentSessions, project),
    renameAgentSession: (project, agent, id, name) =>
      ipcRenderer.invoke(
        terminalChannels.agentSessionRename,
        project,
        agent,
        id,
        name,
      ),
    pinAgentSession: (project, agent, id, pinned) =>
      ipcRenderer.invoke(
        terminalChannels.agentSessionPin,
        project,
        agent,
        id,
        pinned,
      ),
    releaseAgentSessionConductor: (project, agent, id) =>
      ipcRenderer.invoke(
        terminalChannels.agentSessionConductor,
        project,
        agent,
        id,
      ),
    deleteAgentSession: (project, agent, id) =>
      ipcRenderer.invoke(
        terminalChannels.agentSessionDelete,
        project,
        agent,
        id,
      ),
    archiveAgentSession: (project, agent, id) =>
      ipcRenderer.invoke(
        terminalChannels.agentSessionArchive,
        project,
        agent,
        id,
      ),
    archivedAgentSessions: (project) =>
      ipcRenderer.invoke(terminalChannels.agentArchivedSessions, project),
    unarchiveAgentSession: (project, agent, id) =>
      ipcRenderer.invoke(
        terminalChannels.agentSessionUnarchive,
        project,
        agent,
        id,
      ),
    deleteArchivedAgentSession: (project, agent, id) =>
      ipcRenderer.invoke(
        terminalChannels.agentArchivedDelete,
        project,
        agent,
        id,
      ),
    agentSubagent: (project, agent, conversation, sub, run = null) =>
      ipcRenderer.invoke(
        terminalChannels.agentSubagent,
        project,
        agent,
        conversation,
        sub,
        run,
      ),
    agentBackgroundTasks: (project, conversation) =>
      ipcRenderer.invoke(
        terminalChannels.agentBackgroundTasks,
        project,
        conversation,
      ),
    agentTaskOutput: (project, conversation, task) =>
      ipcRenderer.invoke(
        terminalChannels.agentTaskOutput,
        project,
        conversation,
        task,
      ),
    agentStopTask: (project, conversation, task) =>
      ipcRenderer.invoke(
        terminalChannels.agentStopTask,
        project,
        conversation,
        task,
      ),
    ports: (project) => ipcRenderer.invoke(terminalChannels.ports, project),
    stopPort: (project, pid, start) =>
      ipcRenderer.invoke(terminalChannels.stopPort, project, pid, start),
    agentFiles: (project, agent, id) =>
      ipcRenderer.invoke(terminalChannels.agentFiles, project, agent, id),
    agentFilesForWorktree: (project) =>
      ipcRenderer.invoke(terminalChannels.agentFilesForWorktree, project),
    onAgentActivity: (listener) =>
      subscribe(terminalChannels.agentActivity, listener),
    codexUsage: (project) =>
      ipcRenderer.invoke(terminalChannels.codexUsage, project),
    refreshClaudeUsage: () =>
      ipcRenderer.invoke(terminalChannels.refreshClaudeUsage),
    refreshCodexUsage: (force) =>
      ipcRenderer.invoke(terminalChannels.refreshCodexUsage, force),
    consumeCodexReset: (creditId) =>
      ipcRenderer.invoke(terminalChannels.consumeCodexReset, creditId),
    agentFacts: (project, agent, id) =>
      ipcRenderer.invoke(terminalChannels.agentFacts, project, agent, id),
    agentUsage: (project) =>
      ipcRenderer.invoke(terminalChannels.agentUsage, project),
    onAgentWritten: (listener) =>
      subscribe(terminalChannels.agentWritten, listener),
    agents: () => ipcRenderer.invoke(terminalChannels.agents),
    kill: (id) => ipcRenderer.invoke(terminalChannels.kill, id),
    reorder: (project, ids) =>
      ipcRenderer.invoke(terminalChannels.reorder, project, ids),
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

/**
 * The projects surface: projects, their boards and their linked folders.
 *
 * Every board call is addressed by the cloud project id, never the slug.
 */
const projects: DesktopProjectsApi = {
  load: () => ipcRenderer.invoke(projectChannels.load),
  // NOTE: The cloud project id, not the slug: every board call is
  // addressed by it.
  select: (id) => ipcRenderer.invoke(projectChannels.select, id),
  icon: (projectId, iconKey) =>
    ipcRenderer.invoke(projectChannels.icon, projectId, iconKey),
  // The NAME a human typed; main derives the slug the service demands. The
  // folders are pick IDS, primary first. Main resolves them to paths it
  // handed out itself, so no path ever travels this way.
  create: (name, folders) =>
    ipcRenderer.invoke(projectChannels.createProject, name, folders ?? []),
  // NOTE: By cloud ID, never the slug. A uuid matches the service's slug
  // shape, so only the service, not anything here, would catch a mix-up.
  rename: (id, name) =>
    ipcRenderer.invoke(projectChannels.renameProject, id, name),
  reorder: (ids) => ipcRenderer.invoke(projectChannels.reorderProjects, ids),
  // NOTE: By ID for the service and by SLUG for this machine, and both must
  // travel. The machine surface deletes by cloud id (it refuses a slug with
  // a 400), while the folder link main drops afterwards is keyed by slug.
  remove: (id, slug) =>
    ipcRenderer.invoke(projectChannels.deleteProject, id, slug),
  syncToCloud: (localId) =>
    ipcRenderer.invoke(projectChannels.syncToCloud, localId),
  onLocalChange: (listener) =>
    subscribe(projectChannels.localChanged, listener),
  board: {
    load: (projectId, query) =>
      ipcRenderer.invoke(projectChannels.board, projectId, query),
    more: (projectId, query, group, cursor) =>
      ipcRenderer.invoke(projectChannels.more, projectId, query, group, cursor),
    stats: (projectId, query) =>
      ipcRenderer.invoke(projectChannels.stats, projectId, query),
    presence: (projectId) =>
      ipcRenderer.invoke(projectChannels.presence, projectId),
    checkpoint: (projectId, cardId) =>
      ipcRenderer.invoke(projectChannels.checkpoint, projectId, cardId),
    card: (projectId, cardId) =>
      ipcRenderer.invoke(projectChannels.card, projectId, cardId),
    lookup: (projectId, taskId) =>
      ipcRenderer.invoke(projectChannels.lookup, projectId, taskId),
    search: (projectId, query) =>
      ipcRenderer.invoke(projectChannels.search, projectId, query),
    update: (projectId, cardId, patch, revision) =>
      ipcRenderer.invoke(
        projectChannels.update,
        projectId,
        cardId,
        patch,
        revision,
      ),
    // NOTE: `placement` is sent as `null` when absent, never omitted. The
    // handler validates on argument COUNT, and the sender check cannot
    // state a rule for a call that sends four arguments one time and five
    // the next.
    move: (projectId, cardId, columnKey, placement) =>
      ipcRenderer.invoke(
        projectChannels.move,
        projectId,
        cardId,
        columnKey,
        placement ?? null,
      ),
    changes: (projectId, since) =>
      ipcRenderer.invoke(projectChannels.changes, projectId, since),
    toggle: (projectId, cardId, key, checked, revision) =>
      ipcRenderer.invoke(
        projectChannels.toggle,
        projectId,
        cardId,
        key,
        checked,
        revision,
      ),
    setChecklist: (projectId, cardId, items, revision) =>
      ipcRenderer.invoke(
        projectChannels.setChecklist,
        projectId,
        cardId,
        items,
        revision,
      ),
    // NOTE: `cursor` is sent as `null` when absent, never omitted, as `move`
    // does with placement: the handler validates on argument COUNT.
    activity: (projectId, cardId, cursor) =>
      ipcRenderer.invoke(
        projectChannels.activity,
        projectId,
        cardId,
        cursor ?? null,
      ),
    comment: (projectId, cardId, body) =>
      ipcRenderer.invoke(projectChannels.comment, projectId, cardId, body),
    editComment: (projectId, cardId, commentId, body) =>
      ipcRenderer.invoke(
        projectChannels.commentEdit,
        projectId,
        cardId,
        commentId,
        body,
      ),
    deleteComment: (projectId, cardId, commentId) =>
      ipcRenderer.invoke(
        projectChannels.commentDelete,
        projectId,
        cardId,
        commentId,
      ),
    subscribe: (projectId, cardId, subscribed) =>
      ipcRenderer.invoke(
        projectChannels.subscribe,
        projectId,
        cardId,
        subscribed,
      ),
    favorite: (projectId, cardId, favorite) =>
      ipcRenderer.invoke(projectChannels.favorite, projectId, cardId, favorite),
    // NOTE: A file REFERENCE (a path or a URL), never bytes or a handle.
    // Main does not open what is named here; the service stores the string.
    attach: (projectId, cardId, file) =>
      ipcRenderer.invoke(projectChannels.attach, projectId, cardId, file),
    detach: (projectId, cardId, attachmentId) =>
      ipcRenderer.invoke(
        projectChannels.detach,
        projectId,
        cardId,
        attachmentId,
      ),
    create: (projectId, draft) =>
      ipcRenderer.invoke(projectChannels.create, projectId, draft),
    archive: (projectId, cardId) =>
      ipcRenderer.invoke(projectChannels.archive, projectId, cardId),
    purge: (projectId, slug) =>
      ipcRenderer.invoke(projectChannels.purge, projectId, slug),
    importPreview: (projectId) =>
      ipcRenderer.invoke(projectChannels.importPreview, projectId),
    importRun: (projectId) =>
      ipcRenderer.invoke(projectChannels.importRun, projectId),
    importSeal: (projectId) =>
      ipcRenderer.invoke(projectChannels.importSeal, projectId),
  },
  // NOTE: Keyed by SLUG, not by the project id: an older service has no
  // id, and that is the very screen this surface serves.
  folder: {
    state: (slug) => ipcRenderer.invoke(projectChannels.folderState, slug),
    choose: () => ipcRenderer.invoke(projectChannels.folderChoose),
    // FE-106: the path is read here, from a File the OS dropped. A script's
    // own `new File(...)` answers "", and is left out.
    drop: (files) =>
      ipcRenderer.invoke(
        projectChannels.folderDrop,
        files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
      ),
    list: (slug) => ipcRenderer.invoke(projectChannels.folderList, slug),
    link: (slug, folders) =>
      ipcRenderer.invoke(projectChannels.folderLink, slug, folders),
    pick: (slug) => ipcRenderer.invoke(projectChannels.folderPick, slug),
    forget: (slug) => ipcRenderer.invoke(projectChannels.folderForget, slug),
    reveal: (slug) => ipcRenderer.invoke(projectChannels.folderReveal, slug),
  },
};

const desktop: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(channels.appInfo),
  setTheme: (source) => ipcRenderer.invoke(channels.setTheme, source),
  onThemeChange: (listener) => subscribe(channels.themeChanged, listener),
  onViewCommand: (listener) => subscribe(channels.viewCommand, listener),
  zoomFactor: () => webFrame.getZoomFactor(),
  auth,
  projects,
  git,
  worktree,
  terminal: createTerminal(),
  conversation,
  dictation,
  notifications,
  handoff,
  readiness,
  harness,
  memory,
  instructions,
  agentSetup,
  agentConfig,
  laneworkMcp,
  orchestration,
  jev,
  leads,
};
contextBridge.exposeInMainWorld("desktop", desktop);
