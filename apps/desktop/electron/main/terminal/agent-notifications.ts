import { BrowserWindow, Notification } from "electron";
import type { TerminalAgent } from "../../../shared/terminal";

// Keep delivered notifications alive so their click listeners survive GC.
const active = new Set<Notification>();

export function notifyAgentCompleted(
  agent: TerminalAgent,
  project: string,
): void {
  if (!Notification.isSupported()) return;
  try {
    const notification = new Notification({
      title: `${agent === "claude" ? "Claude" : "Codex"} finished`,
      body: `Run completed in ${project}.`,
      // One sound, owned by the OS (and subject to its notification settings).
      silent: false,
    });
    active.add(notification);
    // OSes do not always emit close; bound retained native objects.
    if (active.size > 64) {
      const oldest = active.values().next().value;
      if (oldest) {
        oldest.close();
        active.delete(oldest);
      }
    }
    const release = () => active.delete(notification);
    notification.once("close", release);
    notification.once("failed", release);
    notification.once("click", () => {
      release();
      const window =
        BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    notification.show();
  } catch {
    // An unsupported/denied native notification must not break agent tracking.
  }
}
