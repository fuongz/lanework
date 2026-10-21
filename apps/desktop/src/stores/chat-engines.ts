import { create } from "zustand";

/**
 * The Claude conversations each project runs from the chat.
 *
 * Their engine process is alive, like a live agent tab, so the rail lists
 * them under Running, with Stop, as it does a terminal's.
 *
 * Read again on every engine `state` event of that project, never on a timer:
 * a process starts or ends only with one of those.
 */

const NONE: string[] = [];

/**
 * Request tickets, by workspace.
 *
 * A list read that started first must not land after a later one.
 */
const tickets = new Map<string, number>();

interface ChatEnginesState {
  /** Each workspace's conversation ids with a live engine. */
  alive: Record<string, string[]>;
  refresh: (workspace: string) => Promise<void>;
  /**
   * Follow engine events.
   *
   * @returns The unsubscribe.
   */
  watch: () => () => void;
}

export const useChatEngines = create<ChatEnginesState>((set, get) => ({
  alive: {},

  refresh: async (workspace) => {
    const surface = window.desktop?.conversation;
    if (!surface) return;
    const mine = (tickets.get(workspace) ?? 0) + 1;
    tickets.set(workspace, mine);
    try {
      const ids = await surface.alive(workspace);
      if (tickets.get(workspace) !== mine) return;
      const before = get().alive[workspace] ?? NONE;
      if (
        before.length === ids.length &&
        before.every((id, index) => id === ids[index])
      )
        return;
      set((state) => ({ alive: { ...state.alive, [workspace]: ids } }));
    } catch {
      // The rail keeps what it last knew.
    }
  },

  watch: () => {
    const surface = window.desktop?.conversation;
    if (!surface) return () => {};
    return surface.onEvent((event) => {
      if (event.type === "state") void get().refresh(event.workspace);
    });
  },
}));

/** A stable empty list for a workspace with none. */
export const NO_CHATS = NONE;
