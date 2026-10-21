import { create } from "zustand";
import { forgetDraft } from "#/lib/conversation-draft";
import type {
  AgentActivity,
  AgentCard,
  AgentSession,
  AgentSubagent,
  ClaudeUsage,
  CodexGoal,
  CodexQuota,
  CodexResetOutcome,
  TerminalAgent,
} from "../../shared/terminal";

/**
 * The agent conversations each workspace's folder has on disk.
 *
 * As the rail's Agents group last read them.
 */
interface AgentSessionsState {
  byWorkspace: Record<string, AgentSession[]>;
  /**
   * Whether each conversation's agent is working, by `agent:id`.
   *
   * As the watcher last reported it: newer than the listing's own `working`
   * until the next listing, which clears it. A sub-agent's is under
   * {@link subagentKey}.
   */
  live: Record<string, boolean>;
  /**
   * Whether each conversation's sub-agents are shown, by `agent:id`.
   *
   * As somebody last chose (FE-33/D2). Unset follows them: open while one is
   * working. Kept for the app's run, never on disk.
   */
  open: Record<string, boolean>;
  setOpen: (session: AgentSession, open: boolean) => void;
  /** The card each is on, by `agent:id`, as `live` is to `working`. */
  cards: Record<string, AgentCard | null>;
  load: (workspace: string) => Promise<void>;
  /**
   * Name a conversation in Lanework.
   *
   * @param name Empty goes back to the CLI's title.
   */
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
  /**
   * Delete a conversation's transcript for good.
   *
   * @throws What main refused, when it did.
   */
  remove: (workspace: string, session: AgentSession) => Promise<void>;
  /**
   * Archive it in its CLI's own archive; it leaves the rail.
   *
   * @throws what main refused, e.g. a conversation a tab is running.
   */
  archive: (workspace: string, session: AgentSession) => Promise<void>;
  /**
   * Start listening for transcript writes.
   *
   * @returns The stop.
   */
  watchActivity: () => () => void;
  /**
   * The Codex account's usage, as its newest turn on this machine reported it.
   *
   * It is the account's, so one for every project (FE-41/D1). Null until
   * read, or when no turn ever reported one.
   */
  codexQuota: CodexQuota | null;
  /**
   * The Claude account's usage.
   *
   * From the listings' usage read or from `refreshClaudeUsage`, whichever
   * answered last. Null until read, or when main has nothing to show.
   */
  claudeUsage: ClaudeUsage | null;
  /** A `refreshClaudeUsage` is in flight: the strip's ⟳ spins. */
  claudeRefreshing: boolean;
  /**
   * Fetch Claude's usage now, past main's cache.
   *
   * Concurrent calls share one request. Never throws: a refused call keeps
   * what was shown.
   */
  refreshClaudeUsage: () => Promise<void>;
  /** Each workspace's Codex conversations' goals, by thread id (FE-41/D4). */
  codexGoals: Record<string, Record<string, CodexGoal>>;
  /** Read the usage and goals again, for `workspace`'s conversations. */
  loadCodexUsage: (workspace: string) => Promise<void>;
  /**
   * Ask Codex itself for the account's limits and banked resets, then read
   * them (FE-74). `force` asks even when the last answer is under a minute
   * old — ⟳; the popover opening does not. Never throws.
   */
  refreshCodexUsage: (workspace: string, force: boolean) => Promise<void>;
  /**
   * Spend the banked reset `creditId`, then read the usage again (FE-74).
   * ⚠️ Not undoable: only on the user's confirmed click. Rejects with
   * Codex's message when it fails.
   */
  consumeCodexReset: (
    workspace: string,
    creditId: string,
  ) => Promise<CodexResetOutcome>;
}

/**
 * A conversation's key across both CLIs.
 *
 * Ids are only unique per agent.
 */
export function agentKey(session: {
  agent: TerminalAgent;
  id: string;
}): string {
  return `${session.agent}:${session.id}`;
}

/** A sub-agent's key: its conversation's {@link agentKey}, then its own id. */
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
 * The conversations of `workspace` working on `card` right now.
 *
 * The ones whose latest Lanework MCP call named it, on this board.
 *
 * NOTE: The agent may have typed the task id or the uuid, so both match. Only
 * a call that named this board counts: `FE-3` is another card on every other
 * board. Selected with `useShallow`, so a card no agent is on keeps one empty
 * list and does not redraw.
 *
 * @param workspace The cloud workspace id, which is also the board's.
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
 * Request tickets for listings, by workspace.
 *
 * A read that started before a later one must not land after it, or the rail
 * would flip back to the older list. The same counter as the terminal's.
 */
const latest = new Map<string, number>();

/**
 * How often unknown ids re-list at most: a new conversation, just begun.
 *
 * NOTE: One inside the window is put off to its end, never dropped (FE-31).
 * Otherwise a second agent started within it, or a first whose transcript had
 * no title yet at the first read, is not listed until the window loses and
 * regains focus.
 */
const RELIST_MS = 2_000;
const relisted = new Map<string, number>();
const relistLater = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How often the usage is read again after turns write, at most.
 *
 * A turn opens and closes once, but a spawned thread reports every settled
 * write. One inside the window is put off to its end, as a relist is.
 */
const USAGE_MS = 2_000;
const usageRead = new Map<string, number>();
const usageLater = new Map<string, ReturnType<typeof setTimeout>>();
/** As {@link latest}, for the usage reads. */
const usageLatest = new Map<string, number>();

/** The `refreshClaudeUsage` in flight, so a second click joins it. */
let claudeRefresh: Promise<void> | null = null;
/**
 * Bumped by every refresh answer.
 *
 * A usage read that started before it is older than what the refresh
 * brought, and leaves Claude's part alone.
 */
let claudeAnswers = 0;

/**
 * Whether `next` comes from an older fetch than `shown`.
 *
 * `fetchedAt` is when main last tried, so a usage read must not undo a newer
 * refresh. An answer without one counts as the oldest.
 */
const olderAttempt = (next: ClaudeUsage | null, shown: ClaudeUsage | null) =>
  (next?.fetchedAt ?? 0) < (shown?.fetchedAt ?? 0);

/**
 * Whether two serializable answers say the same, so the rail need not redraw.
 */
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export const useAgentSessions = create<AgentSessionsState>()((set, get) => ({
  byWorkspace: {},
  live: {},
  cards: {},
  open: {},
  codexQuota: null,
  claudeUsage: null,
  claudeRefreshing: false,
  codexGoals: {},

  refreshClaudeUsage: () => {
    const surface = window.desktop?.terminal;
    if (!surface?.refreshClaudeUsage) return Promise.resolve();
    if (claudeRefresh) return claudeRefresh;
    set({ claudeRefreshing: true });
    claudeRefresh = (async () => {
      try {
        const usage = await surface.refreshClaudeUsage();
        claudeAnswers += 1;
        set((state) =>
          sameJson(state.claudeUsage, usage) ? {} : { claudeUsage: usage },
        );
      } catch {
        // Main answers a failure as `error` on the last known values; a
        // refused call (no handler yet, a closing window) keeps what was shown.
      } finally {
        claudeRefresh = null;
        set({ claudeRefreshing: false });
      }
    })();
    return claudeRefresh;
  },

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

  archive: async (workspace, session) => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const listed = await surface.archiveAgentSession(
      workspace,
      session.agent,
      session.id,
    );
    latest.set(workspace, (latest.get(workspace) ?? 0) + 1);
    set((state) => ({
      byWorkspace: { ...state.byWorkspace, [workspace]: listed },
    }));
  },

  remove: async (workspace, session) => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const listed = await surface.deleteAgentSession(
      workspace,
      session.agent,
      session.id,
    );
    forgetDraft(session.id);
    latest.set(workspace, (latest.get(workspace) ?? 0) + 1);
    set((state) => ({
      byWorkspace: { ...state.byWorkspace, [workspace]: listed },
    }));
  },

  watchActivity: () => {
    const surface = window.desktop?.terminal;
    if (!surface) return () => {};
    /** List `workspace` again, but not on every write that asks. */
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
    /** Read the usage again, but not on every write that asks. */
    const usageSoon = (workspace: string) => {
      const read = () => {
        usageLater.delete(workspace);
        usageRead.set(workspace, Date.now());
        void get().loadCodexUsage(workspace);
      };
      const wait = USAGE_MS - (Date.now() - (usageRead.get(workspace) ?? 0));
      if (wait <= 0) read();
      else if (!usageLater.has(workspace))
        usageLater.set(workspace, setTimeout(read, wait));
    };
    const stopWritten = surface.onAgentWritten((write) => {
      if (write.agent === "claude") usageSoon(write.workspace);
    });
    const stopActivity = surface.onAgentActivity((activity: AgentActivity) => {
      // A settled write may carry new usage, or move a Codex goal on.
      if (activity.agent === "codex" || activity.agent === "claude")
        usageSoon(activity.workspace);
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
        // A sub-agent the rail has not listed was just spawned: list again,
        // as for a new conversation.
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
      // A conversation the rail has not listed yet just started: list again,
      // but not on every write of it.
      if (!parent) relistSoon(activity.workspace);
    });
    return () => {
      stopWritten();
      stopActivity();
    };
  },

  load: async (workspace) => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const mine = (latest.get(workspace) ?? 0) + 1;
    latest.set(workspace, mine);
    try {
      const listed = await surface.agentSessions(workspace);
      if (latest.get(workspace) !== mine) return;
      // With every listing, changed or not: the goals are its threads'.
      void get().loadCodexUsage(workspace);
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
            sameSubagents(entry.subagents, listed[index]?.subagents ?? []) &&
            entry.background.running === listed[index]?.background.running &&
            entry.background.total === listed[index]?.background.total,
        )
      )
        return;
      // NOTE: A fresh listing is the truth. What the watcher said about these
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

  loadCodexUsage: async (workspace) => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const mine = (usageLatest.get(workspace) ?? 0) + 1;
    usageLatest.set(workspace, mine);
    const answers = claudeAnswers;
    try {
      const usage = await surface.codexUsage(workspace);
      if (usageLatest.get(workspace) !== mine) return;
      // Unchanged: keep the old objects, so nothing redraws.
      set((state) => {
        const quota = sameJson(state.codexQuota, usage.quota)
          ? state.codexQuota
          : usage.quota;
        const claude =
          answers !== claudeAnswers ||
          claudeRefresh ||
          olderAttempt(usage.claude ?? null, state.claudeUsage) ||
          sameJson(state.claudeUsage, usage.claude ?? null)
            ? state.claudeUsage
            : (usage.claude ?? null);
        const goals = sameJson(state.codexGoals[workspace], usage.goals)
          ? state.codexGoals
          : { ...state.codexGoals, [workspace]: usage.goals };
        return quota === state.codexQuota &&
          claude === state.claudeUsage &&
          goals === state.codexGoals
          ? state
          : { codexQuota: quota, claudeUsage: claude, codexGoals: goals };
      });
    } catch {
      // Main answers empty rather than failing; a refused call keeps what
      // the rail showed.
    }
  },

  refreshCodexUsage: async (workspace, force) => {
    const surface = window.desktop?.terminal;
    if (!surface?.refreshCodexUsage) return;
    try {
      await surface.refreshCodexUsage(force);
    } catch {
      // Codex not there, or signed out: what the rollouts said stands.
    }
    await get().loadCodexUsage(workspace);
  },

  consumeCodexReset: async (workspace, creditId) => {
    const surface = window.desktop?.terminal;
    if (!surface?.consumeCodexReset)
      throw new Error("Codex resets are not available here.");
    try {
      return await surface.consumeCodexReset(creditId);
    } finally {
      await get().loadCodexUsage(workspace);
    }
  },
}));
