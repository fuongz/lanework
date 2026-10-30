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
 * Request tickets, by project.
 *
 * A list read that started first must not land after a later one.
 */
const tickets = new Map<string, number>();

interface ChatEnginesState {
  /** Each project's conversation ids with a live engine. */
  alive: Record<string, string[]>;
  refresh: (project: string) => Promise<void>;
  /**
   * Follow engine events.
   *
   * @returns The unsubscribe.
   */
  watch: () => () => void;
}

export const useChatEngines = create<ChatEnginesState>((set, get) => ({
  alive: {},

  refresh: async (project) => {
    const surface = window.desktop?.conversation;
    if (!surface) return;
    const mine = (tickets.get(project) ?? 0) + 1;
    tickets.set(project, mine);
    try {
      const ids = await surface.alive(project);
      if (tickets.get(project) !== mine) return;
      const before = get().alive[project] ?? NONE;
      if (
        before.length === ids.length &&
        before.every((id, index) => id === ids[index])
      )
        return;
      set((state) => ({ alive: { ...state.alive, [project]: ids } }));
    } catch {
      // The rail keeps what it last knew.
    }
  },

  watch: () => {
    const surface = window.desktop?.conversation;
    if (!surface) return () => {};
    return surface.onEvent((event) => {
      if (event.type === "state") void get().refresh(event.project);
    });
  },
}));

/** A stable empty list for a project with none. */
export const NO_CHATS = NONE;
