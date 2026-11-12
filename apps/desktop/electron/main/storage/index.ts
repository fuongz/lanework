// Settings → Storage. Measures Electron's `userData` and the app home with
// `du`, and empties Chromium's caches through the session: never by deleting
// their files, which the running app holds open.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, session, shell } from "electron";
import {
  type StorageFolder,
  type StorageUsage,
  storageChannels,
} from "../../../shared/storage";
import { handle } from "../ipc";
import { appHomeDir } from "../paths";

const runFile = promisify(execFile);

/**
 * Chromium's cache folders under `userData` that {@link clearCache} empties:
 * HTTP, V8 code, GPU shaders. Only measured here.
 *
 * NOTE: `GraphiteDawnCache` is left out on purpose. No session call clears
 * it and it grows again with every frame drawn, so counting it would show
 * a Clear cache that seems to do nothing. It stays in the total.
 */
const CACHE_DIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
];

async function existing(paths: string[]): Promise<string[]> {
  const found = await Promise.all(
    paths.map((path) =>
      stat(path).then(
        () => path,
        () => null,
      ),
    ),
  );
  return found.filter((path): path is string => path !== null);
}

/**
 * Bytes on disk under `paths`, together; 0 when none of them exists.
 *
 * `du`, not a walk in Node: a run's worktree can hold a `node_modules` of
 * a hundred thousand files, and `du` reads them in a fraction of the time.
 * It exits non-zero when one file cannot be read and still prints the rest,
 * so its output is used either way.
 */
async function diskUsage(paths: string[]): Promise<number> {
  const present = await existing(paths);
  if (!present.length) return 0;
  const stdout = await runFile("du", ["-sk", "--", ...present], {
    maxBuffer: 1 << 20,
  }).then(
    (result) => result.stdout,
    (error: { stdout?: string }) => error.stdout ?? "",
  );
  let kib = 0;
  for (const line of stdout.split("\n")) {
    const size = Number.parseInt(line, 10);
    if (Number.isFinite(size)) kib += size;
  }
  return kib * 1024;
}

async function usage(): Promise<StorageUsage> {
  const root = app.getPath("userData");
  const [cache, checkouts, userData, projects] = await Promise.all([
    diskUsage(CACHE_DIRS.map((dir) => join(root, dir))),
    diskUsage([join(root, "orchestration", "worktrees")]),
    diskUsage([root]),
    diskUsage([appHomeDir()]),
  ]);
  // The rest of `userData`. Measured apart, so never below zero.
  const rest = Math.max(0, userData - cache - checkouts);
  return {
    total: cache + checkouts + projects + rest,
    parts: { cache, checkouts, projects, app: rest },
  };
}

let clearing: Promise<StorageUsage> | null = null;

/** One clear at a time: a second click waits for the first. */
function clearCache(): Promise<StorageUsage> {
  clearing ??= (async () => {
    const ses = session.defaultSession;
    await ses.clearCache();
    await ses.clearCodeCaches({});
    await ses.clearStorageData({ storages: ["shadercache"] });
    return usage();
  })().finally(() => {
    clearing = null;
  });
  return clearing;
}

export function registerStorage(devUrl?: string): void {
  handle(storageChannels.usage, devUrl, (args): Promise<StorageUsage> => {
    if (args.length) throw new Error("This operation takes no arguments");
    return usage();
  });

  handle(storageChannels.clearCache, devUrl, (args): Promise<StorageUsage> => {
    if (args.length) throw new Error("This operation takes no arguments");
    return clearCache();
  });

  handle(storageChannels.reveal, devUrl, async (args): Promise<void> => {
    const [folder] = args as [StorageFolder];
    if (args.length !== 1 || (folder !== "app" && folder !== "projects"))
      throw new Error("Which folder to open is required.");
    await shell.openPath(
      folder === "app" ? app.getPath("userData") : appHomeDir(),
    );
  });
}
