// What Lanework adds to an agent conversation (FE-24, FE-25): a name of its
// own and a pin. Kept in the app's home, never in the CLI's files.
//
// ⚠️ Nothing here imports Electron: main passes the file, and a spec drives it
// under plain Node against a temporary one.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AGENT_NAME_MAX, type AgentSession } from "../../../shared/terminal";
import { agentKey } from "./agent-sessions";

interface AgentMark {
  /** The name given in Lanework; absent means the CLI's own title. */
  name?: string;
  /** Epoch ms it was pinned; absent means not pinned. */
  pinnedAt?: number;
}

type AgentMarks = Record<string, AgentMark>;

/**
 * Every mark on this machine, by `agent:id`.
 *
 * ⚠️ A file that is missing, unreadable or not ours reads as NO marks rather
 * than an error: losing a pin is a nuisance, a rail that stops listing
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
      if (next.name !== undefined || next.pinnedAt !== undefined)
        out[key] = next;
    }
    return out;
  } catch {
    return {};
  }
}

/** Written whole to a temp file and moved over, so a crash never halves it. */
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
 * ⚠️ Refused rather than cleaned when it has a control character in it. A
 * line break in a name is somebody pasting the wrong thing, and quietly
 * gluing it into one line would save something they did not type.
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
  const next = change({ ...marks[key] });
  if (!next.name) delete next.name;
  if (next.pinnedAt === undefined) delete next.pinnedAt;
  if (next.name === undefined && next.pinnedAt === undefined) delete marks[key];
  else marks[key] = next;
  await writeAgentMarks(file, marks);
}

/** The `agent:id`s that must stay listed however old they are: the pinned. */
export function keptKeys(marks: AgentMarks): Set<string> {
  return new Set(
    Object.entries(marks)
      .filter(([, mark]) => mark.pinnedAt !== undefined)
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
    };
  });
}
