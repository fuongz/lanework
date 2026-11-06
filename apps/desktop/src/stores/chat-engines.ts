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

const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

interface ChatEnginesState {
  /** Each project's conversation ids with a live engine. */
  alive: Record<string, string[]>;
  /** Each project's conversation ids kept past the idle limit (FE-126). */
  kept: Record<string, string[]>;
  /** Keep one chat running past the idle limit, or let it go (FE-126). */
  keep: (project: string, conversation: string, on: boolean) => Promise<void>;
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
  kept: {},

  keep: async (project, conversation, on) => {
    await window.desktop?.conversation.keep(project, conversation, on);
    await get().refresh(project);
  },

  refresh: async (project) => {
    const surface = window.desktop?.conversation;
    if (!surface) return;
    const mine = (tickets.get(project) ?? 0) + 1;
    tickets.set(project, mine);
    try {
      const [ids, keptIds] = await Promise.all([
        surface.alive(project),
        surface.kept(project),
      ]);
      if (tickets.get(project) !== mine) return;
      const state = get();
      const aliveSame = same(state.alive[project] ?? NONE, ids);
      const keptSame = same(state.kept[project] ?? NONE, keptIds);
      if (aliveSame && keptSame) return;
      set((current) => ({
        alive: aliveSame ? current.alive : { ...current.alive, [project]: ids },
        kept: keptSame ? current.kept : { ...current.kept, [project]: keptIds },
      }));
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
