import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { TeamLead } from "#/../shared/orchestration";
import type { AgentSession } from "#/../shared/terminal";
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
import { useAgentSessions } from "#/stores/agent-sessions";
import { useChatEngines } from "#/stores/chat-engines";
import { notify } from "#/stores/notify";

/**
 * The composer's `/clear`: a confirm, then the conversation starts over.
 *
 * - A conductor's conversation is reset, as its rail row's Reset
 *   conversation does: this one moves under Sessions and the conductor
 *   starts a fresh one on the next message.
 * - Any other session ends: its agent stops, the transcript stays under
 *   Sessions, and the new-session page opens in its place.
 *
 * Either way the agent behind it is stopped first, so a conversation left
 * behind does not keep a process alive.
 *
 * @returns `onClear` for the composer, and the dialog to draw.
 */
export function useClearConversation({
  slug,
  project,
  id,
  conductor,
  session,
  running,
}: {
  slug: string;
  project: string | null;
  id: string;
  /** The conductor whose conversation this is, if it is one. */
  conductor: TeamLead | null;
  /** This conversation as the rail lists it, once listed. */
  session: AgentSession | undefined;
  /** A turn is in progress, and clearing would cut it off. */
  running: boolean;
}) {
  const navigate = useNavigate();
  const releaseConductor = useAgentSessions((state) => state.releaseConductor);
  const refreshChats = useChatEngines((state) => state.refresh);
  const [asking, setAsking] = useState(false);

  const clear = async () => {
    if (!project) return;
    try {
      await window.desktop?.conversation
        .close(project, id)
        .catch(() => {})
        .finally(() => void refreshChats(project));
      if (conductor) {
        if (!session) throw new Error("This conversation is not listed yet.");
        await releaseConductor(project, session);
        void navigate({
          to: "/w/$slug/conductors/$lead",
          params: { slug, lead: conductor.id },
        });
      } else
        void navigate({ to: "/w/$slug/agents/chat/new", params: { slug } });
    } catch (failure) {
      notify("error", "Could not clear the conversation", {
        description: ipcMessage(failure, "Try Reset conversation instead."),
      });
    }
  };

  const dialog = (
    <AlertDialog open={asking} onOpenChange={setAsking}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {conductor
              ? `Start ${conductor.name} over?`
              : "End this session and start a new one?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {conductor
              ? `This conversation moves under Sessions, where you can still open it. ${conductor.name} starts fresh on your next message.`
              : "Its agent stops and the conversation stays under Sessions. A new session opens in its place."}
            {running && " The turn in progress is cut off."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={running ? "destructive" : "default"}
            className={running ? "border-0" : undefined}
            onClick={() => {
              setAsking(false);
              void clear();
            }}
          >
            {conductor ? "Clear conversation" : "Start new session"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { onClear: () => setAsking(true), dialog };
}
