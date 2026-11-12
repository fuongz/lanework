// INF-11: updates from GitHub Releases, and What's New after one.
//
// - D1: electron-updater reads `latest-mac.yml` from the latest PUBLISHED
//   release of fuongz/lanework (the release workflow uploads it with the zip
//   Squirrel.Mac installs from). A draft is never in the feed: the provider
//   reads the public releases.atom and /releases/latest, neither of which
//   lists drafts or prereleases.
// - Checks on launch and every 4 hours while "Check automatically" is on,
//   and when Settings → About's Check for updates is pressed. A newer release
//   is only offered (`available`): it downloads when the person asks, from
//   the island, Settings → About or the menu's answer; then they choose when
//   to restart.
// - D4: Restart now counts live terminals and active runs first and answers
//   `confirm` while either is nonzero; the page asks again before `force`.
//   Later closes the prompt, and the update installs on the next quit.
// - D6: off entirely in a dev build (`X.Y.Z-dev.…`, INF-10), an unpackaged
//   run, and on any platform but macOS. electron-updater is never even
//   loaded there. An unpackaged run with LANEWORK_UPDATER_SIMULATE set walks
//   the whole flow against a pretend feed instead (`./simulate`).
// - D8: the first launch of a newer version shows its notes once
//   (`pendingWhatsNew`); the app menu's What's New opens them again.
import { createRequire } from "node:module";
import {
  app,
  BrowserWindow,
  dialog,
  autoUpdater as nativeUpdater,
} from "electron";
import type { AppUpdater, ProgressInfo, UpdateInfo } from "electron-updater";
import {
  isNewerRelease,
  isPrereleaseVersion,
  RELEASES_URL,
  type ReleaseNotes,
  type ReleaseNotesResult,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdaterDisabledReason,
  type UpdaterInstallAnswer,
  type UpdaterLiveWork,
  type UpdaterState,
  updaterChannels,
} from "../../../shared/updater";
import { broadcast, handle } from "../ipc";
import { quitForUpdate } from "../terminal";
import { updaterLog } from "./log";
import { fetchReleaseNotes } from "./release-notes";
import { readSettings, writeSettings } from "./settings";
import { createSimulatedUpdater, simulatedScenario } from "./simulate";

/** The launch check waits this long, so it never competes with startup. */
const LAUNCH_CHECK_DELAY_MS = 15_000;
/** A simulated run checks sooner: someone is sitting there waiting for it. */
const SIMULATED_LAUNCH_CHECK_DELAY_MS = 3_000;

/** The pretend feed's scenario, read once at registration; null when real. */
let simulated: ReturnType<typeof simulatedScenario> = null;

export interface UpdaterDeps {
  /** What a restart would stop right now. */
  liveWork: () => Promise<UpdaterLiveWork>;
}

function disabledReason(): UpdaterDisabledReason | null {
  if (simulated) return null;
  if (!app.isPackaged) return "unpackaged";
  if (isPrereleaseVersion(app.getVersion())) return "dev";
  if (process.platform !== "darwin") return "platform";
  return null;
}

let state: UpdaterState = {
  disabled: "unpackaged",
  auto: true,
  status: "idle",
  version: null,
  progress: null,
  error: null,
  checkedAt: null,
  postponed: false,
};
let updater: AppUpdater | null = null;
let timer: NodeJS.Timeout | null = null;
let checking: Promise<UpdaterState> | null = null;

function setState(change: Partial<UpdaterState>): void {
  state = { ...state, ...change };
  broadcast(updaterChannels.changed, state);
}

/** One line a person can read, from whatever electron-updater threw. */
function said(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const line = message.split("\n")[0]?.trim() || "Unknown error";
  return line.length > 300 ? `${line.slice(0, 297)}…` : line;
}

/**
 * electron-updater's `autoUpdater`, made and wired on first use.
 *
 * NOTE: Required at run time, not imported. electron-updater is the app's one
 * production dependency: electron-builder copies it and its dependencies into
 * app.asar's node_modules (see electron-builder.yml), and this loads that
 * copy. A static import would have esbuild inline it into main's bundle as
 * well, and a dev build would load it for nothing.
 */
function loadUpdater(): AppUpdater {
  if (updater) return updater;
  if (simulated) {
    updater = createSimulatedUpdater(simulated, (version) => {
      // Nothing to install and no reason to quit: say what would happen and
      // land where a restart on the new version would.
      updaterLog.info(`simulated: would quit and install ${version} now`);
      setState({
        status: "up-to-date",
        version: null,
        progress: null,
        error: null,
        postponed: false,
        checkedAt: Date.now(),
      });
    });
    wire(updater);
    return updater;
  }
  const runtimeRequire = createRequire(__filename);
  const { autoUpdater } = runtimeRequire("electron-updater") as {
    autoUpdater: AppUpdater;
  };
  autoUpdater.logger = updaterLog;
  // Never on its own: the person decides whether to take a release at all.
  autoUpdater.autoDownload = false;
  // NOTE: True from the start, not only after Later. MacUpdater hands the
  // download to Squirrel.Mac (which stages it for install on quit) only when
  // this is set at download time; set later, a quit would install nothing.
  // A download only ever starts because the person asked for it, so a
  // downloaded update installs on the next quit, as D4's Later does.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.fullChangelog = false;
  wire(autoUpdater);
  // Squirrel.Mac's own event, as quitAndInstall starts closing the windows.
  nativeUpdater.on("before-quit-for-update", () =>
    updaterLog.info(`quitting to install ${state.version}`),
  );
  updater = autoUpdater;
  return autoUpdater;
}

/** Follow an updater's events into `state`; the real one or the pretend. */
function wire(autoUpdater: AppUpdater): void {
  autoUpdater.on("checking-for-update", () => {
    setState({ status: "checking", error: null });
  });
  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    updaterLog.info(`up to date (latest published: ${info.version})`);
    setState({
      status: "up-to-date",
      version: null,
      progress: null,
      checkedAt: Date.now(),
    });
  });
  autoUpdater.on("update-available", (info: UpdateInfo) => {
    updaterLog.info(
      `update available: ${info.version}, waiting for the person`,
    );
    setState({
      status: "available",
      version: info.version,
      progress: null,
      checkedAt: Date.now(),
      postponed: info.version === state.version ? state.postponed : false,
    });
  });
  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    const percent = Math.floor(progress.percent);
    if (percent !== state.progress) setState({ progress: percent });
  });
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    updaterLog.info(`update ${info.version} downloaded, ready to install`);
    setState({
      status: "ready",
      version: info.version,
      progress: null,
      error: null,
      postponed: info.version === state.version ? state.postponed : false,
    });
  });
  autoUpdater.on("error", (error: Error) => {
    updaterLog.error(`update failed: ${said(error)}`);
    setState({
      status: "error",
      error: said(error),
      progress: null,
      checkedAt: Date.now(),
    });
  });
}

/** Ask GitHub for a newer release; answers once the check has ended. */
function check(
  reason: "launch" | "interval" | "manual",
): Promise<UpdaterState> {
  if (state.disabled) {
    updaterLog.info(`check (${reason}) skipped: ${state.disabled} build`);
    return Promise.resolve(state);
  }
  if (state.status === "downloading" || state.status === "ready") {
    updaterLog.info(
      `check (${reason}) skipped: ${state.version} is already ${state.status}`,
    );
    return Promise.resolve(state);
  }
  if (checking) return checking;
  updaterLog.info(`check (${reason}) from ${app.getVersion()}`);
  checking = (async () => {
    try {
      await loadUpdater().checkForUpdates();
    } catch (error) {
      // Already logged by the `error` event; make sure the state says so.
      if (state.status !== "error")
        setState({
          status: "error",
          error: said(error),
          progress: null,
          checkedAt: Date.now(),
        });
    } finally {
      checking = null;
    }
    return state;
  })();
  return checking;
}

function schedule(on: boolean): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (!on || state.disabled) return;
  timer = setInterval(() => void check("interval"), UPDATE_CHECK_INTERVAL_MS);
  timer.unref();
}

/** The person asked for the available update: download it. */
function download(): UpdaterState {
  const ready = updater;
  if (state.status !== "available" || !ready) return state;
  updaterLog.info(`downloading ${state.version}, as asked`);
  setState({
    status: "downloading",
    progress: 0,
    error: null,
    postponed: false,
  });
  // Its failure is reported through the `error` event.
  ready.downloadUpdate().catch(() => undefined);
  return state;
}

async function install(force: boolean): Promise<UpdaterInstallAnswer> {
  const ready = updater;
  if (state.status !== "ready" || !ready) return { result: "not-ready" };
  if (!force) {
    const live = await deps
      .liveWork()
      .catch((): UpdaterLiveWork => ({ terminals: 0, runs: 0 }));
    if (live.terminals > 0 || live.runs > 0) {
      updaterLog.info(
        `install ${state.version} held: ${live.terminals} terminals, ${live.runs} runs live`,
      );
      return { result: "confirm", live };
    }
  }
  updaterLog.info(
    `installing ${state.version} now${force ? " (confirmed over live work)" : ""}`,
  );
  // After the answer is on its way back to the page.
  setImmediate(() => {
    // A pretend install stops nothing: the terminals stay.
    if (!simulated) quitForUpdate();
    ready.quitAndInstall();
  });
  return { result: "installing" };
}

// ─── What's New (D8) ───────────────────────────────────────────────────────

let pending: Promise<ReleaseNotes | null> = Promise.resolve(null);

/**
 * The notes to show once for this launch: only when this version is newer
 * than the last one seen. A first launch, with nothing seen yet, just
 * remembers this version. Notes GitHub cannot give now are tried again on
 * the next launch.
 */
async function prepareWhatsNew(): Promise<ReleaseNotes | null> {
  const current = app.getVersion();
  const { lastSeenVersion } = await readSettings();
  if (!lastSeenVersion || isPrereleaseVersion(lastSeenVersion)) {
    await writeSettings({ lastSeenVersion: current });
    return null;
  }
  if (!isNewerRelease(current, lastSeenVersion)) {
    if (current !== lastSeenVersion)
      await writeSettings({ lastSeenVersion: current });
    return null;
  }
  const notes = await fetchReleaseNotes(current);
  if (!notes)
    updaterLog.warn(
      `notes for ${current} unavailable; trying again next launch`,
    );
  return notes;
}

async function releaseNotes(): Promise<ReleaseNotesResult> {
  const version = app.getVersion();
  if (isPrereleaseVersion(version))
    return { ok: false, reason: "dev", url: RELEASES_URL };
  const notes = await fetchReleaseNotes(version);
  return notes
    ? { ok: true, notes }
    : { ok: false, reason: "unavailable", url: RELEASES_URL };
}

// ─── Check for Updates… (the app menu) ─────────────────────────────────────

/** Why a build never checks, as the menu's answer says it. */
const OFF_REASONS: Record<NonNullable<UpdaterState["disabled"]>, string> = {
  dev: "This is a Preview build. It never updates; install the release to get updates.",
  unpackaged:
    "This is a development run. Updates come only to the installed release.",
  platform: "Updates are not available on this system yet.",
};

/**
 * The app menu's Check for Updates…: check now, then answer in a dialog, as
 * a Mac app does. A ready update offers Restart; live work asks first.
 */
export async function checkForUpdatesFromMenu(): Promise<void> {
  const parent =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const tell = (message: string, detail?: string, buttons = ["OK"]) =>
    parent
      ? dialog.showMessageBox(parent, { message, detail, buttons })
      : dialog.showMessageBox({ message, detail, buttons });
  if (state.disabled) {
    await tell("Updates are off in this build", OFF_REASONS[state.disabled]);
    return;
  }
  const now = await check("manual");
  const current = app.getVersion();
  switch (now.status) {
    case "up-to-date":
    case "idle":
      await tell(
        "You're up to date",
        `Lanework v${current} is the newest version.`,
      );
      return;
    case "checking":
    case "downloading":
      await tell(
        `Lanework v${now.version ?? "?"} is downloading`,
        "Lanework asks you to restart once it is ready. It also installs the next time you quit.",
      );
      return;
    case "available": {
      const { response } = await tell(
        `Lanework v${now.version ?? "?"} is available`,
        `You have v${current}. Download it now? Lanework asks before restarting.`,
        ["Download", "Not Now"],
      );
      if (response === 0) download();
      else if (now.version) setState({ postponed: true });
      return;
    }
    case "error":
      await tell("Could not check for updates", now.error ?? undefined);
      return;
    case "ready": {
      const { response } = await tell(
        `Lanework v${now.version ?? "?"} is ready to install`,
        "Restart now to update, or it installs the next time you quit.",
        ["Restart Now", "Later"],
      );
      if (response !== 0) return;
      const answer = await install(false);
      if (answer.result !== "confirm") return;
      const { terminals, runs } = answer.live;
      const live = [
        terminals
          ? `${terminals} agent ${terminals === 1 ? "tab" : "tabs"}`
          : "",
        runs ? `${runs} ${runs === 1 ? "run" : "runs"}` : "",
      ]
        .filter(Boolean)
        .join(" and ");
      const again = await tell(
        "Restart anyway?",
        `${live} still running will stop.`,
        ["Restart Anyway", "Cancel"],
      );
      if (again.response === 0) await install(true);
      return;
    }
  }
}

/** The app menu's What's New: the page opens the notes for this version. */
export function showReleaseNotes(): void {
  const window =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.webContents.send(updaterChannels.showWhatsNew);
}

// ─── Registration ──────────────────────────────────────────────────────────

let deps: UpdaterDeps = {
  liveWork: async () => ({ terminals: 0, runs: 0 }),
};

function noArgs(args: unknown[]): void {
  if (args.length) throw new Error("This operation takes no arguments");
}

export function registerUpdater(
  devUrl: string | undefined,
  given: UpdaterDeps,
) {
  deps = given;
  simulated = simulatedScenario();
  if (simulated) updaterLog.info(`simulating updates: ${simulated}`);
  const disabled = disabledReason();
  state = { ...state, disabled };
  updaterLog.info(
    disabled
      ? `updates off: ${disabled} build ${app.getVersion()}`
      : `updates on: ${app.getVersion()}`,
  );

  void readSettings().then((settings) => {
    setState({ auto: settings.auto });
    if (disabled || !settings.auto) return;
    schedule(true);
    setTimeout(
      () => void check("launch"),
      simulated ? SIMULATED_LAUNCH_CHECK_DELAY_MS : LAUNCH_CHECK_DELAY_MS,
    ).unref();
  });
  if (app.isPackaged && !isPrereleaseVersion(app.getVersion()))
    pending = prepareWhatsNew().catch(() => null);

  app.on("will-quit", () => schedule(false));

  handle(updaterChannels.get, devUrl, (args): UpdaterState => {
    noArgs(args);
    return state;
  });
  handle(updaterChannels.setAuto, devUrl, async (args) => {
    const [auto] = args;
    if (args.length !== 1 || typeof auto !== "boolean")
      throw new Error("On or off is required.");
    await writeSettings({ auto });
    setState({ auto });
    updaterLog.info(`check automatically: ${auto ? "on" : "off"}`);
    schedule(auto);
    if (auto) void check("manual");
    return state;
  });
  handle(updaterChannels.check, devUrl, (args) => {
    noArgs(args);
    return check("manual");
  });
  handle(updaterChannels.download, devUrl, (args): UpdaterState => {
    noArgs(args);
    return download();
  });
  handle(updaterChannels.install, devUrl, (args) => {
    const [force] = args;
    if (args.length !== 1 || typeof force !== "boolean")
      throw new Error("force must be true or false");
    return install(force);
  });
  handle(updaterChannels.later, devUrl, (args): UpdaterState => {
    noArgs(args);
    if (updater) updater.autoInstallOnAppQuit = true;
    if (state.status === "ready") {
      updaterLog.info(`install ${state.version} later, on the next quit`);
      setState({ postponed: true });
    } else if (state.status === "available") {
      updaterLog.info(`${state.version} not now`);
      setState({ postponed: true });
    }
    return state;
  });
  handle(updaterChannels.pendingWhatsNew, devUrl, (args) => {
    noArgs(args);
    return pending;
  });
  handle(updaterChannels.markWhatsNewSeen, devUrl, async (args) => {
    noArgs(args);
    pending = Promise.resolve(null);
    await writeSettings({ lastSeenVersion: app.getVersion() });
  });
  handle(updaterChannels.releaseNotes, devUrl, (args) => {
    noArgs(args);
    return releaseNotes();
  });
}
