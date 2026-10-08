// The user's own Claude Code and Codex config files, edited in the app
// (FE-47) — the one place to change either agent's settings.
//
// ⚠️ A fixed list (FE-47/D1), and the user's skills (D9). The renderer names
// a file by its `ConfigFileId`, never by path: main resolves it from the
// agents' homes, so no renderer can point a read or a write at a file of its
// choosing.
//
// ⚠️ Unlike the setup view (FE-40), `read` hands over the file WHOLE, secrets
// in `env` or `headers` included — a value nobody can see cannot be edited
// (FE-47/D3). It crosses only when someone opens the file, and is never
// cached, logged or sent anywhere else.
//
// ⚠️ No dependencies: preload imports the channels from here. What reads
// and edits the text lives in `agent-config-text.ts`.
export const CONFIG_FILE_IDS = [
  "claude-settings",
  "claude-md",
  "codex-config",
  "codex-hooks",
  "codex-agents-md",
] as const;

export type FixedConfigId = (typeof CONFIG_FILE_IDS)[number];

/**
 * Where a user's skills live (FE-47/D9): Claude's `~/.claude/skills`, and
 * Codex's `~/.agents/skills` and — the place it used to read — its own
 * `$CODEX_HOME/skills`.
 */
export const SKILL_ROOTS = ["claude", "agents", "codex"] as const;
export type SkillRoot = (typeof SKILL_ROOTS)[number];

/** A skill's `SKILL.md`: `skill:<root>:<folder name>`. */
export type SkillConfigId = `skill:${SkillRoot}:${string}`;

export type ConfigFileId = FixedConfigId | SkillConfigId;

export type ConfigFormat = "json" | "toml" | "markdown";

/**
 * One folder name and nothing else: no separator, no `..`, no leading dot
 * (Codex's own `.system` skills are not the user's to edit).
 */
export function isSkillName(value: string): boolean {
  return (
    /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,127}$/.test(value) && !value.includes("..")
  );
}

export function parseSkillId(
  value: string,
): { root: SkillRoot; name: string } | null {
  const match = /^skill:([a-z]+):(.+)$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const root = match[1] as SkillRoot;
  if (!SKILL_ROOTS.includes(root) || !isSkillName(match[2])) return null;
  return { root, name: match[2] };
}

export function isConfigFileId(value: unknown): value is ConfigFileId {
  if (typeof value !== "string") return false;
  return (
    CONFIG_FILE_IDS.includes(value as FixedConfigId) || !!parseSkillId(value)
  );
}

/** One row of the list: where the file is and what it is — not what it says. */
export interface ConfigFile {
  id: ConfigFileId;
  agent: "claude" | "codex";
  /** A config file of the agent's own, or one of the user's skills (D9). */
  kind: "config" | "skill";
  /** `settings.json`, `CLAUDE.md`, … — a skill's folder name. */
  label: string;
  /** What the file is for, in a line — a skill's own `description`. */
  description: string;
  /** Home shortened to `~`: `~/.codex/config.toml`. */
  path: string;
  format: ConfigFormat;
  /** False when the agent has not made it yet; the first Save creates it. */
  exists: boolean;
  size: number | null;
  /** ISO time of the last change on disk. */
  modifiedAt: string | null;
}

export interface ConfigFileContent {
  id: ConfigFileId;
  text: string;
  /**
   * sha256 of the bytes read; `""` for a file that is not there yet. A write
   * passes it back, and is refused when the file has changed since (D4).
   */
  hash: string;
  /** The Lanework checkpoint hook is in this file (FE-47/D7). */
  laneworkHook: boolean;
}

export type ConfigWriteResult =
  | { status: "ok"; content: ConfigFileContent; backup: string | null }
  /** The file changed on disk after it was opened: reload, then edit again. */
  | { status: "conflict" }
  /** Not valid JSON or TOML; nothing was written. */
  | { status: "invalid"; error: string };

export const agentConfigChannels = {
  list: "agent-config:list",
  read: "agent-config:read",
  write: "agent-config:write",
  reveal: "agent-config:reveal",
} as const;

/** The most a config file may be — the reader's own cap for configs. */
export const CONFIG_EDIT_MAX = 512 * 1024;

export interface DesktopAgentConfigApi {
  list: () => Promise<ConfigFile[]>;
  read: (id: ConfigFileId) => Promise<ConfigFileContent>;
  write: (
    id: ConfigFileId,
    text: string,
    baseHash: string,
  ) => Promise<ConfigWriteResult>;
  /** Show the file in Finder — its folder when it is not there yet. */
  reveal: (id: ConfigFileId) => Promise<void>;
}
