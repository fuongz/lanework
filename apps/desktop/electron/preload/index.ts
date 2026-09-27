import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import { authChannels, type DesktopAuthApi } from "../../shared/auth";
import { channels, type DesktopApi } from "../../shared/desktop";
import { type DesktopGitApi, gitChannels } from "../../shared/git";
import { type DesktopHandoffApi, handoffChannels } from "../../shared/handoff";
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
  fetch: (slug) => ipcRenderer.invoke(worktreeChannels.fetch, slug),
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
    spawn: (workspace, cols, rows, kind = "shell", resume) =>
      resume === undefined
        ? ipcRenderer.invoke(
            terminalChannels.spawn,
            workspace,
            cols,
            rows,
            kind,
          )
        : ipcRenderer.invoke(
            terminalChannels.spawn,
            workspace,
            cols,
            rows,
            kind,
            resume,
          ),
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
    onAgentActivity: (listener) =>
      subscribe(terminalChannels.agentActivity, listener),
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
    onCommand: (listener) =>
      subscribe<TerminalCommand>(terminalChannels.command, listener),
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
    // ⚠️ By ID for the service and by SLUG for this machine, and both have to
    // travel: the machine surface deletes by cloud id — it refuses a slug with a
    // 400 — while the folder link main has to drop afterwards is keyed by slug.
    remove: (id, slug) =>
      ipcRenderer.invoke(workspaceChannels.deleteWorkspace, id, slug),
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
  handoff,
};
contextBridge.exposeInMainWorld("desktop", desktop);
