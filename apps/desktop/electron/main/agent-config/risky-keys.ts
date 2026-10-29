// The keys of an agent config that make the agent run something later, on its
// own: hooks, a status line, an API key helper, MCP servers. A write from the
// renderer that adds or changes one of them is confirmed in main first
// (FE-81/D1), so a script in the renderer cannot plant a command that outlives
// the session.
//
// NOTE: OpenCode's config is watched too (FE-105/D1), for its own keys: MCP
// servers, plugins (code it loads), and the formatters and language servers
// it starts.
//
// NOTE: Node only, no Electron: pure functions over the old and new text.
import { parse as parseToml } from "smol-toml";
import type { ConfigFileId } from "../../../shared/agent-config";
import { parseJsonc } from "../agent-setup/opencode";

type WatchedFormat = "json" | "jsonc" | "toml";

/** The files whose risky keys are confirmed; markdown and skills never are. */
const WATCHED: Partial<Record<ConfigFileId, WatchedFormat>> = {
  "claude-settings": "json",
  "codex-config": "toml",
  "codex-hooks": "json",
  "opencode-config": "jsonc",
};

/** The top-level keys that run a command, in Claude's and Codex's files. */
export const RISKY_KEYS = [
  "hooks",
  "statusLine",
  "apiKeyHelper",
  "mcpServers",
  "mcp_servers",
] as const;

/** The same in OpenCode's config (FE-105/D1). */
export const OPENCODE_RISKY_KEYS = [
  "mcp",
  "plugin",
  "formatter",
  "lsp",
] as const;

/** The leaf keys a person reads as "the command". */
const COMMAND_LEAVES = new Set(["command", "args", "url", "apiKeyHelper"]);

/** The most changed lines a dialog lists, and the longest one. */
const SHOWN_MAX = 12;
const LINE_MAX = 240;

function parse(format: WatchedFormat, text: string): unknown {
  if (!text.trim()) return {};
  // `{}` for blank, null when it does not parse: as below.
  if (format === "jsonc") return parseJsonc(text);
  try {
    return format === "json" ? JSON.parse(text) : parseToml(text);
  } catch {
    return null;
  }
}

/**
 * Every leaf under `value`, as `path = value`.
 *
 * Array positions are left out of the path, so moving an entry is not a
 * change, while adding or editing one is.
 */
interface Leaf {
  /** Dotted, with `[]` for an array: `hooks.Stop[].hooks[].command`. */
  path: string;
  value: string;
}

function leaves(value: unknown, path: string, out: Map<string, Leaf>) {
  if (Array.isArray(value)) {
    for (const item of value) leaves(item, `${path}[]`, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value))
      leaves(child, path ? `${path}.${key}` : key, out);
    return;
  }
  const shown =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  out.set(JSON.stringify([path, shown]), { path, value: shown });
}

function riskyLeaves(
  config: unknown,
  keys: readonly string[],
): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  if (!config || typeof config !== "object" || Array.isArray(config))
    return out;
  const record = config as Record<string, unknown>;
  for (const key of keys) if (key in record) leaves(record[key], key, out);
  return out;
}

export interface RiskyChange {
  /** The risky keys the write adds to or changes. */
  keys: string[];
  /** What changed, one line each: the commands first. */
  lines: string[];
}

/**
 * What a write of `after` over `before` adds or changes under the risky keys,
 * or null when it touches none of them (removing an entry is not asked
 * about), the file is not watched, or `after` does not parse (the write
 * refuses it anyway).
 */
export function riskyChange(
  id: ConfigFileId,
  before: string,
  after: string,
): RiskyChange | null {
  const format = WATCHED[id];
  if (!format) return null;
  const next = parse(format, after);
  if (next === null) return null;
  const watched = format === "jsonc" ? OPENCODE_RISKY_KEYS : RISKY_KEYS;
  // An old file that no longer parses: everything in the new one is new.
  const old = riskyLeaves(parse(format, before), watched);
  const added = [...riskyLeaves(next, watched)]
    .filter(([key]) => !old.has(key))
    .map(([, leaf]) => leaf);
  if (!added.length) return null;

  const keys = [
    ...new Set(added.map(({ path }) => path.split(/[.[]/)[0] ?? path)),
  ];
  const describe = ({ path, value }: Leaf) => {
    const line = `${path.replace(/\[\]/g, "")}: ${value}`;
    return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
  };
  const isCommand = ({ path }: Leaf) =>
    COMMAND_LEAVES.has(path.replace(/\[\]$/, "").split(".").pop() ?? "");
  const ordered = [
    ...added.filter(isCommand),
    ...added.filter((leaf) => !isCommand(leaf)),
  ];
  const lines = ordered.slice(0, SHOWN_MAX).map(describe);
  if (ordered.length > SHOWN_MAX)
    lines.push(`…and ${ordered.length - SHOWN_MAX} more`);
  return { keys, lines };
}
