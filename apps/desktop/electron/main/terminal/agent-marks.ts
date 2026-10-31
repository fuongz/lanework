// What Lanework adds to an agent conversation (FE-24, FE-25): a name of its
// own, a pin, and the conductor it belongs to (FE-95). Kept in Lanework's
// session store (`lw.db`, FE-112), never in the CLI's files.
//
// Until FE-112 they were a JSON file in the app's home,
// `agent-sessions.json`. {@link importLegacyMarksOnce} carries that file over
// on the store's first open, then deletes it.
//
// Nothing here imports Electron: main passes the store and the file, and a
// spec drives it under plain Node against temporary ones.
import { readFileSync, rmSync } from "node:fs";
import { LEAD_REF_PATTERN } from "../../../shared/orchestration";
import { AGENT_NAME_MAX } from "../../../shared/terminal";
import type { SessionStore } from "../../session-store";

/**
 * A name as the rail may show it: one line, trimmed, and short.
 *
 * A name with a control character in it is refused rather than cleaned. A
 * line break in a name is somebody pasting the wrong thing, and gluing it
 * into one line would save something they did not type.
 *
 * @throws when `raw` is not a string, has a control character, or is too
 *   long.
 */
export function cleanAgentName(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("A name is required");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the check.
  if (/[\u0000-\u001f\u007f]/.test(raw))
    throw new Error("A name is one line of text");
  const name = raw.trim();
  if (name.length > AGENT_NAME_MAX)
    throw new Error(`A name is at most ${AGENT_NAME_MAX} characters`);
  return name;
}

// ── The store ───────────────────────────────────────────────────────────────

/**
 * Name conversation `key` in Lanework; empty goes back to the CLI's own
 * title.
 *
 * @returns False when the store has no such conversation.
 * @throws When the name is not one line of at most `AGENT_NAME_MAX`.
 */
export function nameSession(
  store: SessionStore,
  key: string,
  raw: unknown,
): boolean {
  return store.setName(key, cleanAgentName(raw) || null);
}

/**
 * Pin conversation `key`, or unpin it. One already pinned keeps the time it
 * was first pinned, so it holds its place.
 *
 * @returns False when the store has no such conversation.
 */
export function pinSession(
  store: SessionStore,
  key: string,
  pinned: boolean,
): boolean {
  return store.setPinned(key, pinned);
}

/**
 * Make `key` the conductor's own conversation in `conductor.project`, and let
 * go the one it had there before (FE-95): one per conductor per project.
 *
 * @returns False when the store has no such conversation.
 * @throws When `conductor.id` is not a team lead's.
 */
export function bindConductor(
  store: SessionStore,
  key: string,
  conductor: { id: string; project: string },
): boolean {
  if (!LEAD_REF_PATTERN.test(conductor.id))
    throw new Error("A valid conductor is required");
  return store.setConductor(key, { ...conductor });
}

/**
 * Let conversation `key` go from its conductor.
 *
 * @returns False when the store has no such conversation.
 */
export function releaseConductor(store: SessionStore, key: string): boolean {
  return store.setConductor(key, null);
}

/** The conductor whose own conversation `key` is in `project`, or null. */
export function conductorIn(
  store: SessionStore,
  key: string,
  project: string,
): string | null {
  const conductor = store.getSession(key)?.conductor;
  return conductor?.project === project ? conductor.id : null;
}

// ── The legacy file (FE-24 … FE-111) ────────────────────────────────────────

/** Lanework's own additions to one conversation, as the file held them. */
interface AgentMark {
  /** The name given in Lanework; absent means the CLI's own title. */
  name?: string;
  /** Epoch ms it was pinned; absent means not pinned. */
  pinnedAt?: number;
  /**
   * The conductor whose own conversation this is, and the project it is
   * that in: one per conductor per project (FE-95). Absent means none.
   */
  conductor?: { id: string; project: string };
}

/** Every mark, by `agent:id`. */
type AgentMarks = Record<string, AgentMark>;

/**
 * The marks in the file's text.
 *
 * @returns null for a text that is not the file's shape: not JSON, or not
 *   version 1.
 */
function parseAgentMarks(text: string): AgentMarks | null {
  let data: { v?: unknown; marks?: unknown };
  try {
    data = JSON.parse(text) as { v?: unknown; marks?: unknown };
  } catch {
    return null;
  }
  if (data?.v !== 1 || !data.marks || typeof data.marks !== "object")
    return null;
  const out: AgentMarks = {};
  for (const [key, raw] of Object.entries(data.marks)) {
    const mark = raw as AgentMark | null;
    const next: AgentMark = {};
    if (typeof mark?.name === "string" && mark.name) next.name = mark.name;
    if (typeof mark?.pinnedAt === "number" && Number.isFinite(mark.pinnedAt))
      next.pinnedAt = mark.pinnedAt;
    const conductor = mark?.conductor as
      | { id?: unknown; project?: unknown; workspace?: unknown }
      | undefined;
    // NOTE: A mark written before FE-107 names its project `workspace`. It
    // is read here as `project`, so no conductor loses its conversation over
    // the rename.
    const project = conductor?.project ?? conductor?.workspace;
    if (
      typeof conductor?.id === "string" &&
      LEAD_REF_PATTERN.test(conductor.id) &&
      typeof project === "string" &&
      project
    )
      next.conductor = { id: conductor.id, project };
    if (!isEmpty(next)) out[key] = next;
  }
  return out;
}

/**
 * Carry `agent-sessions.json` over into the store, once (FE-112).
 *
 * Every mark goes in one transaction; the file is deleted only once that
 * committed. A file that cannot be read or parsed, or an import that fails,
 * leaves the file where it is, to be tried again on the next launch.
 *
 * NOTE: Synchronous: it runs on the store's first open, before the first
 * rail read, and the file is a few KB.
 *
 * @returns How many marks were carried over; null when there was no file,
 *   or it was left for the next launch.
 */
export function importLegacyMarksOnce(
  store: SessionStore,
  file: string,
): number | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // None: a new install, or carried over already.
    return null;
  }
  const marks = parseAgentMarks(text);
  if (!marks) return null;
  let count: number;
  try {
    count = store.importLegacyMarks(marks);
  } catch {
    return null;
  }
  try {
    rmSync(file, { force: true });
  } catch {
    // Imported all the same. A second import never overwrites a mark the
    // store has.
  }
  return count;
}

/** A mark without its emptied fields. */
function isEmpty(mark: AgentMark): boolean {
  return (
    mark.name === undefined &&
    mark.pinnedAt === undefined &&
    mark.conductor === undefined
  );
}
