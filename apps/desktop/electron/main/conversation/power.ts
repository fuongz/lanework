// Settings → Power saver (FE-126): whether, and after how long, an idle
// chat's engine ends. Kept in `power.json` beside the app's other settings,
// and read by the engines' idle sweep on every pass, so a change applies
// within a minute.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import {
  checkPowerSettings,
  type PowerSettings,
} from "../../../shared/conversation";

const settingsFile = () => join(app.getPath("userData"), "power.json");

let cache: PowerSettings | null = null;
let writing: Promise<void> = Promise.resolve();

/** The saved settings, read once and then held. */
export async function readPowerSettings(): Promise<PowerSettings> {
  if (cache) return cache;
  try {
    cache = checkPowerSettings(
      JSON.parse(await readFile(settingsFile(), "utf8")),
    );
  } catch {
    cache = checkPowerSettings(null);
  }
  return cache;
}

/**
 * The idle limit in milliseconds, or null when power saver is off.
 *
 * Synchronous for the sweep: until the file has been read, the defaults.
 */
export function idleLimitMs(): number | null {
  const settings = cache ?? checkPowerSettings(null);
  if (!cache) void readPowerSettings();
  return settings.enabled ? settings.minutes * 60_000 : null;
}

/** Save `value`, checked, and answer what is now held. */
export async function writePowerSettings(
  value: unknown,
): Promise<PowerSettings> {
  const next = checkPowerSettings(value);
  cache = next;
  const file = settingsFile();
  writing = writing
    .then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(next));
      await rename(temp, file);
    })
    .catch(() => {
      // A failed write is dropped: the copy in memory still answers this run.
    });
  await writing;
  return next;
}
