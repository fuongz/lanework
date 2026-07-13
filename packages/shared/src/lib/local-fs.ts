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
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  REVIEW_ROOT,
  buildReviewCard,
  canonicalStatus,
  composeReviewFile,
  extractReviewTitle,
  parseBoardConfig,
  patchFrontmatter,
  resolveCardLocation,
  serializeList,
  setReviewBody,
  slugify,
  toggleChecklistItem,
  type BoardConfig,
  type Priority,
  type ReviewCard,
  type ReviewColumn,
} from "./reviews-core";
import { parseReviewStats } from "./review-stats";
import { estimateCost } from "./claude-pricing";

/** Target directory: the dir the CLI was launched in (or LANEWORK_DIR). */
export function localRoot(): string {
  return process.env.LANEWORK_DIR || process.cwd();
}

/** Current git branch of the local checkout (or a short SHA when detached). Reads
 *  `.git/HEAD` directly — no spawn. Returns null when not a git repo. */
export async function localGitBranch(): Promise<string | null> {
  try {
    const head = await readFile(join(resolve(localRoot()), ".git", "HEAD"), "utf8");
    const ref = head.match(/ref:\s*refs\/heads\/(.+?)\s*$/);
    if (ref) return ref[1];
    const sha = head.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : null; // detached HEAD
  } catch {
    return null;
  }
}

/** A short, human-friendly name for the local "repo" (the folder name). */
export function localRepoName(): string {
  const root = localRoot();
  const parts = root.split(sep).filter(Boolean);
  return parts[parts.length - 1] || "local";
}

/**
 * The reviews subfolder, relative to the repo root by default (`.agents/reviews`),
 * overridable via `LANEWORK_REVIEWS_DIR` so a repo can keep its board somewhere
 * else — either another relative path or an absolute one. This is the same
 * string used to prefix every card's `path`, so it stays consistent with
 * whatever's actually on disk.
 */
export function reviewRootRel(): string {
  return process.env.LANEWORK_REVIEWS_DIR || REVIEW_ROOT;
}

/** Absolute path to the reviews folder (`<root>/.agents/reviews` by default). */
function reviewsDir(): string {
  const rel = reviewRootRel();
  return isAbsolute(rel) ? rel : join(localRoot(), rel);
}

/**
 * Resolve a card's repo-relative path (e.g. `<reviewRootRel()>/todo/foo.md`) to
 * its absolute location on disk, rejecting anything that resolves outside the
 * reviews root.
 */
function resolveReviewPath(repoPath: string): string {
  const prefix = `${reviewRootRel()}/`;
  if (!repoPath.startsWith(prefix)) throw new Error(`path must be under ${reviewRootRel()}/`);
  const base = resolve(reviewsDir());
  const full = resolve(base, repoPath.slice(prefix.length));
  if (full !== base && !full.startsWith(base + sep)) throw new Error("path outside reviews root");
  return full;
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
        path: `${reviewRootRel()}/${segments.join("/")}`,
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
  return readFile(resolveReviewPath(repoPath), "utf8");
}

/**
 * Overwrite a single review file with new markdown. `repoPath` is the
 * repo-relative path (validated by the caller); re-anchored under the root and
 * rejected if it escapes. Used by the board to persist checkbox edits to disk.
 */
export async function saveLocalCardContent(repoPath: string, content: string): Promise<void> {
  await writeFile(resolveReviewPath(repoPath), content, "utf8");
}

// ── Lifecycle orchestrators (used by the MCP server) ─────────────────────────
//
// These compose the pure helpers in reviews-core with the filesystem so the MCP
// tools can drive the review lifecycle — create → advance status → tick items —
// without hand-editing whole files. Each honours the board's status mode.

/** Re-anchor a repo-relative path under the reviews root and reject escapes. */
function safeFull(repoPath: string): string {
  return resolveReviewPath(repoPath);
}

function isReviewPath(repoPath: string): boolean {
  return repoPath.startsWith(`${reviewRootRel()}/`) && repoPath.endsWith(".md") && !repoPath.includes("..");
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
  const status: ReviewColumn =
    (input.status && canonicalStatus(input.status, config.status.values)) || "todo";
  const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : todayISO();
  const folderMode = config.status.from === "folder";

  const dirRel = folderMode ? `${status}/${date}` : date;
  const absDir = join(reviewsDir(), dirRel);
  await mkdir(absDir, { recursive: true });
  const ordinal = await nextOrdinal(absDir);
  const fileName = `${String(ordinal).padStart(2, "0")}-${slugify(input.title)}.md`;
  const repoPath = `${reviewRootRel()}/${dirRel}/${fileName}`;

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

/**
 * Fill in an existing card's checklist in the canonical house format: preserves
 * the file's frontmatter, then writes the `# Review:` heading, an optional
 * context paragraph, the standard "How to review" line, and a `## Decisions`
 * list. The composer owns the formatting, so a planning agent never hand-builds
 * (and drifts from) the file shape — it just supplies the decision text.
 */
export async function planLocalReview(
  repoPath: string,
  opts: { context?: string; decisions: string[]; title?: string },
): Promise<{ path: string; items: number }> {
  if (!isReviewPath(repoPath)) throw new Error(`path must be under ${reviewRootRel()}/ and end in .md`);
  const decisions = (opts.decisions ?? []).map((d) => String(d).trim()).filter(Boolean);
  if (decisions.length === 0) throw new Error("provide at least one decision");
  const content = await getLocalCardContent(repoPath);
  const title = opts.title?.trim() || extractReviewTitle(content) || humanizeSlug(repoPath);
  const next = setReviewBody(content, { title, context: opts.context, decisions });
  await saveLocalCardContent(repoPath, next);
  return { path: repoPath, items: decisions.length };
}

/** Humanize the slug of a review path, as a title fallback when none is present. */
function humanizeSlug(repoPath: string): string {
  const base = (repoPath.split("/").pop() ?? "").replace(/\.md$/, "");
  const slug = base.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/^\d+[-_]/, "").replace(/[-_]+/g, " ").trim();
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : "Untitled";
}

/** Replace the column segment of a folder-mode path with `newColumn`. */
function relocateColumn(repoPath: string, newColumn: ReviewColumn): string {
  const root = reviewRootRel();
  const rest = repoPath.slice(root.length + 1).split("/");
  rest[0] = newColumn;
  return `${root}/${rest.join("/")}`;
}

/**
 * Advance a card to a new column. Frontmatter mode edits the `status:` field in
 * place; folder mode moves the file into the new column folder.
 */
export async function setLocalReviewStatus(
  repoPath: string,
  status: string,
): Promise<{ path: string; status: ReviewColumn; moved: boolean }> {
  if (!isReviewPath(repoPath)) throw new Error(`path must be under ${reviewRootRel()}/ and end in .md`);
  const config = await loadLocalBoardConfig();
  const resolved = canonicalStatus(status, config.status.values);
  if (!resolved) throw new Error(`invalid status: ${status}`);
  const content = await getLocalCardContent(repoPath);

  if (config.status.from === "folder") {
    const newPath = relocateColumn(repoPath, resolved);
    if (newPath === repoPath) return { path: repoPath, status: resolved, moved: false };
    await mkdir(dirname(safeFull(newPath)), { recursive: true });
    await saveLocalCardContent(newPath, content);
    await unlink(safeFull(repoPath));
    return { path: newPath, status: resolved, moved: true };
  }

  await saveLocalCardContent(repoPath, patchFrontmatter(content, { status: resolved }));
  return { path: repoPath, status: resolved, moved: false };
}

/** Check/uncheck one checklist item (by index or text), optionally adding a note. */
export async function toggleLocalReviewItem(
  repoPath: string,
  opts: { index?: number; match?: string; checked?: boolean; note?: string },
): Promise<{ path: string; line: number | null; checked: boolean | null; progress: ReturnType<typeof parseReviewStats> }> {
  if (!isReviewPath(repoPath)) throw new Error(`path must be under ${reviewRootRel()}/ and end in .md`);
  const content = await getLocalCardContent(repoPath);
  const res = toggleChecklistItem(content, opts);
  if (!res.found) throw new Error("no matching checklist item");
  await saveLocalCardContent(repoPath, res.content);
  return { path: repoPath, line: res.line, checked: res.checked, progress: parseReviewStats(res.content) };
}

/** Delete a review card's file from disk. */
export async function deleteLocalReview(repoPath: string): Promise<{ ok: true }> {
  if (!isReviewPath(repoPath)) throw new Error(`path must be under ${reviewRootRel()}/ and end in .md`);
  await unlink(safeFull(repoPath));
  return { ok: true };
}

/** Patch a card's priority / tags / assignees frontmatter (no file move). */
export async function updateLocalReviewMeta(
  repoPath: string,
  meta: { priority?: Priority; tags?: string[]; assignees?: string[] },
): Promise<{ path: string }> {
  if (!isReviewPath(repoPath)) throw new Error(`path must be under ${reviewRootRel()}/ and end in .md`);
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

interface UsageRecord {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  ts: string | null;
  file: string;
}

/**
 * Read + dedupe assistant-message token usage from a project's transcript dir.
 * Dedupes by assistant message id so retries/streamed duplicate lines don't
 * double-count. `available: false` when the project has no transcripts.
 */
async function collectUsageRecords(
  dir: string,
): Promise<{ available: boolean; files: string[]; records: UsageRecord[] }> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { available: false, files: [], records: [] };
  }
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
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
      const id = msg?.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const cacheCreation = usage.cache_creation as
        | { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
        | undefined;
      records.push({
        model: msg?.model || "unknown",
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite5m: cacheCreation ? (cacheCreation.ephemeral_5m_input_tokens ?? 0) : (usage.cache_creation_input_tokens ?? 0),
        cacheWrite1h: cacheCreation ? (cacheCreation.ephemeral_1h_input_tokens ?? 0) : 0,
        ts: typeof rec.timestamp === "string" ? rec.timestamp : null,
        file,
      });
    }
  }
  return { available: true, files, records };
}

/** Aggregate flat usage records into per-model totals (largest first). */
function groupByModel(records: UsageRecord[]): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const r of records) {
    let agg = byModel.get(r.model);
    if (!agg) {
      agg = { model: r.model, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
      byModel.set(r.model, agg);
    }
    agg.messages += 1;
    agg.input += r.input;
    agg.output += r.output;
    agg.cacheRead += r.cacheRead;
    agg.cacheWrite5m += r.cacheWrite5m;
    agg.cacheWrite1h += r.cacheWrite1h;
  }
  return [...byModel.values()].sort((a, b) => b.input + b.output - (a.input + a.output));
}

/**
 * Token usage for a specific project directory's Claude Code transcripts. The
 * agent dispatcher uses this to price a worktree's agent run; `getLocalCostEstimate`
 * is the current project's all-time view (Cost page + MCP `cost_estimate`).
 */
export async function getCostEstimateForDir(rootDir: string): Promise<CostData> {
  const dir = join(claudeProjectsDir(), encodeProjectPath(resolve(rootDir)));
  const { available, files, records } = await collectUsageRecords(dir);
  if (!available) return { available: false, projectDir: dir, sessions: 0, models: [], firstAt: null, lastAt: null };
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  for (const r of records) {
    if (!r.ts) continue;
    if (!firstAt || r.ts < firstAt) firstAt = r.ts;
    if (!lastAt || r.ts > lastAt) lastAt = r.ts;
  }
  return { available: true, projectDir: dir, sessions: files.length, models: groupByModel(records), firstAt, lastAt };
}

export async function getLocalCostEstimate(): Promise<CostData> {
  return getCostEstimateForDir(localRoot());
}

// ── Agent run telemetry ──────────────────────────────────────────────────────
//
// After a dispatched agent finishes, the runner records what the run cost back
// into the card file: structured `last_run_*` keys in the frontmatter (latest
// run, machine-readable) plus a row appended to a human-readable `## Agent runs`
// table (full history, rendered in the review dialog).

/** What the runner knows about a finished run; usage/cost are derived here. */
export interface AgentRunInput {
  repoPath: string;
  /** The run's worktree — its Claude Code transcript is priced from this. */
  worktree: string;
  mode: string; // "implement" | "plan"
  result: string; // "done" | "failed" | "stopped"
  startedAt: string; // ISO
  endedAt: string; // ISO
}

/** Compact human duration: 48s · 7m12s · 1h03m. */
function formatRunDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Compact token count: 812 · 8.1k · 1.2M. */
function formatCompactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const AGENT_RUNS_HEADING = "## Agent runs";
const AGENT_RUNS_HEADER = "| Finished | Mode | Result | Runtime | In | Out | Cache | Cost |";
const AGENT_RUNS_DIVIDER = "| --- | --- | --- | --- | --- | --- | --- | --- |";

/** Append a row to the `## Agent runs` table, creating the section if absent. */
function appendAgentRunRow(md: string, rowLine: string): string {
  const lines = md.split("\n");
  const hIdx = lines.findIndex((l) => l.trim() === AGENT_RUNS_HEADING);
  if (hIdx === -1) {
    const trimmed = md.replace(/\s+$/, "");
    const block = [AGENT_RUNS_HEADING, "", AGENT_RUNS_HEADER, AGENT_RUNS_DIVIDER, rowLine];
    return `${trimmed}\n\n${block.join("\n")}\n`;
  }
  // The section runs until the next heading (or EOF); append after its last row.
  let end = lines.length;
  for (let i = hIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let lastRow = -1;
  for (let i = hIdx + 1; i < end; i++) {
    if (lines[i].trim().startsWith("|")) lastRow = i;
  }
  if (lastRow === -1) {
    lines.splice(hIdx + 1, 0, "", AGENT_RUNS_HEADER, AGENT_RUNS_DIVIDER, rowLine);
  } else {
    lines.splice(lastRow + 1, 0, rowLine);
  }
  return lines.join("\n");
}

/** "2026-06-30 16:05" in local time, from an ISO timestamp. */
function formatRunStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Persist a finished agent run into its card: `last_run_*` frontmatter (latest
 * run) + a row in the `## Agent runs` history table. Token usage and USD cost are
 * read from the run's worktree transcript. Best-effort and self-contained — the
 * caller (agent runner) wraps this in a catch so telemetry never breaks teardown.
 */
export async function recordAgentRun(run: AgentRunInput): Promise<void> {
  // Price the run from its worktree's Claude Code transcript.
  const cost = await getCostEstimateForDir(run.worktree).catch(
    () => ({ available: false, models: [] }) as Pick<CostData, "available" | "models">,
  );
  let input = 0;
  let output = 0;
  let cache = 0;
  let usd = 0;
  for (const m of cost.models) {
    input += m.input;
    output += m.output;
    cache += m.cacheRead + m.cacheWrite5m + m.cacheWrite1h;
    usd += estimateCost(m.model, m);
  }

  const runtimeMs = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  const runtime = formatRunDuration(runtimeMs);
  const costStr = `~$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;

  let content = await getLocalCardContent(run.repoPath);
  content = patchFrontmatter(content, {
    last_run_at: run.endedAt,
    last_run_mode: run.mode,
    last_run_result: run.result,
    last_run_runtime: runtime,
    last_run_tokens_in: String(input),
    last_run_tokens_out: String(output),
    last_run_cache: String(cache),
    last_run_cost_usd: usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2),
  });
  const row = [
    formatRunStamp(run.endedAt),
    run.mode,
    run.result,
    runtime,
    formatCompactTokens(input),
    formatCompactTokens(output),
    formatCompactTokens(cache),
    costStr,
  ];
  content = appendAgentRunRow(content, `| ${row.join(" | ")} |`);
  await saveLocalCardContent(run.repoPath, content);
}
