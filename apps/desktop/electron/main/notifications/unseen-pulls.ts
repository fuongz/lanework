// The count beside the rail's Issues row: new pull requests nobody has looked
// at yet, per project (FE-76). Your own count too: an agent opens them under
// your login, and they are news to you all the same.
//
// - Fed by every fresh read of a project's open list: the 2-minute watcher,
//   and the Pull requests screen's own reads (FE-76/D4).
// - Seen when the Pull requests tab of that project is on screen (FE-76/D1a).
// - Remembered across restarts in `pulls-seen.json` (FE-76/D2a).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { PullsView } from "../../../shared/git";
import { notificationChannels } from "../../../shared/notifications";
import { broadcast } from "../ipc";

interface SlugSeen {
  /**
   * When this project was first read. A pull request opened before it is old
   * news, even one that only now enters the list (it is capped at 50).
   */
  since: number;
  /** Ready-for-review pull requests already seen. */
  seen: number[];
}

/** How many seen numbers a project keeps. Old ones fall off. */
const SEEN_CAP = 1000;

const seenFile = () => join(app.getPath("userData"), "pulls-seen.json");

let store: Record<string, SlugSeen> | null = null;
let writing: Promise<void> = Promise.resolve();

/** Each project's last open list, to count from and to mark seen. */
const latest = new Map<string, PullsView>();

/** The last counts sent, so an unchanged count is not sent again. */
let sent: Record<string, number> = {};

/** The project whose Pull requests tab is on screen, if any. */
let onScreen: string | null = null;

async function readStore(): Promise<Record<string, SlugSeen>> {
  if (store) return store;
  try {
    const raw: unknown = JSON.parse(await readFile(seenFile(), "utf8"));
    store = {};
    if (raw && typeof raw === "object")
      for (const [slug, value] of Object.entries(raw)) {
        const entry = value as Partial<SlugSeen>;
        if (
          typeof entry.since === "number" &&
          Array.isArray(entry.seen) &&
          entry.seen.every((n) => typeof n === "number")
        )
          store[slug] = { since: entry.since, seen: entry.seen };
      }
  } catch {
    store = {};
  }
  return store;
}

function persist(value: Record<string, SlugSeen>): void {
  const file = seenFile();
  writing = writing
    .then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(value));
      await rename(temp, file);
    })
    .catch(() => {
      // A failed write is dropped: the copy in memory still answers this run.
    });
}

/** What counts: ready, not seen, and newer than the start. */
function unseen(entry: SlugSeen, view: PullsView): number[] {
  const seen = new Set(entry.seen);
  return view.pulls
    .filter(
      (pull) =>
        !pull.draft &&
        !seen.has(pull.number) &&
        Date.parse(pull.createdAt) > entry.since,
    )
    .map((pull) => pull.number);
}

function addSeen(entry: SlugSeen, numbers: number[]): void {
  if (!numbers.length) return;
  entry.seen = [...entry.seen, ...numbers].slice(-SEEN_CAP);
}

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  if (!store) return out;
  for (const [slug, view] of latest) {
    const entry = store[slug];
    if (!entry) continue;
    const count = unseen(entry, view).length;
    if (count > 0) out[slug] = count;
  }
  return out;
}

/** Tells every window the counts, when they changed. */
function send(): void {
  const next = counts();
  const keys = new Set([...Object.keys(next), ...Object.keys(sent)]);
  if ([...keys].every((key) => next[key] === sent[key])) return;
  sent = next;
  broadcast(notificationChannels.unseenPullsChanged, next);
}

/** Everything in the project's list counts as seen. */
function markSeen(slug: string): boolean {
  const entry = store?.[slug];
  const view = latest.get(slug);
  if (!entry || !view) return false;
  const fresh = unseen(entry, view);
  if (!fresh.length) return false;
  addSeen(entry, fresh);
  return true;
}

/**
 * A fresh read of a project's open pull requests.
 *
 * The first one ever for a project only takes note: what was open before
 * the count existed is not news.
 */
export async function observePulls(
  slug: string,
  view: PullsView,
): Promise<void> {
  if (view.status !== "open" || view.stale) return;
  const all = await readStore();
  latest.set(slug, view);
  let entry = all[slug];
  let changed = false;
  if (!entry) {
    entry = { since: Date.now(), seen: [] };
    all[slug] = entry;
    addSeen(
      entry,
      view.pulls.filter((pull) => !pull.draft).map((pull) => pull.number),
    );
    changed = true;
  }
  // Read while its tab is on screen: seen as it lands.
  if (onScreen === slug && markSeen(slug)) changed = true;
  if (changed) persist(all);
  send();
}

/** The project a path shows the Pull requests tab of, or null. */
function pullsSlug(path: string): string | null {
  const match = /^\/w\/([^/]+)\/issues\/pulls(?:\/|$)/.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Called on every move of the window to another screen. */
let navigated: () => void = () => {};

/**
 * Run `listener` whenever the window moves to another screen.
 *
 * The watcher reads again then: a pull request an agent opens from this
 * window's own terminal never takes the focus away, so a focus alone would
 * leave the count waiting out the 2-minute tick.
 */
export function onNavigate(listener: () => void): void {
  navigated = listener;
}

/** The window moved to `path`; a project's Pull requests tab clears its count. */
export function seenAt(path: string): void {
  navigated();
  onScreen = pullsSlug(path);
  if (!onScreen || !store) return;
  if (markSeen(onScreen)) {
    persist(store);
    send();
  }
}

/** The counts now, for a window that just opened. */
export async function unseenPullCounts(): Promise<Record<string, number>> {
  await readStore();
  return counts();
}
