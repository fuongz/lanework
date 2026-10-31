// A Pull's reading half (FE-112): every conversation one folder has in each
// CLI's own files, read one at a time into rows for main to write.
//
// NOTE: No Electron and no store. It runs in the Pull's worker thread
// (`pull-worker.ts`), or on main's own thread for a spec; what it needs of
// the store comes and goes through {@link PullIO}.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import {
  type AgentPullPhase,
  type AgentSubagent,
  isAgentSessionIdOf,
  type TerminalAgent,
} from "../../../shared/terminal";
import type { IngestState } from "../../session-store/types";
import { codexNames, codexRole } from "../terminal/agent-sessions";
import {
  allCodexRollouts,
  claudeFolderDir,
  codexMetaOf,
  type IngestOutcome,
  type IngestRow,
  ingestClaude,
  ingestCodex,
  opencodeConversations,
  opencodeRows,
  opencodeUnchanged,
  SUBAGENT_LIMIT,
} from "./ingest";

/** Rows sent to main at once, at most. */
const BATCH_ROWS = 25;
/** The longest a read row waits to be sent, in ms. */
const BATCH_MS = 250;
/** The least time between two progress reports of one agent, in ms. */
const PROGRESS_MS = 100;
/** How many stored states one ask fetches, at most. */
const STATE_BATCH = 100;
/**
 * The pause after a file that was read, in ms.
 *
 * NOTE: The worker's thread cannot be given a lower priority on every OS
 * (`pull-worker.ts`); this is what keeps a Pull of thousands of transcripts
 * from holding the disk and a core while the user works.
 */
const READ_PAUSE_MS = 2;

/** What a Pull reads: one folder, for the CLIs named. */
export interface PullJob {
  folder: string;
  agents: TerminalAgent[];
  /** The agents' home: Claude's and Codex's folders are under it. */
  home: string;
  /** OpenCode's data folder, as main resolves it (`opencodeDataDirOf`). */
  opencodeDir: string;
}

/** What one batch of a Pull gives main to write, in order. */
export interface PullBatch {
  rows: IngestRow[];
  /**
   * Codex conversations' spawned threads: each one's whole list, newest
   * first, for a conversation that may already be stored.
   */
  subagents: { key: string; list: AgentSubagent[] }[];
}

/** How far one agent's part of a Pull has got. */
export interface PullStep {
  agent: TerminalAgent;
  done: number;
  total: number;
  phase: AgentPullPhase;
}

/** What a Pull asks of, and tells, the side that holds the store. */
export interface PullIO {
  /** The stored read of each `agent:id`; null for one with no row. */
  states(keys: string[]): Promise<Record<string, IngestState | null>>;
  /** Rows to write, in the order they were read. */
  write(batch: PullBatch): void;
  progress(step: PullStep): void;
  /** Checked between two files: a Pull stops at the next one. */
  signal?: AbortSignal;
}

/** Rows gathered for main, sent a batch at a time. */
class Outbox {
  #rows: IngestRow[] = [];
  #subagents: PullBatch["subagents"] = [];
  #since = Date.now();
  readonly #io: PullIO;

  constructor(io: PullIO) {
    this.#io = io;
  }

  add(row: IngestRow): void {
    this.#rows.push(row);
    if (this.#rows.length >= BATCH_ROWS || Date.now() - this.#since >= BATCH_MS)
      this.flush();
  }

  subagents(key: string, list: AgentSubagent[]): void {
    this.#subagents.push({ key, list });
  }

  flush(): void {
    if (this.#rows.length || this.#subagents.length)
      this.#io.write({ rows: this.#rows, subagents: this.#subagents });
    this.#rows = [];
    this.#subagents = [];
    this.#since = Date.now();
  }
}

/** One agent's progress, reported at most every {@link PROGRESS_MS}. */
class Progress {
  done = 0;
  total = 0;
  #at = 0;
  readonly #io: PullIO;
  readonly #agent: TerminalAgent;

  constructor(io: PullIO, agent: TerminalAgent) {
    this.#io = io;
    this.#agent = agent;
  }

  report(phase: AgentPullPhase, force = false): void {
    const now = Date.now();
    if (!force && phase === "read" && now - this.#at < PROGRESS_MS) return;
    this.#at = now;
    this.#io.progress({
      agent: this.#agent,
      done: this.done,
      total: this.total,
      phase,
    });
  }

  /** `count` more of `total` read. */
  step(count = 1): void {
    this.done += count;
    this.report("read", this.done === this.total);
  }
}

/** A breath between two files: a longer one after a file that was read. */
function breathe(outcome: IngestOutcome | null): Promise<unknown> {
  return outcome?.kind === "row" || outcome?.kind === "spawned"
    ? setTimeout(READ_PAUSE_MS)
    : setImmediate();
}

/** `keys`' stored states, asked a batch at a time. */
async function statesOf(
  io: PullIO,
  keys: string[],
): Promise<Record<string, IngestState | null>> {
  const out: Record<string, IngestState | null> = {};
  for (let at = 0; at < keys.length; at += STATE_BATCH)
    Object.assign(out, await io.states(keys.slice(at, at + STATE_BATCH)));
  return out;
}

/** `folder`'s Claude transcripts, newest first. */
async function claudeFiles(
  home: string,
  folder: string,
): Promise<{ file: string; id: string }[]> {
  const dir = claudeFolderDir(home, folder);
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const id = name.slice(0, -6);
        if (!isAgentSessionIdOf("claude", id)) return null;
        const file = join(dir, name);
        const info = await stat(file).catch(() => null);
        return info?.isFile() ? { file, id, at: info.mtimeMs } : null;
      }),
  );
  return files
    .filter((entry) => entry !== null)
    .sort((a, b) => b.at - a.at)
    .map(({ file, id }) => ({ file, id }));
}

async function pullClaude(
  job: PullJob,
  io: PullIO,
  out: Outbox,
  progress: Progress,
): Promise<void> {
  const files = await claudeFiles(job.home, job.folder);
  progress.total = files.length;
  progress.report("read", true);
  for (let at = 0; at < files.length; at += STATE_BATCH) {
    const chunk = files.slice(at, at + STATE_BATCH);
    const states = await statesOf(
      io,
      chunk.map(({ id }) => `claude:${id}`),
    );
    for (const { file, id } of chunk) {
      io.signal?.throwIfAborted();
      const outcome = await ingestClaude(
        file,
        job.folder,
        states[`claude:${id}`] ?? null,
      ).catch(() => null);
      if (outcome?.kind === "row") out.add(outcome.row);
      progress.step();
      await breathe(outcome);
    }
  }
}

/**
 * Codex keeps every folder's rollouts in one tree: each is opened as far as
 * its first line, to learn whose it is, and only the folder's are read on.
 */
async function pullCodex(
  job: PullJob,
  io: PullIO,
  out: Outbox,
  progress: Progress,
): Promise<void> {
  const files = await allCodexRollouts(join(job.home, ".codex", "sessions"));
  const names = await codexNames(job.home);
  progress.total = files.length;
  progress.report("read", true);
  // The threads each conversation spawned, by its id.
  const spawned = new Map<string, AgentSubagent[]>();
  for (const file of files) {
    io.signal?.throwIfAborted();
    let outcome: IngestOutcome | null = null;
    const meta = await codexMetaOf(file, job.folder).catch(() => null);
    if (meta) {
      const conversation = codexRole(meta).kind === "conversation";
      const key = `codex:${meta.id as string}`;
      const prior = conversation
        ? ((await io.states([key]))[key] ?? null)
        : null;
      outcome = await ingestCodex(file, job.folder, prior, {
        names,
        meta,
      }).catch(() => null);
    }
    if (outcome?.kind === "row") out.add(outcome.row);
    if (outcome?.kind === "spawned") {
      const siblings = spawned.get(outcome.root) ?? [];
      siblings.push(outcome.subagent);
      spawned.set(outcome.root, siblings);
    }
    progress.step();
    await breathe(outcome);
  }
  for (const [root, list] of spawned)
    out.subagents(
      `codex:${root}`,
      list
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, SUBAGENT_LIMIT),
    );
}

/**
 * OpenCode keeps every session in one database: the ones written since the
 * store's read are read again, a batch per open of it.
 */
async function pullOpencode(
  job: PullJob,
  io: PullIO,
  out: Outbox,
  progress: Progress,
): Promise<void> {
  const conversations = await opencodeConversations(
    job.opencodeDir,
    job.folder,
  );
  progress.total = conversations.length;
  progress.report("read", true);
  const states = await statesOf(
    io,
    conversations.map(({ id }) => `opencode:${id}`),
  );
  const changed = conversations.filter(
    (conversation) =>
      !opencodeUnchanged(conversation, states[`opencode:${conversation.id}`]),
  );
  progress.done = conversations.length - changed.length;
  progress.report("read", true);
  for (let at = 0; at < changed.length; at += BATCH_ROWS) {
    io.signal?.throwIfAborted();
    const chunk = changed.slice(at, at + BATCH_ROWS);
    for (const row of await opencodeRows(job.opencodeDir, job.folder, chunk))
      out.add(row);
    progress.step(chunk.length);
    await setTimeout(READ_PAUSE_MS);
  }
}

const READERS: Record<
  TerminalAgent,
  (job: PullJob, io: PullIO, out: Outbox, progress: Progress) => Promise<void>
> = { claude: pullClaude, codex: pullCodex, opencode: pullOpencode };

/**
 * Read `job.folder`'s conversations from each of `job.agents`' files, one
 * agent and one file at a time, handing main what to write as it goes.
 *
 * Only what was written since the store's last read of a conversation is
 * read; one that did not move is not read at all.
 *
 * Each agent's part reports `scan`, then `read` as it goes, then `done`;
 * one whose files cannot be read reports `failed`, and the next agent's part
 * goes on.
 *
 * @throws `signal.reason` once `io.signal` aborts, between two files. What
 *   was sent before stays sent.
 */
export async function runPullJob(job: PullJob, io: PullIO): Promise<void> {
  const out = new Outbox(io);
  for (const agent of job.agents) {
    io.signal?.throwIfAborted();
    const progress = new Progress(io, agent);
    progress.report("scan", true);
    try {
      await READERS[agent](job, io, out, progress);
      out.flush();
      progress.report("done", true);
    } catch (error) {
      // What was read before the stop is still main's to write.
      out.flush();
      if (io.signal?.aborted) throw error;
      progress.report("failed", true);
    }
  }
}

/** What the Pull's worker posts to main (`pull-worker.ts` → `pull.ts`). */
export type WorkerMessage =
  | { t: "states"; req: number; keys: string[] }
  | { t: "write"; batch: PullBatch }
  | { t: "progress"; step: PullStep }
  | { t: "done" }
  | { t: "failed"; message: string };

/** What main posts back: the answer to a `states` ask. */
export interface MainMessage {
  t: "states";
  req: number;
  states: Record<string, IngestState | null>;
}
