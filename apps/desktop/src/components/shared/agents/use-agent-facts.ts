import { useEffect } from "react";
import type { AgentFacts, TerminalAgent } from "#/../shared/terminal";
import { useAgentFacts } from "#/stores/agent-facts";
import { agentKey } from "#/stores/agent-sessions";

/**
 * One conversation's numbers, as main last read them.
 *
 * Read when the view opens on it, then again each time its transcript settles
 * a write. Never on a timer: a conversation nobody is in is never written, so
 * it is read once.
 */
export function useConversationFacts(
  project: string | null,
  agent: TerminalAgent | null,
  id: string | null,
): AgentFacts | null {
  const facts = useAgentFacts((state) =>
    agent && id ? state.byKey[agentKey({ agent, id })]?.facts : undefined,
  );
  const read = useAgentFacts((state) => state.read);

  useEffect(() => {
    const surface = window.desktop?.terminal;
    if (!project || !agent || !id || !surface) return;
    read(project, { agent, id });
    return surface.onAgentWritten((write) => {
      if (write.project === project && write.agent === agent && write.id === id)
        read(project, { agent, id });
    });
  }, [read, project, agent, id]);

  return facts ?? null;
}
