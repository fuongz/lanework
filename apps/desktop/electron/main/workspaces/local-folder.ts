import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
  LocalFolderCard,
  LocalFolderSummary,
} from "../../../shared/workspaces";
import { resolveCardLocation } from "./review-location";

// Reads a project folder well enough to say what is in it, and no further.
//
// NOTE: This reader stops at the front matter and the first heading. The one
// definition of a checklist item (fence-aware, blockquote-aware) lives in the
// Lanework board's own parsers, in another repo. A second reader of a card's
// body here would disagree with the board the first time someone hand-edits a
// card, and nobody would see it, because both answers would look plausible.
// Front matter is a fixed set of `key: value` lines with no such ambiguity.
//
// NOTE: Read-only, always. Nothing here opens a file for writing, creates a
// directory or moves anything. Pointing this app at a folder must never change
// that folder.

/** Where a project keeps its review cards, relative to its root. */
export const REVIEW_ROOT = [".agents", "reviews"] as const;

/** How deep under the review root to look. Cards live in `<date>/<file>.md`. */
const MAX_DEPTH = 3;

/**
 * The most files one scan reads.
 *
 * NOTE: A cap, not a guess at how many cards exist. This runs on a folder the
 * user just chose, which could be a home directory or a `node_modules` tree,
 * and the main process must not spend unbounded time on it. Hitting the cap
 * sets `capped`, so the UI can say the counts are a floor.
 */
const MAX_FILES = 2_000;

/** How much of a card to read. Only the head is needed. */
const HEAD_BYTES = 8 * 1024;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const FRONT_LINE = /^([a-z_]+):[ \t]*(.*)$/;
const HEADING = /^#[ \t]+(.+)$/m;

/**
 * Read a front-matter value, unquoted and capped at 80 characters.
 *
 * `"done"`, `'done'` and `done` are the same value.
 *
 * @returns Null for an empty value, `~`, `null` or a list.
 */
function scalar(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (!value || value === "~" || value === "null" || value.startsWith("["))
    return null;
  return value.length > 80 ? value.slice(0, 80) : value;
}

/** The date half of a front-matter timestamp: all this screen shows. */
function day(raw: string | null): string | null {
  const match = raw?.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Read one card's front matter and heading.
 *
 * NOTE: It does not decide whether the file is a card. The caller does, with
 * {@link resolveCardLocation} and the board's own rule. A separate test here
 * ("does it have a schema or a status") once made this summary count 4 cards
 * where the migration counted 6.
 *
 * @param ref The card's path relative to the project root.
 * @param column The lane {@link resolveCardLocation} filed the card in.
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
    // NOTE: The lane the board files it in, not the raw `status:` field. They
    // differ for a file that declares no status, and the migration sends the
    // lane.
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
 * Summarize what a folder holds, as far as front matter can say.
 *
 * It also answers for a folder with no `.agents`, and says so with
 * `looksUnrelated` rather than an error. After choosing the wrong folder the
 * user needs to read "this is not a Lanework project". A thrown error would
 * show as "could not read the folder", which sounds like a permissions
 * problem.
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
    // The head only: front matter and the first heading sit in the first few
    // hundred bytes, and this screen does not read a card's body.
    const head = await readFile(file, "utf8")
      .then((text) => text.slice(0, HEAD_BYTES))
      .catch(() => null);
    if (head === null) {
      unreadable += 1;
      continue;
    }
    // NOTE: The same rule the migration uses, so this summary and the number
    // of cards that travel cannot disagree.
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
