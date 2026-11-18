// The CLI flags that point one agent process at the local board server
// (FE-121/D9). Pure, so the engines and their tests use them without main.
//
// Which conversations need them is `mcp-binding.ts`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_ENV } from "../../../shared/conductor-sessions";
import { CONTROL_ENV } from "../../../shared/orchestration";
import { appHomeDir } from "../paths";

/** The MCP server name of the control tools (FE-155). */
export const CONTROL_SERVER = "lanework_control";

/**
 * The variables the control shim reads. Codex and Claude start an MCP server
 * with a reduced environment, so each is forwarded by name, never by value
 * (a value would show in the process list).
 */
export const CONTROL_FORWARD = [
  SESSIONS_ENV.token,
  CONTROL_ENV.token,
  CONTROL_ENV.endpoint,
  SESSIONS_ENV.cli,
] as const;

/** The control MCP shim, which the app installs under its home. */
export function controlShimPath(): string {
  return join(appHomeDir(), "bin", "lanework-control-mcp");
}

/**
 * The control shim for a process with this env, or null: only a process that
 * carries a conductor sessions token or a run control token gets it.
 */
export function controlMcpFor(
  env: Record<string, string | undefined>,
): string | null {
  if (!env[SESSIONS_ENV.token] && !env[CONTROL_ENV.token]) return null;
  // The app writes it at launch (`ensureControlMcpShim`); a build that may
  // not (dev) attaches nothing rather than a server that cannot start.
  const shim = controlShimPath();
  return existsSync(shim) ? shim : null;
}

/**
 * Claude Code's single `--mcp-config`: `lanework` (the local board shim) and/or
 * `lanework_control` (the control shim). Claude takes one flag, so both go in
 * one object; no shim at all gives no flag.
 *
 * The control entry's env uses Claude's `${VAR:-}` expansion, which keeps the
 * tokens out of the argument list.
 */
export function claudeMcpArgs(
  shim: string | null,
  control: string | null = null,
): string[] {
  if (!shim && !control) return [];
  const mcpServers: Record<string, unknown> = {};
  if (shim) mcpServers.lanework = { type: "stdio", command: shim, args: [] };
  if (control)
    mcpServers[CONTROL_SERVER] = {
      type: "stdio",
      command: control,
      args: [],
      env: Object.fromEntries(CONTROL_FORWARD.map((k) => [k, `\${${k}:-}`])),
    };
  return ["--mcp-config", JSON.stringify({ mcpServers })];
}

/**
 * Codex's `-c` override for the control shim. Codex starts MCP servers with a
 * cleared environment; `env_vars` names the variables it copies from its own.
 */
export function codexControlArgs(control: string): string[] {
  return [
    "-c",
    `mcp_servers.${CONTROL_SERVER}={command=${JSON.stringify(control)},args=[],env_vars=${JSON.stringify([...CONTROL_FORWARD])}}`,
  ];
}

/**
 * Codex's `-c` overrides for the local server.
 *
 * NOTE: Codex MERGES an override into the configured table, and refuses a
 * `lanework` with both the cloud `url` and a `command`. So the cloud entry is
 * switched off for this process and the local one runs beside it as
 * `lanework_local`. Switching off an entry that is not there is refused
 * too, so that override is sent only when the config has one.
 */
export function codexMcpArgs(shim: string, configured: boolean): string[] {
  return [
    ...(configured ? ["-c", "mcp_servers.lanework.enabled=false"] : []),
    "-c",
    `mcp_servers.lanework_local={command=${JSON.stringify(shim)},args=[]}`,
  ];
}

/**
 * Codex's `-c` override that tells it `hint` as developer instructions
 * (BE-01). Only for a config without `developer_instructions` of its own:
 * an override replaces the user's, it does not add to it.
 */
export function codexHintArgs(hint: string): string[] {
  return ["-c", `developer_instructions=${JSON.stringify(hint)}`];
}
