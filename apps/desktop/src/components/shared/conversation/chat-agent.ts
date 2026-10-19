import { useSyncExternalStore } from "react";
import type { ConversationAgent } from "#/../shared/conversation";

/**
 * The CLI of the chat on screen — the conversation's own, or on the new
 * page the one its picked model runs on — for what follows the agent on
 * screen outside the page (the usage strip). Null: no chat, or not known
 * yet.
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
