import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import { desktopSurface } from "#/server/desktop";
import type {
  AgentSession,
  CardBrief,
  TerminalAgent,
  TerminalSession,
} from "../../shared/terminal";

/**
 * The agents running for each project, shown in the main view.
 *
 * Separate from `useTerminal` (FE-26): the panel's tabs are shells, these are
 * Claude and Codex. Both live in the one pty host, since an agent is still a
 * shell with a CLI typed into it. But they are listed, chosen and limited
 * apart, so opening one never moves the other.
 */

/**
 * Whether an agent ended rather than failed: `/exit`, or ⌃C twice.
 *
 * These close the session outright: nobody asked to be left looking at a
 * finished agent. Any other code is a CLI that could not start or crashed,
 * and stays on screen to say why.
 *
 * @param code The CLI's exit code.
 */
function endedCleanly(code: number): boolean {
  return code === 0 || code === 130;
}

/**
 * Request tickets, by workspace.
 *
 * A list read that started before a start or a stop must not land after it.
 */
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
   * The agent resuming `conversation`, started if it is not running.
   *
   * A live one is reused; an exited one is a transcript and is not
   * (FE-23/D6).
   *
   * @returns Its terminal, or null when it could not start.
   */
  resume: (
    workspace: string,
    conversation: AgentSession,
  ) => Promise<TerminalSession | null>;
  /**
   * The live tab running `conversation`, read fresh; never starts one.
   *
   * @returns Its terminal, or null when no tab runs it.
   */
  liveTab: (
    workspace: string,
    conversation: AgentSession,
  ) => Promise<TerminalSession | null>;
  /**
   * Start a new conversation with `agent` (FE-26/D3).
   *
   * @param card When given, the host briefs the agent on it in its first
   * prompt.
   * @returns Its terminal, or null when it could not start.
   */
  start: (
    workspace: string,
    agent: TerminalAgent,
    card?: CardBrief,
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
    card?: CardBrief,
  ): Promise<TerminalSession | null> {
    if (get().starting) return null;
    set({ starting: true, error: null });
    try {
      // A first guess at the size; the view's attach sets the real one.
      const session = await desktopSurface("terminal").spawn(
        workspace,
        120,
        36,
        agent,
        resume,
        card,
      );
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
        const all = (await desktopSurface("terminal").list(workspace)).filter(
          (session) => session.kind !== "shell",
        );
        if ((revision.get(workspace) ?? 0) !== mine) return;
        // Ended cleanly while nobody was looking: close them now, so they
        // neither linger on the rail nor hold one of the eight places.
        const ended = all.filter(
          (session) => session.exit && endedCleanly(session.exit.code),
        );
        for (const session of ended)
          void desktopSurface("terminal")
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

    resume: async (workspace, conversation) =>
      (await get().liveTab(workspace, conversation)) ??
      spawn(workspace, conversation.agent, conversation.id),

    liveTab: async (workspace, conversation) => {
      await get().refresh(workspace);
      return (
        (get().sessions[workspace] ?? []).find(
          (entry) =>
            entry.resume === conversation.id &&
            entry.kind === conversation.agent &&
            !entry.exit,
        ) ?? null
      );
    },

    start: (workspace, agent, card) => spawn(workspace, agent, undefined, card),

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
        await desktopSurface("terminal").kill(id);
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
