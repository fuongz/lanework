// The `lanework` MCP server entry in Claude Code's, Codex's and OpenCode's
// user config (FE-52/D8, FE-104): the offline server over stdio while the app
// runs on the local board, the cloud one over HTTP once signed in. And the
// `lanework-kit` entry beside it (FE-152): the kit's search tools, always
// over stdio, whatever mode the board entry is in.
//
// NOTE: Only OUR entries, ever. `~/.claude.json` holds every project Claude Code
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
// NOTE: The ESM build, by path, as in `opencode.ts`.
import {
  applyEdits,
  type FormattingOptions,
  modify,
} from "jsonc-parser/lib/esm/main.js";
import { MCP_HOST, MCP_URL, MCP_WORKER_URL } from "../../../shared/agent-notes";
import type { KitMcpEntry, KitMcpStatus } from "../../../shared/agent-setup";
import type {
  LaneworkMcpAgent,
  LaneworkMcpEntry,
  LaneworkMcpMode,
  LaneworkMcpStatus,
  LaneworkMcpToolset,
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
import {
  kitMcpPref,
  setKitMcpPref,
  setToolsetPref,
  toolsetFor,
  toolsets,
  WORKER_AGENTS,
} from "./prefs";

/** The name of our entry in both agents' MCP server config. */
export const MCP_NAME = "lanework";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ── Toolsets (FE-119/D1) ─────────────────────────────────────────────────────

/** The cloud URL the app writes for `toolset`. */
export const cloudUrl = (toolset: LaneworkMcpToolset = "full"): string =>
  toolset === "worker" ? MCP_WORKER_URL : MCP_URL;

/**
 * The toolset `url` asks for, when it is exactly a URL the app writes.
 *
 * NOTE: Exact, on purpose. Any other URL on our host (a trailing slash, a
 * query the user added, a staging server) is the user's edit: still ours to
 * switch between stdio and HTTP, never ours to rewrite for a toolset.
 */
export function toolsetOfUrl(url: unknown): LaneworkMcpToolset | null {
  if (url === MCP_URL) return "full";
  if (url === MCP_WORKER_URL) return "worker";
  return null;
}

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
  /**
   * A spec drives this unpackaged build (`LANEWORK_TEST_USER_DATA` or
   * `LANEWORK_TEST_AGENT_HOME`), so the agents' config it would write is a
   * fixture. `LANEWORK_HOME` alone is not enough: `mise run dev` sets it
   * and still reads the real `~/.claude.json`.
   */
  testRun: boolean;
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
 * - Unpackaged: only when a spec drives it ({@link InstallFacts.testRun}).
 *   `mise run dev` never writes them: with its own `~/.lanew-dev` it would
 *   point the real agents' `lanework` entry at the dev build (2026-11-12).
 *
 * @returns Null when it may, else why not.
 */
export function shimRefusal(facts: InstallFacts): ShimRefusal | null {
  if (!facts.packaged) return facts.testRun ? null : "dev";
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
      return "A development build leaves agent hooks and the Lanework MCP server to the installed app.";
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

// ── The Preview never writes the agents' config ──────────────────────────────

/**
 * Why this build may not write any agent's config, or null.
 *
 * Set by main in the Preview (`channel.ts`), where the release app owns the
 * `lanework` entries. Reads stay allowed, so Settings still shows them. Null
 * under plain Node (the specs) and in every other build.
 */
let agentConfigLock: string | null = null;

/** Refuse every write into the agents' config from now on, for `reason`. */
export function lockAgentConfig(reason: string): void {
  agentConfigLock = reason;
}

/** @throws The lock's reason, when the agents' config is locked. */
export function assertUnlocked(): void {
  if (agentConfigLock) throw new Error(agentConfigLock);
  // A dev build never writes the real agents' config, not even on a click.
  if (currentShimRefusal() === "dev")
    throw new Error(shimRefusalMessage("dev"));
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

/**
 * The stdio shim's path, written now when this copy may write it (FE-121/D9).
 *
 * For one conversation that must reach this machine's local boards while the
 * agents' own config points at the cloud. A copy that may not write shims
 * (a dev build) still answers with one already on disk.
 *
 * @returns null when there is no shim to run.
 */
export async function ensureMcpShim(): Promise<string | null> {
  if (!currentShimRefusal()) return writeMcpShim();
  const path = mcpShimPath();
  return existsSync(path) ? path : null;
}

// ── Claude Code: `~/.claude.json` `mcpServers.lanework` ──────────────────────

/** Our `mcpServers` entry for `mode`. */
function claudeEntry(
  mode: LaneworkMcpMode,
  shim = mcpShimPath(),
  url = MCP_URL,
) {
  return mode === "local"
    ? { type: "stdio", command: shim, args: [] as string[] }
    : { type: "http", url };
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

/** What a config without our entry reads as. */
export const NO_ENTRY = {
  installed: false,
  ours: false,
  mode: null,
  transport: null,
  toolset: null,
} as const;

/** What `~/.claude.json` holds under our name. */
function claudeState(
  json: Json,
  shim = mcpShimPath(),
): Omit<LaneworkMcpEntry, "configPath" | "unreadable"> {
  const servers = isObject(json.mcpServers) ? json.mcpServers : {};
  const entry = servers[MCP_NAME];
  if (!isObject(entry)) return NO_ENTRY;
  const mode = modeOf(entry, shim);
  return {
    installed: true,
    // A stale shim is ours with no mode, so `syncLaneworkMcp` rewrites it.
    ours: mode !== null || isStaleShim(entry.command, shim),
    mode,
    toolset: mode === "cloud" ? toolsetOfUrl(entry.url) : null,
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
  url = MCP_URL,
): Json {
  const servers = isObject(json.mcpServers) ? json.mcpServers : {};
  return {
    ...json,
    mcpServers: { ...servers, [MCP_NAME]: claudeEntry(mode, shim, url) },
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
function splitCodex(
  text: string,
  table: RegExp = OUR_TABLE,
): { kept: string[]; ours: string[] } {
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
    if (line.startsWith("[")) inOurs = table.test(line);
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
  if (!ours.length) return NO_ENTRY;
  const url = codexValue(ours, "url");
  const command = codexValue(ours, "command");
  const mode = modeOf({ url, command }, shim);
  return {
    installed: true,
    ours: mode !== null || isStaleShim(command, shim),
    mode,
    toolset: mode === "cloud" ? toolsetOfUrl(url) : null,
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
  url = MCP_URL,
): string {
  const rest = withoutCodexMcp(text).replace(/\n+$/, "");
  const table = [
    `[mcp_servers.${MCP_NAME}]`,
    mode === "local"
      ? `command = ${tomlQuote(shim)}`
      : `url = ${tomlQuote(url)}`,
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
      return { ...NO_ENTRY, configPath, unreadable: true };
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
  if (!json) return { ...NO_ENTRY, configPath, unreadable: true };
  return { ...claudeState(json), configPath, unreadable: false };
}

/** What Settings → Agents shows for the `lanework` MCP entry. */
export async function laneworkMcpStatus(
  want: LaneworkMcpMode | null,
): Promise<LaneworkMcpStatus> {
  const [claude, codex, opencode, chosen] = await Promise.all([
    entryStatus("claude-code"),
    entryStatus("codex"),
    entryStatus("opencode"),
    toolsets(),
  ]);
  return {
    want,
    shimPath: mcpShimPath(),
    claude,
    codex,
    opencode,
    toolsets: chosen,
    workerAgents: [...WORKER_AGENTS],
  };
}

/**
 * Write our entry for `agent`, pointed at `mode`.
 *
 * Replaces any `lanework` entry. A cloud entry asks for the toolset chosen
 * for `agent` ({@link toolsetFor}).
 *
 * @throws When `~/.claude.json` or OpenCode's config is not valid JSON, or
 *   OpenCode's uses its 1.x layout; neither is ever overwritten.
 */
export async function installLaneworkMcp(
  agent: LaneworkMcpAgent,
  mode: LaneworkMcpMode,
): Promise<void> {
  assertUnlocked();
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
  const url = cloudUrl(await toolsetFor(agent));
  if (agent === "opencode") {
    await updateConfigFile(
      path,
      (text) => withOpencodeMcp(text, mode, mcpShimPath(), path, url),
      NEW_CONFIG_MODE,
    );
    return;
  }
  if (agent === "codex") {
    await updateConfigFile(
      path,
      (text) => withCodexMcp(text ?? "", mode, mcpShimPath(), url),
      NEW_CONFIG_MODE,
    );
    return;
  }
  await updateConfigFile(
    path,
    (text) => {
      const json = parseObject(text);
      if (!json) throw notJson(path);
      const next = withClaudeMcp(json, mode, mcpShimPath(), url);
      return `${JSON.stringify(next, null, 2)}\n`;
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
  assertUnlocked();
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
 * Whether an entry of ours must be rewritten for `mode`.
 *
 * Another mode, or a cloud URL the app wrote for the other toolset. A cloud
 * URL the app did not write (`toolset: null`) stays: the user edited it.
 */
function needsRewrite(
  status: LaneworkMcpEntry,
  mode: LaneworkMcpMode,
  want: LaneworkMcpToolset,
): boolean {
  if (!status.ours) return false;
  if (status.mode !== mode) return true;
  return mode === "cloud" && status.toolset !== null && status.toolset !== want;
}

/**
 * Bring entries that are already OURS in line with the session.
 *
 * Stdio while local, HTTP once signed in. Rewrites the shim when a stdio
 * entry needs it. A stale shim of ours ({@link isStaleShim}) is ours, with no
 * mode, so it is rewritten to the one this app runs. Signed out (anonymous,
 * revoked) leaves everything as it is.
 *
 * A cloud entry the app wrote follows its agent's toolset (FE-119/D1), so the
 * first launch after FE-119 moves Codex's `/v1` to `/v1?toolset=worker`.
 * Codex keys its OAuth token by URL, so Codex asks to log in once after it.
 *
 * NOTE: Never ADDS an entry and never touches a `lanework` entry that points
 * somewhere else (a self-hosted server, a dev build): that one is the user's.
 * Nor a cloud URL somebody edited: it stays as written.
 */
export async function syncLaneworkMcp(
  kind: "anonymous" | "machine" | "revoked" | "local",
): Promise<void> {
  const mode = modeFor(kind);
  if (!mode) return;
  // The Preview leaves every entry to the release app.
  if (agentConfigLock) {
    console.info(
      "Preview build: skipped syncing the Lanework MCP entries; the release app manages them.",
    );
    return;
  }
  // A dev build writes no agent's config at all, cloud entry included: the
  // installed app owns them, as it does against the Preview.
  if (currentShimRefusal() === "dev") return;
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
  const wanted = await toolsets();
  for (const [index, agent] of agents.entries()) {
    const status = statuses[index];
    if (!status || !needsRewrite(status, mode, wanted[agent])) continue;
    await installLaneworkMcp(agent, mode).catch(() => undefined);
  }
}

/**
 * Choose `agent`'s toolset, and rewrite its entry when that is ours, cloud
 * and a URL the app wrote.
 *
 * A stdio entry, or none, only remembers the choice: the next cloud entry
 * is written with it.
 *
 * @throws For `worker` on an agent that cannot sign in to it.
 */
export async function setLaneworkMcpToolset(
  agent: LaneworkMcpAgent,
  toolset: LaneworkMcpToolset,
): Promise<void> {
  assertUnlocked();
  await setToolsetPref(agent, toolset);
  const status = await entryStatus(agent);
  if (status.mode === "cloud" && needsRewrite(status, "cloud", toolset))
    await installLaneworkMcp(agent, "cloud");
}

// ── lanework-kit (FE-152) ────────────────────────────────────────────────────
//
// A second stdio entry, `lanework-kit`, that runs the kit's MCP server
// (`dist/electron/mcp-kit/server.cjs`) through its own shim. It needs no
// session and no board: the same entry whether the board's is local, cloud
// or absent. Each agent's switch is a pref (`prefs.ts`):
// - On: the entry is added, and on every launch put back if it went missing
//   and repointed at this build's shim.
// - Off: the entry is removed, and never added again.
// - Never chosen: an entry of ours only gets its shim rewritten.

/** The name of the kit's entry in every agent's MCP config. */
export const KIT_MCP_NAME = "lanework-kit";

const KIT_AGENTS = ["claude-code", "codex", "opencode"] as const;

/** `~/.lanew/bin/lanework-kit-mcp` — what the kit's entry runs. */
export function kitShimPath(): string {
  return join(appHomeDir(), "bin", "lanework-kit-mcp");
}

/**
 * The kit's MCP server bundle, `dist/electron/mcp-kit/server.cjs`, outside
 * the asar archive like {@link mcpServerPath}'s.
 */
export function kitServerPath(mainDir: string = __dirname): string {
  return join(mainDir, "..", "mcp-kit", "server.cjs").replace(
    `app.asar${sep}`,
    `app.asar.unpacked${sep}`,
  );
}

/**
 * The kit's shim, rewritten on every launch like {@link buildMcpShim}'s.
 *
 * NOTE: No `cd`: the server's scope is the folder the agent starts it in.
 * `LANEWORK_HOME` is pinned so it finds this app's socket
 * (`<app home>/run/kit.sock`).
 */
export function buildKitShim(options: {
  execPath: string;
  serverPath: string;
  home: string;
}): string {
  return [
    "#!/bin/sh",
    "# Lanework's lanework-kit MCP server (FE-152). The Lanework app rewrites",
    "# this file on every launch; edits here are lost.",
    "export ELECTRON_RUN_AS_NODE=1",
    `export LANEWORK_HOME=${shellQuote(options.home)}`,
    `exec ${shellQuote(options.execPath)} ${shellQuote(options.serverPath)} "$@"`,
    "",
  ].join("\n");
}

/**
 * Write the kit's shim and return its path.
 *
 * @throws When this copy of the app may not write it ({@link shimRefusal}).
 */
async function writeKitShim(
  execPath: string = process.execPath,
): Promise<string> {
  const refusal = currentShimRefusal();
  if (refusal) throw new Error(shimRefusalMessage(refusal));
  const path = kitShimPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    buildKitShim({
      execPath,
      serverPath: kitServerPath(),
      home: appHomeDir(),
    }),
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

/**
 * Whether `command` is a kit shim of this app's from another app home that
 * is a temp folder or gone, as {@link isStaleShim} judges the board's.
 */
function isStaleKitShim(command: unknown, shim: string): boolean {
  if (typeof command !== "string" || command === shim) return false;
  if (!/[/\\]bin[/\\]lanework-kit-mcp$/.test(command)) return false;
  const temp = [tmpdir(), "/tmp", "/private/tmp", "/var/folders"];
  return (
    temp.some((dir) => command.startsWith(`${dir}${sep}`)) ||
    !existsSync(command)
  );
}

/** What an entry's command says about it. */
function kitState(installed: boolean, command: unknown, shim: string) {
  return {
    installed,
    ours: installed && (command === shim || isStaleKitShim(command, shim)),
    command: installed ? command : null,
  };
}

/** {@link KitMcpEntry}, with the command the entry runs (main only). */
type KitEntryRead = KitMcpEntry & { command: unknown };

// Claude Code: `mcpServers["lanework-kit"]`.

/** `json` with the kit's entry; every other key as it was. */
export function withClaudeKit(json: Json, shim = kitShimPath()): Json {
  const servers = isObject(json.mcpServers) ? json.mcpServers : {};
  return {
    ...json,
    mcpServers: {
      ...servers,
      [KIT_MCP_NAME]: { type: "stdio", command: shim, args: [] as string[] },
    },
  };
}

/** `json` without the kit's entry; the same object when it had none. */
function withoutClaudeKit(json: Json): Json {
  if (!isObject(json.mcpServers) || !(KIT_MCP_NAME in json.mcpServers))
    return json;
  const { [KIT_MCP_NAME]: _, ...rest } = json.mcpServers;
  return { ...json, mcpServers: rest };
}

// Codex: `[mcp_servers.lanework-kit]`.

/** The kit's table header, sub-tables included. */
const KIT_TABLE =
  /^\[\s*mcp_servers\s*\.\s*(?:"lanework-kit"|lanework-kit)\s*(?:\..*)?\]$/;

/** `text` without the kit's table; the same text when it had none. */
export function withoutCodexKit(text: string): string {
  const { kept, ours } = splitCodex(text, KIT_TABLE);
  if (!ours.length) return text;
  return `${kept.join("\n").replace(/\n+$/, "")}\n`;
}

/** `text` with the kit's table at the end; the rest as it was. */
export function withCodexKit(text: string, shim = kitShimPath()): string {
  const rest = withoutCodexKit(text).replace(/\n+$/, "");
  const table = [
    `[mcp_servers.${KIT_MCP_NAME}]`,
    `command = ${tomlQuote(shim)}`,
  ].join("\n");
  return `${rest ? `${rest}\n\n` : ""}${table}\n`;
}

// OpenCode: `mcp.servers["lanework-kit"]`, edited in place as `opencode.ts`
// edits the board's entry, so comments and formatting survive.

/** The indentation the file already uses, as `opencode.ts` reads it. */
function jsoncFormatting(text: string): FormattingOptions {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    insertFinalNewline: true,
  };
}

/**
 * `text` with the kit's entry; every other byte as it was.
 *
 * @throws When `text` is not a JSONC object, or uses OpenCode 1's layout.
 */
export function withOpencodeKit(
  text: string | null,
  path: string,
  shim = kitShimPath(),
): string {
  const config = parseJsonc(text);
  if (!config) throw notJsonc(path);
  if (usesV1Layout(config)) throw v1Refusal(path);
  const base = text?.trim() ? (text as string) : "{}\n";
  const edits = modify(
    base,
    ["mcp", "servers", KIT_MCP_NAME],
    { type: "local", command: [shim] },
    { formattingOptions: jsoncFormatting(base) },
  );
  const next = applyEdits(base, edits);
  return next.endsWith("\n") ? next : `${next}\n`;
}

/**
 * `text` without the kit's entry; null when it had none.
 *
 * Drops an emptied `servers`, then an emptied `mcp`, as
 * `withoutOpencodeMcp` does.
 *
 * @throws When `text` is not a JSONC object.
 */
export function withoutOpencodeKit(text: string, path: string): string | null {
  const config = parseJsonc(text);
  if (!config) throw notJsonc(path);
  const mcp = isObject(config.mcp) ? config.mcp : {};
  const servers = isObject(mcp.servers) ? mcp.servers : {};
  if (!(KIT_MCP_NAME in servers)) return null;
  const lastServer = Object.keys(servers).length === 1;
  const lastInMcp = lastServer && Object.keys(mcp).length === 1;
  const target = lastInMcp
    ? ["mcp"]
    : lastServer
      ? ["mcp", "servers"]
      : ["mcp", "servers", KIT_MCP_NAME];
  const edits = modify(text, target, undefined, {
    formattingOptions: jsoncFormatting(text),
  });
  return applyEdits(text, edits);
}

/** `agent`'s kit entry as its config file holds it now. */
async function kitEntryStatus(agent: LaneworkMcpAgent): Promise<KitEntryRead> {
  const configPath = configPathOf(agent);
  const shim = kitShimPath();
  const on = await kitMcpPref(agent);
  const text = await readOptional(configPath).catch(() => null);
  if (agent === "codex") {
    const { ours } = splitCodex(text ?? "", KIT_TABLE);
    return {
      ...kitState(ours.length > 0, codexValue(ours, "command"), shim),
      on,
      configPath,
      unreadable: false,
    };
  }
  if (agent === "opencode") {
    const config = parseJsonc(text);
    if (!config || usesV1Layout(config))
      return {
        installed: false,
        ours: false,
        command: null,
        on,
        configPath,
        unreadable: true,
      };
    const mcp = isObject(config.mcp) ? config.mcp : {};
    const servers = isObject(mcp.servers) ? mcp.servers : {};
    const entry = servers[KIT_MCP_NAME];
    const command =
      isObject(entry) && Array.isArray(entry.command)
        ? entry.command[0]
        : undefined;
    return {
      ...kitState(isObject(entry), command, shim),
      on,
      configPath,
      unreadable: false,
    };
  }
  const json = parseObject(text);
  if (!json)
    return {
      installed: false,
      ours: false,
      command: null,
      on,
      configPath,
      unreadable: true,
    };
  const servers = isObject(json.mcpServers) ? json.mcpServers : {};
  const entry = servers[KIT_MCP_NAME];
  return {
    ...kitState(isObject(entry), isObject(entry) ? entry.command : null, shim),
    on,
    configPath,
    unreadable: false,
  };
}

/** What Settings → Harness shows for the `lanework-kit` entries. */
export async function kitMcpStatus(): Promise<KitMcpStatus> {
  // The command stays in main: Settings shows only whether it is ours.
  const [claude, codex, opencode] = await Promise.all(
    KIT_AGENTS.map(async (agent) => {
      const { command: _, ...entry } = await kitEntryStatus(agent);
      return entry;
    }),
  );
  const refusal = currentShimRefusal();
  return {
    shimPath: kitShimPath(),
    refusal: agentConfigLock ?? (refusal ? shimRefusalMessage(refusal) : null),
    claude,
    codex,
    opencode,
  };
}

/**
 * Write the kit's entry for `agent`, and its shim.
 *
 * @throws When this copy may not write the shim; when `~/.claude.json` or
 *   OpenCode's config is not valid JSON, or OpenCode's uses its 1.x layout;
 *   when a `lanework-kit` entry there is not ours.
 */
async function installKitMcp(agent: LaneworkMcpAgent): Promise<void> {
  assertUnlocked();
  const path = configPathOf(agent);
  const status = await kitEntryStatus(agent);
  if (status.unreadable)
    throw agent === "opencode"
      ? notJsonc(path)
      : agent === "claude-code"
        ? notJson(path)
        : new Error(`${path} cannot be read.`);
  if (status.installed && !status.ours)
    throw new Error(
      `${path} already has another lanework-kit server. Remove it first, then try again.`,
    );
  const shim = await writeKitShim();
  if (agent === "opencode") {
    await updateConfigFile(
      path,
      (text) => withOpencodeKit(text, path, shim),
      NEW_CONFIG_MODE,
    );
    return;
  }
  if (agent === "codex") {
    await updateConfigFile(
      path,
      (text) => withCodexKit(text ?? "", shim),
      NEW_CONFIG_MODE,
    );
    return;
  }
  await updateConfigFile(
    path,
    (text) => {
      const json = parseObject(text);
      if (!json) throw notJson(path);
      return `${JSON.stringify(withClaudeKit(json, shim), null, 2)}\n`;
    },
    NEW_CONFIG_MODE,
  );
}

/**
 * Remove the kit's entry for `agent`, when it is ours; others stay.
 *
 * @throws When the config file is not valid JSON; it is never overwritten.
 */
async function removeKitMcp(agent: LaneworkMcpAgent): Promise<void> {
  assertUnlocked();
  const path = configPathOf(agent);
  const status = await kitEntryStatus(agent);
  if (!status.installed || !status.ours) return;
  if (agent === "opencode") {
    await updateConfigFile(path, (text) =>
      text === null ? null : withoutOpencodeKit(text, path),
    );
    return;
  }
  if (agent === "codex") {
    await updateConfigFile(path, (text) =>
      text === null ? null : withoutCodexKit(text),
    );
    return;
  }
  await updateConfigFile(path, (text) => {
    if (text === null) return null;
    const json = parseObject(text);
    if (!json) throw notJson(path);
    const next = withoutClaudeKit(json);
    return next === json ? null : `${JSON.stringify(next, null, 2)}\n`;
  });
}

/**
 * Turn `agent`'s kit entry on or off from Settings, and remember it.
 *
 * The choice is stored only once the config agrees, so a refused write
 * leaves the switch where it was.
 */
export async function setKitMcp(
  agent: LaneworkMcpAgent,
  on: boolean,
): Promise<void> {
  assertUnlocked();
  if (on) await installKitMcp(agent);
  else await removeKitMcp(agent);
  await setKitMcpPref(agent, on);
}

/**
 * Bring the kit's entries in line on launch: the shim rewritten for this
 * build when an entry of ours runs it, an entry of ours that runs a stale
 * shim repointed, and one the user turned on put back when it is missing.
 *
 * NOTE: Nothing in the Preview, a dev build, or a copy that may not write
 * shims: the installed app does it on its next launch. Never touches a
 * `lanework-kit` entry that is not ours, nor one the user turned off.
 */
export async function syncKitMcp(): Promise<void> {
  if (agentConfigLock || currentShimRefusal()) return;
  const statuses = await Promise.all(
    KIT_AGENTS.map((agent) => kitEntryStatus(agent).catch(() => null)),
  );
  if (statuses.some((status) => status?.installed && status.ours))
    await writeKitShim();
  const shim = kitShimPath();
  for (const [index, agent] of KIT_AGENTS.entries()) {
    const status = statuses[index];
    if (!status || status.unreadable || status.on === false) continue;
    const repoint = status.ours && status.command !== shim;
    const putBack = !status.installed && status.on === true;
    if (repoint || putBack) await installKitMcp(agent).catch(() => undefined);
  }
}
