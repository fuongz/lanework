import {
  CONTINUATION_INDENT,
  DROPPED_MARKER_RE,
  PICK_ONE_BULLET_RE,
  RECOMMENDED_RE,
  scanLines,
  scanTaskBlocks,
} from "./review-scan";

/**
 * A review file, read the way the Lanework board reads one.
 *
 * ⚠️ Ported from that board's `reviews-core` (`internal.ts`, `card-build.ts`,
 * `doc.ts`) and `local-fs/reviews.ts`. The values that MUST match, because the
 * cloud keys on them or mints from them:
 *
 *   · `path` — repo-relative (`.agents/reviews/<date>/<file>.md`). It is the
 *     import's `source.ref`, so a card imported from here and a card imported
 *     from the CLI have to be the same row, not two.
 *   · `sha` — sha1 of the file, first 12 hex, exactly as `contentSha` does it.
 *   · `column` — the front-matter `status`, falling back to `todo`, which is
 *     what `DEFAULT_BOARD_CONFIG.status` says (`from: "frontmatter"`).
 *   · `title` — the first `# ` heading with a `Review:` prefix stripped; the
 *     filename is a slug and cannot carry a Vietnamese title back.
 *
 * ⚠️ `.agents/reviews/config.json` can override the lanes and categories, and
 * this reader does NOT interpret it (see `review-import.ts`, which refuses to
 * migrate when one exists). Guessing at a config it cannot fully parse is how
 * cards would land in lanes the board does not have.
 */

const PRIORITIES = new Set(["low", "medium", "high"]);

export function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

/** `key: value` lines of the leading `---` block, values left as written. */
export function parseFrontmatterMap(md: string): Record<string, string> {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/);
    if (field?.[1] !== undefined && field[2] !== undefined)
      out[field[1]] = field[2].trim();
  }
  return out;
}

/** A YAML-ish list: `["a", "b"]` or `a, b`. */
export function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* fall through to lenient parsing */
  }
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((entry) => unquote(entry.trim()))
    .filter(Boolean);
}

/**
 * The card's real title.
 *
 * ⚠️ `[ \t]`, not `\s`, and the prefix is stripped from the CAPTURE. With `\s*`
 * after an optional `Review:` the pattern walks past a blank line and captures
 * the first paragraph of the body as the title.
 */
export function extractReviewTitle(md: string): string | null {
  const match = md.match(/^#[ \t]+(.+)$/m);
  if (!match) return null;
  return match[1].replace(/^Review:[ \t]*/, "").trim() || null;
}

export function extractDate(value: string): string | null {
  return value.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

/** Leading `NN-`/`NN_` ordinal of a date-folder filename (`01-foo.md` → 1). */
export function extractOrdinal(fileName: string): number | null {
  const match = fileName.match(/^(\d+)[-_]/);
  return match ? Number(match[1]) : null;
}

/** One checklist row, as the cloud's import contract wants it. */
export interface CardItem {
  id: string;
  section: "decisions" | "verify";
  text: string;
  checked: boolean;
  note: string | null;
  group: string | null;
  dropped: boolean;
  recommended: boolean;
  heading: string | null;
}

/**
 * The section headings ARE the section ids, in English whatever the card's
 * language — a board with Vietnamese titles translates them in the UI. The day
 * the file's own words decide its meaning is the day `## Ngoài phạm vi` stops
 * being findable.
 */
const SECTION_BY_HEADING = new Map<string, "decisions" | "verify">([
  ["decisions", "decisions"],
  ["verify", "verify"],
]);

/**
 * The checklist of a `schema:`-carrying card, by section.
 *
 * ⚠️ Built on `scanTaskBlocks`, like the board's own `parseChecklist` — the
 * block is what says where an item ends, and a second answer to that here is
 * what once spliced a note into the middle of an item.
 */
export function parseCardItems(md: string): CardItem[] {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const blocks = new Map(
    scanTaskBlocks(body).map((block) => [block.task.line, block]),
  );
  const items: CardItem[] = [];
  let section: "decisions" | "verify" | null = null;
  let open: { indent: number; id: string } | null = null;
  let pendingHeading: string | null = null;
  let groupSeq = 0;

  for (const line of scanLines(body)) {
    if (line.kind === "heading") {
      if (line.level === 2 && !line.quote) {
        section =
          SECTION_BY_HEADING.get(line.content.trim().toLowerCase()) ?? null;
        pendingHeading = null;
      } else {
        pendingHeading = line.content.trim() || null;
      }
      open = null;
      continue;
    }
    if (line.kind === "bullet" && !line.quote) {
      if (open && line.indent <= open.indent) open = null;
      if (PICK_ONE_BULLET_RE.test(line.content.trim()))
        open = { indent: line.indent, id: `g${++groupSeq}` };
      continue;
    }
    const block = blocks.get(line.line);
    if (line.kind !== "task" || line.quote || !block) continue;
    // ⚠️ Items outside `## Decisions` / `## Verify` are skipped, not defaulted
    // into decisions: the "How to review" preamble of every card is a task list
    // about the format, and importing it would put three instructions at the top
    // of every card's checklist.
    if (!section) continue;
    if (open && line.indent <= open.indent) open = null;

    const text = [
      line.content,
      ...block.body.map((wrapped) =>
        wrapped.content.slice(line.indent + CONTINUATION_INDENT),
      ),
    ].join("\n");
    // Peeled in the reverse of the order the board appends them.
    const undropped = text.replace(DROPPED_MARKER_RE, "");
    const recommended = RECOMMENDED_RE.test(undropped);
    const note = block.notes.map((row) => row.content.trim()).join("\n");

    items.push({
      id: line.id ?? "",
      section,
      text: undropped.replace(RECOMMENDED_RE, "").trim(),
      // ⚠️ A file hand-edited to `- [x] … *(dropped)*` reads back as UNCHECKED
      // rather than propagating the contradiction — the board's own invariant.
      checked: line.checked && !block.dropped,
      note: note || null,
      group: open && line.indent > open.indent ? open.id : null,
      dropped: block.dropped,
      recommended,
      heading: pendingHeading,
    });
    pendingHeading = null;
  }
  return items;
}

/** Front-matter keys the card surfaces as fields, so they aren't repeated. */
const RESERVED = new Set([
  "schema",
  "status",
  "task_id",
  "category",
  "priority",
  "tags",
  "assignees",
  "agent_assignee",
  "created_at",
  "updated_at",
]);

export interface ReviewFileCard {
  /** Repo-relative, and the import's `source.ref`. */
  path: string;
  fileName: string;
  column: string;
  title: string;
  taskId: string | null;
  category: string | null;
  priority: "low" | "medium" | "high" | null;
  tags: string[];
  assignees: string[];
  agentAssignee: string[];
  custom: Record<string, string>;
  /** `YYYY-MM-DD` from the folder, the filename or `created_at`. */
  date: string | null;
  /** `NN-` prefix, which is the board's within-a-day order. */
  ordinal: number | null;
  /** File mtime, ISO. The only moment a file can actually vouch for. */
  updatedAt: string | null;
  /** sha1 of the file, first 12 hex — `contentSha`. */
  sha: string;
  markdown: string;
  items: CardItem[];
  /** True when the file carries `schema:` and so has structured sections. */
  structured: boolean;
}

export function buildReviewFileCard(input: {
  path: string;
  fileName: string;
  folderDate: string | null;
  /**
   * The lane `resolveCardLocation` put this file in.
   *
   * ⚠️ Passed in rather than read from `status:` here, because the rule is not
   * "whatever the front matter says": an unlabelled file in a date folder is a
   * real card in the fallback lane, and one in a lane FOLDER takes its lane
   * from the folder. One answer, in one place.
   */
  column: string;
  markdown: string;
  updatedAt: string | null;
  sha: string;
}): ReviewFileCard {
  const { path, fileName, folderDate, column, markdown, updatedAt, sha } =
    input;
  const meta = parseFrontmatterMap(markdown);
  const schema = Number(unquote(meta.schema ?? ""));
  const structured = Number.isFinite(schema) && schema > 0;

  const custom: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta))
    if (!RESERVED.has(key) && value) custom[key] = unquote(value);

  return {
    path,
    fileName,
    column,
    title: extractReviewTitle(markdown) ?? fileName.replace(/\.md$/, ""),
    taskId: unquote(meta.task_id ?? "").trim() || null,
    category: unquote(meta.category ?? "").trim() || null,
    priority: (() => {
      const value = unquote(meta.priority ?? "")
        .toLowerCase()
        .trim();
      return PRIORITIES.has(value)
        ? (value as "low" | "medium" | "high")
        : null;
    })(),
    tags: meta.tags ? parseList(meta.tags) : [],
    assignees: meta.assignees ? parseList(meta.assignees) : [],
    agentAssignee: meta.agent_assignee ? parseList(meta.agent_assignee) : [],
    custom,
    date:
      (meta.created_at ? extractDate(unquote(meta.created_at)) : null) ??
      extractDate(folderDate ?? "") ??
      extractDate(fileName),
    ordinal: folderDate ? extractOrdinal(fileName) : null,
    updatedAt,
    sha,
    markdown,
    items: structured ? parseCardItems(markdown) : legacyItems(markdown),
    structured,
  };
}

/**
 * A card written before the document schema still HAS notes — `> …` lines under
 * the item — so this reads BLOCKS rather than bare task lines.
 *
 * ⚠️ Bare task lines would drop every one of those notes silently, which is the
 * loss BE-03 D2 refuses. Ids fall back to position only for a card that never
 * had them.
 */
function legacyItems(md: string): CardItem[] {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return scanTaskBlocks(body).map((block, index) => {
    const note = block.notes
      .map((row) => row.content.trim())
      .filter(Boolean)
      .join(" ");
    return {
      // ⚠️ `""` for an item with no `**D2.**` handle, exactly as
      // `parseCardItems` writes it — NOT the `D<n>` its position suggests.
      // Inventing that number here is what refused a whole 50-record batch: a
      // card numbers its decisions per section (`## A`, `## B`, `## D`) and
      // leaves its "pick ONE" branches unnumbered, so the invented `D2` landed
      // on the key the `**D2.**` further down the same card already owned.
      // Minting a free key is `planMigration`'s job, where the whole card is
      // in view.
      id: block.task.id ?? "",
      section: "decisions" as const,
      text: block.task.content.trim() || `item ${index + 1}`,
      checked: block.task.checked && !block.dropped,
      note: note || null,
      group: null,
      dropped: block.dropped,
      recommended: false,
      heading: null,
    };
  });
}
