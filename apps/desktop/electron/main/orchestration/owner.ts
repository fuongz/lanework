// Which Lanework drives the runs (FE-138).
//
// The installed app and a dev build (`mise run dev`) share one data folder.
// Both reading the runs is fine; both driving them is not: an instance that
// starts pauses every run it finds active, and saves it, as if the app had
// quit under it. So one instance holds `owner.json` and drives the runs; any
// other only follows them, read-only.
//
// - The first instance to find no lock, or a stale one, writes its own.
// - The owner beats every BEAT_MS. A lock whose pid is gone, or whose beat
//   is older than STALE_MS, is stale: a follower that finds it so takes
//   over (`onTakeover`).
// - The owner removes its lock on quit.
//
// Nothing here imports Electron: `index.ts` hands in the file and the label.

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** How often the owner says it is alive. */
export const BEAT_MS = 5_000;
/** How long a lock lives without a beat. */
export const STALE_MS = 20_000;

/** The lock as written. */
export interface OwnerLock {
  pid: number;
  /** One per process start: two instances never share it. */
  instance: string;
  /** How the page names the owner, e.g. "Lanework (Applications)". */
  label: string;
  /** Its last beat, epoch ms. */
  beat: number;
}

/** Whether process `pid` is alive on this machine. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive, only not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLock(value: unknown): value is OwnerLock {
  if (!value || typeof value !== "object") return false;
  const lock = value as Partial<OwnerLock>;
  return (
    typeof lock.pid === "number" &&
    typeof lock.instance === "string" &&
    typeof lock.label === "string" &&
    typeof lock.beat === "number"
  );
}

export class RunOwnership {
  readonly instance = randomUUID();
  private holder: OwnerLock | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Settled once the first claim answered. */
  readonly ready: Promise<void>;

  constructor(
    private readonly file: string,
    private readonly label: string,
    /** Called once this instance becomes the owner after following. */
    private readonly onTakeover: () => void,
  ) {
    this.ready = this.claim().then(() => {
      this.timer = setInterval(() => void this.tick(), BEAT_MS);
      this.timer.unref?.();
    });
  }

  /** Whether this instance drives the runs. */
  owns(): boolean {
    return this.holder?.instance === this.instance;
  }

  /** Who drives the runs when this instance does not; null when it does. */
  heldBy(): string | null {
    return this.owns() ? null : (this.holder?.label ?? null);
  }

  /**
   * Drop the lock, if it is ours: the app quits. Synchronous, so it is done
   * before the process ends.
   */
  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (isLock(value) && value.instance === this.instance)
        rmSync(this.file, { force: true });
    } catch {
      // No lock, or not one we can read: nothing of ours to drop.
    }
  }

  private async read(): Promise<OwnerLock | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return isLock(value) ? value : null;
    } catch {
      return null;
    }
  }

  private stale(lock: OwnerLock): boolean {
    return !alive(lock.pid) || Date.now() - lock.beat > STALE_MS;
  }

  private async write(): Promise<void> {
    const lock: OwnerLock = {
      pid: process.pid,
      instance: this.instance,
      label: this.label,
      beat: Date.now(),
    };
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${this.instance.slice(0, 8)}.tmp`;
    await writeFile(temp, JSON.stringify(lock), { mode: 0o600 });
    await rename(temp, this.file);
    this.holder = lock;
  }

  /** Take the lock when nobody live holds it; else follow its holder. */
  private async claim(): Promise<void> {
    const current = await this.read();
    if (!current || current.instance === this.instance || this.stale(current))
      await this.write();
    else this.holder = current;
  }

  private async tick(): Promise<void> {
    const current = await this.read();
    if (this.owns()) {
      // Another instance took it (both saw it stale at once): follow it.
      if (current && current.instance !== this.instance && !this.stale(current))
        this.holder = current;
      else await this.write();
      return;
    }
    if (current && !this.stale(current)) {
      this.holder = current;
      return;
    }
    await this.write();
    // Read back: of two instances that took it together, the last write
    // wins, and only it drives.
    const settled = await this.read();
    if (settled?.instance === this.instance) this.onTakeover();
    else this.holder = settled;
  }
}
