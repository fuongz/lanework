import { useSyncExternalStore } from "react";
import type { ConversationAgent } from "#/../shared/conversation";

/**
 * The CLI of the chat on screen, for what follows it outside the page (the
 * usage strip).
 *
 * The conversation's own CLI, or on the new-conversation page the one its
 * picked model runs on. Null when there is no chat, or it is not known yet.
 */
let current: ConversationAgent | null = null;
const listeners = new Set<() => void>();

export function setChatAgent(agent: ConversationAgent | null): void {
  if (agent === current) return;
  current = agent;
  for (const listener of listeners) listener();
}

export function useChatAgent(): ConversationAgent | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
