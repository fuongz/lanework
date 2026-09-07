import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import { isTrustedUrl } from "./security";

/**
 * Reject anything that is not our own top-level frame in a real window.
 *
 * Every handler goes through this. A channel is reachable by any frame the
 * renderer can create — an iframe, a detached devtools target — so identifying
 * the sender is the gate, and it is cheaper to apply once here than to remember
 * per handler.
 */
export function assertTrustedSender(
  event: IpcMainInvokeEvent,
  devUrl?: string,
): void {
  const frame = event.senderFrame;
  if (
    !frame ||
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
