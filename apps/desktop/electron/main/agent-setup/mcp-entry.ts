// The `lanework` MCP server entry in Claude Code's, Codex's and OpenCode's
// user config (FE-52/D8, FE-104): the offline server over stdio while the app
// runs on the local board, the cloud one over HTTP once signed in.
//
// NOTE: Only OUR entry, ever. `~/.claude.json` holds every project Claude Code
// has seen and every other MCP server the user added; `~/.codex/config.toml`
// is Codex's whole configuration; `opencode.json[c]` is OpenCode's, comments
// included (`opencode.ts` edits it in place).
// - Everything but the `lanework` entry passes through untouched.
// - A file we cannot safely rewrite is refused.
// - Every write goes through `config-file.ts` (INF-05): atomic, through a
//   symlink, with the file's mode, and never over a change the agent made
//   since the read (read and changed again, once).
// - The stdio shim is written only from a stable install (INF-05, GAP-02):
//   see {@link shimRefusal}.
//
// Electron-free, so a spec can drive it against a fake home. The paths come
// from `agentHome`, which follows `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` (the
// variables every test launch sets); the app home follows `LANEWORK_HOME`.
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
import { updateConfigFile } from "../config-file";
import { shellQuote } from "../handoff/claude-settings";
import { appHomeDir } from "../paths";
import {
  notJsonc,
  opencodeConfigPath,
  opencodeMcpState,
  parseJsonc,
  usesV1Layout,
  v1Refusal,
  withOpencodeMcp,
  withoutOpencodeMcp,
} from "./opencode";

/** The name of our entry in both agents' MCP server config. */
export const MCP_NAME = "lanework";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where the agents' config is read from.
 *
 * `registerAgentSetup` points this at the same home the setup view reads (the
 * dev-build test seam included).
 */
let resolveHome: () => AgentHome = () => agentHome(homedir());

/** Point {@link resolveHome} at another home. */
export function setMcpHome(resolver: () => AgentHome): void {
  resolveHome = resolver;
}

// ── Where the app runs from (INF-05, GAP-02) ─────────────────────────────────

/** What decides whether this copy of the app may write the agents' shims. */
export interface InstallFacts {
  /** `app.isPackaged`. */
  packaged: boolean;
  /** `process.execPath`: the binary every shim would `exec`. */
  execPath: string;
  platform: NodeJS.Platform;
  /** The user's home, for `~/Applications`. */
  home: string;
  /** `LANEWORK_HOME` is set: a dev or test run with its own app home. */
  appHomeOverride: boolean;
  /** `$APPIMAGE` is set: a Linux AppImage, run from a temporary mount. */
  appImage: boolean;
}

/** Why this copy of the app may not write shims. */
export type ShimRefusal = "dev" | "not-installed" | "appimage";

/**
 * Whether this copy of the app may write or repoint the shims the agents run
 * (`~/.lanew/hooks/lanework-checkpoint`, `~/.lanew/bin/lanework-mcp`), and
 * the entries that name them.
 *
 * A shim `exec`s the binary of whichever copy wrote it, so it must be a copy
 * that stays where it is:
 * - Packaged, on macOS: in `/Applications` or `~/Applications`. Never a DMG
 *   volume (`/Volumes/…`) or an App Translocation path, which disappear when
 *   the app quits.
 * - Packaged, on Linux: never an AppImage. Its FUSE mount under /tmp is gone
 *   once the app quits, and another local user could create that path.
 * - Packaged anywhere: never from a temp folder.
 * - Unpackaged (`bun run dev`, the test suite): only with `LANEWORK_HOME`
 *   set, so a dev build never repoints the installed app's shims.
 *
 * @returns Null when it may, else why not.
 */
export function shimRefusal(facts: InstallFacts): ShimRefusal | null {
  if (!facts.packaged) return facts.appHomeOverride ? null : "dev";
  const path = facts.execPath;
  if (
    facts.platform === "linux" &&
    (facts.appImage || path.includes("/.mount_"))
  )
    return "appimage";
  const temp = [tmpdir(), "/tmp", "/private/tmp", "/var/folders"];
  if (temp.some((dir) => path.startsWith(`${dir}${sep}`)))
    return "not-installed";
  if (facts.platform === "darwin") {
    if (path.startsWith("/Volumes/") || path.includes("/AppTranslocation/"))
      return "not-installed";
    const folders = ["/Applications/", `${join(facts.home, "Applications")}/`];
    if (!folders.some((folder) => path.startsWith(folder)))
      return "not-installed";
  }
  return null;
}

/** What Settings shows when a switch is refused for `refusal`. */
export function shimRefusalMessage(refusal: ShimRefusal): string {
  switch (refusal) {
    case "dev":
      return "A development build does not install agent hooks or the offline MCP server. Set LANEWORK_HOME to a scratch folder to try them.";
    case "appimage":
      return "The AppImage runs from a temporary mount, so it cannot install agent hooks or the offline MCP server.";
    case "not-installed":
      return "Move Lanework to the Applications folder first. A copy run from a disk image or another folder cannot install agent hooks or the offline MCP server.";
  }
}

/**
 * The facts {@link shimRefusal} judges, from main.
 *
 * Null under plain Node (the specs), where no app runs and nothing is
 * refused. Main sets it before anything syncs (`handoff/index.ts`).
 */
let installFacts: (() => InstallFacts) | null = null;

/** Let main tell this module where the app runs from. */
export function setInstallFacts(facts: () => InstallFacts): void {
  installFacts = facts;
}

/** Why this copy may not write shims right now, or null. */
export function currentShimRefusal(): ShimRefusal | null {
  return installFacts ? shimRefusal(installFacts()) : null;
}

/** `~/.lanew/bin/lanework-mcp` — what a stdio entry runs. */
export function mcpShimPath(): string {
  return join(appHomeDir(), "bin", "lanework-mcp");
}

/**
 * The offline MCP server's bundle, `dist/electron/mcp-local/server.cjs`.
 *
 * Outside the asar archive, like the hook bundle and for the same reason: a
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
 * A script and not the command itself, like the hook's shim: the app's binary
 * and the bundle move with every update, and the entry in the agents' config
 * never has to.
 *
 * NOTE: `LANEWORK_HOME` is pinned so the server opens the SAME `data.sqlite`
 * this app does, whatever environment the agent was started in.
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

/**
 * Write the shim {@link buildMcpShim} builds and return its path.
 *
 * @throws When this copy of the app may not write it ({@link shimRefusal}).
 */
async function writeMcpShim(
  execPath: string = process.execPath,
): Promise<string> {
  const refusal = currentShimRefusal();
  if (refusal) throw new Error(shimRefusalMessage(refusal));
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

/** Our `mcpServers` entry for `mode`. */
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
 * Whether `command` is a shim of this app's that can no longer be the one
 * meant.
 *
 * That is the offline server's `<home>/bin/lanework-mcp`, but from ANOTHER app
 * home that is a temp folder (a test or verification run's `LANEWORK_HOME`)
 * or is gone. A stale one is ours to fix: it points every Claude Code or Codex
 * session at a board nobody uses.
 *
 * NOTE: Only those two. A shim from a home that is still there (a dev
 * build's) is that build's entry and stays the user's, or the two apps would
 * take the entry from each other on every launch.
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

/** What `~/.claude.json` holds under our name. */
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
    // A stale shim is ours with no mode, so `syncLaneworkMcp` rewrites it.
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

/** `json` without our entry; the same object when it had none. */
function withoutClaudeMcp(json: Json): Json {
  if (!isObject(json.mcpServers) || !(MCP_NAME in json.mcpServers)) return json;
  const { [MCP_NAME]: _, ...rest } = json.mcpServers;
  return { ...json, mcpServers: rest };
}

// ── Codex: `config.toml` `[mcp_servers.lanework]` ────────────────────────────

/** Our table's header, sub-tables included (`[mcp_servers.lanework.env]`). */
const OUR_TABLE =
  /^\[\s*mcp_servers\s*\.\s*(?:"lanework"|lanework)\s*(?:\..*)?\]$/;

/**
 * Split the file into our table's lines and everyone else's.
 *
 * A line inside a multi-line string stays with the table it started in, so a
 * `[` at its start is never read as a header.
 */
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

/** The first quoted string value of `key` in `lines`, or null when none. */
function codexValue(lines: string[], key: string): string | null {
  for (const raw of lines) {
    const match = new RegExp(
      `^\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`,
    ).exec(raw);
    if (match) return (match[1] ?? match[2] ?? "").replace(/\\(["\\])/g, "$1");
  }
  return null;
}

/** What Codex's `config.toml` holds under our name. */
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

/** `text` without our table; the same text when it had none. */
export function withoutCodexMcp(text: string): string {
  const { kept, ours } = splitCodex(text);
  if (!ours.length) return text;
  return `${kept.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * `text` with our table set to `mode`.
 *
 * The table goes at the end; the rest stays as it was.
 */
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

/** The file's text, or null when it does not exist. Other errors throw. */
async function readOptional(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

/** A config file that did not exist yet is created owner-only. */
const NEW_CONFIG_MODE = 0o600;

/** The not-valid-JSON refusal for `~/.claude.json`. */
const notJson = (path: string) =>
  new Error(
    `${path} is not valid JSON. Fix or remove it, then try again — Lanework will not overwrite it.`,
  );

/**
 * The JSON object in `text`.
 *
 * @returns `{}` for a missing or blank file, null when it is not a JSON
 *   object (and so must not be rewritten).
 */
function parseObject(text: string | null): Json | null {
  if (text === null || !text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The config file that holds `agent`'s MCP servers. */
const configPathOf = (agent: LaneworkMcpAgent, home = resolveHome()) =>
  agent === "codex"
    ? join(home.codexDir, "config.toml")
    : agent === "opencode"
      ? opencodeConfigPath(home.home)
      : home.claudeJson;

/** `agent`'s entry as its config file holds it now. */
async function entryStatus(agent: LaneworkMcpAgent): Promise<LaneworkMcpEntry> {
  const configPath = configPathOf(agent);
  const text = await readOptional(configPath).catch(() => null);
  if (agent === "codex")
    return {
      ...codexState(text ?? ""),
      configPath,
      unreadable: false,
    };
  if (agent === "opencode") {
    const config = parseJsonc(text);
    // A file in OpenCode 1's layout is one the app will not rewrite.
    if (!config || usesV1Layout(config))
      return {
        installed: false,
        ours: false,
        mode: null,
        transport: null,
        configPath,
        unreadable: true,
      };
    const shim = mcpShimPath();
    return {
      ...opencodeMcpState(config, shim, (command) =>
        isStaleShim(command, shim),
      ),
      configPath,
      unreadable: false,
    };
  }
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
  const [claude, codex, opencode] = await Promise.all([
    entryStatus("claude-code"),
    entryStatus("codex"),
    entryStatus("opencode"),
  ]);
  return { want, shimPath: mcpShimPath(), claude, codex, opencode };
}

/**
 * Write our entry for `agent`, pointed at `mode`.
 *
 * Replaces any `lanework` entry.
 *
 * @throws When `~/.claude.json` or OpenCode's config is not valid JSON, or
 *   OpenCode's uses its 1.x layout; neither is ever overwritten.
 */
export async function installLaneworkMcp(
  agent: LaneworkMcpAgent,
  mode: LaneworkMcpMode,
): Promise<void> {
  const path = configPathOf(agent);
  if (agent === "claude-code" && !parseObject(await readOptional(path)))
    throw notJson(path);
  // Refused before the shim is written; `withOpencodeMcp` checks again under
  // the write.
  if (agent === "opencode") {
    const config = parseJsonc(await readOptional(path));
    if (!config) throw notJsonc(path);
    if (usesV1Layout(config)) throw v1Refusal(path);
  }
  if (mode === "local") await writeMcpShim();
  if (agent === "opencode") {
    await updateConfigFile(
      path,
      (text) => withOpencodeMcp(text, mode, mcpShimPath(), path),
      NEW_CONFIG_MODE,
    );
    return;
  }
  if (agent === "codex") {
    await updateConfigFile(
      path,
      (text) => withCodexMcp(text ?? "", mode),
      NEW_CONFIG_MODE,
    );
    return;
  }
  await updateConfigFile(
    path,
    (text) => {
      const json = parseObject(text);
      if (!json) throw notJson(path);
      return `${JSON.stringify(withClaudeMcp(json, mode), null, 2)}\n`;
    },
    NEW_CONFIG_MODE,
  );
}

/**
 * Remove the `lanework` entry for `agent`; other servers are left alone.
 *
 * @throws When `~/.claude.json` or OpenCode's config is not valid JSON; it is
 *   never overwritten.
 */
export async function removeLaneworkMcp(
  agent: LaneworkMcpAgent,
): Promise<void> {
  const path = configPathOf(agent);
  if (agent === "opencode") {
    await updateConfigFile(path, (text) =>
      text === null ? null : withoutOpencodeMcp(text, path),
    );
    return;
  }
  if (agent === "codex") {
    await updateConfigFile(path, (text) =>
      text === null ? null : withoutCodexMcp(text),
    );
    return;
  }
  await updateConfigFile(path, (text) => {
    if (text === null) return null;
    const json = parseObject(text);
    if (!json) throw notJson(path);
    const next = withoutClaudeMcp(json);
    return next === json ? null : `${JSON.stringify(next, null, 2)}\n`;
  });
}

/** The entry a principal's session wants, or null when it wants none. */
export function modeFor(
  kind: "anonymous" | "machine" | "revoked" | "local",
): LaneworkMcpMode | null {
  return kind === "machine" ? "cloud" : kind === "local" ? "local" : null;
}

/**
 * Bring entries that are already OURS in line with the session.
 *
 * Stdio while local, HTTP once signed in. Rewrites the shim when a stdio
 * entry needs it. A stale shim of ours ({@link isStaleShim}) is ours, with no
 * mode, so it is rewritten to the one this app runs. Signed out (anonymous,
 * revoked) leaves everything as it is.
 *
 * NOTE: Never ADDS an entry and never touches a `lanework` entry that points
 * somewhere else (a self-hosted server, a dev build): that one is the user's.
 */
export async function syncLaneworkMcp(
  kind: "anonymous" | "machine" | "revoked" | "local",
): Promise<void> {
  const mode = modeFor(kind);
  if (!mode) return;
  // A copy that may not write the shim leaves stdio entries as they are: the
  // installed app repoints them on its next launch (INF-05, GAP-02).
  if (mode === "local" && currentShimRefusal()) return;
  const agents = ["claude-code", "codex", "opencode"] as const;
  const statuses = await Promise.all(
    agents.map((agent) => entryStatus(agent).catch(() => null)),
  );
  // Rewrite the shim whenever a stdio entry of ours will run it, so it runs
  // this build's binary and bundle, not the last one's.
  if (statuses.some((status) => status?.ours && mode === "local"))
    await writeMcpShim();
  for (const [index, agent] of agents.entries()) {
    const status = statuses[index];
    if (!status?.ours || status.mode === mode) continue;
    await installLaneworkMcp(agent, mode).catch(() => undefined);
  }
}
