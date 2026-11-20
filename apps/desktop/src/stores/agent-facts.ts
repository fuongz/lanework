import { create } from "zustand";
import type { AgentFacts, TerminalAgent } from "../../shared/terminal";
import { agentKey } from "./agent-sessions";

/**
 * Each conversation's numbers, as main last read them.
 *
 * Shared by the agent view, which follows its own live, and the rail, which
 * reads one only when its row is hovered (FE-38/D5).
 */
interface AgentFactsState {
  /** By `agent:id`, with when they were read (epoch ms). */
  byKey: Record<string, { facts: AgentFacts; at: number }>;
  /**
   * Read one conversation's numbers again.
   *
   * A read that fails keeps the last one.
   */
  read: (
    project: string,
    session: { agent: TerminalAgent; id: string },
  ) => void;
}

/**
 * The conversations with a read in flight.
 *
 * NOTE: One read in flight per conversation, and at most one queued behind
 * it (`again`). A turn writes many times a second, and a read that started
 * first must not land after a later one.
 */
const reading = new Set<string>();
const again = new Set<string>();

export const useAgentFacts = create<AgentFactsState>()((set, get) => ({
  byKey: {},

  read: (project, session) => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const key = agentKey(session);
    if (reading.has(key)) {
      again.add(key);
      return;
    }
    reading.add(key);
    void surface
      .agentFacts(project, session.agent, session.id)
      .then((facts) =>
        set((state) => {
          // NOTE: A write that changed none of the numbers (a tool call, a
          // user line) answers with equal facts. The old object is kept, so
          // the views that select it do not redraw; only `at` moves on.
          const known = state.byKey[key]?.facts;
          const same =
            known !== undefined &&
            JSON.stringify(known) === JSON.stringify(facts);
          return {
            byKey: {
              ...state.byKey,
              [key]: { facts: same ? known : facts, at: Date.now() },
            },
          };
        }),
      )
      .catch(() => undefined)
      .finally(() => {
        reading.delete(key);
        if (again.delete(key)) get().read(project, session);
      });
  },
}));
