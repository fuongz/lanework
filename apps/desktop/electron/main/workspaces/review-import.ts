import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { folderExists, listCardFiles, REVIEW_ROOT } from "./local-folder";
import {
  buildReviewFileCard,
  parseFrontmatterMap,
  type ReviewFileCard,
} from "./review-card";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_COLUMNS,
  TAG_MAX,
} from "./review-defaults";
import { resolveCardLocation } from "./review-location";

// Turns a repo's review files into the cloud's import records.
//
// NOTE: Read-only over the source, always. Nothing here opens a file for
// writing: the old copy stays where it is so a human can compare. Re-running is
// safe because the API keys every card on `(source_kind, source_ref)`, and
// `source_ref` here is the same repo-relative path the CLI sends. Both routes
// into the cloud produce one card, not two.
//
// NOTE: It refuses to run against a repo with `.agents/reviews/config.json`.
// That file can rename the lanes, re-map `status`, and change the task-id
// format and the tag cap. This app reads the defaults only, so a board with a
// custom config would get its cards filed into lanes it does not have. The
// refusal names the CLI, which reads the config.

/** The `source_kind` every card from a repo's review folder carries. */
const SOURCE_KIND = "local-review";

/** How many records one request carries: the API's own cap. */
export const IMPORT_BATCH = 50;

export { DEFAULT_CATEGORIES, DEFAULT_COLUMNS } from "./review-defaults";

/**
 * Hash a card's text into its `sha`: the first 12 hex of its sha1.
 *
 * It matches the board's own `contentSha`, which the cloud keys on.
 */
export function contentSha(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** One checklist row of an {@link ImportRecord}. */
interface ImportChecklistRow {
  key: string;
  section: "decisions" | "verify";
  text: string;
  checked?: boolean;
  checkedAt?: string;
  note?: string;
  group?: string | null;
}

/** One card as the cloud's import endpoint takes it. */
interface ImportRecord {
  title: string;
  body: string;
  columnKey: string;
  categoryKey: string | null;
  priority: string | null;
  tags: string[];
  assignees: { users: string[]; agents: string[] };
  metadata: Record<string, unknown>;
  source: { kind: string; ref: string; checksum: string };
  restore: {
    taskId: string | null;
    taskSeq: number | null;
    createdAt: string | null;
    updatedAt: string | null;
    checklist: ImportChecklistRow[];
  };
  attachments: { name: string; reference: string; sourceKind: string }[];
}

/** The counts a migration preview shows before anything is sent. */
interface MigrationInventory {
  cards: number;
  byColumn: Record<string, number>;
  checklistItems: number;
  withTaskId: number;
  duplicateTaskIds: string[];
  /**
   * Ticked boxes whose tick time is inferred.
   *
   * It is its own number because it is the one quantity here that is not a
   * fact. Markdown says `- [x]` and never when, so each of these arrives with
   * a timestamp taken from the file's mtime or the card's day.
   */
  inferredCheckedAt: number;
  /** Files a card links to that exist in the repo, recorded as references. */
  attachments: number;
  /** Items in a "pick ONE" group, which the cloud stores. */
  groups: number;
  /** Items decided against. */
  dropped: number;
  problems: { path: string; reason: string }[];
}

/** What a migration would send, with its inventory and any reason to refuse. */
interface MigrationPlan {
  root: string;
  records: ImportRecord[];
  config: {
    columns: {
      key: string;
      name: string;
      role: string;
      icon: string;
      tone: string;
    }[];
    categories: {
      key: string;
      name: string;
      prefix: string;
      format: string;
      pad: number;
      tone: string;
    }[];
    tags: { max: number; allowed: string[] };
  };
  inventory: MigrationInventory;
  /** Why this repo must not be migrated from here, or null. */
  blocked: string | null;
}

/** Links in a card's markdown that point at a file in this repo. */
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/**
 * List the repo files a card links to, as references. Nothing is read or
 * uploaded.
 *
 * A link to something not in the repo (an http URL, an anchor, a path that has
 * moved) is not an attachment. It stays in the body text, where it reads as
 * the author wrote it.
 */
async function referencedFiles(root: string, body: string): Promise<string[]> {
  const out: string[] = [];
  for (const match of body.matchAll(LINK)) {
    const ref = match[1];
    if (!ref || /^[a-z]+:/i.test(ref) || ref.startsWith("#")) continue;
    const clean = ref.split("#")[0]?.split("?")[0] ?? "";
    if (!clean || clean.startsWith("/") || clean.includes("..")) continue;
    const exists = await stat(join(root, clean))
      .then((entry) => entry.isFile())
      .catch(() => false);
    if (exists && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/**
 * Read the sequence number out of a task id: `FE-06` under `FE` gives 6.
 *
 * @returns Null when the id does not match the category's format.
 */
export function parseTaskSeq(
  taskId: string,
  category: { prefix: string; format: string },
): number | null {
  const pattern = category.format
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("\\{prefix\\}", escapeRegex(category.prefix))
    .replace("\\{seq\\}", "(\\d+)");
  const match = taskId.match(new RegExp(`^${pattern}$`));
  const seq = match?.[1] ? Number(match[1]) : null;
  return seq !== null && Number.isFinite(seq) && seq > 0 ? seq : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every review file in the repo, read and parsed. */
async function readReviewCards(root: string): Promise<{
  cards: ReviewFileCard[];
  problems: { path: string; reason: string }[];
}> {
  const base = join(root, ...REVIEW_ROOT);
  const cards: ReviewFileCard[] = [];
  const problems: { path: string; reason: string }[] = [];
  if (!(await folderExists(base))) return { cards, problems };

  const { files, capped } = await listCardFiles(base);
  if (capped)
    problems.push({
      path: REVIEW_ROOT.join("/"),
      reason: "more files than one scan reads; migrate from the CLI instead",
    });

  for (const file of files) {
    const markdown = await readFile(file, "utf8").catch(() => null);
    if (markdown === null) {
      problems.push({
        path: relative(root, file),
        reason: "could not be read",
      });
      continue;
    }
    // NOTE: The board's own rule for "is this a card": a status, a lane
    // folder, or a date folder. Skipping a file the board would show leaves a
    // card behind at the cutover, with nothing reporting the loss.
    const location = resolveCardLocation(
      relative(base, file).split("/"),
      parseFrontmatterMap(markdown).status ?? null,
    );
    if (!location) continue;
    cards.push(
      buildReviewFileCard({
        path: relative(root, file),
        fileName: location.fileName,
        folderDate: location.folderDate,
        column: location.column,
        markdown,
        updatedAt: await stat(file)
          .then((entry) => entry.mtime.toISOString())
          .catch(() => null),
        sha: contentSha(markdown),
      }),
    );
  }
  return { cards, problems };
}

/**
 * Work out what a migration would send, without sending any of it.
 *
 * NOTE: Records are sorted by `(column, date, ordinal)` and sent in that order
 * without a rank. The API appends each card to the bottom of its lane, so the
 * arrival order is the order. Computing ranks here would be a second copy of
 * the board's fractional-index code, and the two would have to agree forever.
 */
export async function planMigration(root: string): Promise<MigrationPlan> {
  const { cards, problems } = await readReviewCards(root);
  const hasConfig = await stat(join(root, ...REVIEW_ROOT, "config.json"))
    .then((entry) => entry.isFile())
    .catch(() => false);

  const sorted = [...cards].sort((a, b) => {
    if (a.column !== b.column) return a.column < b.column ? -1 : 1;
    const day = (a.date ?? "").localeCompare(b.date ?? "");
    if (day !== 0) return day;
    return (a.ordinal ?? 0) - (b.ordinal ?? 0);
  });

  const records: ImportRecord[] = [];
  const byColumn: Record<string, number> = {};
  let checklistItems = 0;
  let inferredCheckedAt = 0;
  let attachments = 0;
  let groups = 0;
  let dropped = 0;

  for (const card of sorted) {
    byColumn[card.column] = (byColumn[card.column] ?? 0) + 1;
    const category = card.category
      ? DEFAULT_CATEGORIES.find((entry) => entry.key === card.category)
      : undefined;

    // The source says `- [x]` and never when. The latest moment the file can
    // vouch for is its own mtime; the card's day is the fallback. The choice is
    // recorded in `metadata.import.checkedAtSource`, so a reader can see the
    // timestamp was inferred, not observed.
    const inferredAt =
      card.updatedAt ?? (card.date ? `${card.date}T00:00:00.000Z` : null);
    const checkedAtSource = card.updatedAt ? "file-mtime" : "card-date";

    // NOTE: A key is minted only for an item with no handle, and it skips
    // every handle the card already claims. The board's API applies the same
    // rule to a `null` key. The plain position once put a second `D2` on a card
    // whose section D already had one. The board refuses a checklist with two
    // items keyed alike, so that card took the other 49 records in its batch
    // down with it.
    const taken = new Set(card.items.map((item) => item.id).filter(Boolean));
    const seen = { decisions: 0, verify: 0 };
    const mintKey = (section: "decisions" | "verify"): string => {
      const prefix = section === "verify" ? "V" : "D";
      let key: string;
      do {
        seen[section] += 1;
        key = `${prefix}${seen[section]}`;
      } while (taken.has(key));
      taken.add(key);
      return key;
    };
    const checklist: ImportChecklistRow[] = card.items.map((item) => {
      checklistItems += 1;
      if (item.checked && inferredAt) inferredCheckedAt += 1;
      if (item.group) groups += 1;
      if (item.dropped) dropped += 1;
      return {
        // NOTE: Never an empty key. A later tick is addressed by the key, and
        // a row the cloud cannot address is a row nobody can check off.
        key: item.id || mintKey(item.section),
        section: item.section,
        text: item.text,
        ...(item.checked && inferredAt
          ? { checked: true, checkedAt: inferredAt }
          : {}),
        ...(item.note ? { note: item.note } : {}),
        ...(item.group ? { group: item.group } : {}),
      };
    });

    const files = await referencedFiles(root, card.markdown);
    attachments += files.length;

    records.push({
      title: card.title,
      body: card.markdown,
      columnKey: card.column,
      categoryKey: card.category,
      priority: card.priority,
      tags: card.tags,
      assignees: { users: card.assignees, agents: card.agentAssignee },
      metadata: {
        ...card.custom,
        import: {
          tool: "lanework-desktop",
          reviewPath: card.path,
          checkedAtSource,
          sha: card.sha,
        },
      },
      source: {
        kind: SOURCE_KIND,
        ref: card.path,
        checksum: contentSha(card.markdown),
      },
      restore: {
        taskId: card.taskId,
        // NOTE: Both or neither. An id restored without its sequence makes the
        // next card minted on that board a duplicate of one that exists.
        taskSeq:
          card.taskId && category ? parseTaskSeq(card.taskId, category) : null,
        createdAt: card.date ? `${card.date}T00:00:00.000Z` : null,
        updatedAt: card.updatedAt,
        checklist,
      },
      attachments: files.map((reference) => ({
        name: reference.split("/").pop() ?? reference,
        reference,
        sourceKind: SOURCE_KIND,
      })),
    });
  }

  const taskIds = sorted.map((card) => card.taskId).filter(Boolean) as string[];
  const duplicateTaskIds = [...new Set(taskIds)].filter(
    (id) => taskIds.filter((other) => other === id).length > 1,
  );

  return {
    root,
    records,
    config: {
      columns: DEFAULT_COLUMNS.map((column) => ({ ...column })),
      categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
      tags: { max: TAG_MAX, allowed: [] },
    },
    inventory: {
      cards: sorted.length,
      byColumn,
      checklistItems,
      withTaskId: taskIds.length,
      duplicateTaskIds,
      inferredCheckedAt,
      attachments,
      groups,
      dropped,
      problems,
    },
    blocked: hasConfig
      ? "This project has its own .agents/reviews/config.json, which can rename lanes and re-map statuses. Migrate it from the Lanework CLI, which reads that file."
      : null,
  };
}
