// What Lanework adds to an agent conversation (FE-24, FE-25): a name of its
// own, a pin, and the conductor it belongs to (FE-95). Kept in the app's
// home, never in the CLI's files.
//
// Nothing here imports Electron: main passes the file, and a spec drives it
// under plain Node against a temporary one.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LEAD_REF_PATTERN } from "../../../shared/orchestration";
import { AGENT_NAME_MAX, type AgentSession } from "../../../shared/terminal";
import { agentKey } from "./agent-sessions";

/** Lanework's own additions to one conversation. */
interface AgentMark {
  /** The name given in Lanework; absent means the CLI's own title. */
  name?: string;
  /** Epoch ms it was pinned; absent means not pinned. */
  pinnedAt?: number;
  /**
   * The conductor whose own conversation this is, and the workspace it is
   * that in: one per conductor per workspace (FE-95). Absent means none.
   */
  conductor?: { id: string; workspace: string };
}

/** Every mark, by `agent:id`. */
type AgentMarks = Record<string, AgentMark>;

/**
 * Every mark on this machine, by `agent:id`.
 *
 * NOTE: A file that is missing, unreadable or not ours reads as NO marks
 * rather than an error. Losing a pin is a nuisance; a rail that stops listing
 * conversations over it is a bug.
 */
export async function readAgentMarks(file: string): Promise<AgentMarks> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as {
      v?: unknown;
      marks?: unknown;
    };
    if (data?.v !== 1 || !data.marks || typeof data.marks !== "object")
      return {};
    const out: AgentMarks = {};
    for (const [key, raw] of Object.entries(data.marks)) {
      const mark = raw as AgentMark | null;
      const next: AgentMark = {};
      if (typeof mark?.name === "string" && mark.name) next.name = mark.name;
      if (typeof mark?.pinnedAt === "number" && Number.isFinite(mark.pinnedAt))
        next.pinnedAt = mark.pinnedAt;
      const conductor = mark?.conductor;
      if (
        typeof conductor?.id === "string" &&
        LEAD_REF_PATTERN.test(conductor.id) &&
        typeof conductor.workspace === "string" &&
        conductor.workspace
      )
        next.conductor = { id: conductor.id, workspace: conductor.workspace };
      if (!isEmpty(next)) out[key] = next;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Save every mark.
 *
 * Written whole to a temp file and moved over, so a crash never halves it.
 */
async function writeAgentMarks(file: string, marks: AgentMarks): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ v: 1, marks }, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temp, file);
}

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

/** Change one mark and save; an emptied mark is removed, not kept blank. */
export async function updateAgentMark(
  file: string,
  key: string,
  change: (mark: AgentMark) => AgentMark,
): Promise<void> {
  const marks = await readAgentMarks(file);
  const next = tidy(change({ ...marks[key] }));
  if (isEmpty(next)) delete marks[key];
  else marks[key] = next;
  await writeAgentMarks(file, marks);
}

/** A mark without its emptied fields. */
function tidy(mark: AgentMark): AgentMark {
  const next = { ...mark };
  if (!next.name) delete next.name;
  if (next.pinnedAt === undefined) delete next.pinnedAt;
  if (!next.conductor) delete next.conductor;
  return next;
}

function isEmpty(mark: AgentMark): boolean {
  return (
    mark.name === undefined &&
    mark.pinnedAt === undefined &&
    mark.conductor === undefined
  );
}

/**
 * Make `key` the conductor's own conversation in `workspace`, and let go the
 * one it had there before (FE-95): one per conductor per workspace.
 */
export async function bindConductor(
  file: string,
  key: string,
  conductor: { id: string; workspace: string },
): Promise<void> {
  if (!LEAD_REF_PATTERN.test(conductor.id))
    throw new Error("A valid conductor is required");
  const marks = await readAgentMarks(file);
  for (const [other, mark] of Object.entries(marks)) {
    if (
      other === key ||
      mark.conductor?.id !== conductor.id ||
      mark.conductor.workspace !== conductor.workspace
    )
      continue;
    const next = tidy({ ...mark, conductor: undefined });
    if (isEmpty(next)) delete marks[other];
    else marks[other] = next;
  }
  marks[key] = { ...marks[key], conductor: { ...conductor } };
  await writeAgentMarks(file, marks);
}

/**
 * The `agent:id`s that must stay listed however old they are: the pinned,
 * and every conductor's own conversation.
 */
export function keptKeys(marks: AgentMarks): Set<string> {
  return new Set(
    Object.entries(marks)
      .filter(
        ([, mark]) =>
          mark.pinnedAt !== undefined || mark.conductor !== undefined,
      )
      .map(([key]) => key),
  );
}

/** A listing with Lanework's names and pins laid over the CLI's. */
export function applyAgentMarks(
  sessions: AgentSession[],
  marks: AgentMarks,
): AgentSession[] {
  return sessions.map((session) => {
    const mark = marks[agentKey(session)];
    return {
      ...session,
      title: mark?.name ?? session.cliTitle,
      pinnedAt: mark?.pinnedAt ?? null,
      conductor: mark?.conductor?.id ?? null,
    };
  });
}
