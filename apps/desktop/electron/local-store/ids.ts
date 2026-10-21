import { randomBytes } from "node:crypto";

/**
 * Mint a UUIDv7 (RFC 9562).
 *
 * 48 bits of Unix milliseconds, then randomness. It sorts by creation time,
 * so a row's id doubles as a stable tiebreak.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ms = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * The width of a lane rank, a fixed-width decimal string.
 *
 * Fixed width makes `ORDER BY sort_key` numeric order. A card goes between
 * two neighbours at their midpoint. A lane whose gap has run out is
 * renumbered by the caller, {@link RANK_STEP} apart.
 */
const RANK_WIDTH = 16;
export const RANK_STEP = 1_000_000;

export function rankString(value: number): string {
  return String(value).padStart(RANK_WIDTH, "0");
}

export function rankValue(rank: string): number {
  const value = Number(rank);
  return Number.isFinite(value) ? value : 0;
}

/** `My Board!` → `my-board`. Never empty. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "board";
}

/**
 * Normalize a git remote to `host/owner/name`.
 *
 * It is the same normal form the cloud's `BoardSummary.repo` uses, so
 * `git remote get-url origin` in any spelling (https, ssh, scp-like, with or
 * without `.git`) finds the same board.
 *
 * @returns Null when the value is not a remote this can read.
 */
export function normalizeRepo(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;
  let host: string;
  let path: string;
  const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    host = url.hostname;
    path = url.pathname;
  } else if (scp?.[1] && scp[2]) {
    host = scp[1];
    path = scp[2];
  } else {
    return null;
  }
  const parts = path
    .replace(/\.git\/?$/i, "")
    .split("/")
    .filter(Boolean);
  if (!host || parts.length < 2) return null;
  return [host.toLowerCase(), ...parts].join("/").toLowerCase();
}

/**
 * Format a task id: `{prefix}-{seq}` with `pad` → `FE-07`.
 *
 * The cloud's format, character for character.
 */
export function formatTaskId(
  category: { prefix: string; format: string; pad: number },
  seq: number,
): string {
  return category.format
    .replace("{prefix}", category.prefix)
    .replace("{seq}", String(seq).padStart(category.pad, "0"));
}
