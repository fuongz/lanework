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

/**
 * Turning a repo's review files into the cloud's import records.
 *
 * ⚠️ Read-only over the source, always. Nothing here opens a file for writing:
 * the old copy stays exactly where it is so a human can compare, and re-running
 * is safe because the API keys every card on `(source_kind, source_ref)` — and
 * `source_ref` here is the same repo-relative path the CLI sends, so the two
 * paths into the cloud produce ONE card, not two.
 *
 * ⚠️ It refuses to run against a repo with `.agents/reviews/config.json`. That
 * file can rename the lanes, re-map `status`, change the task-id format and the
 * tag cap; this app reads the DEFAULTS only, so a board with a custom config
 * would have its cards filed into lanes it does not have. Refusing names the
 * CLI, which reads the config properly.
 */

/** The `source_kind` every card from a repo's review folder carries. */
export const SOURCE_KIND = "local-review";

/** How many records one request carries — the API's own cap. */
export const IMPORT_BATCH = 50;

export { DEFAULT_CATEGORIES, DEFAULT_COLUMNS } from "./review-defaults";

/** Short content hash used as the card's `sha`, exactly as `contentSha` does it. */
export function contentSha(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

export interface ImportChecklistRow {
  key: string;
  section: "decisions" | "verify";
  text: string;
  checked?: boolean;
  checkedAt?: string;
  note?: string;
  group?: string | null;
}

export interface ImportRecord {
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

export interface MigrationInventory {
  cards: number;
  byColumn: Record<string, number>;
  checklistItems: number;
  withTaskId: number;
  duplicateTaskIds: string[];
  /**
   * Ticked boxes whose moment has to be INFERRED.
   *
   * ⚠️ Its own number because it is the one quantity here that is not a fact:
   * markdown says `- [x]` and never when, so each of these arrives with a
   * timestamp derived from the file's mtime or the card's day.
   */
  inferredCheckedAt: number;
  /** Files a card links to that exist in the repo — recorded as references. */
  attachments: number;
  /** "Pick ONE" groups, which the cloud stores; counted so the screen can say so. */
  groups: number;
  /** Items decided against, which travel as unchecked rows carrying the marker. */
  dropped: number;
  problems: { path: string; reason: string }[];
}

export interface MigrationPlan {
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
 * The files a card refers to, as REFERENCES — nothing is read or uploaded.
 *
 * A link to something not in the repo (an http URL, an anchor, a path that has
 * moved) is not an attachment and is left in the body text, where it still
 * reads exactly as the author wrote it.
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

/** `FE-06` under the `FE` category → 6, for the format the defaults use. */
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
export async function readReviewCards(root: string): Promise<{
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
    // ⚠️ The board's own rule for "is this a card", not a guess: a status, a
    // lane folder, or a date folder. Skipping a file the board WOULD show is
    // how a cutover leaves a card behind with nothing reporting the loss.
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
 * What a migration WOULD send, without sending any of it.
 *
 * ⚠️ Records are sorted by `(column, date, ordinal)` and sent in that order
 * WITHOUT a rank: the API appends each card to the bottom of its lane, so
 * arriving in order IS the order. Computing ranks here would be a second copy
 * of the board's fractional-index code, and the two would have to agree forever.
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

    // ⚠️ The source says `- [x]` and never when. The most recent moment the
    // FILE can vouch for is its own mtime; the card's day is the fallback. The
    // choice is recorded in `metadata.import.checkedAtSource` so a reader can
    // see the timestamp was inferred rather than observed.
    const inferredAt =
      card.updatedAt ?? (card.date ? `${card.date}T00:00:00.000Z` : null);
    const checkedAtSource = card.updatedAt ? "file-mtime" : "card-date";

    const seen = { decisions: 0, verify: 0 };
    const checklist: ImportChecklistRow[] = card.items.map((item) => {
      seen[item.section] += 1;
      checklistItems += 1;
      if (item.checked && inferredAt) inferredCheckedAt += 1;
      if (item.group) groups += 1;
      if (item.dropped) dropped += 1;
      return {
        // ⚠️ A positional fallback rather than an empty key: the id is what a
        // later tick is addressed by, and a row the cloud cannot address is a
        // row nobody can ever check off.
        key:
          item.id ||
          `${item.section === "verify" ? "V" : "D"}${seen[item.section]}`,
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
        // ⚠️ Both or neither: an id restored without its sequence makes the
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
