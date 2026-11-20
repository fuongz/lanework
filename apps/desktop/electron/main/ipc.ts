import {
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  type WebContents,
} from "electron";
import { isTrustedUrl } from "./security";

/**
 * Reject anything that is not our own top-level frame in a real window.
 *
 * Every handler goes through this. Any frame the renderer can create (an
 * iframe, a detached devtools target) can reach a channel, so the sender is
 * the gate. Checking it once here is safer than remembering it per handler.
 *
 * A sender whose frame no longer exists is a ghost, not an impostor: a page
 * torn down mid-quit (Ctrl+C, dev restart) still delivers invokes that were
 * already in flight. Throwing only prints `Error occurred in handler` noise
 * for a renderer that cannot read it, so ghosts resolve to nothing instead —
 * and their handler never runs (FE-127): a sender nobody can check is not
 * one to act for.
 *
 * @returns true for a live, trusted sender; false for a ghost, whose call
 *   the caller answers with nothing.
 * @throws When the sender is a LIVE frame that is not the main frame of
 *   a window on a trusted URL.
 */
export function assertTrustedSender(
  event: IpcMainInvokeEvent,
  devUrl?: string,
): boolean {
  const frame = event.senderFrame;
  if (!frame) return false;
  if (
    frame !== event.sender.mainFrame ||
    !BrowserWindow.fromWebContents(event.sender) ||
    !isTrustedUrl(frame.url, devUrl)
  )
    throw new Error("Untrusted IPC sender");
  return true;
}

/**
 * Register an `invoke` handler whose sender is validated before it runs.
 *
 * `sender` is the window's page that asked, for a handler that answers per
 * window (`conversation.subscribe`).
 */
export function handle<T>(
  channel: string,
  devUrl: string | undefined,
  handler: (args: unknown[], sender: WebContents) => T | Promise<T>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!assertTrustedSender(event, devUrl)) return undefined;
    return handler(args, event.sender);
  });
}

type BroadcastListener = (channel: string, payload: unknown) => void;
const broadcastListeners = new Set<BroadcastListener>();

/**
 * Hear every broadcast in main too, open window or not (FE-136: the
 * attention count follows `orchestration:changed`). Returns the unsubscribe.
 */
export function onBroadcast(listener: BroadcastListener): () => void {
  broadcastListeners.add(listener);
  return () => broadcastListeners.delete(listener);
}

/** The page of every open window: what `broadcast` sends to. */
export function windowContents(): WebContents[] {
  return BrowserWindow.getAllWindows().map((window) => window.webContents);
}

/** Send `payload` to one window's page, unless it is gone. */
export function sendTo(
  contents: WebContents,
  channel: string,
  payload: unknown,
): void {
  if (!contents.isDestroyed()) contents.send(channel, payload);
}

/** Send `payload` to every open window's top frame, and to main's listeners. */
export function broadcast(channel: string, payload: unknown): void {
  for (const contents of windowContents()) sendTo(contents, channel, payload);
  hearInMain(channel, payload);
}

/**
 * Tell main's own listeners ({@link onBroadcast}) of `payload`, as a
 * `broadcast` would, for a sender that picks its windows itself.
 */
export function hearInMain(channel: string, payload: unknown): void {
  for (const listener of broadcastListeners) {
    try {
      listener(channel, payload);
    } catch (error) {
      console.error(`broadcast listener failed on ${channel}`, error);
    }
  }
}
