import { contextBridge, ipcRenderer } from "electron";
import { authChannels, type DesktopAuthApi } from "../../shared/auth";
import { channels, type DesktopApi } from "../../shared/desktop";
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

const desktop: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(channels.appInfo),
  setTheme: (source) => ipcRenderer.invoke(channels.setTheme, source),
  onThemeChange: (listener) => subscribe(channels.themeChanged, listener),
  auth,
  workspaces: {
    load: () => ipcRenderer.invoke(workspaceChannels.load),
    // ⚠️ The cloud workspace id, not the slug: every board call is addressed by
    // it, and a slug is a display key a rename can move.
    select: (id) => ipcRenderer.invoke(workspaceChannels.select, id),
    // The NAME a human typed; main derives the slug the service demands.
    create: (name) =>
      ipcRenderer.invoke(workspaceChannels.createWorkspace, name),
    board: {
      load: (workspaceId) =>
        ipcRenderer.invoke(workspaceChannels.board, workspaceId),
      move: (workspaceId, cardId, columnKey) =>
        ipcRenderer.invoke(
          workspaceChannels.move,
          workspaceId,
          cardId,
          columnKey,
        ),
      toggle: (workspaceId, cardId, key, checked, revision) =>
        ipcRenderer.invoke(
          workspaceChannels.toggle,
          workspaceId,
          cardId,
          key,
          checked,
          revision,
        ),
      create: (workspaceId, title) =>
        ipcRenderer.invoke(workspaceChannels.create, workspaceId, title),
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
      pick: (slug) => ipcRenderer.invoke(workspaceChannels.folderPick, slug),
      forget: (slug) =>
        ipcRenderer.invoke(workspaceChannels.folderForget, slug),
      reveal: (slug) =>
        ipcRenderer.invoke(workspaceChannels.folderReveal, slug),
    },
  },
};
contextBridge.exposeInMainWorld("desktop", desktop);
