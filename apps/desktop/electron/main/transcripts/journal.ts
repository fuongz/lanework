// A workflow run's `journal.jsonl` (FE-01): the agents it started, in order,
// and the ones that gave back a result.
//
// NOTE: The journal is the CLI's own, undocumented. A journal of another
// shape, or none, reads as empty, and every agent is still listed from its
// own `.meta.json` (FE-01/D1). A leaf over `./jsonl`; Node only, no Electron.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { isClaudeSubagentId } from "../../../shared/terminal";
import { eachLine } from "./jsonl";

/** One agent the run started, as its journal said. */
export interface JournalStart {
  /** Its place in the order the run started its agents. */
  at: number;
  /**
   * What the run calls this `agent()` call (`v2:<hash>`): a resumed run
   * starts an unfinished one again under a new id with the same key.
   */
  key: string | null;
  phase: string | null;
  label: string | null;
}

/** What a run's journal says so far. */
export interface Journal {
  /** The agents started, by id, in the order they were. */
  started: Map<string, JournalStart>;
  /** The agents that gave back a result: done, whatever their file says. */
  results: Set<string>;
}

/** Journals whose read is kept, oldest read first. */
const JOURNAL_CACHE_MAX = 64;
/** Each journal read so far, and how far: only what is written since is read. */
const journals = new Map<string, { end: number; journal: Journal }>();
/** One read of a journal at a time: a second waits and takes the cache. */
const reading = new Map<string, Promise<Journal>>();

/** A `result` line's agent: its result can be MBs, so only its start is read. */
const RESULT_AGENT =
  /^\{"type":"result"[^{]*?"agentId":"([A-Za-z0-9_-]{1,64})"/;

/** A non-blank string, or null. */
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/** Fold one journal line into `journal`. */
function visit(journal: Journal, line: string) {
  if (line.startsWith('{"type":"result"')) {
    const id = RESULT_AGENT.exec(line)?.[1];
    if (id) journal.results.add(id);
    return;
  }
  if (!line.startsWith('{"type":"started"')) return;
  try {
    const entry = JSON.parse(line) as Record<string, unknown>;
    const id = entry.agentId;
    if (!isClaudeSubagentId(id) || journal.started.has(id)) return;
    journal.started.set(id, {
      at: journal.started.size,
      key: str(entry.key),
      phase: str(entry.phase),
      label: str(entry.label),
    });
  } catch {
    // Cut, or not a line of it.
  }
}

async function read(file: string): Promise<Journal> {
  const size = (await stat(file).catch(() => null))?.size ?? 0;
  const cached = journals.get(file);
  // Gone, or shorter than what was read: rewritten, so read it as new.
  const known =
    cached && cached.end <= size
      ? cached
      : { end: 0, journal: { started: new Map(), results: new Set<string>() } };
  journals.delete(file);
  journals.set(file, known);
  while (journals.size > JOURNAL_CACHE_MAX) {
    const oldest = journals.keys().next().value;
    if (oldest === undefined) break;
    journals.delete(oldest);
  }
  if (known.end < size)
    known.end = await eachLine(file, known.end, (line) =>
      visit(known.journal, line),
    ).catch(() => known.end);
  return known.journal;
}

/**
 * The journal of the run whose agents are in `dir`
 * (`<conversation>/subagents/workflows/<run>`).
 *
 * @returns Empty when there is none, or it cannot be read.
 */
export function readJournal(dir: string): Promise<Journal> {
  const file = join(dir, "journal.jsonl");
  const prior = reading.get(file) ?? Promise.resolve(null);
  const next = prior.catch(() => null).then(() => read(file));
  reading.set(file, next);
  const done = () => {
    if (reading.get(file) === next) reading.delete(file);
  };
  next.then(done, done);
  return next;
}
