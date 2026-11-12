// INF-11: a pretend update feed, so a dev run can walk the whole update flow.
//
// `LANEWORK_UPDATER_SIMULATE=<scenario> mise run dev` swaps electron-updater
// for this. Honoured only in an unpackaged run: a packaged build (release or
// Preview) never reads it, so nothing installed can be talked into it.
//
// Scenarios:
// - `available` (also `1`): a newer version is out; Download runs a fake
//   download (about 6 s) and Restart now pretends to install.
// - `none`: the check finds nothing newer.
// - `error`: the check fails.
// - `download-error`: a newer version is out, and its download fails at 40%.
//
// `LANEWORK_UPDATER_SIMULATE_VERSION` names the version offered; otherwise
// the next patch after this build's own.
import { EventEmitter } from "node:events";
import { app } from "electron";
import type { AppUpdater } from "electron-updater";

export type SimulatedScenario =
  | "available"
  | "none"
  | "error"
  | "download-error";

const SCENARIOS: readonly SimulatedScenario[] = [
  "available",
  "none",
  "error",
  "download-error",
];

/** The scenario this run pretends, or null for the real updater. */
export function simulatedScenario(): SimulatedScenario | null {
  if (app.isPackaged) return null;
  const said = process.env.LANEWORK_UPDATER_SIMULATE?.trim().toLowerCase();
  if (!said || said === "0" || said === "false") return null;
  if (said === "1" || said === "true") return "available";
  return (SCENARIOS as readonly string[]).includes(said)
    ? (said as SimulatedScenario)
    : "available";
}

/** The version offered: the env's, or the next patch after this build's. */
function offeredVersion(): string {
  const named = process.env.LANEWORK_UPDATER_SIMULATE_VERSION?.trim();
  if (named) return named.replace(/^v/, "");
  const [major = 0, minor = 0, patch = 0] = app
    .getVersion()
    .split(/[-+]/)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return `${major}.${minor}.${patch + 1}`;
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * The parts of electron-updater's `AppUpdater` the updater uses, pretended.
 *
 * Events and their order follow electron-updater: `checking-for-update`,
 * then `update-available` / `update-not-available` / `error`; after
 * `downloadUpdate`, `download-progress` and `update-downloaded` (or `error`).
 * `quitAndInstall` calls `onInstall` instead of quitting.
 */
export function createSimulatedUpdater(
  scenario: SimulatedScenario,
  onInstall: (version: string) => void,
): AppUpdater {
  const emitter = new EventEmitter();
  const version = offeredVersion();
  const info = () => ({
    version,
    files: [],
    path: "",
    sha512: "",
    releaseDate: new Date().toISOString(),
  });
  let downloading: Promise<string[]> | null = null;

  const fake = Object.assign(emitter, {
    logger: null as unknown,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: true,
    allowPrerelease: false,
    allowDowngrade: false,
    fullChangelog: false,

    async checkForUpdates() {
      emitter.emit("checking-for-update");
      await wait(1200);
      if (scenario === "error") {
        const error = new Error(
          "Simulated: could not reach the update feed (LANEWORK_UPDATER_SIMULATE=error)",
        );
        emitter.emit("error", error);
        throw error;
      }
      if (scenario === "none") {
        emitter.emit("update-not-available", {
          ...info(),
          version: app.getVersion(),
        });
        return null;
      }
      emitter.emit("update-available", info());
      return { updateInfo: info(), isUpdateAvailable: true };
    },

    downloadUpdate() {
      if (downloading) return downloading;
      downloading = (async () => {
        try {
          for (let percent = 0; percent <= 100; percent += 5) {
            if (scenario === "download-error" && percent === 40) {
              const error = new Error(
                "Simulated: the download broke off at 40% (LANEWORK_UPDATER_SIMULATE=download-error)",
              );
              emitter.emit("error", error);
              throw error;
            }
            emitter.emit("download-progress", {
              percent,
              bytesPerSecond: 1_000_000,
              transferred: percent * 1_000_000,
              total: 100_000_000,
              delta: 5_000_000,
            });
            await wait(300);
          }
          emitter.emit("update-downloaded", {
            ...info(),
            downloadedFile: "",
          });
          return [];
        } finally {
          downloading = null;
        }
      })();
      return downloading;
    },

    quitAndInstall() {
      onInstall(version);
    },
  });
  return fake as unknown as AppUpdater;
}
