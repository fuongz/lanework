// The sessions a conductor started (FE-128), where each stands: read by its
// Sessions panel and by the capsules above its chat's prompt.
import { useMemo } from "react";
import type { AgentSession } from "#/../shared/terminal";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { awaitingKey, useAwaiting } from "#/stores/awaiting";
import type { SessionActivity } from "./conductor-sessions.item";

/** Stable empty list: a selector that allocates one re-renders forever. */
const NONE: AgentSession[] = [];

/**
 * `conductor`'s sessions in `project` and where each stands: the active
 * (working or waiting for the user) first, then newest first.
 */
export function useConductorSessions(
  project: string,
  conductor: string | null,
) {
  const all = useAgentSessions((state) => state.byProject[project] ?? NONE);
  const listing = useAgentSessions(
    (state) => state.byProject[project] === undefined,
  );
  const live = useAgentSessions((state) => state.live);
  const waiting = useAwaiting((state) => state.byKey);
  const sessions = useMemo(() => {
    const activity = (session: AgentSession): SessionActivity =>
      waiting[awaitingKey(project, session.id)]
        ? "awaiting"
        : (live[agentKey(session)] ?? session.working)
          ? "working"
          : "idle";
    // A chat that is no conductor's (FE-128's panel, opened on any chat)
    // has no sessions of its own.
    if (!conductor) return [];
    return all
      .filter((session) => session.launchedBy?.conductor === conductor)
      .map((session) => ({ session, activity: activity(session) }))
      .sort(
        (a, b) =>
          Number(b.activity !== "idle") - Number(a.activity !== "idle") ||
          b.session.updatedAt.localeCompare(a.session.updatedAt),
      );
  }, [all, conductor, live, waiting, project]);
  return { sessions, listing };
}
