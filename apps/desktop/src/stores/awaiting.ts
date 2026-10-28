import { useEffect } from "react";
import { create } from "zustand";
import type {
  Awaiting,
  ConversationEvent,
  PermissionRequest,
} from "../../shared/conversation";
import { useAgentSessions } from "./agent-sessions";
import { useNewChats } from "./new-chats";

/**
 * The conversations whose engine waits on the person: a tool's permission,
 * or `AskUserQuestion` (FE-97).
 *
 * Read once from main, which keeps them for a window that opens late, then
 * followed from the engine's events: `permission` adds a request,
 * `permission-done` takes one away, and a `state` that ends the turn takes
 * the conversation's all. Never on a timer.
 */

/**
 * One waiting conversation.
 *
 * `agent` is null when an event named a conversation the rail has not
 * listed yet: the island then says "An agent" rather than guess.
 */
export type AwaitingEntry = Omit<Awaiting, "agent"> & {
  agent: Awaiting["agent"] | null;
};

/** The store's key for a conversation in a workspace. */
export function awaitingKey(workspace: string, conversation: string): string {
  return `${workspace}:${conversation}`;
}

/** What one request says: `AskUserQuestion`'s first question, or null. */
function requestOf(request: PermissionRequest): AwaitingEntry["requests"][0] {
  return {
    id: request.id,
    tool: request.tool,
    summary: request.summary,
    question: request.questions?.[0]?.question ?? null,
  };
}

/** Which CLI runs a conversation, as far as this window knows. */
function agentOf(
  workspace: string,
  conversation: string,
): AwaitingEntry["agent"] {
  const listed = useAgentSessions
    .getState()
    .byWorkspace[workspace]?.find((session) => session.id === conversation);
  if (listed) return listed.agent === "codex" ? "codex" : "claude";
  const started = useNewChats.getState().started[conversation];
  return started?.agent ?? null;
}

interface AwaitingState {
  byKey: Record<string, AwaitingEntry>;
  /**
   * Follow the engine's events, after one read of what already waits.
   *
   * Counted: the last caller's unsubscribe stops it.
   *
   * @returns The unsubscribe.
   */
  watch: () => () => void;
}

let watchers = 0;
let stop: (() => void) | null = null;

export const useAwaiting = create<AwaitingState>((set) => {
  /** Apply one event to the map; the same map back when it changes nothing. */
  const apply = (
    byKey: Record<string, AwaitingEntry>,
    event: ConversationEvent,
  ): Record<string, AwaitingEntry> => {
    if (
      event.type !== "permission" &&
      event.type !== "permission-done" &&
      event.type !== "state"
    )
      return byKey;
    const key = awaitingKey(event.workspace, event.conversation);
    const entry = byKey[key];
    if (event.type === "permission") {
      const request = requestOf(event.request);
      if (entry?.requests.some((item) => item.id === request.id)) return byKey;
      return {
        ...byKey,
        [key]: entry
          ? {
              ...entry,
              agent:
                entry.agent ?? agentOf(event.workspace, event.conversation),
              requests: [...entry.requests, request],
            }
          : {
              workspace: event.workspace,
              conversation: event.conversation,
              agent: agentOf(event.workspace, event.conversation),
              requests: [request],
              since: new Date().toISOString(),
            },
      };
    }
    if (!entry) return byKey;
    if (event.type === "permission-done") {
      const requests = entry.requests.filter((item) => item.id !== event.id);
      if (requests.length === entry.requests.length) return byKey;
      const { [key]: _, ...rest } = byKey;
      return requests.length > 0
        ? { ...byKey, [key]: { ...entry, requests } }
        : rest;
    }
    // The turn is over: nothing it asked is still waiting.
    const ended =
      event.engine.state === "idle" ||
      event.engine.state === "error" ||
      event.engine.state === "terminal";
    if (!ended) return byKey;
    const { [key]: _, ...rest } = byKey;
    return rest;
  };

  const start = () => {
    const surface = window.desktop?.conversation;
    if (!surface) return () => {};
    // Events that land before the read: replayed over it, so an answer
    // given meanwhile is not brought back by an older list.
    let early: ConversationEvent[] | null = [];
    let disposed = false;
    const off = surface.onEvent((event) => {
      if (early) early.push(event);
      set((state) => {
        const byKey = apply(state.byKey, event);
        return byKey === state.byKey ? state : { byKey };
      });
    });
    void surface
      .awaiting()
      .then((list) => {
        if (disposed) return;
        let byKey: Record<string, AwaitingEntry> = {};
        for (const entry of list)
          byKey[awaitingKey(entry.workspace, entry.conversation)] = entry;
        for (const event of early ?? []) byKey = apply(byKey, event);
        early = null;
        set({ byKey });
      })
      .catch(() => {
        // Followed from the events alone.
        early = null;
      });
    return () => {
      disposed = true;
      off();
    };
  };

  return {
    byKey: {},
    watch: () => {
      watchers += 1;
      if (watchers === 1) stop = start();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        watchers -= 1;
        if (watchers > 0) return;
        stop?.();
        stop = null;
      };
    },
  };
});

/** Follow what waits on the person while the caller is mounted. */
export function useAwaitingWatch() {
  const watch = useAwaiting((state) => state.watch);
  useEffect(() => watch(), [watch]);
}
