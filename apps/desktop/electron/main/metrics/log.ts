// The resource log's files (FE-115): one JSON line per sample, one file per
// UTC hour, `<appHome>/metrics/2026-10-31T09.jsonl`, the newest 24 kept.
// No Electron here, so it can be tested on its own.
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MetricsSample } from "../../../shared/metrics";

const HOUR_MS = 3_600_000;
/** Hours kept, the current one included. */
export const KEEP_HOURS = 24;
const HOUR_FILE = /^(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

/** The file a sample taken at `at` goes in. */
export function hourFile(at: Date): string {
  return `${at.toISOString().slice(0, 13)}.jsonl`;
}

/**
 * Every route segment the app spells itself. Anything else in a path is a
 * project slug, a conversation, a card, a number or a sha: a name or an id,
 * which the log never keeps.
 */
const ROUTE_WORDS = new Set([
  "about",
  "account",
  "agents",
  "appearance",
  "board",
  "changes",
  "chat",
  "conductors",
  "config",
  "decision",
  "dictation",
  "effective",
  "files",
  "gh",
  "harness",
  "history",
  "instructions",
  "issues",
  "keybindings",
  "mcp",
  "memory",
  "models",
  "new",
  "notifications",
  "project-archived",
  "project-mcp",
  "project-skills",
  "projects",
  "pulls",
  "settings",
  "skills",
  "sub",
  "task",
  "w",
  "workspaces",
]);

/**
 * The screen `path` shows, with every segment the app did not spell itself
 * replaced by `$`: `/w/acme/agents/chat/3f2a` → `/w/$/agents/chat/$`. The
 * query and the hash are dropped.
 */
export function routeTemplate(path: string | null): string | null {
  if (path === null) return null;
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  const segments = bare.split("/");
  return segments
    .map((segment, i) =>
      // `/w/<slug>`: a project may be named like one of the words.
      (i === 2 && segments[1] === "w") ||
      (segment !== "" && !ROUTE_WORDS.has(segment))
        ? "$"
        : segment,
    )
    .join("/");
}

/** Append one sample to its hour's file; the folder is this user's only. */
export async function appendSample(
  dir: string,
  sample: MetricsSample,
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(
    join(dir, hourFile(new Date(sample.t))),
    `${JSON.stringify(sample)}\n`,
    { mode: 0o600 },
  );
}

/**
 * Delete the hour files older than the newest `KEEP_HOURS` hours before
 * `now`. Files of any other name are left alone.
 *
 * @returns the names deleted.
 */
export async function pruneSamples(dir: string, now: Date): Promise<string[]> {
  const names = await readdir(dir).catch((): string[] => []);
  const oldest = Math.floor(now.getTime() / HOUR_MS - (KEEP_HOURS - 1));
  const gone: string[] = [];
  for (const name of names) {
    const hour = HOUR_FILE.exec(name)?.[1];
    if (!hour) continue;
    const start = Date.parse(`${hour}:00:00Z`);
    if (Number.isNaN(start) || start / HOUR_MS >= oldest) continue;
    await rm(join(dir, name), { force: true });
    gone.push(name);
  }
  return gone;
}
