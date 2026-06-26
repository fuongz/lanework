// Filesystem data source for `lanework` local mode. Reads `.agents/reviews`
// straight off disk in the target directory, producing the same ReviewCard
// shape the GitHub data source returns (via the shared reviews-core builder).
//
// IMPORTANT: this module imports `node:*` and must NEVER enter the Cloudflare
// Workers bundle. It is only ever loaded through a dynamic import guarded by the
// statically-false `__LANEWORK_LOCAL__` constant in the cloud build, so the
// bundler drops this branch (and its node deps) from the Worker entirely.
import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
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
