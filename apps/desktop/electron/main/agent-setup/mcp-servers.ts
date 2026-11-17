// Remove, disable or enable one of an agent's MCP servers (FE-147), by the
// id `read.ts` gave it, in the file it came from.
//
// NOTE: As `mcp-entry.ts` does for our own entry: only the named server is
// touched, everything else in the file passes through as it was, and every
// write goes through `config-file.ts` (atomic, mode kept, never over a change
// made since the read). A server a plugin brings, and Lanework's own entry
// (its switch is on the Harness page), are refused.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  applyEdits,
  type FormattingOptions,
  modify,
} from "jsonc-parser/lib/esm/main.js";
import {
  type McpServerAction,
  mcpActionRefusal,
  type SetupMcpServer,
  type SetupScope,
} from "../../../shared/agent-setup";
import type { AgentHome } from "../agent-home";
import { updateConfigFile } from "../config-file";
import { runInLoginShell } from "../harness/shell";
import { assertUnlocked } from "./mcp-entry";
import { opencodeConfigPath, parseJsonc, usesV1Layout } from "./opencode";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A name safe to hand a CLI and to match a TOML table header with. */
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

// ── Claude ────────────────────────────────────────────────────────────────────

const json = (text: string | null, path: string): Json => {
  if (text === null) throw new Error(`${path} is not there any more.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isObject(parsed))
    throw new Error(`${path} is not valid JSON, so it was left as it is.`);
  return parsed;
};
const out = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;

/** `servers` without `name`; null when it was not there. */
function without(servers: unknown, name: string): Json | null {
  if (!isObject(servers) || !(name in servers)) return null;
  const { [name]: _, ...rest } = servers;
  return rest;
}

/** `~/.claude.json` with `name` gone from its user or one project's map. */
export function claudeJsonWithout(
  text: string | null,
  path: string,
  name: string,
  folder: string | null,
): string | null {
  const config = json(text, path);
  if (folder === null) {
    const rest = without(config.mcpServers, name);
    return rest ? out({ ...config, mcpServers: rest }) : null;
  }
  const projects = isObject(config.projects) ? config.projects : {};
  const project = isObject(projects[folder]) ? projects[folder] : null;
  const rest = project ? without(project.mcpServers, name) : null;
  if (!project || !rest) return null;
  return out({
    ...config,
    projects: { ...projects, [folder]: { ...project, mcpServers: rest } },
  });
}

/** A repo's `.mcp.json` without `name`. */
export function mcpJsonWithout(
  text: string | null,
  path: string,
  name: string,
): string | null {
  const config = json(text, path);
  const rest = without(config.mcpServers, name);
  return rest ? out({ ...config, mcpServers: rest }) : null;
}

/**
 * `~/.claude.json` with `name` in or out of the folder's
 * `disabledMcpjsonServers`: Claude's own switch for a `.mcp.json` server.
 */
export function claudeJsonSwitched(
  text: string | null,
  path: string,
  name: string,
  folder: string,
  off: boolean,
): string | null {
  const config = json(text, path);
  const projects = isObject(config.projects) ? config.projects : {};
  const project = isObject(projects[folder]) ? projects[folder] : {};
  const list = Array.isArray(project.disabledMcpjsonServers)
    ? project.disabledMcpjsonServers.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const has = list.includes(name);
  if (has === off) return null;
  const next = off ? [...list, name] : list.filter((entry) => entry !== name);
  return out({
    ...config,
    projects: {
      ...projects,
      [folder]: { ...project, disabledMcpjsonServers: next },
    },
  });
}

// ── Codex: `[mcp_servers.<name>]` ──────────────────────────────────────────────

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `name`'s table header, sub-tables included (`.env`). */
const tableOf = (name: string) =>
  new RegExp(
    `^\\[\\s*mcp_servers\\s*\\.\\s*(?:"${escapeRegex(name)}"|${escapeRegex(name)})\\s*(\\..*)?\\]$`,
  );

/**
 * The file's lines, each marked with the table it is in: `name`'s own
 * (`main`), one of its sub-tables (`.env`), or anyone else's. A line inside
 * a multi-line string stays with the table it started in.
 */
function codexRuns(text: string, name: string) {
  const header = tableOf(name);
  const lines: { raw: string; ours: boolean; main: boolean; head: boolean }[] =
    [];
  let state: "none" | "main" | "sub" = "none";
  let multiline: string | null = null;
  for (const raw of text.split("\n")) {
    let head = false;
    if (!multiline) {
      const line = raw.replace(/\s+#.*$/, "").trim();
      if (line.startsWith("[")) {
        const match = header.exec(line);
        state = match ? (match[1] ? "sub" : "main") : "none";
        head = true;
      }
    }
    lines.push({ raw, ours: state !== "none", main: state === "main", head });
    if (multiline) {
      if (raw.split(multiline).length % 2 === 0) multiline = null;
      continue;
    }
    for (const quote of ['"""', "'''"])
      if (raw.split(quote).length % 2 === 0) {
        multiline = quote;
        break;
      }
  }
  return lines;
}

/** `config.toml` without `name`'s table and its sub-tables. */
export function codexWithout(text: string | null, name: string): string | null {
  if (text === null) return null;
  const lines = codexRuns(text, name);
  if (!lines.some((line) => line.ours)) return null;
  const kept = lines.filter((line) => !line.ours).map((line) => line.raw);
  return `${kept.join("\n").replace(/\n+$/, "")}\n`;
}

/** `config.toml` with `enabled = false` in `name`'s table, or without it. */
export function codexSwitched(
  text: string | null,
  name: string,
  off: boolean,
): string | null {
  if (text === null) return null;
  const lines = codexRuns(text, name);
  const start = lines.findIndex((line) => line.head && line.main);
  if (start < 0) throw new Error(`${name} is not in config.toml any more.`);
  const enabledAt = lines.findIndex(
    (line, at) =>
      at > start && line.main && !line.head && /^\s*enabled\s*=/.test(line.raw),
  );
  const raws = lines.map((line) => line.raw);
  if (off) {
    if (enabledAt >= 0) raws[enabledAt] = "enabled = false";
    else raws.splice(start + 1, 0, "enabled = false");
  } else if (enabledAt >= 0) raws.splice(enabledAt, 1);
  else return null;
  const next = raws.join("\n");
  return next === text ? null : next;
}

// ── OpenCode: `mcp.servers.<name>` (2.x) or `mcp.<name>` (1.x) ────────────────

function formatting(text: string): FormattingOptions {
  const indent = /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

function opencodePathOf(text: string, path: string, name: string): string[] {
  const config = parseJsonc(text);
  if (!config)
    throw new Error(`${path} is not valid JSONC, so it was left as it is.`);
  const mcp = isObject(config.mcp) ? config.mcp : {};
  const v1 = usesV1Layout(config);
  const servers = v1 ? mcp : isObject(mcp.servers) ? mcp.servers : {};
  if (!isObject(servers[name]))
    throw new Error(`${name} is not in ${path} any more.`);
  return v1 ? ["mcp", name] : ["mcp", "servers", name];
}

/** OpenCode's config without `name`, comments and layout kept. */
export function opencodeWithout(
  text: string | null,
  path: string,
  name: string,
): string | null {
  if (text === null) return null;
  const at = opencodePathOf(text, path, name);
  return applyEdits(
    text,
    modify(text, at, undefined, { formattingOptions: formatting(text) }),
  );
}

/** OpenCode's config with `name` switched off (`enabled: false`) or on. */
export function opencodeSwitched(
  text: string | null,
  path: string,
  name: string,
  off: boolean,
): string | null {
  if (text === null) return null;
  const at = opencodePathOf(text, path, name);
  const options = { formattingOptions: formatting(text) };
  let next = applyEdits(
    text,
    modify(text, [...at, "enabled"], off ? false : undefined, options),
  );
  // An older spelling, `disabled: true`, would keep it off: it goes too.
  if (!off)
    next = applyEdits(
      next,
      modify(next, [...at, "disabled"], undefined, options),
    );
  return next === text ? null : next;
}

// ── Where, and doing it ────────────────────────────────────────────────────────

/**
 * The file `server` was read from: the ones `read.ts` reads, the first of
 * a scope's spellings that holds it.
 */
function fileOf(
  server: Pick<SetupMcpServer, "agent" | "scope" | "name">,
  where: AgentHome,
  folder: string | null,
): string {
  const need = (scope: SetupScope) => {
    if (scope !== "user" && !folder)
      throw new Error(
        "This server belongs to a project: open it from that project.",
      );
  };
  need(server.scope);
  if (server.agent === "claude") {
    if (server.scope === "project") return join(folder as string, ".mcp.json");
    return where.claudeJson;
  }
  if (server.agent === "codex")
    return server.scope === "project"
      ? join(folder as string, ".codex", "config.toml")
      : join(where.codexDir, "config.toml");
  if (server.scope === "user") return opencodeConfigPath(where.home);
  const found = [
    "opencode.json",
    "opencode.jsonc",
    join(".opencode", "opencode.json"),
    join(".opencode", "opencode.jsonc"),
  ]
    .map((name) => join(folder as string, name))
    .find((path) => existsSync(path));
  if (!found) throw new Error("Its OpenCode config is not there any more.");
  return found;
}

/**
 * Do `action` to `server` in its file.
 *
 * After a remove, a remote server Codex signed in to is signed out
 * (`codex mcp logout`), so its token goes too. Claude Code and OpenCode have
 * no such command; their token, if any, stays in their own store, unused.
 *
 * @returns The file written, for the message.
 * @throws With a reason a person can act on.
 */
export async function editMcpServer(
  server: SetupMcpServer,
  action: McpServerAction,
  where: AgentHome,
  folder: string | null,
): Promise<string> {
  assertUnlocked();
  const refusal = mcpActionRefusal(server, action);
  if (refusal) throw new Error(refusal);
  const { name } = server;
  const path = fileOf(server, where, folder);
  const off = action === "disable";

  if (server.agent === "claude") {
    if (action === "remove") {
      await updateConfigFile(path, (text) =>
        server.scope === "project"
          ? mcpJsonWithout(text, path, name)
          : claudeJsonWithout(
              text,
              path,
              name,
              server.scope === "local" ? folder : null,
            ),
      );
      return path;
    }
    // A `.mcp.json` server's switch is in `~/.claude.json`, per folder.
    await updateConfigFile(where.claudeJson, (text) =>
      claudeJsonSwitched(text, where.claudeJson, name, folder as string, off),
    );
    return where.claudeJson;
  }

  if (server.agent === "codex") {
    await updateConfigFile(path, (text) =>
      action === "remove"
        ? codexWithout(text, name)
        : codexSwitched(text, name, off),
    );
    if (
      action === "remove" &&
      server.transport !== "stdio" &&
      SAFE_NAME.test(name)
    )
      // Best effort: a server never signed in to has nothing to log out.
      await runInLoginShell(
        `command -v codex >/dev/null 2>&1 && codex mcp logout '${name}' </dev/null >/dev/null 2>&1; true`,
        { timeoutMs: 15_000 },
      ).catch(() => {});
    return path;
  }

  await updateConfigFile(path, (text) =>
    action === "remove"
      ? opencodeWithout(text, path, name)
      : opencodeSwitched(text, path, name, off),
  );
  return path;
}
