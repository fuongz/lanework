// A project's agent setup (FE-40): every MCP server, skill, command, hook,
// permission and plugin Claude Code and Codex would load in its folder, as
// their config files on this machine say. Read-only — nothing here changes.
//
// ⚠️ Cleaned in MAIN, before it crosses. No `env`, `headers`, `args` value,
// token or URL query string ever reaches the renderer: an MCP server is its
// name, transport and the command's file name or the URL's host, and every
// command or rule shown has been through the checkpoint hook's `redact()`.
//
// ⚠️ The renderer names a project by slug and a skill or command by the `id`
// main handed out with it — never by path (FE-40/D4).

export type SetupAgent = "claude" | "codex";

/**
 * Where an entry comes from (FE-40/D3): the user's own config, the repo's,
 * the user's config for this one folder, a plugin — or, for the skills
 * Codex ships in `$CODEX_HOME/skills/.system`, Codex itself.
 */
export type SetupScope = "user" | "project" | "local" | "plugin" | "system";

export interface SetupOrigin {
  /** Stable within one read; a skill's or command's is what `open` takes. */
  id: string;
  agent: SetupAgent;
  scope: SetupScope;
  /** The file it was read from, home shortened to `~`: `~/.claude.json`. */
  source: string;
  /** The plugin that brings it, `name@marketplace`; null outside one. */
  plugin: string | null;
  /** Why it is not in effect — drawn dimmed (FE-40/D3); null when it is. */
  disabled: string | null;
}

export type SetupTransport = "stdio" | "http" | "sse" | "ws" | "unknown";

export interface SetupMcpServer extends SetupOrigin {
  name: string;
  transport: SetupTransport;
  /** The command's file name or the URL's host — nothing else of either. */
  target: string | null;
}

/** A skill (`SKILL.md`) or a slash command (`.md`). */
export interface SetupDoc extends SetupOrigin {
  name: string;
  description: string | null;
}

export interface SetupHook extends SetupOrigin {
  /** `Stop`, `PreToolUse`, … as the file names it. */
  event: string;
  matcher: string | null;
  /** `command`, `http`, `prompt`, … */
  type: string;
  /** What runs: the command or prompt, redacted, or a URL's host. */
  detail: string | null;
  /** Lanework's own checkpoint hook (FE-28, FE-29, INF-03) — marked (D5). */
  lanework: boolean;
}

/**
 * - `allow` / `ask` / `deny`: a rule — Claude's `permissions`, Codex's
 *   `prefix_rule`.
 * - `mode`: Claude's `defaultMode`.
 * - `directory`: one of Claude's `additionalDirectories`.
 * - `auto`: Claude's `autoMode` rules, as counts only — they are prose.
 * - `approval` / `sandbox` / `trust`: Codex's `approval_policy`,
 *   `sandbox_mode` and this folder's `trust_level`.
 */
export type SetupPermissionKind =
  | "allow"
  | "ask"
  | "deny"
  | "mode"
  | "directory"
  | "auto"
  | "approval"
  | "sandbox"
  | "trust";

export interface SetupPermission extends SetupOrigin {
  kind: SetupPermissionKind;
  value: string;
}

export interface SetupPlugin extends SetupOrigin {
  /** `name@marketplace`. */
  name: string;
  version: string | null;
}

export interface AgentSetup {
  /** The folder it was read for; null — and every list empty — without one. */
  folder: string | null;
  mcp: SetupMcpServer[];
  skills: SetupDoc[];
  commands: SetupDoc[];
  hooks: SetupHook[];
  permissions: SetupPermission[];
  plugins: SetupPlugin[];
  /**
   * Config files that are there but could not be read, so an empty group is
   * not taken for "nothing configured".
   */
  unreadable: string[];
  readAt: string;
}

/** One skill or command, opened read-only (FE-40/D4). */
export interface SetupFile {
  id: string;
  name: string;
  source: string;
  /** Its frontmatter as written, without the `---` lines; null for none. */
  frontmatter: string | null;
  body: string;
  /** Longer than one read takes; what is here is its start. */
  truncated: boolean;
}

export const agentSetupChannels = {
  read: "agent-setup:read",
  readGlobal: "agent-setup:read-global",
  open: "agent-setup:open",
  reveal: "agent-setup:reveal",
} as const;

/** An id main handed out — not a path, and never more than this long. */
export function isSetupId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

export interface DesktopAgentSetupApi {
  read: (slug: string) => Promise<AgentSetup>;
  /**
   * What every project gets — the `user`, `plugin` and `system` entries
   * alone, read for no folder. `folder` is null; skills and commands in it
   * cannot be opened (`open` takes a project).
   */
  readGlobal: () => Promise<AgentSetup>;
  /** A skill's `SKILL.md` or a command's file, by the id `read` gave it. */
  open: (slug: string, id: string) => Promise<SetupFile>;
  /** Show that file in Finder. */
  reveal: (slug: string, id: string) => Promise<void>;
}
