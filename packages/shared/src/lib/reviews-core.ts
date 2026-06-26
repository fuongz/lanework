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
  date: string | null; // created_at frontmatter date, else date in filename
  title: string; // humanized slug
  sha: string;
  assignees: string[];
  tags: string[];
  priority: Priority | null;
  stats: ReviewStats;
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

/**
 * Build a card from a review file's location + markdown text. `text` may be
 * undefined when the content could not be loaded (card still renders with empty
 * metadata/stats). Shared by the GitHub and filesystem data sources so both
 * produce byte-identical cards.
 */
export function buildReviewCard(args: {
  path: string;
  column: ReviewColumn;
  fileName: string;
  sha: string;
  text: string | undefined;
}): ReviewCard {
  const { path, column, fileName, sha, text } = args;
  const meta = text ? parseFrontmatter(text) : EMPTY_META;
  const stats = text ? parseReviewStats(text) : { total: 0, done: 0, notes: 0 };
  return {
    path,
    column,
    fileName,
    date: meta.createdAt ?? extractDate(fileName),
    title: humanizeFileName(fileName),
    sha,
    assignees: meta.assignees,
    tags: meta.tags,
    priority: meta.priority,
    stats,
  };
}

/** Parse the simple YAML frontmatter block at the top of a review file. */
function parseFrontmatter(md: string): ReviewMeta {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return EMPTY_META;
  const meta: ReviewMeta = { assignees: [], tags: [], priority: null, createdAt: null };
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === "assignees") meta.assignees = parseList(val);
    else if (key === "tags") meta.tags = parseList(val);
    else if (key === "priority") meta.priority = normPriority(val);
    else if (key === "created_at") meta.createdAt = extractDate(val);
  }
  return meta;
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

function humanizeFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.md$/, "");
  const withoutDate = withoutExt.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const words = withoutDate.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
