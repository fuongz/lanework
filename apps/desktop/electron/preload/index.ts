import { contextBridge, ipcRenderer } from "electron";
import { authChannels, type DesktopAuthApi } from "../../shared/auth";
import { channels, type DesktopApi } from "../../shared/desktop";
import { type DesktopGitApi, gitChannels } from "../../shared/git";
import { workspaceChannels } from "../../shared/workspaces";

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
 * The GitHub surface.
 *
 * ⚠️ Nothing here can return the token, and nothing here takes a repository to
 * fetch from. Every read names a PROJECT; main resolves that to the repo it
 * wrote down itself. `linkRepo` is the single exception and it takes the raw
 * string a human typed, which main parses before it becomes part of any URL.
 */
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

const desktop: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(channels.appInfo),
  setTheme: (source) => ipcRenderer.invoke(channels.setTheme, source),
  onThemeChange: (listener) => subscribe(channels.themeChanged, listener),
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
};
contextBridge.exposeInMainWorld("desktop", desktop);
