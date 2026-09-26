import { create } from "zustand";
import type {
  AgentActivity,
  AgentCard,
  AgentSession,
  TerminalAgent,
} from "../../shared/terminal";

/**
 * The agent conversations each workspace's folder has on disk (FE-23), as the
 * rail's Agents group last read them.
 */
interface AgentSessionsState {
  byWorkspace: Record<string, AgentSession[]>;
  /**
   * Whether each conversation's agent is working, by `agent:id`, as the
   * watcher last reported it (FE-25) — newer than the listing's own
   * `working` until the next listing, which clears it.
   */
  live: Record<string, boolean>;
  /** The card each is on, by `agent:id`, as `live` is to `working` (FE-27). */
  cards: Record<string, AgentCard | null>;
  load: (workspace: string) => Promise<void>;
  /** Name it in Lanework; empty goes back to the CLI's title (FE-24). */
  rename: (
    workspace: string,
    session: AgentSession,
    name: string,
  ) => Promise<void>;
  pin: (
    workspace: string,
    session: AgentSession,
    pinned: boolean,
  ) => Promise<void>;
  /** Start listening for transcript writes; returns the stop. */
  watchActivity: () => () => void;
}

/** A conversation's key across both CLIs: ids are only unique per agent. */
export function agentKey(session: {
  agent: TerminalAgent;
  id: string;
}): string {
  return `${session.agent}:${session.id}`;
}

function sameCard(
  a: AgentCard | null | undefined,
  b: AgentCard | null | undefined,
): boolean {
  return a?.boardId === b?.boardId && a?.card === b?.card;
}

/**
 * The conversations of `workspace` working on `card` right now (FE-27): the
 * ones whose latest Lanework MCP call named it, on this board.
 *
 * ⚠️ `card` as the agent typed it may be the task id or the uuid, so both are
 * matched — and only a call that named THIS board: `FE-3` is another card on
 * every other board. Selected with `useShallow`, so a card that no agent is
 * on keeps one empty list and does not redraw.
 */
export function workingOn(
  state: Pick<AgentSessionsState, "byWorkspace" | "live" | "cards">,
  workspace: string,
  card: { id: string; taskId: string | null },
): AgentSession[] {
  const out: AgentSession[] = [];
  for (const session of state.byWorkspace[workspace] ?? []) {
    const key = agentKey(session);
    if (!(state.live[key] ?? session.working)) continue;
    const on = key in state.cards ? state.cards[key] : session.card;
    if (
      on &&
      on.boardId === workspace &&
      (on.card === card.id ||
        (card.taskId !== null &&
          on.card.toUpperCase() === card.taskId.toUpperCase()))
    )
      out.push(session);
  }
  return out;
}

/**
 * A read that started before a later one must not land after it — the rail
 * would flip back to the older list. The same counter idea as the terminal's.
 */
const latest = new Map<string, number>();

/** Unknown ids re-list at most this often: a new conversation, just begun. */
const RELIST_MS = 5_000;
const relisted = new Map<string, number>();

export const useAgentSessions = create<AgentSessionsState>()((set, get) => ({
  byWorkspace: {},
  live: {},
  cards: {},

  rename: async (workspace, session, name) => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const listed = await surface.renameAgentSession(
      workspace,
      session.agent,
      session.id,
      name,
    );
    latest.set(workspace, (latest.get(workspace) ?? 0) + 1);
    set((state) => ({
      byWorkspace: { ...state.byWorkspace, [workspace]: listed },
    }));
  },

  pin: async (workspace, session, pinned) => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const listed = await surface.pinAgentSession(
      workspace,
      session.agent,
      session.id,
      pinned,
    );
    latest.set(workspace, (latest.get(workspace) ?? 0) + 1);
    set((state) => ({
      byWorkspace: { ...state.byWorkspace, [workspace]: listed },
    }));
  },

  watchActivity: () => {
    const surface = window.desktop?.terminal;
    if (!surface) return () => {};
    return surface.onAgentActivity((activity: AgentActivity) => {
      const key = agentKey(activity);
      set((state) =>
        state.live[key] === activity.working &&
        sameCard(state.cards[key], activity.card)
          ? state
          : {
              live: { ...state.live, [key]: activity.working },
              cards: { ...state.cards, [key]: activity.card },
            },
      );
      // ⚠️ A conversation the rail has not listed yet is one that just
      // started: list again — but not on every write of it.
      const known = get().byWorkspace[activity.workspace] ?? [];
      if (known.some((entry) => agentKey(entry) === key)) return;
      const now = Date.now();
      if (now - (relisted.get(activity.workspace) ?? 0) < RELIST_MS) return;
      relisted.set(activity.workspace, now);
      void get().load(activity.workspace);
    });
  },

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
            entry.updatedAt === listed[index]?.updatedAt &&
            entry.pinnedAt === listed[index]?.pinnedAt &&
            entry.working === listed[index]?.working &&
            sameCard(entry.card, listed[index]?.card),
        )
      )
        return;
      // ⚠️ A fresh listing is the truth: what the watcher said about these
      // conversations before it is older, and is dropped.
      set((state) => {
        const live = { ...state.live };
        const cards = { ...state.cards };
        for (const entry of listed) {
          delete live[agentKey(entry)];
          delete cards[agentKey(entry)];
        }
        return {
          byWorkspace: { ...state.byWorkspace, [workspace]: listed },
          live,
          cards,
        };
      });
    } catch {
      // No folder, not signed in, a file mid-write: the group keeps what it
      // showed, or stays hidden (FE-23/D9).
    }
  },
}));
