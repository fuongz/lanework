import { DEFAULT_COLUMNS } from "./review-defaults";

/**
 * Which lane a review file belongs to — and whether it is a card at all.
 *
 * ⚠️ Ported from the board's `reviews-core/card-location.ts`, and the rule is
 * WIDER than it looks: in front-matter mode a file counts as a card if it
 * declares a status, OR sits in a lane folder, OR lives in a date folder. A
 * `README.md` inside `.agents/reviews/2026-09-08/` is therefore a card — filed
 * under the fallback lane — and the board really does show it.
 *
 * ⚠️ Matching that exactly is not pedantry. A reader that skipped such a file
 * would leave it behind at the cutover: the board would have shown it before,
 * the cloud would not have it after, and nothing would report a loss. Two
 * readers in this app (the folder summary and the migration) go through here so
 * they cannot disagree with each other either.
 */

/** A `YYYY-MM-DD` path segment used as a date subfolder. */
export const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** The lane carrying the `start` role, which is where an unlabelled card lands. */
const FALLBACK =
  DEFAULT_COLUMNS.find((column) => column.role === "start")?.key ?? "todo";

/**
 * A raw `status:` value resolved to one of this board's lane keys.
 *
 * Tried in order — key, then name — which is what keeps it deterministic when a
 * lane's NAME is another lane's key. Null when unrecognised.
 */
export function canonicalStatus(raw: string): string | null {
  const value = raw.replace(/['"]/g, "").trim().toLowerCase();
  if (!value) return null;
  const byKey = DEFAULT_COLUMNS.find(
    (column) => column.key.toLowerCase() === value,
  );
  if (byKey) return byKey.key;
  const byName = DEFAULT_COLUMNS.find(
    (column) => column.name.toLowerCase() === value,
  );
  return byName ? byName.key : null;
}

/**
 * Resolve a file's lane, filename and folder-date from its path under
 * `.agents/reviews/`, or null when it does not belong to the board.
 *
 * `segments` is the path relative to the review root, split on "/" — e.g.
 * `["2026-09-08", "01-foo.md"]` or `["done", "2026-09-08", "01-foo.md"]`.
 */
export function resolveCardLocation(
  segments: string[],
  status: string | null,
): { column: string; fileName: string; folderDate: string | null } | null {
  if (segments.length === 0) return null;
  const fileName = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  const folderColumn = canonicalStatus(dirs[0] ?? "");
  const fromStatus = status ? canonicalStatus(status) : null;
  const folderDate = dirs.find((dir) => DATE_DIR.test(dir)) ?? null;

  // Loose markdown — a README or a note at the review root — is not surfaced.
  if (!fromStatus && !folderColumn && !folderDate) return null;
  return {
    column: fromStatus ?? folderColumn ?? FALLBACK,
    fileName,
    folderDate,
  };
}
