// Context compaction (FE-117): the checkpoint hook also runs on Claude Code's
// `PreCompact` and on `SessionStart` with source `compact`.
//
// - PreCompact: the hook writes a full checkpoint, marked pre-compact, with no
//   model call, exactly as on Stop but never thinned. It prints nothing:
//   Claude Code appends a PreCompact hook's stdout to the compaction
//   instructions.
// - SessionStart (compact): the hook prints ONE reminder to the model to call
//   the lanework `checkpoint` tool with `next_step`, which only the model can
//   state. Only when the session is bound to a card, and only once per
//   compaction.
//
// NOTE: "Once per compaction" is this marker file. PreCompact writes it
// (synchronously, in the hook proper, so it exists before compaction starts);
// the worker adds the card it resolved; SessionStart takes it with an atomic
// rename, so of two SessionStart runs at most one finds it, and a
// SessionStart with no PreCompact before it finds nothing and says nothing.
//
// ⚠️ The reminder is a STATIC template, only the task id varies, and the id is
// checked against a strict pattern first. Compaction rebuilds the agent's
// context anyway, so one line there does not break a cached prefix mid-session
// (INF-07); anything printed on Stop or PreCompact would, and nothing is.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** How long after PreCompact its SessionStart may still remind. */
export const COMPACT_WINDOW_MS = 15 * 60 * 1000;

/**
 * What PreCompact left for its SessionStart.
 *
 * `taskId` is unset until the worker resolved the session's card, and null
 * when it resolved that there is none.
 */
export type CompactionMarker = { at: number; taskId?: string | null };

/**
 * A task id the reminder may name: `FE-117`, `BE-17`, `INF-01`.
 *
 * Anything else (a card argument the model spelled oddly, or text that is
 * not an id at all) is never printed into the model's context.
 */
const REMINDABLE_ID = /^[A-Z][A-Z0-9]{0,9}-\d{1,6}$/;

export function isRemindableTaskId(taskId: string): boolean {
  return REMINDABLE_ID.test(taskId);
}

/** The reminder SessionStart (compact) gives the model. Static but the id. */
export function compactReminder(taskId: string): string {
  return `Lanework: the context was just compacted while you were working ${taskId}. Before continuing, call the lanework \`checkpoint\` tool for card ${taskId} with \`next_step\` (and a \`summary\` of where the work stands).`;
}

/** The SessionStart hook output that adds `context` for the model. */
export function sessionStartOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}

export function markerFile(stateDir: string, sessionId: string): string {
  const id = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDir, `compact-${id}.json`);
}

function writeMarker(file: string, marker: CompactionMarker): void {
  writeFileSync(file, JSON.stringify(marker), { mode: 0o600 });
}

/** PreCompact: a compaction is starting. Overwrites an older marker. */
export function markCompaction(stateDir: string, sessionId: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeMarker(markerFile(stateDir, sessionId), { at: Date.now() });
}

/**
 * The worker: record which card the session is bound to, or that it has none.
 *
 * Only while the marker is still there: one SessionStart already took must
 * not come back for the next.
 */
export function noteCompactionCard(
  stateDir: string,
  sessionId: string,
  taskId: string | null,
): void {
  const file = markerFile(stateDir, sessionId);
  let marker: CompactionMarker;
  try {
    marker = JSON.parse(readFileSync(file, "utf8")) as CompactionMarker;
  } catch {
    return;
  }
  writeMarker(file, { ...marker, taskId });
}

/**
 * SessionStart (compact): take the marker, so no later run finds it.
 *
 * @returns Null when there is none, it is stale, or another run took it.
 */
export function takeCompactionMarker(
  stateDir: string,
  sessionId: string,
): CompactionMarker | null {
  const file = markerFile(stateDir, sessionId);
  const taken = `${file}.${process.pid}.taken`;
  try {
    renameSync(file, taken);
  } catch {
    return null;
  }
  try {
    const marker = JSON.parse(readFileSync(taken, "utf8")) as CompactionMarker;
    if (typeof marker.at !== "number") return null;
    if (Date.now() - marker.at > COMPACT_WINDOW_MS) return null;
    return marker;
  } catch {
    return null;
  } finally {
    rmSync(taken, { force: true });
  }
}
