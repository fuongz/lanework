// The CLI flags that point one agent process at the local board server
// (FE-121/D9). Pure, so the engines and their tests use them without main.
//
// Which conversations need them is `mcp-binding.ts`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_ENV } from "../../../shared/conductor-sessions";
import { CONTROL_ENV } from "../../../shared/orchestration";
import { lwkBinaryPath } from "../agent-setup/lwk-install";
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
  "LANEWORK_CONTROL_AS",
] as const;

/**
 * Set to `conductor` on a conductor's (or a lead's) process, so the control
 * server lists the conductor tools there only. Every conversation the app
 * starts holds a sessions token (it may save a conductor), so the token
 * alone does not say whose conversation it is.
 */
export const CONTROL_ROLE_ENV = "LANEWORK_CONTROL_AS";

/**
 * The control tools a conductor's process calls without a permission
 * prompt, by their MCP names.
 *
 * NOTE: Each one only reaches the conductor's own sessions and memory, or
 * reads the model catalog: asking the user before every call buried the
 * work under prompts. `sessions_answer` is left out on purpose: it allows
 * a tool in a session the user cannot see, so in an asking mode the user
 * still confirms it. `conductors_create` saves a conductor, which is the
 * user's to approve.
 */
export const CONDUCTOR_ALLOWED_TOOLS = [
  "sessions_start",
  "sessions_list",
  "sessions_read",
  "sessions_send",
  "sessions_access",
  "memory_read",
  "memory_append",
  "memory_write",
  "models_list",
  "thread_read",
  "conversations_list",
  "conversation_message",
] as const;

/**
 * The control tools EVERY process with the control server calls without a
 * permission prompt: `thread_read` (BE-03) only reads back the caller's own
 * thread, which its transcript already holds.
 */
export const ANY_ALLOWED_TOOLS = [
  "thread_read",
  // PD-06: the app decides who may message whom, and asks the user on a
  // pair's first message, so the tool itself needs no prompt.
  "conversations_list",
  "conversation_message",
] as const;

/**
 * The control tools a process runs without asking: a conductor's or any
 * other's list, `thread_read` left out when `threadRead` is false (a CLI
 * older than Lanework's floor, FE-168/D2).
 */
function allowedTools(conductor: boolean, threadRead: boolean): string[] {
  const tools: readonly string[] = conductor
    ? CONDUCTOR_ALLOWED_TOOLS
    : ANY_ALLOWED_TOOLS;
  return tools.filter((tool) => threadRead || tool !== "thread_read");
}

/**
 * Claude Code's `--allowedTools` for a process with the control server: the
 * {@link CONDUCTOR_ALLOWED_TOOLS} on a conductor's, the
 * {@link ANY_ALLOWED_TOOLS} on any other, under the server's prefix.
 *
 * NOTE: An allow rule only skips the prompt in the asking modes; a deny
 * rule (a guarded lead's `--disallowedTools`, the user's settings) still
 * wins over it, so the two flags need no merging.
 */
export function claudeControlAllowArgs(
  conductor = false,
  threadRead = true,
): string[] {
  const tools = allowedTools(conductor, threadRead);
  if (!tools.length) return [];
  return [
    "--allowedTools",
    tools.map((tool) => `mcp__${CONTROL_SERVER}__${tool}`).join(","),
  ];
}

/**
 * Whether `text`, the turn a process is started for, is a conductor's: the
 * app wraps every conductor message, and every report and run update it
 * sends one, in one of these hidden blocks. A plain session's never is.
 */
export function isConductorTurn(text: string): boolean {
  return /^\s*<lanework_(conductor|sessions|orchestration)\b/.test(text);
}

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
  // The app writes it at launch (`ensureControlMcpShim`); a copy that may
  // not (a DMG, an AppImage) attaches nothing rather than a server that
  // cannot start.
  const shim = controlShimPath();
  return existsSync(shim) ? shim : null;
}

/** The kit's MCP server name, the same as the user-config entry it overrides. */
export const KIT_SERVER = "lanework-kit";

/** How a process reaches the kit: this build's `lwk mcp`, on this app's home. */
export interface KitMcp {
  command: string;
  home: string;
}

/**
 * This build's `lwk mcp` for an agent process, or null (FE-158).
 *
 * The `lanework-kit` entry in the agents' user config runs the INSTALLED
 * app's shim, so a conversation started by the Preview (or any build but the
 * one the shim points at) would search through another app's kit.sock.
 * Unless the kit backend is `ts`, the app overrides that entry for the
 * processes it starts with its own lwk, whose socket is this app's home. The
 * backend is read as `kit-socket.ts` reads it: `LANEWORK_KIT_BACKEND`, else
 * `backend` in `<app home>/kit.json`, else `lwk-shadow` (FE-161).
 */
export function kitMcpFor(
  home = appHomeDir(),
  command = lwkBinaryPath(),
): KitMcp | null {
  let backend: unknown = process.env.LANEWORK_KIT_BACKEND;
  if (!backend) {
    try {
      backend = (
        JSON.parse(readFileSync(join(home, "kit.json"), "utf8")) as {
          backend?: unknown;
        }
      ).backend;
    } catch {
      backend = undefined;
    }
  }
  // FE-161: every backend but `ts` answers from lwk or compares it.
  if (backend === "ts") return null;
  return existsSync(command) ? { command, home } : null;
}

/**
 * What a process told to use the kit is told (FE-158), given with the other
 * hints when {@link kitMcpFor} attaches this build's lwk. Agents reach for
 * the shell by habit (`grep -r … | head`, `cat`, `sed -n`), and Claude Code
 * loads MCP tools on demand, so without this the kit goes unused.
 *
 * NOTE: Input names are the kit contract's (`lanework-kit` contract/kit.json).
 */
export const KIT_HINT = [
  "Lanework: the `lanework-kit` MCP server is this project's search. It respects .gitignore, skips binaries, stays inside the project and caps its answers. Search with it, not with the shell:",
  "- A file by (part of) its name, typos allowed: `find_files` (`query`), not find, fd, ls -R or `git ls-files | grep`.",
  "- Text in files: `search_text` (`query` is literal; `regex: true` for a pattern; `case_sensitive`; `globs` such as `*.ts` or `!*.test.ts`; `path` for one folder or one file), not grep -r, rg or git grep.",
  "- Code by its shape (definitions, calls, imports, JSX): `search_structural` with an ast-grep `pattern` and `lang`, e.g. `useEffect($A, [])` (tsx), `def $F($$$ARGS): $$$BODY` (python), `fn $F($$$ARGS) -> $R { $$$BODY }` (rust), not a regex grep.",
  "- The files under a folder: `list_files` (`path`), not ls -R or `find . -type f`.",
  "- What an earlier agent conversation in this project said or did: `search_sessions` (`query`), not grep over ~/.claude or ~/.codex.",
  "An empty answer is complete: nothing in the project's searchable files matches, so do not search again with grep or find to double-check. Use the shell only for what the kit leaves out on purpose (files .gitignore excludes, such as node_modules, dist or .env, and git history), and only when the question is about those.",
  "Answers are already capped (`limit`, `max_lines`), so never pipe them through head. Once a search has given you the file and line, read just that part with your file-reading tool (an offset and a limit), not cat, head or sed -n. Keep the shell for running things: git, builds, package scripts. If your tools load on demand, load lanework-kit's before your first search.",
].join("\n");

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
  kit: KitMcp | null = null,
): string[] {
  if (!shim && !control && !kit) return [];
  const mcpServers: Record<string, unknown> = {};
  if (shim) mcpServers.lanework = { type: "stdio", command: shim, args: [] };
  // A server named as the user's entry replaces it for this process.
  if (kit)
    mcpServers[KIT_SERVER] = {
      type: "stdio",
      command: kit.command,
      args: ["mcp"],
      env: { LANEWORK_HOME: kit.home },
    };
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
 *
 * A `conductor`'s process approves the {@link CONDUCTOR_ALLOWED_TOOLS}
 * up front, any other the {@link ANY_ALLOWED_TOOLS}, as Claude's
 * `--allowedTools` does: Codex takes an `approval_mode` per MCP tool
 * (`approve` skips the prompt). Every other tool keeps Codex's default, so
 * `sessions_answer` asks as the session's policy says.
 */
export function codexControlArgs(
  control: string,
  conductor = false,
  threadRead = true,
): string[] {
  const allowed = allowedTools(conductor, threadRead);
  const tools = allowed.length
    ? `,tools={${allowed.map((tool) => `${tool}={approval_mode="approve"}`).join(",")}}`
    : "";
  return [
    "-c",
    `mcp_servers.${CONTROL_SERVER}={command=${JSON.stringify(control)},args=[],env_vars=${JSON.stringify([...CONTROL_FORWARD])}${tools}}`,
  ];
}

/**
 * Codex's `-c` override for the kit (FE-158): the whole `lanework-kit` table,
 * so the user's entry is replaced for this process, not merged into.
 */
export function codexKitArgs(kit: KitMcp): string[] {
  return [
    "-c",
    `mcp_servers.${KIT_SERVER}={command=${JSON.stringify(kit.command)},args=["mcp"],env={LANEWORK_HOME=${JSON.stringify(kit.home)}}}`,
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

/**
 * Which Lanework board this conversation's project is, told to the agent at
 * start: the app knows it, so the agent need not find it from `git remote`
 * (which a repo with no origin cannot answer) or ask.
 */
export function boardHint(board: { id: string; name: string }): string {
  return `Lanework: this conversation runs in the project ${JSON.stringify(board.name)}; its Lanework board is board_id ${JSON.stringify(board.id)}. Use that board for every Lanework board tool; do not look it up from git remote or ask which board.`;
}

/** The hints a process starts with, joined; null when there are none. */
export function joinHints(...hints: (string | null)[]): string | null {
  const kept = hints.filter((hint): hint is string => !!hint);
  return kept.length ? kept.join("\n\n") : null;
}
