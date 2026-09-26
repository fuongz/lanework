import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import type {
  AgentSession,
  TerminalAgent,
  TerminalSession,
} from "../../shared/terminal";

/**
 * The agents running for each project, shown in the MAIN view (FE-26).
 *
 * ⚠️ Separate from `useTerminal` on purpose (FE-26): the panel's tabs are
 * shells, these are Claude and Codex. Both live in the one pty host — an
 * agent is still a shell with a CLI typed into it — but they are listed,
 * chosen and limited apart, so opening one never moves the other.
 */

const api = () => {
  const surface = window.desktop?.terminal;
  if (!surface)
    throw new Error("This window is not connected to the desktop app.");
  return surface;
};

/**
 * An agent that ENDED rather than failed: `/exit`, or ⌃C twice (FE-26).
 *
 * ⚠️ These close the session outright — it is an agent, not a terminal, and
 * nobody asked to be left looking at a finished one. Any other code is a CLI
 * that could not start or crashed, and stays on screen to say why.
 */
export function endedCleanly(code: number): boolean {
  return code === 0 || code === 130;
}

/** A list read that started before a start or a stop must not land after it. */
const revision = new Map<string, number>();
const bump = (workspace: string) =>
  revision.set(workspace, (revision.get(workspace) ?? 0) + 1);

interface AgentTerminalsState {
  /** Each workspace's running agents, as the host last listed them. */
  sessions: Record<string, TerminalSession[]>;
  starting: boolean;
  error: string | null;
  refresh: (workspace: string) => Promise<void>;
  /**
   * The agent resuming `conversation`, started if it is not running (FE-23/D6:
   * a live one is reused, an exited one is a transcript and is not).
   * Answers its terminal, or null when it could not start.
   */
  resume: (
    workspace: string,
    conversation: AgentSession,
  ) => Promise<TerminalSession | null>;
  /** A new conversation with `agent` (FE-26/D3). */
  start: (
    workspace: string,
    agent: TerminalAgent,
  ) => Promise<TerminalSession | null>;
  stop: (workspace: string, id: string) => Promise<void>;
  markExited: (workspace: string, id: string, code: number) => void;
  clearError: () => void;
}

export const useAgentTerminals = create<AgentTerminalsState>()((set, get) => {
  async function spawn(
    workspace: string,
    agent: TerminalAgent,
    resume?: string,
  ): Promise<TerminalSession | null> {
    if (get().starting) return null;
    set({ starting: true, error: null });
    try {
      // A first guess at the size; the view's attach sets the real one.
      const session = await api().spawn(workspace, 120, 36, agent, resume);
      bump(workspace);
      set((state) => ({
        sessions: {
          ...state.sessions,
          [workspace]: [
            ...(state.sessions[workspace] ?? []).filter(
              (entry) => entry.id !== session.id,
            ),
            session,
          ],
        },
      }));
      return session;
    } catch (error) {
      set({ error: ipcMessage(error, `Could not start ${agent}.`) });
      return null;
    } finally {
      set({ starting: false });
    }
  }

  return {
    sessions: {},
    starting: false,
    error: null,

    refresh: async (workspace) => {
      const mine = revision.get(workspace) ?? 0;
      try {
        const all = (await api().list(workspace)).filter(
          (session) => session.kind !== "shell",
        );
        if ((revision.get(workspace) ?? 0) !== mine) return;
        // Ended cleanly while nobody was looking: close them now, so they
        // neither linger on the rail nor hold one of the eight places.
        const ended = all.filter(
          (session) => session.exit && endedCleanly(session.exit.code),
        );
        for (const session of ended)
          void api()
            .kill(session.id)
            .catch(() => {});
        const listed = all.filter((session) => !ended.includes(session));
        set((state) => ({
          sessions: { ...state.sessions, [workspace]: listed },
        }));
      } catch (error) {
        set({
          error: ipcMessage(error, "Could not list this project's agents."),
        });
      }
    },

    resume: async (workspace, conversation) => {
      await get().refresh(workspace);
      const live = (get().sessions[workspace] ?? []).find(
        (entry) => entry.resume === conversation.id && !entry.exit,
      );
      return live ?? spawn(workspace, conversation.agent, conversation.id);
    },

    start: (workspace, agent) => spawn(workspace, agent),

    stop: async (workspace, id) => {
      bump(workspace);
      set((state) => ({
        sessions: {
          ...state.sessions,
          [workspace]: (state.sessions[workspace] ?? []).filter(
            (entry) => entry.id !== id,
          ),
        },
      }));
      try {
        await api().kill(id);
      } catch (error) {
        set({ error: ipcMessage(error, "Could not stop that agent.") });
      }
    },

    markExited: (workspace, id, code) => {
      if (endedCleanly(code)) {
        void get().stop(workspace, id);
        return;
      }
      set((state) => ({
        sessions: {
          ...state.sessions,
          [workspace]: (state.sessions[workspace] ?? []).map((entry) =>
            entry.id === id && !entry.exit
              ? { ...entry, exit: { code, signal: null } }
              : entry,
          ),
        },
      }));
    },

    clearError: () => set({ error: null }),
  };
});
