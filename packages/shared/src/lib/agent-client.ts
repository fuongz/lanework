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

export type AgentMode = "implement" | "plan";
/** Reasoning effort, mapped to the `claude --effort` flag ("" = CLI default). */
export type AgentEffort = "" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RunOptions {
  mode?: AgentMode;
  /** Claude model alias/id (e.g. "opus", "sonnet", "haiku"); "" = CLI default. */
  model?: string;
  effort?: AgentEffort;
}

/** Selectable models for the run UI. "" = whatever `claude` is configured to use. */
export const AGENT_MODELS: { value: string; label: string }[] = [
  { value: "", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/** Selectable reasoning efforts for the run UI (the `claude --effort` levels). */
export const AGENT_EFFORTS: { value: AgentEffort; label: string }[] = [
  { value: "", label: "Default effort" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

/** Selectable run modes for the UI. */
export const AGENT_MODES: { value: AgentMode; label: string }[] = [
  { value: "implement", label: "Implement" },
  { value: "plan", label: "Plan" },
];

/**
 * Dispatch a Claude Code agent for a card (worktree + headless run).
 * `mode` "implement" (default) builds + commits code; "plan" investigates the repo
 * and writes the card's review checklist, then returns it to To-Do. `model` and
 * `effort` map to the `claude --model` / `--effort` flags (omit for CLI defaults).
 */
export function runAgentForCard(path: string, opts: RunOptions = {}) {
  return post("/_local/agent/run", { path, ...opts });
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
      /** The model/effort this run was dispatched with (null = CLI default). */
      model: string | null;
      effort: string | null;
      branch: string;
      worktree: string;
      pid: number | null;
      startedAt: string;
      endedAt: string | null;
      exitCode: number | null;
      /** Per-model token usage from this agent's worktree transcript (or null). */
      usage:
        | {
            model: string;
            messages: number;
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite5m: number;
            cacheWrite1h: number;
          }[]
        | null;
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
