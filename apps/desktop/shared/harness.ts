// Harness updates (FE-61): which version of each agent CLI this machine runs,
// whether a newer one is out, and updating it from the app.
import type { TerminalAgent } from "./terminal";

/** A harness is one of the agent CLIs a tab can run. */
export type HarnessAgent = TerminalAgent;

/**
 * How the CLI was installed, read from where its binary really lives. It
 * decides both where "latest" comes from and which command updates it.
 */
export type InstallMethod =
  | "native"
  | "brew-cask"
  | "brew-formula"
  | "npm"
  | "unknown";

export type HarnessUpdateState =
  | { state: "idle" }
  | { state: "updating" }
  | { state: "done"; version: string }
  | { state: "failed"; message: string };

export interface HarnessInfo {
  agent: HarnessAgent;
  /** The binary's real path, links resolved; null when it is not installed. */
  path: string | null;
  /** The installed version; null when it is not installed or unreadable. */
  version: string | null;
  /** The newest version its install method offers; null when unknown. */
  latest: string | null;
  installMethod: InstallMethod;
  /**
   * The command that updates it, fixed by main from the install method —
   * never anything the renderer supplied. Null when the app cannot tell how
   * it was installed, and there is no Update button.
   */
  updateCommand: string | null;
  /** The version the user closed the island on (FE-61/D9), or null. */
  dismissed: string | null;
  update: HarnessUpdateState;
  /** ISO time of the last check; null before the first one finishes. */
  checkedAt: string | null;
}

/** Whether a harness has an update the island should offer. */
export function hasPendingUpdate(info: HarnessInfo): boolean {
  return (
    info.version !== null &&
    info.latest !== null &&
    info.updateCommand !== null &&
    info.latest !== info.dismissed &&
    compareVersions(info.latest, info.version) > 0
  );
}

/**
 * Compare two dotted versions numerically: negative, zero or positive.
 * A pre-release (`1.2.0-beta.1`) sorts before its release.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/, "").split("-", 2);
    return {
      parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre,
    };
  };
  const left = split(a);
  const right = split(b);
  const length = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < length; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export const harnessChannels = {
  list: "harness:list",
  check: "harness:check",
  update: "harness:update",
  dismiss: "harness:dismiss",
  openInTerminal: "harness:open-in-terminal",
  /** main → renderer: the list changed. Carries `HarnessInfo[]`. */
  changed: "harness:changed",
} as const;

export interface DesktopHarnessApi {
  /** The last known state, without asking anything again. */
  list: () => Promise<HarnessInfo[]>;
  /** Probe versions and ask for the latest now, whatever the schedule says. */
  check: () => Promise<HarnessInfo[]>;
  /** Run the harness's update command in the background. */
  update: (agent: HarnessAgent) => Promise<HarnessInfo[]>;
  /** Skip exactly `version` of this harness until a newer one is out. */
  dismiss: (agent: HarnessAgent, version: string) => Promise<HarnessInfo[]>;
  /** Run the update command in Terminal, where its output can be read. */
  openInTerminal: (agent: HarnessAgent) => Promise<void>;
  onChanged: (listener: (list: HarnessInfo[]) => void) => () => void;
}
