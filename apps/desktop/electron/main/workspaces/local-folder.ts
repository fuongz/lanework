import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
  LocalFolderCard,
  LocalFolderSummary,
} from "../../../shared/workspaces";
import { resolveCardLocation } from "./review-location";

/**
 * Reading a project folder well enough to say what is in it — and no further.
 *
 * ⚠️ This reader stops at the front matter and the first heading, ON PURPOSE.
 * The single definition of what a checklist item is (fence-aware,
 * blockquote-aware) lives in the Lanework board's own parsers, in another repo;
 * a second reader of a card's BODY here would disagree with the board the first
 * time somebody hand-edits a card, and the disagreement would be invisible
 * because both sides would look plausible. Front matter is a fixed set of
 * `key: value` lines nothing has an opinion about.
 *
 * ⚠️ Read-only, always. Nothing in this file opens a file for writing, creates
 * a directory, or moves anything. Pointing this app at a folder must never be
 * able to change that folder.
 */

/** Where a project keeps its review cards, relative to its root. */
export const REVIEW_ROOT = [".agents", "reviews"] as const;

/** How deep under the review root to look. Cards live in `<date>/<file>.md`. */
const MAX_DEPTH = 3;

/**
 * How many files one scan reads.
 *
 * ⚠️ A cap, not a guess at how many cards exist: this runs on a folder a user
 * just chose, which could be a home directory or a node_modules tree, and the
 * main process is not somewhere to spend an unbounded amount of time. Hitting
 * it sets `capped`, so the UI can say the counts are a floor.
 */
const MAX_FILES = 2_000;

/** Only the head of a card is needed, and a card is not a place for megabytes. */
const HEAD_BYTES = 8 * 1024;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const FRONT_LINE = /^([a-z_]+):[ \t]*(.*)$/;
const HEADING = /^#[ \t]+(.+)$/m;

/** `"done"`, `'done'` and `done` are the same value; `[]` and `~` are absent. */
function scalar(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (!value || value === "~" || value === "null" || value.startsWith("["))
    return null;
  return value.length > 80 ? value.slice(0, 80) : value;
}

/** The date half of a front-matter timestamp, which is all this screen shows. */
function day(raw: string | null): string | null {
  const match = raw?.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * One card's front matter and heading.
 *
 * ⚠️ It does NOT decide whether the file is a card — `resolveCardLocation`
 * does, with the board's own rule, and the caller applies it. Deciding it here
 * (on "does it have a schema or a status") is what made this summary count 4
 * cards where the migration counted 6.
 */
function readCardHead(
  ref: string,
  head: string,
  column: string,
): LocalFolderCard {
  const fields = new Map<string, string>();
  const front = head.match(FRONT_MATTER);
  for (const line of front?.[1]?.split(/\r?\n/) ?? []) {
    const match = line.match(FRONT_LINE);
    if (match?.[1] && match[2] !== undefined) fields.set(match[1], match[2]);
  }

  const body = front ? head.slice(front[0].length) : head;
  const heading = body.match(HEADING)?.[1]?.trim() ?? "";
  const title = heading.replace(/^Review:[ \t]*/i, "").trim();

  return {
    ref,
    taskId: scalar(fields.get("task_id") ?? ""),
    // A card with no heading still has a name: the file it lives in. An empty
    // title would render as a blank row and read as data loss.
    title: title || basename(ref, ".md"),
    // ⚠️ The lane the board would file it in, not the raw `status:` field —
    // they differ for a file that declares no status, and the lane is what the
    // migration will send.
    status: column,
    category: scalar(fields.get("category") ?? ""),
    createdAt: day(scalar(fields.get("created_at") ?? "")),
  };
}

/** The raw `status:` line, for the location rule to resolve. */
function frontStatus(head: string): string | null {
  const front = head.match(FRONT_MATTER);
  for (const line of front?.[1]?.split(/\r?\n/) ?? []) {
    const match = line.match(FRONT_LINE);
    if (match?.[1] === "status") return match[2] ?? null;
  }
  return null;
}

/** Whether this path is a directory that still exists and can be listed. */
export async function folderExists(path: string): Promise<boolean> {
  return await stat(path)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
}

/** Every `.md` file under `root`, breadth-first, up to the cap. */
export async function listCardFiles(
  root: string,
): Promise<{ files: string[]; capped: boolean }> {
  const files: string[] = [];
  let queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const next: typeof queue = [];
    for (const { dir, depth } of queue) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth + 1 < MAX_DEPTH) next.push({ dir: path, depth: depth + 1 });
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          if (files.length >= MAX_FILES) return { files, capped: true };
          files.push(path);
        }
      }
    }
    queue = next;
  }
  return { files, capped: false };
}

/**
 * What a folder holds, as far as front matter can say.
 *
 * ⚠️ It answers for a folder with no `.agents` too, and says so with
 * `looksUnrelated` rather than an error. "This is not a Lanework project" is
 * something the user needs to read after choosing the wrong folder, and a
 * thrown error would land as "could not read the folder", which sounds like a
 * permissions problem.
 */
export async function readLocalFolder(
  path: string,
): Promise<LocalFolderSummary> {
  const empty: LocalFolderSummary = {
    path,
    reviewRoot: null,
    cards: 0,
    byStatus: {},
    byCategory: {},
    newest: null,
    unreadable: 0,
    capped: false,
    looksUnrelated: !(await folderExists(join(path, ".agents"))),
    sample: [],
  };

  const root = join(path, ...REVIEW_ROOT);
  if (!(await folderExists(root))) return empty;

  const { files, capped } = await listCardFiles(root);
  const cards: LocalFolderCard[] = [];
  let unreadable = 0;
  for (const file of files) {
    // The head only: front matter and the first heading are in the first few
    // hundred bytes, and a card's body is not this screen's business.
    const head = await readFile(file, "utf8")
      .then((text) => text.slice(0, HEAD_BYTES))
      .catch(() => null);
    if (head === null) {
      unreadable += 1;
      continue;
    }
    // ⚠️ The SAME rule the migration uses, so this summary and the number of
    // cards that actually travel cannot disagree.
    const location = resolveCardLocation(
      relative(root, file).split("/"),
      frontStatus(head),
    );
    if (!location) continue;
    cards.push(readCardHead(relative(path, file), head, location.column));
  }

  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let newest: string | null = null;
  for (const card of cards) {
    const status = card.status ?? "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (card.category)
      byCategory[card.category] = (byCategory[card.category] ?? 0) + 1;
    // ISO dates compare correctly as strings, and these are `YYYY-MM-DD`.
    if (card.createdAt && (!newest || card.createdAt > newest))
      newest = card.createdAt;
  }

  return {
    ...empty,
    reviewRoot: cards.length ? REVIEW_ROOT.join("/") : null,
    cards: cards.length,
    byStatus,
    byCategory,
    newest,
    unreadable,
    capped,
    looksUnrelated: false,
    sample: [...cards]
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, 5),
  };
}
