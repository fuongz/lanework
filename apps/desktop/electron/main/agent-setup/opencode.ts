// OpenCode's user config (FE-104): where it lives, and the `lanework` MCP
// entry in it.
//
// NOTE: OpenCode's config is JSONC (`opencode.json` or `opencode.jsonc`): it
// may hold comments and trailing commas. Every edit goes through
// `jsonc-parser`'s `modify`, which changes the bytes of our entry and nothing
// else, so the user's comments, order and formatting survive a write.
//
// NOTE: OpenCode 2 keeps MCP servers under `mcp.servers`; OpenCode 1 kept
// them directly under `mcp`. A file written in the 1.x layout is REFUSED, not
// converted: rewriting the user's other servers is not ours to do, and
// adding a `servers` map beside them would leave a file neither version reads
// the same way.
//
// Electron-free, so a spec can drive it against a fake home.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// NOTE: The ESM build, by path. The package's `main` is a UMD wrapper that
// `require`s its own files through a variable, which esbuild cannot follow:
// the bundle would throw "Cannot find module './impl/format'" at launch.
import {
  applyEdits,
  type FormattingOptions,
  modify,
  type ParseError,
  parse,
} from "jsonc-parser/lib/esm/main.js";
import { MCP_HOST, MCP_URL } from "../../../shared/agent-notes";
import type { LaneworkMcpEntry, LaneworkMcpMode } from "../../../shared/auth";

/** The name of our entry, as in Claude's and Codex's config. */
const NAME = "lanework";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * OpenCode's config folder: `$XDG_CONFIG_HOME/opencode`, else
 * `~/.config/opencode`.
 *
 * NOTE: The environment counts only for the real home, as
 * `opencodeDataDir()` does for its data: a spec points `home` at a fake one
 * and must never reach the machine's config through a variable.
 */
export function opencodeConfigDir(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  realHome = home === homedir(),
): string {
  if (realHome && env.XDG_CONFIG_HOME)
    return join(env.XDG_CONFIG_HOME, "opencode");
  return join(home, ".config", "opencode");
}

/**
 * The user config file OpenCode reads, and the one our entry goes into.
 *
 * `$OPENCODE_CONFIG` when set (real home only), else the first of
 * `opencode.json` and `opencode.jsonc` in the config folder that exists, else
 * `opencode.json` there.
 */
export function opencodeConfigPath(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  realHome = home === homedir(),
): string {
  if (realHome && env.OPENCODE_CONFIG) return env.OPENCODE_CONFIG;
  const dir = opencodeConfigDir(home, env, realHome);
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return join(dir, "opencode.json");
}

/**
 * The JSONC object in `text`.
 *
 * @returns `{}` for a missing or blank file, null when it does not parse to
 *   an object (and so must not be rewritten).
 */
export function parseJsonc(text: string | null): Json | null {
  if (text === null || !text.trim()) return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  return errors.length === 0 && isObject(value) ? value : null;
}

/** `mcp.timeout` in OpenCode 2: `{ startup?, catalog?, execution? }`. */
function isTimeoutSettings(value: unknown): boolean {
  return (
    isObject(value) &&
    Object.entries(value).every(
      ([key, ms]) =>
        ["startup", "catalog", "execution"].includes(key) &&
        typeof ms === "number",
    )
  );
}

/**
 * Whether `config` keeps its servers in OpenCode 1's layout: an object under
 * `mcp` that is not `servers` (or 2.x's `timeout` settings).
 */
export function usesV1Layout(config: Json): boolean {
  const mcp = config.mcp;
  if (!isObject(mcp)) return false;
  return Object.entries(mcp).some(
    ([key, value]) =>
      key !== "servers" &&
      isObject(value) &&
      !(key === "timeout" && isTimeoutSettings(value)),
  );
}

/** The refusal for a file in OpenCode 1's layout. */
export const v1Refusal = (path: string) =>
  new Error(
    `${path} lists MCP servers in OpenCode 1's layout (directly under "mcp"). Lanework writes OpenCode 2's "mcp.servers" only. Move your servers under "mcp.servers", or add the lanework server by hand.`,
  );

/** The refusal for a file that is not a JSONC object. */
export const notJsonc = (path: string) =>
  new Error(
    `${path} is not valid JSON. Fix or remove it, then try again — Lanework will not overwrite it.`,
  );

/** Our `mcp.servers` entry for `mode`. */
function entryFor(mode: LaneworkMcpMode, shim: string): Json {
  return mode === "local"
    ? { type: "local", command: [shim] }
    : { type: "remote", url: MCP_URL };
}

/** What `config` holds under our name. */
export function opencodeMcpState(
  config: Json,
  shim: string,
  isStale: (command: unknown) => boolean = () => false,
): Omit<LaneworkMcpEntry, "configPath" | "unreadable"> {
  const mcp = isObject(config.mcp) ? config.mcp : {};
  const servers = isObject(mcp.servers) ? mcp.servers : {};
  const entry = servers[NAME];
  if (!isObject(entry))
    return { installed: false, ours: false, mode: null, transport: null };
  const command = Array.isArray(entry.command) ? entry.command[0] : undefined;
  const url = typeof entry.url === "string" ? entry.url : null;
  const mode: LaneworkMcpMode | null =
    url?.includes(MCP_HOST) === true
      ? "cloud"
      : command === shim
        ? "local"
        : null;
  return {
    installed: true,
    ours: mode !== null || isStale(command),
    mode,
    transport: url !== null ? "http" : command !== undefined ? "stdio" : null,
  };
}

/** The indentation the file already uses, so an insert matches it. */
function formatting(text: string): FormattingOptions {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    insertFinalNewline: true,
  };
}

/**
 * `text` with our entry set to `mode`; every other byte as it was.
 *
 * @throws When `text` is not a JSONC object, or uses OpenCode 1's layout.
 */
export function withOpencodeMcp(
  text: string | null,
  mode: LaneworkMcpMode,
  shim: string,
  path: string,
): string {
  const config = parseJsonc(text);
  if (!config) throw notJsonc(path);
  if (usesV1Layout(config)) throw v1Refusal(path);
  const base = text?.trim() ? (text as string) : "{}\n";
  const edits = modify(base, ["mcp", "servers", NAME], entryFor(mode, shim), {
    formattingOptions: formatting(base),
  });
  const next = applyEdits(base, edits);
  return next.endsWith("\n") ? next : `${next}\n`;
}

/**
 * `text` without our entry; null when it had none (nothing to write).
 *
 * @throws When `text` is not a JSONC object.
 */
export function withoutOpencodeMcp(text: string, path: string): string | null {
  const config = parseJsonc(text);
  if (!config) throw notJsonc(path);
  const mcp = isObject(config.mcp) ? config.mcp : {};
  const servers = isObject(mcp.servers) ? mcp.servers : {};
  if (!(NAME in servers)) return null;
  // Ours was the last of what we made: drop the emptied `servers`, then an
  // emptied `mcp`, rather than leave `{ "servers": {} }` behind (FE-105/D9).
  // Anything else in either is the user's and keeps them.
  const lastServer = Object.keys(servers).length === 1;
  const lastInMcp = lastServer && Object.keys(mcp).length === 1;
  const target = lastInMcp
    ? ["mcp"]
    : lastServer
      ? ["mcp", "servers"]
      : ["mcp", "servers", NAME];
  const edits = modify(text, target, undefined, {
    formattingOptions: formatting(text),
  });
  return applyEdits(text, edits);
}
