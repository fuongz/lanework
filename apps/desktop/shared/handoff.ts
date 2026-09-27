// Handing a card between agents (FE-28): the Claude Code Stop hook that leaves
// a checkpoint on the card after every turn (BE-17), switched on from
// Settings → Agents instead of from a terminal.

/** What Settings → Agents shows. Everything here is read on the machine. */
export interface HandoffStatus {
  /**
   * Whether this build can install the hook here. macOS only for now: the
   * credential lives in the Keychain, and elsewhere there is nowhere as safe
   * to put it (FE-28, out of scope).
   */
  supported: boolean;
  /** Signed in, so there is a machine credential to hand the hook. */
  signedIn: boolean;
  /** Our Stop hook is in `~/.claude/settings.json`. */
  installed: boolean;
  /** The hook's credential is in the Keychain and matches this machine's. */
  credential: boolean;
  /** FE-28/D3: the hook also pushes the uncommitted tree. Off by default. */
  pushWip: boolean;
  /**
   * `~/.claude/settings.json` exists but is not JSON we can safely rewrite.
   * The switch refuses rather than overwrite a file somebody else owns.
   */
  settingsUnreadable: boolean;
  /** The settings file the hook goes into, for the row that names it. */
  settingsPath: string;
  /** The newest checkpoint the hook recorded on this machine, if any. */
  last: { taskId: string; at: string } | null;
}

export const handoffChannels = {
  status: "handoff:status",
  enable: "handoff:enable",
  disable: "handoff:disable",
  setPushWip: "handoff:push-wip",
} as const;

export interface DesktopHandoffApi {
  status: () => Promise<HandoffStatus>;
  /** Install the hook and hand it this machine's credential. */
  enable: () => Promise<HandoffStatus>;
  /** Remove the hook and its credential. Other hooks are left alone. */
  disable: () => Promise<HandoffStatus>;
  setPushWip: (on: boolean) => Promise<HandoffStatus>;
}
