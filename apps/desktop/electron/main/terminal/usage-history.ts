// The usage readings the forecast island (FE-181) draws its pace from.
//
// - Kept in memory and persisted to `<userData>/usage-history.json`, so the
//   history survives a restart.
// - Writes are debounced, atomic (a temp file, then a rename) and flushed when
//   the app quits.
// - Only the readings main already takes are recorded: nothing here asks a
//   provider for anything.
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import {
  appendSample,
  type ForecastAgent,
  historyKey,
  type UsageHistory,
  type UsageSample,
  windowOfMinutes,
} from "../../../shared/usage-forecast";
import { testEnv } from "../test-seams";

/** Bumped when the file's shape changes; any other version starts empty. */
const FILE_VERSION = 1;
const FILE_NAME = "usage-history.json";
const WRITE_DELAY_MS = 5_000;

let history: UsageHistory | null = null;
let writeTimer: NodeJS.Timeout | null = null;
let quitHooked = false;

function historyFile(): string {
  return join(app.getPath("userData"), FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps the well-formed samples of every list; never throws. */
function cleanHistory(value: unknown): UsageHistory {
  const clean: UsageHistory = {};
  if (!isRecord(value)) return clean;
  for (const [key, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    const samples: UsageSample[] = [];
    for (const entry of list) {
      if (
        !isRecord(entry) ||
        typeof entry.at !== "number" ||
        typeof entry.usedPercent !== "number" ||
        !Number.isFinite(entry.at) ||
        !Number.isFinite(entry.usedPercent)
      )
        continue;
      const resetsAt =
        typeof entry.resetsAt === "number" && Number.isFinite(entry.resetsAt)
          ? entry.resetsAt
          : null;
      samples.push({ at: entry.at, usedPercent: entry.usedPercent, resetsAt });
    }
    if (samples.length > 0) clean[key] = samples;
  }
  return clean;
}

/** The stored history; a missing, corrupt or other-version file reads empty. */
function load(): UsageHistory {
  try {
    const parsed: unknown = JSON.parse(readFileSync(historyFile(), "utf8"));
    if (isRecord(parsed) && parsed.version === FILE_VERSION)
      return cleanHistory(parsed.history);
  } catch {
    // Missing or unreadable: start empty.
  }
  return {};
}

function current(): UsageHistory {
  history ??= load();
  return history;
}

function writeNow(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!history) return;
  const file = historyFile();
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, JSON.stringify({ version: FILE_VERSION, history }), {
      mode: 0o600,
    });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    console.error("Could not write the usage history", error);
  }
}

function scheduleWrite(): void {
  if (!quitHooked) {
    quitHooked = true;
    app.on("will-quit", writeNow);
  }
  if (writeTimer) return;
  writeTimer = setTimeout(writeNow, WRITE_DELAY_MS);
  writeTimer.unref();
}

/**
 * Records one reading of an agent's rate-limit windows.
 *
 * A window that is neither the 5-hour nor the weekly one is ignored.
 *
 * @param at When the provider took the reading, epoch ms; now by default.
 */
export function recordUsage(
  agent: ForecastAgent,
  windows: {
    usedPercent: number;
    windowMinutes: number;
    resetsAt: number | null;
  }[],
  at = Date.now(),
): void {
  const all = current();
  let changed = false;
  for (const reading of windows) {
    const window = windowOfMinutes(reading.windowMinutes);
    if (!window) continue;
    const key = historyKey(agent, window);
    const before = all[key] ?? [];
    const after = appendSample(
      before,
      {
        at,
        usedPercent: reading.usedPercent,
        resetsAt: reading.resetsAt,
      },
      window,
    );
    if (after.length === before.length && after.at(-1) === before.at(-1))
      continue;
    all[key] = after;
    changed = true;
  }
  if (changed) scheduleWrite();
}

/**
 * A copy of the recorded history.
 *
 * NOTE: A test seam, guarded the way `LANEWORK_TEST_USER_DATA` is. Under
 * test, `LANEWORK_TEST_USAGE_HISTORY` names a JSON file holding a
 * `UsageHistory`, read on every call and answered instead of the live one.
 * A test run never reads the developer's real history: `userData` itself
 * moves to the test's folder.
 */
export function usageHistoryNow(): UsageHistory {
  const seam = testEnv("LANEWORK_TEST_USER_DATA")
    ? testEnv("LANEWORK_TEST_USAGE_HISTORY")
    : undefined;
  if (seam) {
    try {
      return cleanHistory(JSON.parse(readFileSync(seam, "utf8")));
    } catch {
      return {};
    }
  }
  return structuredClone(current());
}
