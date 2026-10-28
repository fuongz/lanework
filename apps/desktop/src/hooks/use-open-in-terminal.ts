import { useNavigate } from "@tanstack/react-router";
import type { AgentSession } from "#/../shared/terminal";
import { ipcMessage } from "#/lib/ipc-error";
import { useAgentTerminals } from "#/stores/agent-terminals";

/**
 * Hand a conversation to a terminal (D3), from the rail's menu: the chat
 * lets it go, then the agent that resumes it opens in the main view. One
 * already running it is reused.
 *
 * Off while a turn runs (the caller's to check): one writer at a time.
 *
 * @returns Why it could not, or null when the terminal is on screen.
 */
export function useOpenInTerminal(slug: string, workspace: string) {
  const navigate = useNavigate();
  const resume = useAgentTerminals((state) => state.resume);
  return async (session: AgentSession): Promise<string | null> => {
    try {
      await window.desktop?.conversation.release(workspace, session.id);
      const next = await resume(workspace, session);
      if (!next) return "Could not open a terminal.";
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug, terminalId: next.id },
      });
      return null;
    } catch (caught) {
      return ipcMessage(caught, "Could not open a terminal.");
    }
  };
}
