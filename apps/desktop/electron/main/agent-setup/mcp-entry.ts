// The `lanework` MCP server entry in Claude Code's and Codex's user config
// (FE-52/D8): the offline server over stdio while the app runs on the local
// board, the cloud one over HTTP once signed in.
//
// ⚠️ Only OUR entry, ever. `~/.claude.json` holds every project Claude Code has
// seen and every other MCP server the user added; `~/.codex/config.toml` is
// Codex's whole configuration. Everything but the `lanework` entry is passed
// through untouched, a file that is not what we can safely rewrite is refused,
// and every write is atomic (temp file + rename).
//
// ⚠️ Electron-free, so a spec can drive it against a fake home. The paths come
// from `agentHome`, which follows `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` — the
// variables every test launch sets — and the app home follows `LANEWORK_HOME`.
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { MCP_HOST, MCP_URL } from "../../../shared/agent-notes";
import type {
  LaneworkMcpAgent,
  LaneworkMcpEntry,
  LaneworkMcpMode,
  LaneworkMcpStatus,
} from "../../../shared/auth";
import { type AgentHome, agentHome } from "../agent-home";
import { shellQuote } from "../handoff/claude-settings";
import { appHomeDir } from "../paths";

export const MCP_NAME = "lanework";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where the agents' config is read from. `registerAgentSetup` points this at
 * the same home the setup view reads (the dev-build test seam included).
 */
let resolveHome: () => AgentHome = () => agentHome(homedir());

export function setMcpHome(resolver: () => AgentHome): void {
  resolveHome = resolver;
}

/** `~/.lanew/bin/lanework-mcp` — what a stdio entry runs. */
export function mcpShimPath(): string {
  return join(appHomeDir(), "bin", "lanework-mcp");
}

/**
 * The offline MCP server's bundle (W3: `dist/electron/mcp-local/server.cjs`),
 * outside the asar archive — the hook bundle's rule, for the same reason: a
 * plain Node (`ELECTRON_RUN_AS_NODE`) cannot read a path inside `app.asar`.
 */
export function mcpServerPath(mainDir: string = __dirname): string {
  return join(mainDir, "..", "mcp-local", "server.cjs").replace(
    `app.asar${sep}`,
    `app.asar.unpacked${sep}`,
  );
}

/**
 * The script a stdio entry points at, rewritten on every launch.
 *
 * ⚠️ A script and not the command itself, like the hook's shim: the app's
 * binary and the bundle move with every update, and the entry in the agents'
 * config never has to. `LANEWORK_HOME` is pinned so the server opens the SAME
 * `data.sqlite` this app does, whatever environment the agent was started in.
 */
export function buildMcpShim(options: {
  execPath: string;
  serverPath: string;
  home: string;
}): string {
  return [
    "#!/bin/sh",
    "# Lanework's offline MCP server (FE-52). The Lanework app rewrites this",
    "# file on every launch; edits here are lost.",
    "export ELECTRON_RUN_AS_NODE=1",
    `export LANEWORK_HOME=${shellQuote(options.home)}`,
    `exec ${shellQuote(options.execPath)} ${shellQuote(options.serverPath)} "$@"`,
    "",
  ].join("\n");
}

async function writeMcpShim(
  execPath: string = process.execPath,
): Promise<string> {
  const path = mcpShimPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    buildMcpShim({
      execPath,
      serverPath: mcpServerPath(),
      home: appHomeDir(),
    }),
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

// ── Claude Code: `~/.claude.json` `mcpServers.lanework` ──────────────────────

function claudeEntry(mode: LaneworkMcpMode, shim = mcpShimPath()) {
  return mode === "local"
    ? { type: "stdio", command: shim, args: [] as string[] }
    : { type: "http", url: MCP_URL };
}

/** What one config entry points at, or null when it is not one we can read. */
function modeOf(
  entry: { command?: unknown; url?: unknown },
  shim: string,
): LaneworkMcpMode | null {
  if (typeof entry.url === "string" && entry.url.includes(MCP_HOST))
    return "cloud";
  if (entry.command === shim) return "local";
  return null;
}

/**
 * A shim of this app's that can no longer be the one meant: the offline
 * server's `<home>/bin/lanework-mcp`, but from ANOTHER app home that is a
 * temp folder (a test or verification run's `LANEWORK_HOME`) or is gone.
 *
 * ⚠️ Only those two. A shim from a home that is still there — a dev build's —
 * is that build's entry and stays the user's, or the two apps would take the
 * entry from each other on every launch. A stale one is ours to fix: it
 * points every Claude Code or Codex session at a board nobody uses.
 */
export function isStaleShim(command: unknown, shim: string): boolean {
  if (typeof command !== "string" || command === shim) return false;
  if (!/[/\\]bin[/\\]lanework-mcp$/.test(command)) return false;
  const temp = [tmpdir(), "/tmp", "/private/tmp", "/var/folders"];
  return (
    temp.some((dir) => command.startsWith(`${dir}${sep}`)) ||
    !existsSync(command)
  );
}

function claudeState(
  json: Json,
  shim = mcpShimPath(),
): Omit<LaneworkMcpEntry, "configPath" | "unreadable"> {
  const servers = isObject(json.mcpServers) ? json.mcpServers : {};
  const entry = servers[MCP_NAME];
  if (!isObject(entry))
    return { installed: false, ours: false, mode: null, transport: null };
  const mode = modeOf(entry, shim);
  return {
    installed: true,
    // A stale shim is ours with no mode: the sync below then rewrites it.
    ours: mode !== null || isStaleShim(entry.command, shim),
    mode,
    transport:
      typeof entry.url === "string"
        ? "http"
        : typeof entry.command === "string"
          ? "stdio"
          : null,
  };
}

/** `json` with our entry set to `mode`; every other key as it was. */
export function withClaudeMcp(
  json: Json,
  mode: LaneworkMcpMode,
  shim = mcpShimPath(),
): Json {
  const servers = isObject(json.mcpServers) ? json.mcpServers : {};
  return {
    ...json,
    mcpServers: { ...servers, [MCP_NAME]: claudeEntry(mode, shim) },
  };
}

function withoutClaudeMcp(json: Json): Json {
  if (!isObject(json.mcpServers) || !(MCP_NAME in json.mcpServers)) return json;
  const { [MCP_NAME]: _, ...rest } = json.mcpServers;
  return { ...json, mcpServers: rest };
}

// ── Codex: `config.toml` `[mcp_servers.lanework]` ────────────────────────────

const OUR_TABLE =
  /^\[\s*mcp_servers\s*\.\s*(?:"lanework"|lanework)\s*(?:\..*)?\]$/;

/** Splits the file into our table's lines and everyone else's. */
function splitCodex(text: string): { kept: string[]; ours: string[] } {
  const kept: string[] = [];
  const ours: string[] = [];
  let inOurs = false;
  let multiline: string | null = null;
  for (const raw of text.split("\n")) {
    if (multiline) {
      (inOurs ? ours : kept).push(raw);
      if (raw.split(multiline).length % 2 === 0) multiline = null;
      continue;
    }
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line.startsWith("[")) inOurs = OUR_TABLE.test(line);
    (inOurs ? ours : kept).push(raw);
    for (const quote of ['"""', "'''"])
      if (raw.split(quote).length % 2 === 0) {
        multiline = quote;
        break;
      }
  }
  return { kept, ours };
}

function codexValue(lines: string[], key: string): string | null {
  for (const raw of lines) {
    const match = new RegExp(
      `^\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`,
    ).exec(raw);
    if (match) return (match[1] ?? match[2] ?? "").replace(/\\(["\\])/g, "$1");
  }
  return null;
}

export function codexState(
  text: string,
  shim = mcpShimPath(),
): Omit<LaneworkMcpEntry, "configPath" | "unreadable"> {
  const { ours } = splitCodex(text);
  if (!ours.length)
    return { installed: false, ours: false, mode: null, transport: null };
  const url = codexValue(ours, "url");
  const command = codexValue(ours, "command");
  const mode = modeOf({ url, command }, shim);
  return {
    installed: true,
    ours: mode !== null || isStaleShim(command, shim),
    mode,
    transport: url !== null ? "http" : command !== null ? "stdio" : null,
  };
}

const tomlQuote = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function withoutCodexMcp(text: string): string {
  const { kept, ours } = splitCodex(text);
  if (!ours.length) return text;
  return `${kept.join("\n").replace(/\n+$/, "")}\n`;
}

/** `text` with our table set to `mode`, appended at the end; the rest as it was. */
export function withCodexMcp(
  text: string,
  mode: LaneworkMcpMode,
  shim = mcpShimPath(),
): string {
  const rest = withoutCodexMcp(text).replace(/\n+$/, "");
  const table = [
    `[mcp_servers.${MCP_NAME}]`,
    mode === "local"
      ? `command = ${tomlQuote(shim)}`
      : `url = ${tomlQuote(MCP_URL)}`,
  ].join("\n");
  return `${rest ? `${rest}\n\n` : ""}${table}\n`;
}

// ── Files ────────────────────────────────────────────────────────────────────

async function readOptional(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.lanework-${process.pid}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

function parseObject(text: string | null): Json | null {
  if (text === null || !text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const configPathOf = (agent: LaneworkMcpAgent, home = resolveHome()) =>
  agent === "codex" ? join(home.codexDir, "config.toml") : home.claudeJson;

async function entryStatus(agent: LaneworkMcpAgent): Promise<LaneworkMcpEntry> {
  const configPath = configPathOf(agent);
  const text = await readOptional(configPath).catch(() => null);
  if (agent === "codex")
    return {
      ...codexState(text ?? ""),
      configPath,
      unreadable: false,
    };
  const json = parseObject(text);
  if (!json)
    return {
      installed: false,
      ours: false,
      mode: null,
      transport: null,
      configPath,
      unreadable: true,
    };
  return { ...claudeState(json), configPath, unreadable: false };
}

/** What Settings → Agents shows for the `lanework` MCP entry. */
export async function laneworkMcpStatus(
  want: LaneworkMcpMode | null,
): Promise<LaneworkMcpStatus> {
  const [claude, codex] = await Promise.all([
    entryStatus("claude-code"),
    entryStatus("codex"),
  ]);
  return { want, shimPath: mcpShimPath(), claude, codex };
}

/** Write our entry for `agent`, pointed at `mode`. Replaces any `lanework` entry. */
export async function installLaneworkMcp(
  agent: LaneworkMcpAgent,
  mode: LaneworkMcpMode,
): Promise<void> {
  const path = configPathOf(agent);
  const text = await readOptional(path);
  if (mode === "local") await writeMcpShim();
  if (agent === "codex") {
    const next = withCodexMcp(text ?? "", mode);
    if (next !== text) await writeAtomic(path, next);
    return;
  }
  const json = parseObject(text);
  if (!json)
    throw new Error(
      `${path} is not valid JSON. Fix or remove it, then try again — Lanework will not overwrite it.`,
    );
  await writeAtomic(
    path,
    `${JSON.stringify(withClaudeMcp(json, mode), null, 2)}\n`,
  );
}

/** Remove the `lanework` entry for `agent`; other servers are left alone. */
export async function removeLaneworkMcp(
  agent: LaneworkMcpAgent,
): Promise<void> {
  const path = configPathOf(agent);
  const text = await readOptional(path);
  if (text === null) return;
  if (agent === "codex") {
    const next = withoutCodexMcp(text);
    if (next !== text) await writeAtomic(path, next);
    return;
  }
  const json = parseObject(text);
  if (!json)
    throw new Error(
      `${path} is not valid JSON. Fix or remove it, then try again — Lanework will not overwrite it.`,
    );
  const next = withoutClaudeMcp(json);
  if (next !== json)
    await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** The entry a principal's session wants, or null when there is none to want. */
export function modeFor(
  kind: "anonymous" | "machine" | "revoked" | "local",
): LaneworkMcpMode | null {
  return kind === "machine" ? "cloud" : kind === "local" ? "local" : null;
}

/**
 * Bring entries that are already OURS in line with the session: stdio while
 * local, HTTP once signed in. Rewrites the shim when a stdio entry needs it.
 *
 * ⚠️ Never ADDS an entry and never touches a `lanework` entry that points
 * somewhere else — a self-hosted server, a dev build — which is the user's.
 * A stale shim of ours (`isStaleShim`) is ours, with no mode, so it is
 * rewritten to the one this app runs.
 * Signed out (anonymous, revoked) leaves everything as it is.
 */
export async function syncLaneworkMcp(
  kind: "anonymous" | "machine" | "revoked" | "local",
): Promise<void> {
  const mode = modeFor(kind);
  if (!mode) return;
  const agents = ["claude-code", "codex"] as const;
  const statuses = await Promise.all(
    agents.map((agent) => entryStatus(agent).catch(() => null)),
  );
  // The shim is rewritten whenever a stdio entry of ours will run it — this
  // build's binary and bundle, not the last one's.
  if (statuses.some((status) => status?.ours && mode === "local"))
    await writeMcpShim();
  for (const [index, agent] of agents.entries()) {
    const status = statuses[index];
    if (!status?.ours || status.mode === mode) continue;
    await installLaneworkMcp(agent, mode).catch(() => undefined);
  }
}
