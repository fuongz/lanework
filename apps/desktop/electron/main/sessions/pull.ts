// A Pull's main-thread half (FE-112): the worker that reads the CLIs' files,
// and the store writes of what it read. Also the one-conversation read the
// transcript watcher runs on a settled write, without a worker.
//
// NOTE: No Electron here either; `index.ts` of the terminal feature calls
// these from its IPC handlers and its watcher, with the store it opened.
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type {
  AgentPullProgress,
  AgentPullResult,
  AgentSubagent,
  TerminalAgent,
} from "../../../shared/terminal";
import {
  type IngestState,
  type SessionStore,
  SessionStoreError,
} from "../../session-store";
import { agentKey, codexNames, codexRole } from "../terminal/agent-sessions";
import { opencodeDataDirOf } from "../terminal/opencode-sessions";
import {
  codexMetaOf,
  type IngestOutcome,
  type IngestRow,
  ingestClaude,
  ingestCodex,
  ingestOpencode,
  SUBAGENT_LIMIT,
} from "./ingest";
import {
  type MainMessage,
  type PullBatch,
  type PullJob,
  type PullStep,
  runPullJob,
  type WorkerMessage,
} from "./pull-job";

/**
 * The most heap the worker may take, in MB.
 *
 * A transcript is read a step at a time, but one line of it (a prompt with
 * screenshots pasted in) can be tens of MB.
 */
const WORKER_HEAP_MB = 512;

/** The phases that end an agent's part of a Pull. */
const FINAL = new Set<string>(["done", "cancelled", "failed"]);

/**
 * Where the worker's bundle is: `session-pull.cjs`, beside main's own
 * (`scripts/electron-bundle.mjs`), as `pty-host.cjs` is.
 */
export function pullWorkerFile(): string {
  return join(__dirname, "session-pull.cjs");
}

/**
 * The Pull's worker, on `file`.
 *
 * NOTE: A packaged build's bundle is inside `app.asar`, which main's `fs`
 * reads and a worker's own loader is not promised to. There the worker is
 * handed the bundle's text, read here; it needs nothing but Node's own
 * modules.
 */
function startWorker(file: string, job: PullJob): Worker {
  const options: WorkerOptions = {
    workerData: job,
    name: "Lanework Pull",
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
  };
  return file.includes(`app.asar${sep}`)
    ? new Worker(readFileSync(file, "utf8"), { ...options, eval: true })
    : new Worker(file, options);
}

/** What {@link pull} asks of its caller, and tells it. */
export interface PullHandlers {
  /** The stored read of each `agent:id`; null for one with no row. */
  states(
    keys: string[],
  ):
    | Record<string, IngestState | null>
    | Promise<Record<string, IngestState | null>>;
  /** Rows to write, in the order they were read. */
  write(batch: PullBatch): void;
  progress?(step: PullStep): void;
  /** Ends the Pull: the worker is stopped, and nothing it sends after counts. */
  signal?: AbortSignal;
  /** Default {@link pullWorkerFile}. */
  workerFile?: string;
  /** Read on this thread, no worker: for specs. */
  inline?: boolean;
}

/**
 * Run `job` in the Pull's worker thread, one file at a time, handing each
 * batch it reads to `handlers.write`.
 *
 * @throws `signal.reason` once `handlers.signal` aborts; what was written
 *   before stays. The worker's own error when it fails, or when it stops.
 */
export function pull(job: PullJob, handlers: PullHandlers): Promise<void> {
  if (handlers.inline)
    return runPullJob(job, {
      states: async (keys) => handlers.states(keys),
      write: (batch) => handlers.write(batch),
      progress: (step) => handlers.progress?.(step),
      signal: handlers.signal,
    });
  return new Promise<void>((resolve, reject) => {
    const signal = handlers.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const worker = startWorker(handlers.workerFile ?? pullWorkerFile(), job);
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", stop);
      void worker.terminate();
      if (error === undefined) resolve();
      else reject(error);
    };
    const stop = () => finish(signal?.reason);
    signal?.addEventListener("abort", stop, { once: true });
    worker.on("message", async (message: WorkerMessage) => {
      if (settled) return;
      try {
        switch (message.t) {
          case "states": {
            const states = await handlers.states(message.keys);
            if (settled) return;
            const answer: MainMessage = {
              t: "states",
              req: message.req,
              states,
            };
            worker.postMessage(answer);
            return;
          }
          case "write":
            handlers.write(message.batch);
            return;
          case "progress":
            handlers.progress?.(message.step);
            return;
          case "done":
            finish();
            return;
          case "failed":
            finish(new Error(message.message));
            return;
        }
      } catch (error) {
        finish(error);
      }
    });
    worker.on("error", (error) => finish(error));
    worker.on("exit", (code) =>
      finish(new Error(`The Pull's worker stopped (exit code ${code}).`)),
    );
  });
}

/**
 * Write one row: the conversation, how far it was read, its sub-agents.
 *
 * NOTE: Inside {@link applyBatch}'s transaction. The store refuses an invalid
 * row before it writes anything, so skipping one leaves the batch whole.
 *
 * @returns False for a row the store refused as invalid.
 * @throws When the store is closed.
 */
function applyRow(store: SessionStore, project: string, row: IngestRow) {
  try {
    store.upsertSession({ ...row.session, project });
    store.saveIngest(row.key, row.ingest);
    if (row.subagents) store.setSubagents(row.key, row.subagents);
    return true;
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === "invalid")
      return false;
    throw error;
  }
}

/**
 * Write what a Pull read for `project`, as one transaction.
 *
 * @returns How many rows were written, and the key of every conversation
 *   that changed, sub-agent lists included.
 */
export function applyBatch(
  store: SessionStore,
  project: string,
  batch: PullBatch,
): { rows: number; keys: string[] } {
  return store.transaction(() => {
    const keys = new Set<string>();
    let rows = 0;
    for (const row of batch.rows)
      if (applyRow(store, project, row)) {
        rows += 1;
        keys.add(row.key);
      }
    // A list for a conversation never stored (nothing typed in it) is
    // dropped.
    for (const { key, list } of batch.subagents)
      if (store.setSubagents(key, list)) keys.add(key);
    return { rows, keys: [...keys] };
  });
}

/** What {@link pullIntoStore} reads, and where it reports. */
export interface PullIntoStoreOptions {
  /** The project whose rail lists what is read. */
  project: string;
  /** The folder the CLIs ran in. */
  folder: string;
  agents: readonly TerminalAgent[];
  /** The agents' home (`agentHomeDir()`); a spec points it at fixtures. */
  home: string;
  /** Default `opencodeDataDirOf(home)`. */
  opencodeDir?: string;
  signal?: AbortSignal;
  onProgress?: (progress: AgentPullProgress) => void;
  /** After each batch is written: the conversations it changed. */
  onWritten?: (keys: string[]) => void;
  /** Default {@link pullWorkerFile}. */
  workerFile?: string;
  /** Read on this thread, no worker: for specs. */
  inline?: boolean;
}

/** What a Pull came to. */
export interface PullOutcome extends AgentPullResult {
  /** It was stopped before the end; what it read until then is written. */
  cancelled: boolean;
}

/**
 * Pull `folder`'s conversations for `project` from the CLIs' own files into
 * the store (FE-112).
 *
 * The files are read in a worker thread, one at a time, and only what was
 * written since the store's last read of each; main writes each batch as it
 * comes, so the rail fills while it reads. Lanework's marks (names, pins,
 * conductors, archives) are never touched.
 *
 * Every agent's part ends on `done`, `failed` or `cancelled`, reported
 * through `onProgress`.
 *
 * @returns Resolves once it ends, cancelled or not.
 * @throws The worker's error, when it fails as a whole.
 */
export async function pullIntoStore(
  store: SessionStore,
  options: PullIntoStoreOptions,
): Promise<PullOutcome> {
  let pulled = 0;
  const last = new Map<TerminalAgent, PullStep>();
  const report = (step: PullStep) => {
    last.set(step.agent, step);
    options.onProgress?.({ project: options.project, ...step });
  };
  try {
    await pull(
      {
        folder: options.folder,
        agents: [...options.agents],
        home: options.home,
        opencodeDir: options.opencodeDir ?? opencodeDataDirOf(options.home),
      },
      {
        states: (keys) =>
          Object.fromEntries(
            keys.map((key) => [key, store.getIngestState(key)]),
          ),
        write: (batch) => {
          const { rows, keys } = applyBatch(store, options.project, batch);
          pulled += rows;
          if (keys.length) options.onWritten?.(keys);
        },
        progress: report,
        signal: options.signal,
        workerFile: options.workerFile,
        inline: options.inline,
      },
    );
    return { pulled, cancelled: false };
  } catch (error) {
    const cancelled = options.signal?.aborted === true;
    // Every agent not yet at an end ends here, where it got to.
    for (const agent of options.agents) {
      const step = last.get(agent);
      if (step && FINAL.has(step.phase)) continue;
      report({
        agent,
        done: step?.done ?? 0,
        total: step?.total ?? 0,
        phase: cancelled ? "cancelled" : "failed",
      });
    }
    if (cancelled) return { pulled, cancelled: true };
    throw error;
  }
}

// ── One conversation, on a settled write ────────────────────────────────────

/** Which conversation {@link ingestOne} reads. */
export type IngestSource =
  /** Its transcript (`claudeTranscriptOf`). */
  | { agent: "claude"; file: string }
  /** Its rollout, or a thread's it spawned. */
  | { agent: "codex"; file: string }
  /** OpenCode keeps no file per conversation: its id. */
  | { agent: "opencode"; id: string };

export interface IngestOneOptions {
  project: string;
  folder: string;
  /** The agents' home (`agentHomeDir()`). */
  home: string;
  /** Default `opencodeDataDirOf(home)`. */
  opencodeDir?: string;
}

/** One read of a source at a time: a second waits, then reads on from it. */
const ingesting = new Map<string, Promise<unknown>>();

function oneAtATime<T>(lock: string, run: () => Promise<T>): Promise<T> {
  const prior = ingesting.get(lock) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(run);
  ingesting.set(lock, next);
  const done = () => {
    if (ingesting.get(lock) === next) ingesting.delete(lock);
  };
  next.then(done, done);
  return next;
}

/** Codex's `session_index.jsonl` as last read, by home. */
const codexIndex = new Map<
  string,
  { size: number; mtimeMs: number; names: Map<string, string> }
>();

/**
 * `codexNames(home)`, read again only once the index changed: a settled
 * write of a rollout comes every few hundred ms while a turn runs.
 */
async function codexNamesOf(home: string): Promise<Map<string, string>> {
  const info = await stat(join(home, ".codex", "session_index.jsonl")).catch(
    () => null,
  );
  const known = codexIndex.get(home);
  if (
    info &&
    known &&
    known.size === info.size &&
    known.mtimeMs === info.mtimeMs
  )
    return known.names;
  const names = await codexNames(home);
  if (info)
    codexIndex.set(home, { size: info.size, mtimeMs: info.mtimeMs, names });
  return names;
}

/** `list` with `subagent` in it, newest first, at most the limit. */
function withSubagent(
  list: readonly AgentSubagent[],
  subagent: AgentSubagent,
): AgentSubagent[] {
  return [subagent, ...list.filter((entry) => entry.id !== subagent.id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, SUBAGENT_LIMIT);
}

async function ingestNow(
  store: SessionStore,
  source: IngestSource,
  options: IngestOneOptions,
): Promise<{ key: string | null; written: boolean }> {
  let key: string;
  let outcome: IngestOutcome;
  if (source.agent === "claude") {
    key = agentKey({ agent: "claude", id: basename(source.file, ".jsonl") });
    outcome = await ingestClaude(
      source.file,
      options.folder,
      store.getIngestState(key),
    );
  } else if (source.agent === "codex") {
    const meta = await codexMetaOf(source.file, options.folder);
    if (!meta) return { key: null, written: false };
    key = agentKey({ agent: "codex", id: meta.id as string });
    const conversation = codexRole(meta).kind === "conversation";
    outcome = await ingestCodex(
      source.file,
      options.folder,
      conversation ? store.getIngestState(key) : null,
      {
        names: conversation ? await codexNamesOf(options.home) : new Map(),
        meta,
      },
    );
  } else {
    key = agentKey({ agent: "opencode", id: source.id });
    outcome = await ingestOpencode(
      options.opencodeDir ?? opencodeDataDirOf(options.home),
      options.folder,
      source.id,
      store.getIngestState(key),
    );
  }
  if (outcome.kind === "row")
    return { key, written: applyRow(store, options.project, outcome.row) };
  if (outcome.kind === "spawned") {
    // A thread its conversation spawned: its place in that one's list.
    const parent = agentKey({ agent: "codex", id: outcome.root });
    const stored = store.getSession(parent);
    if (!stored) return { key: parent, written: false };
    return {
      key: parent,
      written: store.setSubagents(
        parent,
        withSubagent(stored.subagents, outcome.subagent),
      ),
    };
  }
  return { key, written: false };
}

/**
 * Read one conversation into the store after a settled write of it
 * (FE-112): only what was written since its last read, on this thread.
 *
 * Reads of one source wait on each other, so two settled writes never read
 * the same bytes twice.
 *
 * @returns The conversation the write was news of (for a Codex thread, the
 *   conversation that spawned it), and whether the store changed; `key` is
 *   null for a rollout that is not `folder`'s.
 */
export function ingestOne(
  store: SessionStore,
  source: IngestSource,
  options: IngestOneOptions,
): Promise<{ key: string | null; written: boolean }> {
  const lock =
    source.agent === "opencode" ? `opencode:${source.id}` : source.file;
  return oneAtATime(lock, () => ingestNow(store, source, options));
}
