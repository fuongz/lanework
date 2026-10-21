import { DEFAULT_COLUMNS } from "./review-defaults";

// Which lane a review file belongs to, and whether it is a card at all.
//
// NOTE: Ported from the board's `reviews-core/card-location.ts`. The rule is
// wider than it looks: in front-matter mode a file is a card if it declares a
// status, OR sits in a lane folder, OR lives in a date folder. So a `README.md`
// inside `.agents/reviews/2026-09-08/` is a card, filed under the fallback
// lane, and the board shows it.
//
// The match must be exact. A reader that skipped such a file would leave it
// behind at the cutover: the board showed it before, the cloud would not have
// it after, and nothing would report the loss. The folder summary and the
// migration both go through here, so they cannot disagree either.

/** A `YYYY-MM-DD` path segment used as a date subfolder. */
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** The lane with the `start` role, where an unlabelled card lands. */
const FALLBACK =
  DEFAULT_COLUMNS.find((column) => column.role === "start")?.key ?? "todo";

/**
 * Resolve a raw `status:` value to one of this board's lane keys.
 *
 * It tries keys first, then names. That order keeps the answer deterministic
 * when one lane's name is another lane's key.
 *
 * @returns Null when the value matches no lane.
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
 * Resolve a file's lane, file name and folder date from its path under
 * `.agents/reviews/`.
 *
 * @param segments The path relative to the review root, split on `/`, e.g.
 *   `["2026-09-08", "01-foo.md"]` or `["done", "2026-09-08", "01-foo.md"]`.
 * @param status The file's raw `status:` value, or null when it has none.
 * @returns Null when the file does not belong to the board.
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
