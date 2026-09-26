import { create } from "zustand";
import type { AgentSession } from "../../shared/terminal";

/**
 * The agent conversations each workspace's folder has on disk (FE-23), as the
 * rail's Agents group last read them.
 */
interface AgentSessionsState {
  byWorkspace: Record<string, AgentSession[]>;
  load: (workspace: string) => Promise<void>;
}

/**
 * A read that started before a later one must not land after it — the rail
 * would flip back to the older list. The same counter idea as the terminal's.
 */
const latest = new Map<string, number>();

export const useAgentSessions = create<AgentSessionsState>()((set, get) => ({
  byWorkspace: {},

  load: async (workspace) => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const mine = (latest.get(workspace) ?? 0) + 1;
    latest.set(workspace, mine);
    try {
      const listed = await surface.agentSessions(workspace);
      if (latest.get(workspace) !== mine) return;
      const previous = get().byWorkspace[workspace];
      // Unchanged: keep the old array, so the rail does not redraw.
      if (
        previous &&
        previous.length === listed.length &&
        previous.every(
          (entry, index) =>
            entry.id === listed[index]?.id &&
            entry.title === listed[index]?.title &&
            entry.updatedAt === listed[index]?.updatedAt,
        )
      )
        return;
      set((state) => ({
        byWorkspace: { ...state.byWorkspace, [workspace]: listed },
      }));
    } catch {
      // No folder, not signed in, a file mid-write: the group keeps what it
      // showed, or stays hidden (FE-23/D9).
    }
  },
}));
