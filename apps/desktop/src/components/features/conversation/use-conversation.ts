import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Conversation,
  EngineState,
  PermissionRequest,
  Turn,
} from "#/../shared/conversation";
import { ipcMessage } from "#/lib/ipc-error";

export interface ConversationState {
  conversation: Conversation | null;
  error: string | null;
  engine: EngineState;
  /**
   * Text streamed for the open turn since the last read (D1): drawn after
   * its last text, dropped as soon as a read brings the line itself.
   */
  delta: string;
  /** Permissions the CLI is waiting on, oldest first. */
  permissions: PermissionRequest[];
  /** Set the engine's state from an answer that carried one (send, takeOver). */
  setEngine: (engine: EngineState) => void;
  /** Read again now — after a send, a fork, a take-over. */
  reload: () => void;
}

interface Inner {
  key: string;
  conversation: Conversation | null;
  error: string | null;
  engine: EngineState;
  delta: string;
  permissions: PermissionRequest[];
}

const IDLE: EngineState = { state: "idle" };
const empty = (key: string): Inner => ({
  key,
  conversation: null,
  error: null,
  engine: IDLE,
  delta: "",
  permissions: [],
});

/** `turns`, `turn` put in place of the one with its id, or added at the end. */
function patched(turns: Turn[], turn: Turn): Turn[] {
  const at = turns.findIndex((entry) => entry.id === turn.id);
  if (at === -1) return [...turns, turn];
  const next = turns.slice();
  next[at] = turn;
  return next;
}

/**
 * One Claude conversation as a chat (FE-62): read once, read again each time
 * the watcher says IT was written, with main's events laid over the read —
 * streamed text, a permission waiting, the engine's state.
 *
 * ⚠️ One read in flight at a time, and at most one queued behind it, as the
 * sub-agent view does: a working agent writes many times a second, and a read
 * that started first must not land after a later one.
 */
export function useConversation(
  workspace: string | null,
  id: string,
): ConversationState {
  const key = `${workspace}:${id}`;
  const [state, setState] = useState<Inner>(() => empty(key));
  const readRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const surface = window.desktop?.conversation;
    const terminal = window.desktop?.terminal;
    if (!workspace || !surface) return;
    let gone = false;
    let reading = false;
    let again = false;
    setState((previous) => (previous.key === key ? previous : empty(key)));

    const read = () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      surface
        .read(workspace, id)
        .then((conversation) => {
          if (gone) return;
          setState((previous) => ({
            ...(previous.key === key ? previous : empty(key)),
            conversation,
            error: null,
            // The line landed: what streamed before it is in it now.
            delta: "",
          }));
        })
        .catch((error: unknown) => {
          if (gone) return;
          // A read that failed mid-run keeps what the last one showed.
          setState((previous) => ({
            ...(previous.key === key ? previous : empty(key)),
            error: ipcMessage(error, "Could not read this conversation."),
          }));
        })
        .finally(() => {
          reading = false;
          if (again && !gone) {
            again = false;
            read();
          }
        });
    };
    read();
    readRef.current = read;

    void surface
      .engineState(workspace, id)
      .then((engine) => {
        if (!gone)
          setState((previous) =>
            previous.key === key ? { ...previous, engine } : previous,
          );
      })
      .catch(() => {});

    // ⚠️ A question asked while this page was not open came as an event
    // nobody heard, and the CLI waits on it for as long as it takes: read
    // what the engine is still waiting on. `?.`: an older preload has none.
    void surface
      .permissions?.(workspace, id)
      .then((waiting) => {
        if (gone || waiting.length === 0) return;
        setState((previous) => {
          if (previous.key !== key) return previous;
          const known = new Set(previous.permissions.map((entry) => entry.id));
          return {
            ...previous,
            permissions: [
              ...waiting.filter((entry) => !known.has(entry.id)),
              ...previous.permissions,
            ],
          };
        });
      })
      .catch(() => {});

    const offActivity = terminal?.onAgentActivity((activity) => {
      if (
        activity.workspace === workspace &&
        activity.agent === "claude" &&
        activity.id === id &&
        activity.subagent === null
      )
        read();
    });

    const offEvent = surface.onEvent((event) => {
      if (event.workspace !== workspace || event.conversation !== id) return;
      switch (event.type) {
        case "state":
          setState((previous) =>
            previous.key === key
              ? {
                  ...previous,
                  engine: event.engine,
                  // A turn that ended streams no more.
                  delta: event.engine.state === "running" ? previous.delta : "",
                  permissions:
                    event.engine.state === "running" ||
                    event.engine.state === "starting"
                      ? previous.permissions
                      : [],
                }
              : previous,
          );
          if (event.engine.state !== "running") read();
          break;
        case "delta":
          setState((previous) =>
            previous.key === key
              ? { ...previous, delta: previous.delta + event.text }
              : previous,
          );
          break;
        case "turn":
          setState((previous) =>
            previous.key === key && previous.conversation
              ? {
                  ...previous,
                  conversation: {
                    ...previous.conversation,
                    turns: patched(previous.conversation.turns, event.turn),
                  },
                  delta: "",
                }
              : previous,
          );
          read();
          break;
        case "permission":
          setState((previous) =>
            previous.key === key
              ? {
                  ...previous,
                  permissions: [
                    ...previous.permissions.filter(
                      (entry) => entry.id !== event.request.id,
                    ),
                    event.request,
                  ],
                }
              : previous,
          );
          break;
        case "permission-done":
          setState((previous) =>
            previous.key === key
              ? {
                  ...previous,
                  permissions: previous.permissions.filter(
                    (entry) => entry.id !== event.id,
                  ),
                }
              : previous,
          );
          break;
      }
    });

    return () => {
      gone = true;
      if (readRef.current === read) readRef.current = null;
      offActivity?.();
      offEvent();
    };
  }, [key, workspace, id]);

  const setEngine = useCallback(
    (engine: EngineState) =>
      setState((previous) =>
        previous.key === key ? { ...previous, engine } : previous,
      ),
    [key],
  );
  const reload = useCallback(() => readRef.current?.(), []);

  // Another conversation's, still on screen from before: none yet.
  const mine = state.key === key ? state : empty(key);
  return {
    conversation: mine.conversation,
    error: mine.error,
    engine: mine.engine,
    delta: mine.delta,
    permissions: mine.permissions,
    setEngine,
    reload,
  };
}
