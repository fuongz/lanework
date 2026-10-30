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
