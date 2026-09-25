import { useEffect } from "react";
import { useTerminal } from "#/stores/terminal";

/**
 * Keep one project's terminal list current: re-list on entering it, and
 * whenever the host says its list changed (an exit, another window).
 *
 * ⚠️ Called by the SHELL, not the panel. Hidden, the panel is not mounted, and
 * the bar that stands in for it still has to count this project's terminals —
 * including on a project the window has only just switched to.
 *
 * ⚠️ Cheap before the terminal is ever used: a list with no pty host running
 * is answered by main with `[]` and starts nothing, and listening for changes
 * opens no port.
 */
export function useTerminalSessions(workspace: string | null) {
  const refresh = useTerminal((state) => state.refresh);
  useEffect(() => {
    if (!workspace) return;
    void refresh(workspace);
    return window.desktop?.terminal.onChange((changed) => {
      if (changed === workspace || changed === "*") void refresh(workspace);
    });
  }, [workspace, refresh]);
}
