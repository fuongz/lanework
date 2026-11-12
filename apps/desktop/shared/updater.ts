// INF-11: updates and What's New.
//
// A release build (`X.Y.Z`, packaged, macOS) checks the published GitHub
// Releases of fuongz/lanework through electron-updater: on launch and every
// 4 hours while "Check automatically" is on, and whenever the person presses
// Check for updates. A newer release is only offered: nothing downloads until
// the person says so (the island outside Settings, Settings → About, or the
// app menu's answer), and once it is downloaded they choose when to restart. A dev build (`X.Y.Z-dev.…`, INF-10) or an
// unpackaged run never checks.
//
// After an update, the first launch of the newer version shows that release's
// notes once; the app menu opens them again.

/** The repository whose published releases are the update feed. */
export const RELEASE_REPO = { owner: "fuongz", repo: "lanework" } as const;

/** Where a person reads every release, when the notes cannot be shown. */
export const RELEASES_URL = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases`;

/** How often a release build checks while "Update automatically" is on. */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** The longest release notes the app reads; the rest is cut. */
export const RELEASE_NOTES_MAX = 100_000;

/**
 * Why a build never checks.
 *
 * - `dev`: the version carries a prerelease tag (`-dev.…`, INF-10).
 * - `unpackaged`: run from the checkout (`bun run dev`, the test suite).
 * - `platform`: only the macOS build is released.
 */
export type UpdaterDisabledReason = "dev" | "unpackaged" | "platform";

/**
 * Where the updater is.
 *
 * - `idle`: nothing checked yet this run.
 * - `checking`: under way.
 * - `available`: a newer release is out; nothing is downloaded until the
 *   person asks (`download`).
 * - `downloading`: the person asked, and it is under way.
 * - `ready`: an update is downloaded and waits to be installed.
 * - `up-to-date`: the last check found nothing newer.
 * - `error`: the last check or download failed; `error` says why.
 */
export type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error";

export interface UpdaterState {
  /** Null when this build checks; otherwise why it never does. */
  disabled: UpdaterDisabledReason | null;
  /** "Check automatically": check on launch and every 4 hours. On by default. */
  auto: boolean;
  status: UpdaterStatus;
  /** The version available, being downloaded or ready; null otherwise. */
  version: string | null;
  /** Download progress, 0 to 100, while `downloading`. */
  progress: number | null;
  /** What went wrong, for a person to read, while `error`. */
  error: string | null;
  /** When the last check finished, ms since the epoch. */
  checkedAt: number | null;
  /**
   * The person chose Later for this version: the island stops offering it
   * for this run. A ready update still installs the next time Lanework
   * quits; an available one stays undownloaded.
   */
  postponed: boolean;
}

/** What still runs and a restart would stop. */
export interface UpdaterLiveWork {
  /** Live terminal tabs, agent or shell. */
  terminals: number;
  /** Orchestration runs that are active (not paused, stopped or finished). */
  runs: number;
}

/**
 * The answer to Restart now.
 *
 * - `installing`: Lanework quits and comes back on the new version.
 * - `confirm`: work is still running; ask again with `force` to go ahead.
 * - `not-ready`: there is no downloaded update to install.
 */
export type UpdaterInstallAnswer =
  | { result: "installing" }
  | { result: "confirm"; live: UpdaterLiveWork }
  | { result: "not-ready" };

/** One published release's notes, from the GitHub API. */
export interface ReleaseNotes {
  version: string;
  /** The release's title, e.g. "Lanework 0.2.0". */
  title: string;
  /** Markdown, as GitHub holds it. */
  body: string;
  /** The release's page on github.com. */
  url: string;
}

/**
 * The notes for this build's version.
 *
 * - `dev`: a dev build has no release of its own.
 * - `unavailable`: GitHub could not be reached, or has no such release.
 */
export type ReleaseNotesResult =
  | { ok: true; notes: ReleaseNotes }
  | { ok: false; reason: "dev" | "unavailable"; url: string };

export const updaterChannels = {
  get: "updater:get",
  setAuto: "updater:set-auto",
  check: "updater:check",
  /** Download the available update; the person asked for it. */
  download: "updater:download",
  install: "updater:install",
  later: "updater:later",
  /** The notes of a version this Mac just updated to, once; else null. */
  pendingWhatsNew: "updater:pending-whats-new",
  /** The person closed the notes shown after an update: never again. */
  markWhatsNewSeen: "updater:mark-whats-new-seen",
  /** The notes for this build's version, for the menu's What's New. */
  releaseNotes: "updater:release-notes",
  /** Main → renderer: the updater's state changed. */
  changed: "updater:changed",
  /** Main → renderer: the app menu's What's New was chosen. */
  showWhatsNew: "updater:show-whats-new",
} as const;

export interface DesktopUpdaterApi {
  get: () => Promise<UpdaterState>;
  /** Switch "Update automatically"; answers with the new state. */
  setAuto: (auto: boolean) => Promise<UpdaterState>;
  /** Check now, whatever the switch says; answers once the check ends. */
  check: () => Promise<UpdaterState>;
  /** Download the available update; answers once the download started. */
  download: () => Promise<UpdaterState>;
  /**
   * Restart now and install the ready update. Without `force`, main answers
   * `confirm` while terminals or runs are live, and does nothing.
   */
  install: (force: boolean) => Promise<UpdaterInstallAnswer>;
  /**
   * Later: stop offering this version for this run. A ready update installs
   * on the next quit.
   */
  later: () => Promise<UpdaterState>;
  pendingWhatsNew: () => Promise<ReleaseNotes | null>;
  markWhatsNewSeen: () => Promise<void>;
  releaseNotes: () => Promise<ReleaseNotesResult>;
  onChange: (listener: (state: UpdaterState) => void) => () => void;
  onShowWhatsNew: (listener: () => void) => () => void;
}

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether `version` is SemVer with a prerelease tag (`0.2.1-dev.…`). */
export function isPrereleaseVersion(version: string): boolean {
  const match = SEMVER.exec(version);
  return !match || match[4] !== undefined;
}

/**
 * Whether release `version` is newer than release `than`. Both must be plain
 * `X.Y.Z`; anything else answers false, so a dev or unreadable version never
 * counts as an update.
 */
export function isNewerRelease(version: string, than: string): boolean {
  const a = SEMVER.exec(version);
  const b = SEMVER.exec(than);
  if (!a || !b || a[4] !== undefined || b[4] !== undefined) return false;
  for (let index = 1; index <= 3; index++) {
    const left = Number(a[index]);
    const right = Number(b[index]);
    if (left !== right) return left > right;
  }
  return false;
}
