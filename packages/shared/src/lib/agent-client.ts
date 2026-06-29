// Client helpers for the local agent dispatcher (server.mjs /_local/agent/*).
// Only reachable from the local board (LocalBoard renders solely when
// `__LANEWORK_LOCAL__`), so these endpoints always exist when these run.

async function post(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data?.error || `request failed (${res.status})`);
  return data;
}

/**
 * Dispatch a Claude Code agent for a card (worktree + headless run).
 * `mode` "implement" (default) builds + commits code; "plan" investigates the repo
 * and writes the card's review checklist, then returns it to To-Do.
 */
export function runAgentForCard(path: string, mode: "implement" | "plan" = "implement") {
  return post("/_local/agent/run", { path, mode });
}

/** Stop a card's agent and prune its worktree/branch. */
export function stopAgentForCard(path: string) {
  return post("/_local/agent/stop", { path });
}

/** Merge a finished agent's branch into the current checkout, then clean up. */
export function mergeAgentForCard(path: string) {
  return post("/_local/agent/merge", { path });
}

export interface AgentStatus {
  active: number;
  max: number;
  agents: Record<
    string,
    {
      state: "running" | "done" | "failed";
      mode: "implement" | "plan";
      branch: string;
      worktree: string;
      pid: number | null;
      startedAt: string;
      endedAt: string | null;
      exitCode: number | null;
      log: string[];
    }
  >;
}

/** Snapshot of all known agents (for live status / log tail). */
export async function getAgentStatus(): Promise<AgentStatus> {
  const res = await fetch("/_local/agent/status");
  if (!res.ok) throw new Error(`status failed (${res.status})`);
  return res.json();
}
