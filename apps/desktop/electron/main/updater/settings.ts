// INF-11: what the updater keeps between launches, in <userData>/updater.json.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";

export interface UpdaterSettings {
  /** "Update automatically". On unless switched off. */
  auto: boolean;
  /**
   * The last version whose release notes were shown, or that was running
   * when this file was first written. Null until then.
   */
  lastSeenVersion: string | null;
}

const settingsFile = () => join(app.getPath("userData"), "updater.json");

let cache: UpdaterSettings | null = null;

export async function readSettings(): Promise<UpdaterSettings> {
  if (cache) return cache;
  try {
    const saved = JSON.parse(await readFile(settingsFile(), "utf8"));
    cache = {
      auto: saved?.auto !== false,
      lastSeenVersion:
        typeof saved?.lastSeenVersion === "string"
          ? saved.lastSeenVersion
          : null,
    };
  } catch {
    cache = { auto: true, lastSeenVersion: null };
  }
  return cache;
}

/**
 * Save `change` over what is held. This run follows it even when the file
 * cannot be written.
 */
export async function writeSettings(
  change: Partial<UpdaterSettings>,
): Promise<UpdaterSettings> {
  const next = { ...(await readSettings()), ...change };
  cache = next;
  try {
    const file = settingsFile();
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(next));
    await rename(temp, file);
  } catch {
    // Not saved: the next launch reads the old choice.
  }
  return next;
}
