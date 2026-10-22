import { useEffect } from "react";
import { useTerminal } from "#/stores/terminal";

/**
 * Keeps one project's terminal list current.
 *
 * Re-lists on entering the project, and whenever the host says its list
 * changed (an exit, another window). Cheap before the terminal is ever used:
 * main answers a list with no pty host running with `[]` and starts nothing,
 * and listening for changes opens no port.
 *
 * NOTE: Called by the shell, not the panel. A hidden panel is not mounted,
 * and the bar that stands in for it still has to count this project's
 * terminals, including on a project the window has only just switched to.
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
