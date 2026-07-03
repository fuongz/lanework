// Pure review-parsing core shared by every data source (GitHub API in the cloud
// app, local filesystem in `lanework` local mode). Nothing here touches the
// network, Cloudflare, or Node — it operates purely on file paths + markdown
// text, so it bundles cleanly on Workers and runs unchanged under Node.
import { parseReviewStats, type ReviewStats } from "./review-stats";

export const REVIEW_ROOT = ".agents/reviews";
export const REVIEW_COLUMNS = ["todo", "processing", "done", "dropped"] as const;
export type ReviewColumn = (typeof REVIEW_COLUMNS)[number];
export type Priority = "low" | "medium" | "high";

export interface ReviewCard {
  path: string; // full repo path, e.g. .agents/reviews/todo/2026-06-21-foo.md
  column: ReviewColumn;
  fileName: string; // 2026-06-21-foo.md
  date: string | null; // created_at frontmatter date, else folder date, else date in filename
  ordinal: number | null; // intra-day sort order from a NN- filename prefix (date-folder layout)
  title: string; // humanized slug
  sha: string;
  assignees: string[];
  tags: string[];
  priority: Priority | null;
  stats: ReviewStats;
  summary: string; // first prose paragraph of the body, for the card preview
  lastRun: LastRun | null; // telemetry from the most recent agent run (last_run_* frontmatter)
}

/** The most recent agent run on a card, parsed from its `last_run_*` frontmatter. */
export interface LastRun {
  at: string | null; // ISO timestamp the run finished
  mode: string | null; // "implement" | "plan"
  result: string | null; // "done" | "failed" | "stopped"
  runtime: string | null; // human duration, e.g. "7m12s"
  tokensIn: number;
  tokensOut: number;
  cache: number;
  costUsd: number;
}

interface ReviewMeta {
  assignees: string[];
  tags: string[];
  priority: Priority | null;
  createdAt: string | null;
}
const EMPTY_META: ReviewMeta = { assignees: [], tags: [], priority: null, createdAt: null };

export function isReviewColumn(c: string): c is ReviewColumn {
  return (REVIEW_COLUMNS as readonly string[]).includes(c);
}

// ── Board configuration ─────────────────────────────────────────────────────
//
// An optional `.agents/reviews/config.json` lets a board pick how a card's
// column (status) is derived and which frontmatter keys map to which card field.
// The default `status.from` is "frontmatter": the column comes from each file's
// `status:` field, falling back to the containing column folder (so existing
// folder-based boards keep working). Set `from: "folder"` to make the folder
// authoritative and ignore any `status:` field.
//
// `fields` lets a repo use its own frontmatter key names, e.g.
//   { "fields": { "assignees": ["owner"], "tags": ["labels"], "created_at": ["due"] } }
// The canonical key is always accepted too, so adding an alias never breaks the
// defaults. The first matching key present in a file wins.
//
// A client that doesn't speak "to-do / done" can also remap the *status
// values themselves*, independently in each direction:
//   "values" — extra words accepted for a column, mapped onto the canonical
//              name, e.g. { "processing": ["In Review"] } lets a file's
//              `status: In Review` field *and* a `In Review/` column folder
//              (in folder mode) both resolve to the `processing` column.
//   "labels" — what the board displays for a column, e.g.
//              { "processing": "In Review" } shows that text in the UI
//              instead of "In Progress". Purely cosmetic — files (and folders)
//              lanework writes are always the canonical value.

/** Frontmatter keys accepted for each card field (canonical key always included). */
export interface FieldAliases {
  status: string[];
  assignees: string[];
  tags: string[];
  priority: string[];
  created_at: string[];
}

export interface BoardConfig {
  status: {
    /**
     * "frontmatter" — column is each file's `status:` field, falling back to the
     *                 containing column folder, then `fallback` (default). Files
     *                 can be organised on disk however you like.
     * "folder"      — column is strictly the top-level folder under
     *                 .agents/reviews/ (todo/ processing/ done/ dropped/); any
     *                 `status:` field is ignored.
     */
    from: "folder" | "frontmatter";
    /** Column used when no `status:` field and no column folder apply. */
    fallback: ReviewColumn;
    /** Extra frontmatter `status:` words accepted for each canonical column. */
    values: Partial<Record<ReviewColumn, string[]>>;
    /** Display label override per canonical column (e.g. "In Review" for `processing`). */
    labels: Partial<Record<ReviewColumn, string>>;
  };
  /** Frontmatter key aliases per card field. */
  fields: FieldAliases;
}

const DEFAULT_FIELDS: FieldAliases = {
  status: ["status"],
  assignees: ["assignees"],
  tags: ["tags"],
  priority: ["priority"],
  created_at: ["created_at"],
};

export const DEFAULT_BOARD_CONFIG: BoardConfig = {
  status: { from: "frontmatter", fallback: "todo", values: {}, labels: {} },
  fields: DEFAULT_FIELDS,
};

/** Repo-relative path of the optional board config file. */
export const BOARD_CONFIG_PATH = `${REVIEW_ROOT}/config.json`;

/** Merge user-supplied aliases onto the canonical key for one field. */
function aliasesFor(canonical: string, raw: unknown): string[] {
  const extra = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : typeof raw === "string" && raw.trim() !== ""
      ? [raw]
      : [];
  return [...new Set([canonical, ...extra.map((s) => s.trim())])];
}

/** Non-empty trimmed strings out of a JSON value that may be a string or string array. */
function stringsFrom(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim());
}

/** Parse a `{ column: string | string[] }` map, dropping unrecognised columns/empty lists. */
function parseColumnMap<T>(raw: unknown, pick: (v: unknown) => T | undefined): Partial<Record<ReviewColumn, T>> {
  const out: Partial<Record<ReviewColumn, T>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isReviewColumn(k)) continue;
    const picked = pick(v);
    if (picked !== undefined) out[k] = picked;
  }
  return out;
}

/** Parse (and defensively validate) the board config JSON; falls back to defaults. */
export function parseBoardConfig(json: string | undefined): BoardConfig {
  if (!json) return DEFAULT_BOARD_CONFIG;
  try {
    const raw = JSON.parse(json) as {
      status?: { from?: unknown; fallback?: unknown; values?: unknown; labels?: unknown };
      fields?: Record<string, unknown>;
    };
    // Anything other than an explicit "folder" means the default frontmatter mode.
    const from = raw.status?.from === "folder" ? "folder" : "frontmatter";
    const fb = raw.status?.fallback;
    const fallback = typeof fb === "string" && isReviewColumn(fb) ? fb : "todo";
    const values = parseColumnMap(raw.status?.values, (v) => {
      const list = stringsFrom(v);
      return list.length ? list : undefined;
    });
    const labels = parseColumnMap(raw.status?.labels, (v) =>
      typeof v === "string" && v.trim() ? v.trim() : undefined,
    );
    const f = raw.fields ?? {};
    const fields: FieldAliases = {
      status: aliasesFor("status", f.status),
      assignees: aliasesFor("assignees", f.assignees),
      tags: aliasesFor("tags", f.tags),
      priority: aliasesFor("priority", f.priority),
      created_at: aliasesFor("created_at", f.created_at),
    };
    return { status: { from, fallback, values, labels }, fields };
  } catch {
    return DEFAULT_BOARD_CONFIG;
  }
}

/**
 * Resolve a raw `status:` string (or MCP tool argument) to its canonical
 * column: the canonical name itself, or one of `values`' configured aliases
 * for any column (case-insensitive, quotes stripped). Null if unrecognised.
 */
export function canonicalStatus(raw: string, values?: Partial<Record<ReviewColumn, string[]>>): ReviewColumn | null {
  const v = raw.replace(/['"]/g, "").trim().toLowerCase();
  if (isReviewColumn(v)) return v;
  if (!values) return null;
  for (const col of REVIEW_COLUMNS) {
    if (values[col]?.some((alias) => alias.toLowerCase() === v)) return col;
  }
  return null;
}

/** A `YYYY-MM-DD` path segment used as a date subfolder in the date-folder layout. */
export const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** Parse the YAML frontmatter block into a flat key → raw-value map. */
function parseFrontmatterMap(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key && !(key in out)) out[key] = line.slice(idx + 1).trim();
  }
  return out;
}

/** First non-empty value among `keys` present in the frontmatter map. */
function pickField(map: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = map[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * Column from the `status:` frontmatter field, honouring `fields.status` key
 * aliases and `status.values` value aliases; null if absent or unrecognised.
 */
export function statusFromFrontmatter(md: string, config: BoardConfig = DEFAULT_BOARD_CONFIG): ReviewColumn | null {
  const raw = pickField(parseFrontmatterMap(md), config.fields.status);
  if (raw === undefined) return null;
  return canonicalStatus(raw, config.status.values);
}

/** First `YYYY-MM-DD` path segment, if any (date-folder layout). */
function dateFromSegments(dirs: string[]): string | null {
  for (const d of dirs) if (DATE_DIR.test(d)) return d;
  return null;
}

/**
 * Resolve a file's column + filename + folder-date from its path under
 * `.agents/reviews/`, honouring the board's status mode. Returns null for files
 * that don't belong to the board (a stray markdown file with no `status:`, no
 * column folder, and no date folder). Shared by every data source so they map
 * paths identically.
 *
 * `segments` is the path split on "/" relative to REVIEW_ROOT, e.g.
 *   ["todo", "2026-06-29", "01-foo.md"]  or  ["2026-06-29", "01-foo.md"].
 * `text` is the file's markdown (needed in frontmatter mode to read `status:`).
 */
export function resolveCardLocation(
  segments: string[],
  config: BoardConfig,
  text: string | undefined,
): { column: ReviewColumn; fileName: string; folderDate: string | null } | null {
  if (segments.length === 0) return null;
  const fileName = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  const folderColumn = canonicalStatus(dirs[0] ?? "", config.status.values);

  if (config.status.from === "frontmatter") {
    const fromStatus = text ? statusFromFrontmatter(text, config) : null;
    const folderDate = dateFromSegments(dirs);
    // Treat as a card only if it declares a status, sits in a column folder, or
    // lives in a date folder — so loose markdown (READMEs, notes) isn't surfaced.
    if (!fromStatus && !folderColumn && !folderDate) return null;
    const column = fromStatus ?? folderColumn ?? config.status.fallback;
    return { column, fileName, folderDate };
  }

  // Folder mode: first segment is the column (canonical name or a configured
  // `status.values` alias, e.g. "completed" for `done`), with an optional date subfolder.
  const [rawColumn, ...rest] = segments;
  const column = canonicalStatus(rawColumn, config.status.values);
  if (!column) return null;
  if (rest.length === 1) return { column, fileName: rest[0], folderDate: null };
  if (rest.length === 2 && DATE_DIR.test(rest[0])) {
    return { column, fileName: rest[1], folderDate: rest[0] };
  }
  return null;
}

/**
 * Build a card from a review file's location + markdown text. `text` may be
 * undefined when the content could not be loaded (card still renders with empty
 * metadata/stats). Shared by the GitHub and filesystem data sources so both
 * produce byte-identical cards.
 *
 * Two filename layouts are supported:
 *   - flat:        <column>/YYYY-MM-DD-slug.md          (date + title in the filename)
 *   - date-folder: <column>/YYYY-MM-DD/NN-slug.md       (date from the folder, NN = sort order)
 * Pass `folderDate` when the file lives in a date subfolder. Pass `config` so
 * frontmatter is read with the board's field aliases (defaults to canonical keys).
 */
export function buildReviewCard(args: {
  path: string;
  column: ReviewColumn;
  fileName: string;
  sha: string;
  text: string | undefined;
  folderDate?: string | null;
  config?: BoardConfig;
}): ReviewCard {
  const { path, column, fileName, sha, text, folderDate, config } = args;
  const fields = (config ?? DEFAULT_BOARD_CONFIG).fields;
  const meta = text ? parseFrontmatter(text, fields) : EMPTY_META;
  const stats = text ? parseReviewStats(text) : { total: 0, done: 0, notes: 0 };
  return {
    path,
    column,
    fileName,
    date: meta.createdAt ?? extractDate(folderDate ?? "") ?? extractDate(fileName),
    ordinal: folderDate ? extractOrdinal(fileName) : null,
    title: humanizeFileName(fileName),
    sha,
    assignees: meta.assignees,
    tags: meta.tags,
    priority: meta.priority,
    stats,
    summary: text ? extractSummary(text) : "",
    lastRun: text ? parseLastRun(parseFrontmatterMap(text)) : null,
  };
}

/** Parse the `last_run_*` frontmatter keys into a LastRun (null if no run yet). */
function parseLastRun(map: Record<string, string>): LastRun | null {
  if (!map["last_run_at"]) return null;
  const num = (k: string) => {
    const n = Number(map[k]);
    return Number.isFinite(n) ? n : 0;
  };
  const str = (k: string) => {
    const v = map[k];
    return v ? v.replace(/^["']|["']$/g, "") : null;
  };
  return {
    at: str("last_run_at"),
    mode: str("last_run_mode"),
    result: str("last_run_result"),
    runtime: str("last_run_runtime"),
    tokensIn: num("last_run_tokens_in"),
    tokensOut: num("last_run_tokens_out"),
    cache: num("last_run_cache"),
    costUsd: num("last_run_cost_usd"),
  };
}

/**
 * First prose paragraph of a review body, for the card preview. Skips the
 * frontmatter, the `# Review:` heading, the "How to review" boilerplate, quotes,
 * and checklist items; strips inline markdown; truncates to a card-sized snippet.
 */
export function extractSummary(md: string): string {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue; // heading
    if (line.startsWith(">")) continue; // quote
    if (line.startsWith("|")) continue; // table row (e.g. the Agent runs log)
    if (/^[-*+]\s/.test(line) || /^\d+\.\s/.test(line)) continue; // list / checklist
    if (/^\*\*how to review/i.test(line)) continue; // template boilerplate
    const text = line
      .replace(/`([^`]+)`/g, "$1") // inline code
      .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
      .replace(/\*([^*]+)\*/g, "$1") // italic
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → text
      .trim();
    if (!text) continue;
    return text.length > 200 ? `${text.slice(0, 200).trimEnd()}…` : text;
  }
  return "";
}

/**
 * Parse the simple YAML frontmatter block at the top of a review file, reading
 * each card field from the first matching key in `fields` (canonical key + any
 * repo-configured aliases).
 */
function parseFrontmatter(md: string, fields: FieldAliases = DEFAULT_FIELDS): ReviewMeta {
  const map = parseFrontmatterMap(md);
  const assignees = pickField(map, fields.assignees);
  const tags = pickField(map, fields.tags);
  const priority = pickField(map, fields.priority);
  const createdAt = pickField(map, fields.created_at);
  return {
    assignees: assignees ? parseList(assignees) : [],
    tags: tags ? parseList(tags) : [],
    priority: priority ? normPriority(priority) : null,
    createdAt: createdAt ? extractDate(createdAt) : null,
  };
}

function parseList(v: string): string[] {
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* fall through to lenient parsing */
  }
  return v
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function normPriority(v: string): Priority | null {
  const s = v.replace(/['"]/g, "").toLowerCase().trim();
  return s === "low" || s === "medium" || s === "high" ? s : null;
}

function extractDate(s: string): string | null {
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Leading `NN-`/`NN_` ordinal of a date-folder filename (e.g. `01-foo.md` → 1). */
function extractOrdinal(fileName: string): number | null {
  const m = fileName.match(/^(\d+)[-_]/);
  return m ? Number(m[1]) : null;
}

function humanizeFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.md$/, "");
  // Strip a leading date prefix (flat layout) or a leading NN- ordinal prefix
  // (date-folder layout) before humanizing the remaining slug.
  const withoutDate = withoutExt.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/^\d+[-_]/, "");
  const words = withoutDate.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ── Authoring helpers (used by the MCP lifecycle tools) ──────────────────────

/** A filesystem-safe slug for a review filename. */
export function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return out || "untitled";
}

/** Serialize a string list as inline JSON for a frontmatter value. */
export function serializeList(arr: string[]): string {
  return `[${arr.map((s) => JSON.stringify(s)).join(", ")}]`;
}

/** The standard "How to review" instruction line, shared by every composer. */
const HOW_TO_REVIEW =
  "**How to review:** flip `- [ ]` to `- [x]` for each item you agree with; add a `> note` under any you don't. Implementation starts only after every box is `[x]`.";

/**
 * Canonical below-frontmatter body for a review: the `# Review:` heading, an
 * optional context paragraph, the standard "How to review" line, and a
 * `## Decisions` list rendered as `- [ ] **D{n}.** …`. Shared by create_review's
 * starter and the plan tool so every generated card matches the house format.
 * Each decision string is plain text; the `**D{n}.**` prefix is added here.
 */
export function composeReviewBody(opts: { title: string; context?: string; decisions?: string[] }): string {
  const lines: string[] = [`# Review: ${opts.title}`, ""];
  const context = opts.context?.trim();
  if (context) lines.push(context, "");
  lines.push(HOW_TO_REVIEW, "", "## Decisions", "");
  const decisions = (opts.decisions ?? []).map((d) => d.trim()).filter(Boolean);
  if (decisions.length) {
    decisions.forEach((d, i) => lines.push(`- [ ] **D${i + 1}.** ${d}`));
  } else {
    lines.push("- [ ] **D1.** …");
  }
  lines.push("");
  return lines.join("\n");
}

/** The frontmatter block (`---` … `---`) of a file, or null if it has none. */
function frontmatterBlock(md: string): string | null {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---/);
  return m ? m[0] : null;
}

/** The title from a review's `# Review: …` (or first `#`) heading, else null. */
export function extractReviewTitle(md: string): string | null {
  const m = md.match(/^#\s+(?:Review:\s*)?(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Compose a fresh review file (frontmatter + heading + body). Writes canonical
 * keys; pass `status: null` to omit the field (folder-encoded boards). A custom
 * `body` is placed verbatim after the heading; omit it for the canonical starter.
 */
export function composeReviewFile(opts: {
  title: string;
  status?: ReviewColumn | null;
  assignees?: string[];
  tags?: string[];
  priority?: Priority | null;
  date: string; // YYYY-MM-DD
  body?: string;
}): string {
  const fm: string[] = ["---"];
  if (opts.status) fm.push(`status: ${opts.status}`);
  fm.push(`assignees: ${serializeList(opts.assignees ?? [])}`);
  fm.push(`created_at: ${opts.date} 00:00:00Z`);
  if (opts.priority) fm.push(`priority: ${opts.priority}`);
  fm.push(`tags: ${serializeList(opts.tags ?? [])}`);
  fm.push("---");
  const body = opts.body?.trim();
  const below = body ? `# Review: ${opts.title}\n\n${body}\n` : composeReviewBody({ title: opts.title });
  return `${fm.join("\n")}\n\n${below}`;
}

/**
 * Replace everything below the frontmatter with a freshly composed canonical
 * plan body, preserving the file's existing frontmatter exactly. Used by the
 * plan tool so an agent fills in a card without hand-rebuilding the file.
 */
export function setReviewBody(md: string, opts: { title: string; context?: string; decisions?: string[] }): string {
  const fm = frontmatterBlock(md);
  const below = composeReviewBody(opts);
  return fm ? `${fm}\n\n${below}` : below;
}

/**
 * Set/insert/remove scalar frontmatter keys. `patch` values are already
 * serialized (e.g. `"done"`, `'["a","b"]'`); a `null` value removes the key.
 * Creates a frontmatter block if the file has none.
 */
export function patchFrontmatter(md: string, patch: Record<string, string | null>): string {
  const entries = Object.entries(patch);
  const m = md.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) {
    const block = entries.filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join("\n");
    return block ? `---\n${block}\n---\n\n${md}` : md;
  }
  const remaining = new Map(entries);
  const out: string[] = [];
  for (const line of m[2].split("\n")) {
    const idx = line.indexOf(":");
    const key = idx === -1 ? null : line.slice(0, idx).trim();
    if (key && remaining.has(key)) {
      const v = remaining.get(key)!;
      remaining.delete(key);
      if (v !== null) out.push(`${key}: ${v}`); // null → drop the line
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of remaining) if (v !== null) out.push(`${k}: ${v}`);
  return md.slice(0, m.index) + m[1] + out.join("\n") + m[3] + md.slice(m.index! + m[0].length);
}

/**
 * Toggle a single checklist item, selected by 1-based `index` (across all items)
 * or by case-insensitive `match` text (first hit), else the first item. `checked`
 * forces a state (default: flip). An optional `note` is inserted as a `> …` line.
 */
export function toggleChecklistItem(
  md: string,
  opts: { index?: number; match?: string; checked?: boolean; note?: string },
): { content: string; found: boolean; line: number | null; checked: boolean | null } {
  const lines = md.split("\n");
  const cb = /^(\s*[-*+]\s+\[)( |x|X)(\].*)$/;
  let count = 0;
  let target = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!cb.test(lines[i])) continue;
    count++;
    if (opts.index != null) {
      if (count === opts.index) { target = i; break; }
    } else if (opts.match) {
      if (lines[i].toLowerCase().includes(opts.match.toLowerCase())) { target = i; break; }
    } else {
      target = i;
      break;
    }
  }
  if (target === -1) return { content: md, found: false, line: null, checked: null };
  const m = lines[target].match(cb)!;
  const next = opts.checked != null ? opts.checked : m[2] === " ";
  lines[target] = `${m[1]}${next ? "x" : " "}${m[3]}`;
  if (opts.note?.trim()) {
    const indent = lines[target].match(/^\s*/)?.[0] ?? "";
    lines.splice(target + 1, 0, `${indent}  > ${opts.note.trim()}`);
  }
  return { content: lines.join("\n"), found: true, line: target + 1, checked: next };
}
