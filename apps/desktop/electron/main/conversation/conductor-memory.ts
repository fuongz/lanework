// A conductor's memory of one project (FE-128, see
// `shared/conductor-sessions.ts`): one JSON file per conductor × project,
// `<project folder>/conductors/<id>/memory.json` (`paths.ts`).
//
// - Main writes the ledger: a session's entry as `sessions.start` starts it,
//   and again each time one of its turns ends.
// - Main also writes the runs: one entry per orchestration run the conductor
//   led, once, when the run finished or was stopped (FE-131).
// - The conductor replaces its notes with `memory.write`; the user may edit
//   them from the conductor's settings (`leads.saveMemoryNotes`). Both go
//   through the one store here, so neither overwrites the other's write.
//
// Every write to one file waits on the one before it (read, change, write),
// and lands whole: a temporary file renamed over the old one. A file that
// does not read as a memory reads as an empty one.
//
// NOTE: Nothing here is ever put into a prompt by main: the conductor reads
// its memory with `memory.read` when it wants to, so no conversation's prompt
// prefix changes between its turns.
//
// Nothing here imports Electron: `index.ts` hands in where each file lives.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type ConductorLedgerEntry,
  type ConductorMemory,
  type ConductorRunEntry,
  emptyConductorMemory,
  MEMORY_LEDGER_MAX,
  MEMORY_NOTES_MAX,
  MEMORY_RUN_ERROR_MAX,
  MEMORY_RUN_TASKS_MAX,
  MEMORY_RUNS_MAX,
  MEMORY_SUMMARY_MAX,
  normalizeConductorMemory,
} from "../../../shared/conductor-sessions";

export interface ConductorMemoryDeps {
  /**
   * The memory file of conductor `conductorId` in `project`.
   *
   * @throws When the project is not known here, or the id is not a lead's.
   */
  fileOf: (project: string, conductorId: string) => Promise<string>;
}

/** A ledger entry as main hands it in; the store stamps `updatedAt`. */
export type LedgerUpdate = Omit<ConductorLedgerEntry, "updatedAt">;

export class ConductorMemoryStore {
  /** File → the last write queued on it. */
  private chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ConductorMemoryDeps) {}

  /** The whole memory; an empty one when nothing was written yet. */
  async read(project: string, conductorId: string): Promise<ConductorMemory> {
    const file = await this.deps.fileOf(project, conductorId);
    // After any write already queued, so a read never misses one.
    return this.queue(file, () => load(file));
  }

  /**
   * Replace the notes wholesale; "" clears them. The ledger is kept.
   *
   * @throws When `notes` is longer than {@link MEMORY_NOTES_MAX}.
   */
  async writeNotes(
    project: string,
    conductorId: string,
    notes: string,
  ): Promise<{ notesLength: number; updatedAt: number }> {
    const clean = notes.trim();
    if (clean.length > MEMORY_NOTES_MAX)
      throw new Error(
        `Notes are longer than ${MEMORY_NOTES_MAX} characters: keep what matters.`,
      );
    const file = await this.deps.fileOf(project, conductorId);
    return this.queue(file, async () => {
      const memory = await load(file);
      const updatedAt = Date.now();
      await save(file, { ...memory, notes: clean, updatedAt });
      return { notesLength: clean.length, updatedAt };
    });
  }

  /**
   * Add a session's ledger entry, or update the one it has, and put it
   * first. The oldest falls off past {@link MEMORY_LEDGER_MAX}.
   */
  async record(
    project: string,
    conductorId: string,
    update: LedgerUpdate,
  ): Promise<void> {
    const file = await this.deps.fileOf(project, conductorId);
    await this.queue(file, async () => {
      const memory = await load(file);
      const updatedAt = Date.now();
      const entry: ConductorLedgerEntry = {
        ...update,
        summary: update.summary.slice(0, MEMORY_SUMMARY_MAX),
        updatedAt,
      };
      if (!entry.taskId) delete entry.taskId;
      await save(file, {
        ...memory,
        ledger: [
          entry,
          ...memory.ledger.filter(
            (other) => other.sessionId !== update.sessionId,
          ),
        ].slice(0, MEMORY_LEDGER_MAX),
        updatedAt,
      });
    });
  }

  /**
   * Add a finished or stopped run, or replace the one it has, and put it
   * first. The oldest falls off past {@link MEMORY_RUNS_MAX}.
   */
  async recordRun(
    project: string,
    conductorId: string,
    entry: ConductorRunEntry,
  ): Promise<void> {
    const file = await this.deps.fileOf(project, conductorId);
    await this.queue(file, async () => {
      const memory = await load(file);
      const kept: ConductorRunEntry = {
        ...entry,
        tasks: entry.tasks.slice(0, MEMORY_RUN_TASKS_MAX).map((task) => {
          const { error, ...rest } = task;
          return error
            ? { ...rest, error: error.slice(0, MEMORY_RUN_ERROR_MAX) }
            : rest;
        }),
      };
      await save(file, {
        ...memory,
        runs: [
          kept,
          ...memory.runs.filter((other) => other.runId !== entry.runId),
        ].slice(0, MEMORY_RUNS_MAX),
        updatedAt: Date.now(),
      });
    });
  }

  /** Run `task` once every task queued on `file` before it is done. */
  private queue<T>(file: string, task: () => Promise<T>): Promise<T> {
    const before = this.chains.get(file) ?? Promise.resolve();
    const next = before.catch(() => {}).then(task);
    this.chains.set(file, next);
    // Forget a chain nothing was queued on since, so the map stays small.
    const forget = () => {
      if (this.chains.get(file) === next) this.chains.delete(file);
    };
    next.then(forget, forget);
    return next;
  }
}

async function load(file: string): Promise<ConductorMemory> {
  try {
    return normalizeConductorMemory(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return emptyConductorMemory();
  }
}

async function save(file: string, memory: ConductorMemory): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(memory, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temp, file);
}
