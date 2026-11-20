import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Conversation,
  ConversationEvent,
  ConversationReplay,
  EngineState,
  PermissionRequest,
  Turn,
} from "#/../shared/conversation";
import { ipcMessage } from "#/lib/ipc-error";

interface ConversationState {
  /**
   * The conversation as the page holds it: the newest turns a read sends,
   * with the older pages `loadEarlier` brought in before them.
   */
  conversation: Conversation | null;
  error: string | null;
  engine: EngineState;
  engineLoaded: boolean;
  /**
   * Text streamed for the open turn since the last read (D1): drawn after
   * its last text, dropped as soon as a read brings the line itself.
   */
  delta: string;
  /** Permissions the CLI is waiting on, oldest first. */
  permissions: PermissionRequest[];
  /**
   * Sets the engine's state from an answer that carried one (send,
   * takeOver).
   */
  setEngine: (engine: EngineState) => void;
  /** Reads again now: after a send, a fork, a take-over. */
  reload: () => void;
  /**
   * Reads the conversation, its engine's state and what it waits on again:
   * after a `switchAgent`, whose new session's first events may come under
   * its own id, before the thread knows it.
   */
  resync: () => void;
  /** How many turns main holds before `conversation.turns`. */
  earlier: number;
  /** A page of earlier turns is being read. */
  loadingEarlier: boolean;
  /** Bring in the page of turns before the oldest one held, when there is one. */
  loadEarlier: () => void;
}

interface Inner {
  key: string;
  conversation: Conversation | null;
  error: string | null;
  engine: EngineState;
  engineLoaded: boolean;
  delta: string;
  permissions: PermissionRequest[];
  loadingEarlier: boolean;
}

const IDLE: EngineState = { state: "idle" };
const empty = (key: string): Inner => ({
  key,
  conversation: null,
  error: null,
  engine: IDLE,
  engineLoaded: false,
  delta: "",
  permissions: [],
  loadingEarlier: false,
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
 * A read's window laid over what the page holds: the older pages kept in
 * front of it, as long as they still lead up to it.
 *
 * NOTE: A read sends only the newest turns (`windowStart`), and its first
 * turn moves on as the conversation grows. The turns held before the first
 * one the read also has are kept; with none in common, they are kept only
 * when the read starts right after them (one long turn may fill a window on
 * its own). Anything else is a rewritten transcript, or a gap: the read
 * stands alone, and `earlier` pages back again from it.
 */
function merged(held: Conversation | null, read: Conversation): Conversation {
  const earlier = read.earlier ?? 0;
  if (!held || held.id !== read.id || earlier === 0) return read;
  const ids = new Set(read.turns.map((turn) => turn.id));
  const shared = held.turns.findIndex((turn) => ids.has(turn.id));
  const keep =
    shared !== -1
      ? shared
      : earlier === (held.earlier ?? 0) + held.turns.length
        ? held.turns.length
        : 0;
  if (keep === 0) return read;
  return {
    ...read,
    turns: [...held.turns.slice(0, keep), ...read.turns],
    earlier: Math.max(0, earlier - keep),
  };
}

/**
 * One conversation, Claude's or Codex's, as a chat.
 *
 * Read once, and again each time the watcher says IT was written, with main's
 * events laid over the read: streamed text, a permission waiting, the
 * engine's state.
 *
 * NOTE: One read in flight at a time, and at most one queued behind it, as
 * the sub-agent view does. A working agent writes many times a second, and a
 * read that started first must not land after a later one.
 *
 * NOTE: While its engine runs a turn, a Claude or OpenCode chat is not read
 * again on every line: the engine's `turn` events carry each line's turn,
 * and a read per line re-sent the whole conversation each time, the square
 * of a long turn. It is read when the turn ends (the state leaves
 * `running`), on a `moved`, on `reload`, and when it opens. A Codex engine
 * sends no `turn` events: its chat is still read as its rollout is written.
 *
 * NOTE: A read brings the newest turns only (`CONVERSATION_WINDOW_TURNS`),
 * not the whole conversation: `loadEarlier` pages back from there, and a
 * read after it keeps those pages (`merged`).
 */
export function useConversation(
  project: string | null,
  id: string,
): ConversationState {
  const key = `${project}:${id}`;
  const [state, setState] = useState<Inner>(() => empty(key));
  const readRef = useRef<(() => void) | null>(null);
  const resyncRef = useRef<(() => void) | null>(null);
  const earlierRef = useRef<(() => void) | null>(null);
  /** The state as last drawn, for `loadEarlier` to page back from. */
  const stateRef = useRef(state);
  stateRef.current = state;
  /** The engine's state as last heard, for the effect's listeners. */
  const engineRef = useRef<EngineState["state"]>(IDLE.state);
  const keyRef = useRef(key);
  keyRef.current = key;
  /**
   * The conversation's last `seq` this page applied (null: none yet, or
   * followed without), and its last read's, kept across runs of the effect.
   */
  const seqRef = useRef<{ key: string; applied: number | null; read: number }>({
    key: "",
    applied: null,
    read: 0,
  });

  useEffect(() => {
    const surface = window.desktop?.conversation;
    const terminal = window.desktop?.terminal;
    if (!project || !surface) return;
    let gone = false;
    let reading = false;
    let again = false;
    /**
     * Who writes it now, once read: a Codex chat has no `turn` events. For
     * a thread, its newest session's agent.
     */
    let agent: Conversation["agent"] | null = null;
    /**
     * The native sessions of the thread `id` names, as the last read tagged
     * its turns; `id` alone for a conversation in no thread.
     *
     * NOTE: The page is named by the thread's head, but the watcher tells of
     * each native session by its own id: a write to the newest session (a
     * Codex rollout above all, which has no `turn` events) must read the
     * thread again too.
     */
    let sessions = new Set<string>([id]);
    const learn = (turns: readonly Turn[]) => {
      const next = new Set<string>([id]);
      for (const turn of turns) {
        if (turn.session) next.add(turn.session.conversation);
        if (turn.role === "handoff") {
          next.add(turn.to.conversation);
          for (const side of turn.from) next.add(side.conversation);
        }
      }
      sessions = next;
    };
    /**
     * The `turn` events heard while a read was in flight, laid over what it
     * answers: the file may not hold their lines yet, and while a turn runs
     * no read comes after to bring them.
     */
    let patches: Turn[] | null = null;
    /** Streamed text not drawn yet, and the frame that draws it. */
    let streamed = "";
    let frame: number | null = null;
    /** A page of earlier turns is being read. */
    let paging = false;
    /**
     * The next read stands alone, not laid over what is held: a page asked
     * from a turn main no longer has means the transcript was rewritten.
     */
    let fresh = false;
    /**
     * The `seq`s applied, kept from a run of this effect on the same
     * conversation whose turns are still held: it asks main for only the
     * events since, not the whole conversation again.
     */
    const kept = stateRef.current;
    const resume =
      seqRef.current.key === key &&
      kept.key === key &&
      kept.conversation !== null &&
      seqRef.current.applied !== null;
    if (!resume) seqRef.current = { key, applied: null, read: 0 };
    const seen = seqRef.current;
    /**
     * Events heard while main is asked for its `seq` (`subscribe`) or for
     * those skipped (`replay`): applied once it answers, in order. Null when
     * nothing is asked.
     */
    let waiting: ConversationEvent[] | null = null;
    engineRef.current = resume ? kept.engine.state : IDLE.state;
    if (resume) {
      agent = kept.conversation?.agent ?? null;
      learn(kept.conversation?.turns ?? []);
    }
    setState((previous) => (previous.key === key ? previous : empty(key)));

    /**
     * Draw the streamed text held.
     *
     * NOTE: Text streams in many events a second; drawn once a frame, not
     * once an event. Called before anything else changes the state, so the
     * text keeps its place: a `turn` or a read that clears it clears all of
     * it, never what came after.
     */
    const flush = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (!streamed) return;
      const text = streamed;
      streamed = "";
      setState((previous) =>
        previous.key === key
          ? { ...previous, delta: previous.delta + text }
          : previous,
      );
    };

    /** A turn runs, and its engine tells each of its lines' turns. */
    const live = () => engineRef.current === "running";

    const read = () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      patches = [];
      const alone = fresh;
      fresh = false;
      surface
        .read(project, id)
        .then((read) => {
          if (gone) return;
          agent = read.agent;
          learn(read.turns);
          if (read.seq !== undefined) seen.read = Math.max(seen.read, read.seq);
          const heard = patches ?? [];
          flush();
          setState((previous) => {
            const mine = previous.key === key ? previous : empty(key);
            const conversation = alone ? read : merged(mine.conversation, read);
            return {
              ...mine,
              conversation: heard.length
                ? {
                    ...conversation,
                    turns: heard.reduce(patched, conversation.turns),
                  }
                : conversation,
              error: null,
              // The line landed: what streamed before it is in it now.
              delta: "",
            };
          });
          // NOTE: Every event up to the read's `seq` came before its answer,
          // so one past what was applied means some never reached this page.
          if (
            read.seq !== undefined &&
            seen.applied !== null &&
            waiting === null &&
            read.seq > seen.applied
          ) {
            waiting = [];
            catchUp();
          }
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
          patches = null;
          if (again && !gone) {
            again = false;
            read();
          }
        });
    };
    readRef.current = read;

    const loadEarlier = () => {
      const held = stateRef.current;
      const conversation = held.key === key ? held.conversation : null;
      const first = conversation?.turns[0];
      if (paging || !conversation || !first || !conversation.earlier) return;
      paging = true;
      setState((previous) =>
        previous.key === key ? { ...previous, loadingEarlier: true } : previous,
      );
      surface
        .readBefore(project, id, first.id)
        .then((page) => {
          if (gone) return;
          setState((previous) => {
            if (previous.key !== key || !previous.conversation) return previous;
            const turns = previous.conversation.turns;
            // A read since stood alone: the page leads up to nothing held.
            if (turns[0]?.id !== first.id)
              return { ...previous, loadingEarlier: false };
            const known = new Set(turns.map((turn) => turn.id));
            return {
              ...previous,
              loadingEarlier: false,
              conversation: {
                ...previous.conversation,
                turns: [
                  ...page.turns.filter((turn) => !known.has(turn.id)),
                  ...turns,
                ],
                earlier: page.earlier,
              },
            };
          });
        })
        .catch(() => {
          if (gone) return;
          setState((previous) =>
            previous.key === key
              ? { ...previous, loadingEarlier: false }
              : previous,
          );
          // The turn it paged from is gone: read the newest turns anew.
          fresh = true;
          read();
        })
        .finally(() => {
          paging = false;
        });
    };
    earlierRef.current = loadEarlier;

    /**
     * Read everything events would have told: the conversation, its
     * engine's state, and what the engine still waits on.
     *
     * NOTE: On open, and when events went missing that main no longer
     * holds. Each answer is newer than every event that came before it (one
     * pipe, in order), so it replaces what they said.
     */
    const resync = () => {
      read();
      readEngine();
      readPermissions();
    };
    resyncRef.current = resync;

    /** The engine's state, as main has it now. */
    const readEngine = () => {
      void surface
        .engineState(project, id)
        .then((engine) => {
          if (gone) return;
          engineRef.current = engine.state;
          setState((previous) =>
            previous.key === key
              ? { ...previous, engine, engineLoaded: true }
              : previous,
          );
        })
        .catch(() => {});
    };

    /** What the engine still waits on. */
    const readPermissions = () => {
      // NOTE: A question asked while this page was not open came as an
      // event nobody heard, and the CLI waits on it for as long as it takes,
      // so read what the engine is still waiting on. `?.`: an older preload
      // has none.
      void surface
        .permissions?.(project, id)
        .then((list) => {
          if (gone) return;
          setState((previous) => {
            if (previous.key !== key) return previous;
            if (list.length === 0 && previous.permissions.length === 0)
              return previous;
            return { ...previous, permissions: list };
          });
        })
        .catch(() => {});
    };

    // Any CLI's: the id is a UUID or OpenCode's `ses_…`, and a Codex
    // rollout or an OpenCode session moves the way a Claude transcript does.
    const offActivity = terminal?.onAgentActivity((activity) => {
      if (
        activity.project === project &&
        sessions.has(activity.id) &&
        activity.subagent === null &&
        // Its running turn comes as `turn` events (see above).
        !(live() && agent !== null && agent !== "codex")
      )
        read();
    });

    /** Lay one event over what the page holds. */
    const apply = (event: ConversationEvent) => {
      // NOTE: A replayed `delta` or `moved` the last read already holds is
      // dropped: its text is in the read, and it asks for a read that came.
      const old =
        event.seq !== undefined &&
        event.seq <= seen.read &&
        (event.type === "delta" || event.type === "moved");
      if (old) return;
      if (event.type === "delta") {
        streamed += event.text;
        frame ??= requestAnimationFrame(() => {
          frame = null;
          flush();
        });
        return;
      }
      // What streamed before this event is drawn before it.
      flush();
      switch (event.type) {
        case "state":
          engineRef.current = event.engine.state;
          setState((previous) =>
            previous.key === key
              ? {
                  ...previous,
                  engine: event.engine,
                  engineLoaded: true,
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
        case "moved":
          read();
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
          patches?.push(event.turn);
          // The turn's end reads it whole (`state`); until then this is it.
          if (!live()) read();
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
    };

    /**
     * Apply events in `seq` order: one applied already is dropped, and one
     * past a gap waits while main is asked for those skipped.
     */
    const accept = (events: readonly ConversationEvent[]) => {
      for (const event of events) {
        if (waiting) {
          waiting.push(event);
          continue;
        }
        const seq = event.seq;
        if (seq !== undefined && seen.applied !== null) {
          if (seq <= seen.applied) continue;
          if (seq > seen.applied + 1) {
            waiting = [event];
            catchUp();
            continue;
          }
        }
        if (seq !== undefined && seen.applied !== null) seen.applied = seq;
        apply(event);
      }
    };

    /**
     * Main answered `subscribe` or `replay` (null: it failed). The events
     * since `from` are applied, then those heard meanwhile; when main no
     * longer holds them, everything is read again (unless `synced`: a read
     * already went), and the count starts from main's `seq`.
     */
    const settle = (
      answer: ConversationReplay | null,
      from: number | null,
      synced: boolean,
    ) => {
      const heard = waiting ?? [];
      waiting = null;
      if (answer?.events && from !== null) {
        seen.applied = from;
        accept([...answer.events, ...heard]);
        return;
      }
      // NOTE: Failed: followed without `seq`, as before there was one.
      seen.applied = answer ? answer.seq : null;
      if (!synced) resync();
      accept(heard);
    };

    /** Ask main for the events since the last applied. */
    const catchUp = () => {
      const from = seen.applied;
      if (from === null) {
        settle(null, null, false);
        return;
      }
      surface.replay(project, id, from).then(
        (answer) => {
          if (!gone) settle(answer, from, false);
        },
        () => {
          if (!gone) settle(null, from, false);
        },
      );
    };

    const offEvent = surface.onEvent((event) => {
      if (event.project !== project || event.conversation !== id) return;
      accept([event]);
    });

    // NOTE: Subscribed, or this window hears only the conversation's status
    // (no `delta`, no `turn`): main sends those only to a page that shows
    // it. Asked first: main takes the calls in order, so the reads after it
    // miss nothing. Held over from a run on the same conversation, only the
    // events since are asked for, and nothing is read when main has them.
    const from = resume ? seen.applied : null;
    waiting = [];
    surface.subscribe(project, id, from).then(
      (answer) => {
        if (!gone) settle(answer, from, !resume);
      },
      () => {
        if (!gone) settle(null, from, !resume);
      },
    );
    if (!resume) resync();

    return () => {
      gone = true;
      if (frame !== null) cancelAnimationFrame(frame);
      if (readRef.current === read) readRef.current = null;
      if (resyncRef.current === resync) resyncRef.current = null;
      if (earlierRef.current === loadEarlier) earlierRef.current = null;
      offActivity?.();
      offEvent();
      void surface.unsubscribe(project, id).catch(() => {});
    };
  }, [key, project, id]);

  const setEngine = useCallback(
    (engine: EngineState) => {
      // A callback kept from the conversation before says nothing of this one.
      if (keyRef.current === key) engineRef.current = engine.state;
      setState((previous) =>
        previous.key === key ? { ...previous, engine } : previous,
      );
    },
    [key],
  );
  const reload = useCallback(() => readRef.current?.(), []);
  const resync = useCallback(() => resyncRef.current?.(), []);
  const loadEarlier = useCallback(() => earlierRef.current?.(), []);

  // Another conversation's, still on screen from before: none yet.
  const mine = state.key === key ? state : empty(key);
  return {
    conversation: mine.conversation,
    error: mine.error,
    engine: mine.engine,
    engineLoaded: mine.engineLoaded,
    delta: mine.delta,
    permissions: mine.permissions,
    setEngine,
    reload,
    resync,
    earlier: mine.conversation?.earlier ?? 0,
    loadingEarlier: mine.loadingEarlier,
    loadEarlier,
  };
}
