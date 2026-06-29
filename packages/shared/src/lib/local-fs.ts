// Filesystem data source for `lanework` local mode. Reads `.agents/reviews`
// straight off disk in the target directory, producing the same ReviewCard
// shape the GitHub data source returns (via the shared reviews-core builder).
//
// IMPORTANT: this module imports `node:*` and must NEVER enter the Cloudflare
// Workers bundle. It is only ever loaded through a dynamic import guarded by the
// statically-false `__LANEWORK_LOCAL__` constant in the cloud build, so the
// bundler drops this branch (and its node deps) from the Worker entirely.
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  REVIEW_ROOT,
  buildReviewCard,
  composeReviewFile,
  isReviewColumn,
  parseBoardConfig,
  patchFrontmatter,
  resolveCardLocation,
  serializeList,
  slugify,
  toggleChecklistItem,
  type BoardConfig,
  type Priority,
  type ReviewCard,
  type ReviewColumn,
} from "./reviews-core";
import { parseReviewStats } from "./review-stats";

/** Target directory: the dir the CLI was launched in (or LANEWORK_DIR). */
export function localRoot(): string {
  return process.env.LANEWORK_DIR || process.cwd();
}

/** A short, human-friendly name for the local "repo" (the folder name). */
export function localRepoName(): string {
  const root = localRoot();
  const parts = root.split(sep).filter(Boolean);
  return parts[parts.length - 1] || "local";
}

/** Absolute path to `<root>/.agents/reviews`. */
function reviewsDir(): string {
  return join(localRoot(), REVIEW_ROOT);
}

/** Short content hash used as the card's `sha` (changes when the file changes). */
function contentSha(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** Recursively collect every `.md` file under `dir`, as path segments relative to it. */
async function walkMdFiles(dir: string, rel: string[] = []): Promise<string[][]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const out: string[][] = [];
  for (const e of entries) {
    if (e.isDirectory()) out.push(...(await walkMdFiles(join(dir, e.name), [...rel, e.name])));
    else if (e.isFile() && e.name.endsWith(".md")) out.push([...rel, e.name]);
  }
  return out;
}

/**
 * Every review card under `<root>/.agents/reviews/`. Supports the flat layout
 * (`<column>/YYYY-MM-DD-slug.md`), the date-folder layout
 * (`<column>/YYYY-MM-DD/NN-slug.md`), and — when `config.json` sets
 * `status.from = "frontmatter"` — any layout with the column in frontmatter.
 */
/** Read and parse the optional `.agents/reviews/config.json` for this repo. */
export async function loadLocalBoardConfig(): Promise<BoardConfig> {
  const json = await readFile(join(reviewsDir(), "config.json"), "utf8").catch(() => undefined);
  return parseBoardConfig(json);
}

export async function listLocalReviewCards(): Promise<ReviewCard[]> {
  const base = reviewsDir();
  const config = await loadLocalBoardConfig();

  const cards: ReviewCard[] = [];
  for (const segments of await walkMdFiles(base)) {
    const text = await readFile(join(base, ...segments), "utf8").catch(() => undefined);
    const loc = resolveCardLocation(segments, config, text);
    if (!loc) continue; // not a board file (e.g. a stray .md outside any column)
    cards.push(
      buildReviewCard({
        path: `${REVIEW_ROOT}/${segments.join("/")}`,
        column: loc.column,
        fileName: loc.fileName,
        sha: text ? contentSha(text) : loc.fileName,
        text,
        folderDate: loc.folderDate,
        config,
      }),
    );
  }
  return cards;
}

/**
 * Markdown content of a single review file. `repoPath` is the repo-relative path
 * (e.g. `.agents/reviews/todo/foo.md`) already validated by the caller; we still
 * re-anchor it under the root and reject any path that escapes it.
 */
export async function getLocalCardContent(repoPath: string): Promise<string> {
  const root = resolve(localRoot());
  const full = resolve(root, repoPath);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error("path outside project root");
  }
  return readFile(full, "utf8");
}

/**
 * Overwrite a single review file with new markdown. `repoPath` is the
 * repo-relative path (validated by the caller); re-anchored under the root and
 * rejected if it escapes. Used by the board to persist checkbox edits to disk.
 */
export async function saveLocalCardContent(repoPath: string, content: string): Promise<void> {
  const root = resolve(localRoot());
  const full = resolve(root, repoPath);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error("path outside project root");
  }
  await writeFile(full, content, "utf8");
}

// ── Lifecycle orchestrators (used by the MCP server) ─────────────────────────
//
// These compose the pure helpers in reviews-core with the filesystem so the MCP
// tools can drive the review lifecycle — create → advance status → tick items —
// without hand-editing whole files. Each honours the board's status mode.

/** Re-anchor a repo-relative path under the root and reject escapes. */
function safeFull(repoPath: string): string {
  const root = resolve(localRoot());
  const full = resolve(root, repoPath);
  if (full !== root && !full.startsWith(root + sep)) throw new Error("path outside project root");
  return full;
}

function isReviewPath(repoPath: string): boolean {
  return repoPath.startsWith(`${REVIEW_ROOT}/`) && repoPath.endsWith(".md") && !repoPath.includes("..");
}

/** Today as YYYY-MM-DD (local time). */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Next `NN` ordinal for a date folder: max existing prefix + 1. */
async function nextOrdinal(absDir: string): Promise<number> {
  const entries = await readdir(absDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  let max = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const m = e.name.match(/^(\d+)[-_]/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export interface CreateReviewInput {
  title: string;
  status?: string;
  priority?: Priority;
  tags?: string[];
  assignees?: string[];
  date?: string; // YYYY-MM-DD; defaults to today
  body?: string; // markdown after the `# Review:` heading
}

/**
 * Create a new review card. In the default frontmatter mode it lands at
 * `.agents/reviews/<date>/NN-<slug>.md` with a `status:` field; in folder mode at
 * `.agents/reviews/<status>/<date>/NN-<slug>.md` (folder encodes the column).
 */
export async function createLocalReview(input: CreateReviewInput): Promise<{
  path: string;
  status: ReviewColumn;
  date: string;
  ordinal: number;
}> {
  const config = await loadLocalBoardConfig();
  const status: ReviewColumn = input.status && isReviewColumn(input.status) ? input.status : "todo";
  const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : todayISO();
  const folderMode = config.status.from === "folder";

  const dirRel = folderMode ? `${REVIEW_ROOT}/${status}/${date}` : `${REVIEW_ROOT}/${date}`;
  const absDir = join(resolve(localRoot()), dirRel);
  await mkdir(absDir, { recursive: true });
  const ordinal = await nextOrdinal(absDir);
  const fileName = `${String(ordinal).padStart(2, "0")}-${slugify(input.title)}.md`;
  const repoPath = `${dirRel}/${fileName}`;

  const content = composeReviewFile({
    title: input.title,
    status: folderMode ? null : status,
    assignees: input.assignees,
    tags: input.tags,
    priority: input.priority ?? null,
    date,
    body: input.body,
  });
  await saveLocalCardContent(repoPath, content);
  return { path: repoPath, status, date, ordinal };
}

/** Replace the column segment of a folder-mode path with `newColumn`. */
function relocateColumn(repoPath: string, newColumn: ReviewColumn): string {
  const rest = repoPath.slice(REVIEW_ROOT.length + 1).split("/");
  rest[0] = newColumn;
  return `${REVIEW_ROOT}/${rest.join("/")}`;
}

/**
 * Advance a card to a new column. Frontmatter mode edits the `status:` field in
 * place; folder mode moves the file into the new column folder.
 */
export async function setLocalReviewStatus(
  repoPath: string,
  status: string,
): Promise<{ path: string; status: ReviewColumn; moved: boolean }> {
  if (!isReviewPath(repoPath)) throw new Error("path must be under .agents/reviews/ and end in .md");
  if (!isReviewColumn(status)) throw new Error(`invalid status: ${status}`);
  const config = await loadLocalBoardConfig();
  const content = await getLocalCardContent(repoPath);

  if (config.status.from === "folder") {
    const newPath = relocateColumn(repoPath, status);
    if (newPath === repoPath) return { path: repoPath, status, moved: false };
    await mkdir(dirname(safeFull(newPath)), { recursive: true });
    await saveLocalCardContent(newPath, content);
    await unlink(safeFull(repoPath));
    return { path: newPath, status, moved: true };
  }

  await saveLocalCardContent(repoPath, patchFrontmatter(content, { status }));
  return { path: repoPath, status, moved: false };
}

/** Check/uncheck one checklist item (by index or text), optionally adding a note. */
export async function toggleLocalReviewItem(
  repoPath: string,
  opts: { index?: number; match?: string; checked?: boolean; note?: string },
): Promise<{ path: string; line: number | null; checked: boolean | null; progress: ReturnType<typeof parseReviewStats> }> {
  if (!isReviewPath(repoPath)) throw new Error("path must be under .agents/reviews/ and end in .md");
  const content = await getLocalCardContent(repoPath);
  const res = toggleChecklistItem(content, opts);
  if (!res.found) throw new Error("no matching checklist item");
  await saveLocalCardContent(repoPath, res.content);
  return { path: repoPath, line: res.line, checked: res.checked, progress: parseReviewStats(res.content) };
}

/** Patch a card's priority / tags / assignees frontmatter (no file move). */
export async function updateLocalReviewMeta(
  repoPath: string,
  meta: { priority?: Priority; tags?: string[]; assignees?: string[] },
): Promise<{ path: string }> {
  if (!isReviewPath(repoPath)) throw new Error("path must be under .agents/reviews/ and end in .md");
  const patch: Record<string, string | null> = {};
  if (meta.priority !== undefined) patch.priority = meta.priority;
  if (meta.tags !== undefined) patch.tags = serializeList(meta.tags);
  if (meta.assignees !== undefined) patch.assignees = serializeList(meta.assignees);
  if (Object.keys(patch).length === 0) return { path: repoPath };
  const content = await getLocalCardContent(repoPath);
  await saveLocalCardContent(repoPath, patchFrontmatter(content, patch));
  return { path: repoPath };
}

// ── Cost estimation from Claude Code transcripts ────────────────────────────
//
// Claude Code stores per-session transcripts at
// `~/.claude/projects/<encoded-cwd>/*.jsonl`, where the directory name is the
// project's absolute path with `/`, `.`, and `_` replaced by `-`. Each assistant
// line carries `message.model` + `message.usage`, which we aggregate per model.

/** Per-model token totals across this project's Claude Code sessions. */
export interface ModelUsage {
  model: string;
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface CostData {
  /** False when there are no Claude Code transcripts for this project. */
  available: boolean;
  /** The `~/.claude/projects/<…>` directory we read (for display/debugging). */
  projectDir: string;
  sessions: number;
  models: ModelUsage[];
  firstAt: string | null;
  lastAt: string | null;
}

function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/** Claude Code's directory encoding for an absolute project path. */
function encodeProjectPath(root: string): string {
  return root.replace(/[/._]/g, "-");
}

/**
 * Aggregate token usage from this project's Claude Code transcripts so the board
 * can price it. Reads only the matching `~/.claude/projects/<encoded>` folder;
 * dedupes assistant messages by id so retries/duplicate lines aren't double-counted.
 */
export async function getLocalCostEstimate(): Promise<CostData> {
  const root = resolve(localRoot());
  const dir = join(claudeProjectsDir(), encodeProjectPath(root));

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { available: false, projectDir: dir, sessions: 0, models: [], firstAt: null, lastAt: null };
  }

  const byModel = new Map<string, ModelUsage>();
  const seen = new Set<string>();
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (rec.type !== "assistant") continue;
      const msg = rec.message as { id?: string; model?: string; usage?: Record<string, number | undefined> } | undefined;
      const usage = msg?.usage;
      if (!usage) continue;
      // Dedupe by assistant message id (skip duplicate/streamed lines).
      const id = msg?.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }

      const model = msg?.model || "unknown";
      let agg = byModel.get(model);
      if (!agg) {
        agg = { model, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
        byModel.set(model, agg);
      }
      const cacheCreation = usage.cache_creation as
        | { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
        | undefined;
      agg.messages += 1;
      agg.input += usage.input_tokens ?? 0;
      agg.output += usage.output_tokens ?? 0;
      agg.cacheRead += usage.cache_read_input_tokens ?? 0;
      if (cacheCreation) {
        agg.cacheWrite5m += cacheCreation.ephemeral_5m_input_tokens ?? 0;
        agg.cacheWrite1h += cacheCreation.ephemeral_1h_input_tokens ?? 0;
      } else {
        // No 5m/1h split available → treat all cache writes as 5-minute.
        agg.cacheWrite5m += usage.cache_creation_input_tokens ?? 0;
      }

      const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;
      if (ts) {
        if (!firstAt || ts < firstAt) firstAt = ts;
        if (!lastAt || ts > lastAt) lastAt = ts;
      }
    }
  }

  const models = [...byModel.values()].sort(
    (a, b) => b.input + b.output - (a.input + a.output),
  );
  return { available: true, projectDir: dir, sessions: files.length, models, firstAt, lastAt };
}
