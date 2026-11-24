// `thread.read` (BE-03): the turns a handoff left out, read back on demand.
//
// A handoff carries only what fits its budget (`handoff.ts`). Every turn of
// the thread it came from has a reference `<session>:<index>`: the session
// is the native conversation's id cut short (`shortSession`), the index the
// turn's place among that session's own turns as `readSession` lists them,
// handoff markers left out. The block names the references it left out, and
// the new agent reads one only when the request needs it.
//
// Who may read what is the caller's own thread (D2): its sessions, and the
// conversations it was handed off from, which main works out
// (`ThreadReadDeps.sessions`). Nothing here imports Electron.

import {
  THREAD_READ_BYTES_MAX,
  THREAD_READ_TURN_CHARS,
  type ThreadReadInput,
  type ThreadReadResult,
  type ThreadReadTurn,
} from "../../../shared/conductor-sessions";
import {
  AGENT_LABELS,
  type ConversationAgent,
  splitHandoffText,
  type Turn,
} from "../../../shared/conversation";

/** The characters a session's reference keeps of its id. */
const SHORT_LENGTH = 8;
/** OpenCode's ids share this prefix: the reference skips it. */
const OPENCODE_PREFIX = "ses_";

/** A session's id as its references name it: its first 8 characters. */
export function shortSession(conversation: string): string {
  const id = conversation.startsWith(OPENCODE_PREFIX)
    ? conversation.slice(OPENCODE_PREFIX.length)
    : conversation;
  return id.slice(0, SHORT_LENGTH);
}

/** One turn with its reference. */
export interface IndexedTurn {
  turn: Turn;
  /** The native session it came from. */
  session: string;
  /** Its place among that session's turns, from 0. */
  index: number;
  ref: string;
}

/**
 * `turns` with their references; handoff markers are no session's turns
 * and get none.
 *
 * @param fallback The session of a turn without a tag: a lone
 *   conversation's turns carry none.
 */
export function indexTurns(
  turns: readonly Turn[],
  fallback: string,
): (IndexedTurn | null)[] {
  const next = new Map<string, number>();
  return turns.map((turn) => {
    if (turn.role === "handoff") return null;
    const session = turn.session?.conversation ?? fallback;
    const index = next.get(session) ?? 0;
    next.set(session, index + 1);
    return { turn, session, index, ref: `${shortSession(session)}:${index}` };
  });
}

/** One session the caller may read. */
export interface ThreadSession {
  conversation: string;
  agent: ConversationAgent;
  model: string | null;
}

export interface ThreadReadDeps {
  /** The sessions the caller may read, oldest first. */
  sessions: () => Promise<ThreadSession[]>;
  /** One session's own turns, as `readSession` lists them. */
  turns: (conversation: string) => Promise<Turn[]>;
}

export class ThreadReadError extends Error {}

/** A turn's text as `thread.read` gives it, whole. */
function turnText(turn: Turn, tools: boolean): string {
  switch (turn.role) {
    case "user": {
      const split = splitHandoffText(turn.text);
      const text = (split?.message ?? turn.text).trim();
      const note = split
        ? "(This session started with a handoff block, left out here.)\n"
        : "";
      const attached = turn.attachments.length
        ? `\n(Attached: ${turn.attachments.map((entry) => entry.name).join(", ")})`
        : "";
      return `${note}${text}${attached}`;
    }
    case "assistant": {
      const parts: string[] = [];
      for (const block of turn.blocks) {
        if (block.type === "text" && block.text.trim())
          parts.push(block.text.trim());
        else if (block.type === "tools")
          for (const call of block.calls) {
            const line = `- ${call.tool}: ${call.summary.replace(/\s+/g, " ").trim()}${call.error ? " (failed)" : ""}`;
            parts.push(
              tools && call.output
                ? `${line}\n  Output:\n${call.output}${call.outputCut ? "\n  [output cut]" : ""}`
                : line,
            );
          }
      }
      return parts.join("\n\n");
    }
    case "peer":
      return `Message from another Claude session${turn.name ? ` (${turn.name})` : ""}:\n${turn.text}`;
    case "compaction":
      return `The conversation was compacted here. Summary it kept:\n${turn.summary?.trim() ?? "(none)"}`;
    case "handoff":
      return "";
  }
}

function readTurn(
  entry: IndexedTurn,
  tools: boolean,
  offset: number,
): ThreadReadTurn {
  const whole = turnText(entry.turn, tools);
  const end = offset + THREAD_READ_TURN_CHARS;
  const out: ThreadReadTurn = {
    ref: entry.ref,
    role: entry.turn.role === "handoff" ? "compaction" : entry.turn.role,
    at: entry.turn.at,
    text: whole.slice(offset, end),
    nextTextOffset: end < whole.length ? end : null,
  };
  if (entry.turn.role === "assistant" && entry.turn.model)
    out.model = entry.turn.model;
  return out;
}

/** The session `prefix` names among `sessions`, or refused. */
function sessionOf(
  sessions: readonly ThreadSession[],
  prefix: string,
): ThreadSession {
  const key = prefix.startsWith(OPENCODE_PREFIX)
    ? prefix.slice(OPENCODE_PREFIX.length)
    : prefix;
  const found = sessions.filter(
    (session) =>
      shortSession(session.conversation).startsWith(key) ||
      session.conversation.startsWith(prefix),
  );
  if (found.length === 1) return found[0] as ThreadSession;
  throw new ThreadReadError(
    found.length
      ? `"${prefix}" names more than one session of this thread: give more of its id.`
      : `"${prefix}" is no session of this conversation's thread. Call thread.read {} for its sessions.`,
  );
}

/** One session's turns with their references, markers left out. */
async function indexed(
  deps: ThreadReadDeps,
  session: ThreadSession,
): Promise<IndexedTurn[]> {
  const turns = await deps.turns(session.conversation).catch(() => []);
  return indexTurns(turns, session.conversation).filter(
    (entry): entry is IndexedTurn => entry !== null,
  );
}

/**
 * Answer one `thread.read` call.
 *
 * - `{}`: the sessions the caller may read, each with its turn count.
 * - `{ref, textOffset}`: that one turn, from `textOffset`.
 * - `{session, after, limit}`: its turns after index `after`, at most
 *   `limit` and {@link THREAD_READ_BYTES_MAX} in all.
 *
 * @throws {ThreadReadError} For a session or turn the caller may not read.
 */
export async function readThread(
  deps: ThreadReadDeps,
  input: ThreadReadInput,
): Promise<ThreadReadResult> {
  const sessions = await deps.sessions();
  const tools = input.includeTools ?? false;
  const describe = (session: ThreadSession, turns?: number) => ({
    session: shortSession(session.conversation),
    conversation: session.conversation,
    agent: AGENT_LABELS[session.agent],
    model: session.model,
    ...(turns === undefined ? {} : { turns }),
  });

  if (input.ref) {
    const [prefix = "", at = ""] = input.ref.split(":");
    const session = sessionOf(sessions, prefix);
    const index = Number(at);
    const entry = (await indexed(deps, session))[index];
    if (!entry)
      throw new ThreadReadError(
        `${input.ref} is past the end of session ${shortSession(session.conversation)}.`,
      );
    return {
      sessions: [describe(session)],
      turns: [readTurn(entry, tools, input.textOffset ?? 0)],
      next: null,
    };
  }

  if (!input.session) {
    const counted = await Promise.all(
      sessions.map(async (session) =>
        describe(session, (await indexed(deps, session)).length),
      ),
    );
    return { sessions: counted, turns: [], next: null };
  }

  const session = sessionOf(sessions, input.session);
  const all = await indexed(deps, session);
  const limit = input.limit ?? 10;
  const turns: ThreadReadTurn[] = [];
  let bytes = 0;
  let at = (input.after ?? -1) + 1;
  for (; at < all.length && turns.length < limit; at++) {
    const turn = readTurn(all[at] as IndexedTurn, tools, 0);
    const cost = Buffer.byteLength(turn.text) + 200;
    if (turns.length && bytes + cost > THREAD_READ_BYTES_MAX) break;
    turns.push(turn);
    bytes += cost;
  }
  return {
    sessions: [describe(session, all.length)],
    turns,
    next:
      at < all.length
        ? { session: shortSession(session.conversation), after: at - 1 }
        : null,
  };
}
