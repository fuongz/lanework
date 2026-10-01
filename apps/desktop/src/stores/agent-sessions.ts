import { create } from "zustand";
import type {
  AgentActivity,
  AgentCard,
  AgentSession,
  AgentSubagent,
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
   * `working` until the next listing, which clears it. A sub-agent's is
   * under `subagentKey` (FE-33).
   */
  live: Record<string, boolean>;
  /**
   * Whether each conversation's sub-agents are shown, by `agent:id`, as
   * somebody last chose (FE-33/D2). Unset follows them: open while one is
   * working. Kept for the app's run, never on disk.
   */
  open: Record<string, boolean>;
  setOpen: (session: AgentSession, open: boolean) => void;
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

/** A sub-agent's key: its conversation's, then its own id (FE-33). */
export function subagentKey(
  session: { agent: TerminalAgent; id: string },
  subagent: { id: string },
): string {
  return `${agentKey(session)}/${subagent.id}`;
}

function sameSubagents(a: AgentSubagent[], b: AgentSubagent[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, index) =>
        entry.id === b[index]?.id &&
        entry.title === b[index]?.title &&
        entry.updatedAt === b[index]?.updatedAt &&
        entry.working === b[index]?.working,
    )
  );
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

/**
 * Unknown ids re-list at most this often: a new conversation, just begun.
 *
 * ⚠️ One inside the window is put off to its end, never dropped (FE-31): a
 * second agent started within it — or a first whose transcript had no title
 * yet at the first read — was otherwise never listed until the window lost
 * and regained focus.
 */
const RELIST_MS = 2_000;
const relisted = new Map<string, number>();
const relistLater = new Map<string, ReturnType<typeof setTimeout>>();

export const useAgentSessions = create<AgentSessionsState>()((set, get) => ({
  byWorkspace: {},
  live: {},
  cards: {},
  open: {},

  setOpen: (session, open) =>
    set((state) => ({ open: { ...state.open, [agentKey(session)]: open } })),

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
    /** List `workspace` again — but not on every write that asks (FE-31). */
    const relistSoon = (workspace: string) => {
      const relist = () => {
        relistLater.delete(workspace);
        relisted.set(workspace, Date.now());
        void get().load(workspace);
      };
      const wait = RELIST_MS - (Date.now() - (relisted.get(workspace) ?? 0));
      if (wait <= 0) relist();
      else if (!relistLater.has(workspace))
        relistLater.set(workspace, setTimeout(relist, wait));
    };
    return surface.onAgentActivity((activity: AgentActivity) => {
      const known = get().byWorkspace[activity.workspace] ?? [];
      const parent = known.find(
        (entry) => agentKey(entry) === agentKey(activity),
      );
      if (activity.subagent) {
        const key = subagentKey(activity, { id: activity.subagent });
        set((state) =>
          state.live[key] === activity.working
            ? state
            : { live: { ...state.live, [key]: activity.working } },
        );
        // ⚠️ A sub-agent the rail has not listed is one just spawned (FE-33):
        // list again, the way a new conversation is.
        if (!parent?.subagents.some((entry) => entry.id === activity.subagent))
          relistSoon(activity.workspace);
        return;
      }
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
      if (!parent) relistSoon(activity.workspace);
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
            sameCard(entry.card, listed[index]?.card) &&
            sameSubagents(entry.subagents, listed[index]?.subagents ?? []),
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
          for (const sub of entry.subagents)
            delete live[subagentKey(entry, sub)];
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
