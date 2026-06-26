// Filesystem data source for `lanework` local mode. Reads `.agents/reviews`
// straight off disk in the target directory, producing the same ReviewCard
// shape the GitHub data source returns (via the shared reviews-core builder).
//
// IMPORTANT: this module imports `node:*` and must NEVER enter the Cloudflare
// Workers bundle. It is only ever loaded through a dynamic import guarded by the
// statically-false `__LANEWORK_LOCAL__` constant in the cloud build, so the
// bundler drops this branch (and its node deps) from the Worker entirely.
import { readdir, readFile, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  REVIEW_COLUMNS,
  REVIEW_ROOT,
  buildReviewCard,
  type ReviewCard,
  type ReviewColumn,
} from "./reviews-core";

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

/** Every review card under `<root>/.agents/reviews/<column>/*.md`. */
export async function listLocalReviewCards(): Promise<ReviewCard[]> {
  const base = reviewsDir();
  const cards: ReviewCard[] = [];
  for (const column of REVIEW_COLUMNS) {
    const dir = join(base, column);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // column folder absent → no cards for it
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const text = await readFile(join(dir, entry.name), "utf8").catch(() => undefined);
      cards.push(
        buildReviewCard({
          path: `${REVIEW_ROOT}/${column}/${entry.name}`,
          column: column as ReviewColumn,
          fileName: entry.name,
          sha: text ? contentSha(text) : entry.name,
          text,
        }),
      );
    }
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
