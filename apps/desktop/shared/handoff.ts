// Handing a card between agents (FE-28, FE-29): the Stop hook that leaves a
// checkpoint on the card after every turn (BE-17), for Claude Code and for
// Codex, switched on from Settings → Agents instead of from a terminal.

export type HookAgent = "claude-code" | "codex";

/** One CLI's hook, as its settings file holds it. */
export interface AgentHookStatus {
  /** Our Stop hook is in this CLI's settings file. */
  installed: boolean;
  /**
   * The settings file exists but is not JSON we can safely rewrite. The
   * switch refuses rather than overwrite a file somebody else owns.
   */
  settingsUnreadable: boolean;
  /** The file the hook goes into, for the row that names it. */
  settingsPath: string;
  /**
   * We installed it and it is gone — another tool rewrote the file
   * (FE-29/D8). Shown, never silently re-added.
   */
  removedElsewhere: boolean;
}

export interface CodexHookStatus extends AgentHookStatus {
  /** `[features] hooks = true` in Codex's config.toml; without it no hook runs. */
  hooksEnabled: boolean;
  /**
   * Codex holds an approval for the hook at our position (FE-29/D7). Read
   * from config.toml, never written by the app.
   */
  approved: boolean;
  configPath: string;
}

/** What Settings → Agents shows. Everything here is read on the machine. */
export interface HandoffStatus {
  /**
   * Whether this build can install the hook here. macOS only for now: the
   * credential lives in the Keychain, and elsewhere there is nowhere as safe
   * to put it.
   */
  supported: boolean;
  /** Signed in, so there is a machine credential to hand the hook. */
  signedIn: boolean;
  /** The hook's credential is in the Keychain and matches this machine's. */
  credential: boolean;
  /** FE-28/D3: the hook also pushes the uncommitted tree. Off by default. */
  pushWip: boolean;
  /** The newest checkpoint the hook recorded on this machine, if any. */
  last: { taskId: string; at: string } | null;
  claude: AgentHookStatus;
  codex: CodexHookStatus;
  /** What to add to Codex's config.toml when hooks are off (FE-29/D5). */
  codexFeatureLine: string;
}

export const handoffChannels = {
  status: "handoff:status",
  enable: "handoff:enable",
  disable: "handoff:disable",
  setPushWip: "handoff:push-wip",
} as const;

export interface DesktopHandoffApi {
  status: () => Promise<HandoffStatus>;
  /** Install the hook for one CLI and hand it this machine's credential. */
  enable: (agent: HookAgent) => Promise<HandoffStatus>;
  /** Remove one CLI's hook. Other hooks in its file are left alone. */
  disable: (agent: HookAgent) => Promise<HandoffStatus>;
  /** For both CLIs: a setting the hook reads, not part of its command. */
  setPushWip: (on: boolean) => Promise<HandoffStatus>;
}
