// Each project's autonomy dial (PD-08), read from and written to
// `<project folder>/autonomy.json`.
//
// - Read on every get, not cached: the file is a few bytes, and an edit by
//   hand is seen at once without a watcher.
// - Writes are atomic (a temp file, then a rename), 0600 as the permission
//   rules are, and one at a time per file.
// - Clearing the dial deletes the file, so "not set" has one shape on disk.
//
// NOTE: Electron-free, so it can be driven under plain Node.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type AutonomySettings,
  checkAutonomySettings,
} from "../../../shared/autonomy";
import { autonomyFile } from "../paths";

export interface AutonomyStoreDeps {
  /** The project's own folder under `<home>/projects`. */
  folderOf: (project: string) => Promise<string>;
  /** A project's dial changed. */
  changed: (project: string) => void;
}

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Write `text` to `file` through a temp file and a rename. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export class AutonomyStore {
  /** By file: its writes, one after another. */
  private writes = new Map<string, Promise<void>>();

  constructor(private readonly deps: AutonomyStoreDeps) {}

  private async file(project: string): Promise<string> {
    return autonomyFile(await this.deps.folderOf(project));
  }

  /**
   * `project`'s dial, or null when it is not set.
   *
   * NOTE: A file that cannot be read or parsed reads as not set, never as a
   * guess: the dial only ever loosens what an agent may do, so a broken file
   * must fall back to the agent's own settings.
   */
  async get(project: string): Promise<AutonomySettings | null> {
    const file = await this.file(project);
    await this.writes.get(file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (!isMissing(error)) console.error(`Could not read ${file}`, error);
      return null;
    }
    try {
      return checkAutonomySettings(JSON.parse(text));
    } catch (error) {
      console.error(`Could not read ${file}`, error);
      return null;
    }
  }

  /**
   * Store `project`'s dial, or delete the file for null.
   *
   * @returns What was stored, overrides equal to the level dropped.
   * @throws When `input` is neither null nor a dial with a known level.
   */
  async set(project: string, input: unknown): Promise<AutonomySettings | null> {
    const settings = input === null ? null : checkAutonomySettings(input);
    if (input !== null && !settings)
      throw new Error("That autonomy level is not known.");
    const file = await this.file(project);
    const run = (this.writes.get(file) ?? Promise.resolve()).then(() =>
      settings
        ? writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`)
        : rm(file, { force: true }),
    );
    this.writes.set(
      file,
      run.catch(() => {}),
    );
    await run;
    this.deps.changed(project);
    return settings;
  }
}
