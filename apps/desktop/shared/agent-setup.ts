// A project's agent setup: every MCP server, skill, command, hook, permission
// and plugin Claude Code and Codex would load in its folder, as their config
// files on this machine say. Read-only, but for one thing: the user's answer
// to each CLI's trust question for the folder (FE-101).
//
// NOTE: Cleaned in MAIN, before it crosses. No `env`, `headers`, `args` value,
// token or URL query string ever reaches the renderer. An MCP server is its
// name, its transport, and the command's file name or the URL's host. Every
// command or rule shown has been through the checkpoint hook's `redact()`.
//
// NOTE: The renderer names a project by slug and a skill or command by the
// `id` main handed out with it, never by path (FE-40/D4).

/**
 * The CLIs whose setup is read; OpenCode since FE-104.
 *
 * NOTE: OpenCode asks no trust question for a folder, so {@link ProjectTrust}
 * has no `opencode` and main refuses `setTrust` for it.
 */
export type SetupAgent = "claude" | "codex" | "opencode";

/**
 * Where an entry comes from (FE-40/D3).
 *
 * The user's own config, the repo's, the user's config for this one folder, a
 * plugin, or Codex itself for the skills it ships in
 * `$CODEX_HOME/skills/.system`.
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
  /** Why it is not in effect, drawn dimmed (FE-40/D3); null when it is. */
  disabled: string | null;
}

export type SetupTransport = "stdio" | "http" | "sse" | "ws" | "unknown";

export interface SetupMcpServer extends SetupOrigin {
  name: string;
  transport: SetupTransport;
  /** The command's file name or the URL's host, and nothing else of either. */
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
  /** Whether it is Lanework's own checkpoint hook, marked in the view (D5). */
  lanework: boolean;
}

/**
 * What a permission entry is.
 *
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
  /** The folder it was read for; null, with every list empty, without one. */
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
  /** Whether the file is longer than one read takes; `body` is its start. */
  truncated: boolean;
}

/**
 * One CLI's trust in a project's folder (FE-101).
 *
 * - `trusted`: whether it loads the repo's own config there now.
 * - `own`: the folder's own record: true, false, or null with none.
 * - `from`: the folder above whose record trusts it when its own does not,
 *   home shortened to `~`. Untrusting the folder cannot take that away.
 */
export interface FolderTrust {
  trusted: boolean;
  own: boolean | null;
  from: string | null;
}

export interface ProjectTrust {
  /** The folder it was read for, home shortened; null without one. */
  folder: string | null;
  claude: FolderTrust;
  codex: FolderTrust;
}

export const agentSetupChannels = {
  read: "agent-setup:read",
  trust: "agent-setup:trust",
  setTrust: "agent-setup:set-trust",
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
   * The entries every project gets: `user`, `plugin` and `system` alone.
   *
   * Read for no folder, so `folder` is null. Its skills and commands cannot be
   * opened, since `open` takes a project.
   */
  readGlobal: () => Promise<AgentSetup>;
  /** A skill's `SKILL.md` or a command's file, by the id `read` gave it. */
  open: (slug: string, id: string) => Promise<SetupFile>;
  /** Shows that file in Finder. */
  reveal: (slug: string, id: string) => Promise<void>;
  /** Whether Claude Code and Codex trust the project's folder (FE-101). */
  trust: (slug: string) => Promise<ProjectTrust>;
  /**
   * Trust the project's folder, or take the trust back, for one CLI.
   *
   * Only on the user's confirmed click. Open chats in the project restart on
   * their next turn, an idle one at once.
   */
  setTrust: (
    slug: string,
    agent: SetupAgent,
    on: boolean,
  ) => Promise<ProjectTrust>;
}
