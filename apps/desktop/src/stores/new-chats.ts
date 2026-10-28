import { create } from "zustand";
import type { ConversationAgent } from "#/../shared/conversation";

/**
 * Conversations started from the new-conversation page that the rail cannot
 * list yet.
 *
 * The rail lists a conversation once its CLI has written a transcript and the
 * listing has been read again, which is seconds after Enter. Until then this
 * is what gives it a row: first while the CLI starts (no id yet), then under
 * its id until the listing has it.
 */
export interface NewChat {
  workspace: string;
  agent: ConversationAgent;
  /** The first message, which stands in for its title. */
  text: string;
  /** The conductor whose own conversation it is (FE-95): not an Agents row. */
  conductor?: string;
}

interface NewChatsState {
  /** Each workspace's conversation being started: Enter pressed, no id yet. */
  starting: Record<string, NewChat>;
  /** Started ones by conversation id, until the rail lists them. */
  started: Record<string, NewChat>;
  begin: (chat: NewChat) => void;
  /** The start answered: its id, or `null` when it failed. */
  end: (workspace: string, conversation: string | null) => void;
  /** Listed now: its own row takes over. */
  forget: (conversations: string[]) => void;
}

export const useNewChats = create<NewChatsState>((set) => ({
  starting: {},
  started: {},

  begin: (chat) =>
    set((state) => ({
      starting: { ...state.starting, [chat.workspace]: chat },
    })),

  end: (workspace, conversation) =>
    set((state) => {
      const { [workspace]: chat, ...starting } = state.starting;
      if (!chat || !conversation) return { starting };
      return { starting, started: { ...state.started, [conversation]: chat } };
    }),

  forget: (conversations) =>
    set((state) => {
      if (!conversations.some((id) => id in state.started)) return state;
      const started = { ...state.started };
      for (const id of conversations) delete started[id];
      return { started };
    }),
}));
