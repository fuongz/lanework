import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { ipcMessage } from "#/lib/ipc-error";
import { useChatEngines } from "#/stores/chat-engines";
import { notify } from "#/stores/notify";

/**
 * ⌘W (Ctrl+W elsewhere) in a chat: asks, then stops the session, as the
 * rail's Stop does.
 *
 * - While a turn runs: the turn is cut off and the agent behind it ended
 *   (Claude's or Codex's process; OpenCode's session interrupted and its
 *   stream let go).
 * - While the agent is merely alive between turns: it is ended.
 * - Either way the transcript stays; the next message starts it again.
 * - With nothing alive the key does nothing: the menu leaves ⌘W unbound
 *   (`menu.ts`), so the window never closes from it either.
 * - The dialog closes by itself when the agent ends on its own meanwhile.
 *
 * @returns The dialog to draw.
 */
export function useStopShortcut({
  label,
  project,
  id,
  running,
}: {
  /** The agent's name, e.g. "OpenCode". */
  label: string;
  project: string | null;
  id: string;
  /** A turn is in progress. */
  running: boolean;
}) {
  const refreshChats = useChatEngines((state) => state.refresh);
  const alive = useChatEngines((state) =>
    project ? (state.alive[project]?.includes(id) ?? false) : false,
  );
  const live = running || alive;
  const [asking, setAsking] = useState(false);
  /** What the dialog said when it opened, kept while it closes. */
  const [wasRunning, setWasRunning] = useState(false);

  useEffect(() => {
    if (!project) return;
    void refreshChats(project);
  }, [project, refreshChats]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey)
        return;
      if (event.key.toLowerCase() !== "w") return;
      event.preventDefault();
      if (!live) return;
      setWasRunning(running);
      setAsking(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, running]);

  // The agent ended by itself: nothing left to stop.
  useEffect(() => {
    if (!live) setAsking(false);
  }, [live]);

  const stop = () => {
    setAsking(false);
    if (!project) return;
    void window.desktop?.conversation
      .close(project, id)
      .catch((failure: unknown) =>
        notify("error", `Could not stop ${label}`, {
          description: ipcMessage(failure, "Try Stop in the sidebar."),
        }),
      )
      .finally(() => void refreshChats(project));
  };

  return (
    <AlertDialog open={asking} onOpenChange={setAsking}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop this {label} session?</AlertDialogTitle>
          <AlertDialogDescription>
            {wasRunning
              ? `${label} is still working on its reply. Stopping cuts the reply off and ends ${label} for this chat.`
              : `${label} is done replying but still running for this chat. Stopping ends it.`}{" "}
            The conversation stays; your next message starts it again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            // `border-0`: without it the popup shows through as a 1px ring
            // (see account-section's Sign out for why it lives here).
            className="border-0"
            onClick={stop}
          >
            Stop
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
