import { create } from "zustand";
import type { AgentFacts, TerminalAgent } from "../../shared/terminal";
import { agentKey } from "./agent-sessions";

/**
 * Each conversation's numbers (FE-38), as main last read them: shared by the
 * agent view, which follows its own live, and the rail, which reads one only
 * when its row is hovered (FE-38/D5).
 */
interface AgentFactsState {
  /** By `agent:id`, with when they were read (epoch ms). */
  byKey: Record<string, { facts: AgentFacts; at: number }>;
  /** Read one conversation's again. A read that fails keeps the last one. */
  read: (
    workspace: string,
    session: { agent: TerminalAgent; id: string },
  ) => void;
}

/**
 * ⚠️ One read in flight per conversation, and at most one queued behind it:
 * a turn writes many times a second, and a read that started first must not
 * land after a later one.
 */
const reading = new Set<string>();
const again = new Set<string>();

export const useAgentFacts = create<AgentFactsState>()((set, get) => ({
  byKey: {},

  read: (workspace, session) => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const key = agentKey(session);
    if (reading.has(key)) {
      again.add(key);
      return;
    }
    reading.add(key);
    void surface
      .agentFacts(workspace, session.agent, session.id)
      .then((facts) =>
        set((state) => ({
          byKey: { ...state.byKey, [key]: { facts, at: Date.now() } },
        })),
      )
      .catch(() => undefined)
      .finally(() => {
        reading.delete(key);
        if (again.delete(key)) get().read(workspace, session);
      });
  },
}));
