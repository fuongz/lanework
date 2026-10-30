import { useEffect, useMemo, useState } from "react";
import type { TeamLead } from "#/../shared/orchestration";
import { useProposalEdits } from "#/components/features/orchestration/orchestration-panel.store";
import { liveRun, useOrchestrationRuns } from "#/hooks/use-orchestration-runs";
import { conductorConversation } from "#/lib/conductors";
import { deriveProposals } from "#/lib/orchestration-prompt";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { useNewChats } from "#/stores/new-chats";

/**
 * Where a conductor stands, as its dot says it (FE-95/D4).
 *
 * - `needs-you`: its conversation waits on a permission, its proposal on
 *   approval, or a run under it is paused or waits on a scope.
 * - `working`: its conversation is answering, or a run under it is going.
 * - `idle`: neither.
 */
export type ConductorState = "idle" | "working" | "needs-you";

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
      const edit = proposal ? edits[proposal] : undefined;
      if (proposal && !edit?.runId && !edit?.cancelled) waiting.add(id);
    }
    return waiting;
  }, [latest, edits]);
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
  const proposals = useWaitingProposals(project, conversations, conductors);

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
    if (asking || proposing || paused || scope)
      out[conductor.id] = {
        state: "needs-you",
        reason: asking
          ? "Waiting for a permission"
          : proposing
            ? "A proposal waits for your approval"
            : paused
              ? "A run is paused"
              : "A worker waits for a wider scope",
        conversation,
      };
    else if (answering || running)
      out[conductor.id] = {
        state: "working",
        reason: answering ? "Working" : "Running workers",
        conversation,
      };
    else out[conductor.id] = { ...IDLE, conversation };
  }
  return out;
}
