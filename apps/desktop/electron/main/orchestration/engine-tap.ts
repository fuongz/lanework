// What the conversation engines tell orchestration (FE-87), and what they ask
// it, without importing it.
//
// The engines (`conversation/engine.ts`, `conversation/codex-engine.ts`) run
// every chat's CLI. A run's lead and workers are ordinary conversations, so
// orchestration listens here instead of wrapping them:
//
// - `env`: the extra environment one CLI process starts with. The lead gets
//   the control endpoint and its token; a worker gets its private scratch as
//   TMPDIR. Every other process gets neither.
// - `event`: every event an engine emits, with the folder it runs in.
// - `write`: a tool call that writes files, as soon as the CLI names it.
// - `result`: the text a turn ended with.
// - `guard`: whether a process is a lead whose run is active or paused
//   (FE-136/D1). Its edit tools are off: Claude starts without them, Codex
//   runs read-only so a write asks. Asked again when each turn starts.
// - `worker`: whether a process is a run worker's (FE-165). Its permission
//   requests are orchestration's to answer, after its write-scope guard, so
//   the engine never answers one from the project's rules itself.
//
// A conductor's sessions add their own `env` (`setSessionsEnv`): the token
// any conversation but a worker's starts with, checked on each call.
//
// Nothing here imports Electron or the engines.

import { SESSIONS_ENV } from "../../../shared/conductor-sessions";
import type { ConversationEvent } from "../../../shared/conversation";
import { CONTROL_ENV } from "../../../shared/orchestration";

/** Which process an engine is about to start. */
export interface EngineTarget {
  project: string;
  /** Null for a Codex conversation Codex has not named yet. */
  conversation: string | null;
  /** The folder it runs in: a worker's is its own worktree. */
  folder: string;
  /**
   * The conversation's id as it is now: a new Codex conversation's is named
   * after its process started.
   */
  named?: () => string | null;
}

/** A tool call that writes files. */
export interface EngineWrite extends EngineTarget {
  /** As the CLI names it: `Edit`, `Write`, `apply_patch`. */
  tool: string;
  /** As the CLI gave them: absolute, or relative to `folder`. */
  paths: string[];
}

/** A turn's last answer. */
export interface EngineResult extends EngineTarget {
  text: string;
  /** The CLI said the turn failed. */
  error: boolean;
}

export interface EngineTap {
  env?: (target: EngineTarget) => Record<string, string> | null;
  event?: (event: ConversationEvent, folder: string) => void;
  write?: (write: EngineWrite) => void;
  result?: (result: EngineResult) => void;
  guard?: (target: EngineTarget) => boolean;
  worker?: (target: EngineTarget) => boolean;
}

let tap: EngineTap = {};
let sessionsEnv: EngineTap["env"];

/** Install orchestration's listeners; `{}` removes them. */
export function setEngineTap(next: EngineTap): void {
  tap = next;
}

/** Install a conductor's sessions' env; undefined removes it. */
export function setSessionsEnv(next: EngineTap["env"]): void {
  sessionsEnv = next;
}

/** The listeners now installed. */
export function engineTap(): EngineTap {
  return tap;
}

/**
 * The environment one engine process starts with.
 *
 * The control variables are always removed first, even when the app itself
 * was started with them (from a lead's own terminal): only the tap may give
 * them, and it gives them to a lead alone. The sessions token goes to every
 * process but a worker's; only a conductor's may use it.
 */
export function agentEnv(
  base: Record<string, string>,
  target: EngineTarget,
): Record<string, string> {
  const env = { ...base };
  delete env[CONTROL_ENV.endpoint];
  delete env[CONTROL_ENV.token];
  delete env[SESSIONS_ENV.token];
  delete env[SESSIONS_ENV.cli];
  const extra = (give: EngineTap["env"]) => {
    try {
      return give?.(target) ?? null;
    } catch {
      return null;
    }
  };
  // The run's env last: a worker's scratch, or a lead's own endpoint.
  return { ...env, ...extra(sessionsEnv), ...extra(tap.env) };
}

/**
 * Whether `target` is a lead whose run is active or paused (FE-136/D1): its
 * edit tools are off. False when nothing answers, or the answer throws.
 */
export function leadGuarded(target: EngineTarget): boolean {
  try {
    return tap.guard?.(target) === true;
  } catch {
    return false;
  }
}

/**
 * Whether `target` runs a run worker (FE-165): orchestration answers its
 * permission requests. True when the answer throws: an engine then leaves
 * the request alone rather than answer what a scope guard might refuse.
 */
export function runWorker(target: EngineTarget): boolean {
  try {
    return tap.worker?.(target) === true;
  } catch {
    return true;
  }
}

/**
 * What one process may reach of the user's MCP servers (FE-166), fixed when
 * it starts.
 */
export interface ConnectorPlan {
  /** Server names to turn off for this process. */
  disabled: string[];
  /**
   * Claude only: start with only the servers in `--mcp-config`
   * (`--strict-mcp-config`), the way a run worker does.
   */
  strict: boolean;
}

/** Where a process's disabled connectors come from; main installs it. */
export interface ConnectorSource {
  /**
   * The names the conductor behind `target` turned off; [] for a process
   * that is no conductor's. Called at each process start, so it must do no
   * work for a conversation no conductor owns.
   */
  disabled: (
    target: EngineTarget,
    agent: "claude" | "codex",
    conductor: boolean,
  ) => string[] | Promise<string[]>;
  /**
   * The user's non-Lanework servers of `project` as last cached, for a
   * worker's process; never starts a scan of its own account.
   */
  all: (project: string, agent: "claude" | "codex") => Promise<string[]>;
}

let connectorSource: ConnectorSource | undefined;

/** Install the connector source; undefined removes it. */
export function setConnectorSource(next: ConnectorSource | undefined): void {
  connectorSource = next;
}

/**
 * The connectors `target`'s process starts with, or null for all of them.
 *
 * - A run worker gets only Lanework's servers: Claude with
 *   `--strict-mcp-config` when `strictOk` (the args then carry the local
 *   board and the kit themselves), else every cached non-Lanework server
 *   switched off; Codex the same switch-off. (OpenCode has no per-process
 *   switch, see `connectors/flags.ts`.)
 * - Any other process gets what its conductor disabled: `inherited` when
 *   the caller already knows it (a session a conductor starts), else the
 *   source's answer.
 *
 * NOTE: Built from stored names only. No scan, no timer, no watcher; a
 * process nothing is disabled for costs a few lookups.
 */
export async function connectorPlan(
  target: EngineTarget,
  agent: "claude" | "codex",
  options: {
    conductor: boolean;
    inherited?: readonly string[];
    strictOk?: boolean;
  },
): Promise<ConnectorPlan | null> {
  let worker = false;
  try {
    worker = tap.worker?.(target) === true;
  } catch {
    worker = false;
  }
  try {
    if (worker) {
      if (agent === "claude" && options.strictOk)
        return { disabled: [], strict: true };
      const names = (await connectorSource?.all(target.project, agent)) ?? [];
      return names.length ? { disabled: names, strict: false } : null;
    }
    let names = options.inherited?.length
      ? [...options.inherited]
      : ((await connectorSource?.disabled(target, agent, options.conductor)) ??
        []);
    // Codex refuses to start when told to switch off a server its config no
    // longer has (see `codexMcpArgs`), so a stale stored name is dropped.
    // Only reached when something is disabled; `all` is memoized per folder.
    if (agent === "codex" && names.length && connectorSource) {
      const known = new Set(await connectorSource.all(target.project, agent));
      names = names.filter((name) => known.has(name));
    }
    return names.length ? { disabled: names, strict: false } : null;
  } catch {
    // A list that cannot be read starts the process as it always did.
    return null;
  }
}

/** Tools that write the file their input names. */
export const WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * The paths a Claude `tool_use` block writes, or null when it writes none.
 */
export function writtenPaths(block: unknown): string[] | null {
  const value = (block ?? {}) as Record<string, unknown>;
  if (value.type !== "tool_use" || typeof value.name !== "string") return null;
  if (!WRITE_TOOLS.has(value.name)) return null;
  const input = (value.input ?? {}) as Record<string, unknown>;
  const path =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.notebook_path === "string"
        ? input.notebook_path
        : null;
  return path ? [path] : null;
}

/** Call a listener, never letting it break the engine that called. */
export function safely(run: () => void): void {
  try {
    run();
  } catch {
    // A listener's failure is its own.
  }
}
