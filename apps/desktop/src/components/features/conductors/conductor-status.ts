import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import type { OrchestrationRun, TeamLead } from "#/../shared/orchestration";
import {
  proposalRun,
  useProposalEdits,
} from "#/components/features/orchestration/orchestration-panel.store";
import { liveRun, useOrchestrationRuns } from "#/hooks/use-orchestration-runs";
import { conductorConversation } from "#/lib/conductors";
import { deriveProposals } from "#/lib/orchestration-prompt";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { awaitingKey, useAwaiting } from "#/stores/awaiting";
import { useNewChats } from "#/stores/new-chats";

/**
 * Where a conductor stands, as its dot says it (FE-95/D4).
 *
 * - `needs-you`: its conversation waits on a permission, its proposal on
 *   approval, a run under it is paused or waits on a scope, or a session it
 *   started waits on the person.
 * - `working`: its conversation is answering, a run under it is going, or
 *   a session it started is working: those are never rows under Sessions
 *   either, so its dot stays lit while they research or build (FE-128).
 * - `running`: between turns, with background jobs still going (Claude
 *   only): its conversation is never a row under Sessions, so this row is
 *   the rail's only sign of them.
 * - `done`: idle, but its last turn or run ended while it was not open, and
 *   it has not been opened since. Never from {@link useConductorStatuses}:
 *   the rail lays it over `idle` ({@link useFinishedConductors}).
 * - `idle`: none of these.
 */
export type ConductorState =
  | "idle"
  | "working"
  | "running"
  | "needs-you"
  | "done";

/**
 * The conductors that finished while nobody was looking, by
 * `project:conductor`, until each is opened.
 *
 * Without it the dot just went out when a conductor finished, and a
 * conductor left working in the background read the same as one never
 * started. In memory: after a restart nothing is "just finished".
 */
export const useFinishedConductors = create<{
  keys: ReadonlySet<string>;
  mark: (key: string) => void;
  clear: (key: string) => void;
}>((set, get) => ({
  keys: new Set(),
  mark: (key) => {
    if (get().keys.has(key)) return;
    set({ keys: new Set(get().keys).add(key) });
  },
  clear: (key) => {
    if (!get().keys.has(key)) return;
    const keys = new Set(get().keys);
    keys.delete(key);
    set({ keys });
  },
}));

export interface ConductorStatus {
  state: ConductorState;
  /** Why, in a few words, for the tooltip and screen readers. */
  reason: string;
  /** Its own conversation in this project; null before it has one. */
  conversation: string | null;
}

const IDLE: ConductorStatus = {
  state: "idle",
  reason: "Idle",
  conversation: null,
};

/**
 * The conversations of `project` that wait on a permission answer, from
 * the engine's events since the rail mounted.
 */
function useWaitingPermissions(project: string): ReadonlySet<string> {
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setWaiting(new Set());
    const surface = window.desktop?.conversation;
    if (!surface) return;
    return surface.onEvent((event) => {
      if (event.project !== project) return;
      if (event.type === "permission")
        setWaiting((current) => new Set(current).add(event.conversation));
      else if (
        event.type === "permission-done" ||
        (event.type === "state" && event.engine.state !== "running")
      )
        setWaiting((current) => {
          if (!current.has(event.conversation)) return current;
          const next = new Set(current);
          next.delete(event.conversation);
          return next;
        });
    });
  }, [project]);
  return waiting;
}

/**
 * The conductor conversations whose latest proposal waits on the user:
 * read from their transcripts, on mount and whenever one goes idle.
 *
 * NOTE: Only conductors' own conversations are read, a handful at most, and
 * only when a turn ends: the proposal is the transcript's (FE-87), kept
 * nowhere else.
 */
function useWaitingProposals(
  project: string,
  conversations: readonly string[],
  leads: readonly TeamLead[],
  runs: readonly OrchestrationRun[],
): ReadonlySet<string> {
  const edits = useProposalEdits((state) => state.edits);
  // Each conversation's latest ready proposal id, or null.
  const [latest, setLatest] = useState<Record<string, string | null>>({});
  const key = conversations.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the list.
  useEffect(() => {
    const surface = window.desktop?.conversation;
    if (!surface || conversations.length === 0) return;
    let gone = false;
    const read = (id: string) =>
      surface
        .read(project, id)
        .then((conversation) => {
          if (gone) return;
          const ready = deriveProposals(conversation.turns, false, leads).at(
            -1,
          );
          setLatest((current) => ({
            ...current,
            [id]: ready?.status === "ready" ? ready.id : null,
          }));
        })
        .catch(() => {});
    for (const id of conversations) void read(id);
    const off = surface.onEvent((event) => {
      if (
        event.type === "state" &&
        event.project === project &&
        event.engine.state === "idle" &&
        conversations.includes(event.conversation)
      )
        void read(event.conversation);
    });
    return () => {
      gone = true;
      off();
    };
  }, [project, key, leads]);
  return useMemo(() => {
    const waiting = new Set<string>();
    for (const [id, proposal] of Object.entries(latest)) {
      if (
        proposal &&
        !proposalRun(proposal, edits, runs) &&
        !edits[proposal]?.cancelled
      )
        waiting.add(id);
    }
    return waiting;
  }, [latest, edits, runs]);
}

/** Every conductor's status in `project`, by its id. */
export function useConductorStatuses(
  project: string,
  conductors: readonly TeamLead[],
): Record<string, ConductorStatus> {
  const sessions = useAgentSessions((state) => state.byProject[project]);
  const live = useAgentSessions((state) => state.live);
  const started = useNewChats((state) => state.started);
  const starting = useNewChats((state) => state.starting[project]);
  const runs = useOrchestrationRuns(project);
  const permissions = useWaitingPermissions(project);
  const awaiting = useAwaiting((state) => state.byKey);

  const own = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const conductor of conductors)
      out[conductor.id] = conductorConversation(
        sessions,
        started,
        project,
        conductor.id,
      );
    return out;
  }, [conductors, sessions, started, project]);
  const conversations = useMemo(
    () => Object.values(own).filter((id): id is string => id !== null),
    [own],
  );
  const proposals = useWaitingProposals(
    project,
    conversations,
    conductors,
    runs,
  );

  const out: Record<string, ConductorStatus> = {};
  for (const conductor of conductors) {
    const conversation = own[conductor.id] ?? null;
    const session = conversation
      ? sessions?.find((entry) => entry.id === conversation)
      : undefined;
    const mine = runs.filter((run) => run.teamLead === conductor.id);
    const paused = mine.some((run) => run.status === "paused");
    const scope = mine.some(
      (run) =>
        liveRun(run) &&
        run.tasks.some((task) => (task.scopeApproval?.length ?? 0) > 0),
    );
    const asking = conversation !== null && permissions.has(conversation);
    const proposing = conversation !== null && proposals.has(conversation);
    const answering =
      starting?.conductor === conductor.id ||
      (conversation !== null &&
        ((session ? (live[agentKey(session)] ?? session.working) : false) ||
          (!session && conversation in started)));
    const running = mine.some((run) => run.status === "active");
    // The sessions it started: hidden from the Sessions rail, so its dot
    // speaks for them, as their own rows would (ConductorSessions).
    let launchedWaiting = false;
    let launchedWorking = 0;
    for (const entry of sessions ?? []) {
      if (entry.launchedBy?.conductor !== conductor.id) continue;
      if (awaiting[awaitingKey(project, entry.id)]) launchedWaiting = true;
      else if (live[agentKey(entry)] ?? entry.working) launchedWorking += 1;
    }
    // Its background tasks still running; only Claude counts them (FE-42/D1).
    const background =
      session?.agent === "claude" ? session.background.running : 0;
    if (asking || proposing || paused || scope || launchedWaiting)
      out[conductor.id] = {
        state: "needs-you",
        reason: asking
          ? "Waiting for a permission"
          : proposing
            ? "A proposal waits for your approval"
            : paused
              ? "A run is paused"
              : scope
                ? "A worker waits for a wider scope"
                : "A session it started waits for you",
        conversation,
      };
    else if (answering || running || launchedWorking > 0)
      out[conductor.id] = {
        state: "working",
        reason: answering
          ? "Working"
          : running
            ? "Running workers"
            : `${launchedWorking} session${launchedWorking === 1 ? "" : "s"} working`,
        conversation,
      };
    else if (background > 0)
      out[conductor.id] = {
        state: "running",
        reason: `${background} background job${background === 1 ? "" : "s"} running`,
        conversation,
      };
    else out[conductor.id] = { ...IDLE, conversation };
  }
  return out;
}
