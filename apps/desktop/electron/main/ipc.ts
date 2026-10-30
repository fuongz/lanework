import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
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
 * for a renderer that cannot read it, so ghosts resolve to nothing instead.
 *
 * @throws When the sender is a LIVE frame that is not the main frame of
 *   a window on a trusted URL.
 */
export function assertTrustedSender(
  event: IpcMainInvokeEvent,
  devUrl?: string,
): void {
  const frame = event.senderFrame;
  if (!frame) return;
  if (
    frame !== event.sender.mainFrame ||
    !BrowserWindow.fromWebContents(event.sender) ||
    !isTrustedUrl(frame.url, devUrl)
  )
    throw new Error("Untrusted IPC sender");
}

/** Register an `invoke` handler whose sender is validated before it runs. */
export function handle<T>(
  channel: string,
  devUrl: string | undefined,
  handler: (args: unknown[]) => T | Promise<T>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertTrustedSender(event, devUrl);
    return handler(args);
  });
}

/** Send `payload` to every open window's top frame. */
export function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send(channel, payload);
}
