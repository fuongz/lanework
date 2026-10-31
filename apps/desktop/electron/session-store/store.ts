import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { LEAD_REF_PATTERN } from "../../shared/orchestration";
import {
  AGENT_SESSION_LIMIT,
  type AgentCard,
  type AgentSession,
  type AgentSubagent,
  isAgentSessionIdOf,
  isTerminalAgent,
  type TerminalAgent,
} from "../../shared/terminal";
import {
  openDatabase,
  type SqlDatabase,
  type SqlValue,
} from "../local-store/driver";
import { sessionStorePath } from "../main/paths";
import { migrate } from "./schema";
import {
  type IngestSave,
  type IngestState,
  type LegacyMarks,
  type SessionFields,
  type SessionOrigin,
  SessionStoreError,
  type SessionUpsert,
  type StoredSession,
} from "./types";

export interface OpenOptions {
  /** Default {@link sessionStorePath}. `:memory:` works for a throwaway one. */
  path?: string;
  /**
   * How long a writer waits on another's lock before `SQLITE_BUSY`, in ms.
   *
   * Default 5000.
   */
  busyTimeoutMs?: number;
}

/** A conversation's key: `agent:id`, as the rail and the marks name it. */
export function sessionKey(agent: TerminalAgent, id: string): string {
  return `${agent}:${id}`;
}

/** The agent and id in `key`, or null when it is not one of ours. */
export function parseSessionKey(
  key: string,
): { agent: TerminalAgent; id: string } | null {
  const at = key.indexOf(":");
  if (at < 0) return null;
  const agent = key.slice(0, at);
  const id = key.slice(at + 1);
  return isTerminalAgent(agent) && isAgentSessionIdOf(agent, id)
    ? { agent, id }
    : null;
}

interface SessionRow {
  key: string;
  agent: TerminalAgent;
  cli_id: string;
  project: string | null;
  folder: string | null;
  cli_title: string;
  name: string | null;
  origin: SessionOrigin;
  created_at: string;
  updated_at: string;
  pinned_at: number | null;
  conductor_id: string | null;
  conductor_project: string | null;
  archived_at: string | null;
  working: number;
  card_board: string | null;
  card_id: string | null;
  bg_running: number;
  bg_total: number;
  source_path: string | null;
  source_size: number | null;
  source_mtime: number | null;
  source_offset: number | null;
  ingest_state: string | null;
}

/**
 * The columns a CLI write sets: every one but Lanework's marks.
 *
 * NOTE: `name`, `pinned_at`, `conductor_*` and `archived_at` are left out on
 * purpose. A Pull or an ingest writes through {@link UPSERT_SQL} alone, so it
 * cannot reset a name, a pin, a conductor or an archive, whatever it read.
 */
const CLI_COLUMNS = [
  "key",
  "agent",
  "cli_id",
  "project",
  "folder",
  "cli_title",
  "origin",
  "created_at",
  "updated_at",
  "working",
  "card_board",
  "card_id",
  "bg_running",
  "bg_total",
  "source_path",
  "source_size",
  "source_mtime",
  "source_offset",
  "ingest_state",
] as const;

type CliRow = Pick<SessionRow, (typeof CLI_COLUMNS)[number]>;

/** Set once, at insert: who a row is and where it came from. */
const INSERT_ONLY = new Set<string>(["key", "agent", "cli_id", "origin"]);

const UPSERT_SQL = `INSERT INTO agent_session (${CLI_COLUMNS.join(", ")})
  VALUES (${CLI_COLUMNS.map(() => "?").join(", ")})
  ON CONFLICT(key) DO UPDATE SET ${CLI_COLUMNS.filter(
    (column) => !INSERT_ONLY.has(column),
  )
    .map((column) => `${column} = excluded.${column}`)
    .join(", ")}`;

/** What the rail reads of a row; every one is in `agent_session_rail`. */
const RAIL_COLUMNS =
  "key, agent, cli_id, cli_title, name, updated_at, pinned_at, conductor_id, working, card_board, card_id, bg_running, bg_total";

type RailRow = Pick<
  SessionRow,
  | "key"
  | "agent"
  | "cli_id"
  | "cli_title"
  | "name"
  | "updated_at"
  | "pinned_at"
  | "conductor_id"
  | "working"
  | "card_board"
  | "card_id"
  | "bg_running"
  | "bg_total"
>;

/**
 * A project's rail: every pinned and conductor row, then the newest `limit`
 * of the rest, archived ones left out.
 *
 * NOTE: Both halves walk `agent_session_rail` and stop there; the second
 * stops after `limit` rows, however many the project has.
 */
const RAIL_SQL = `SELECT ${RAIL_COLUMNS} FROM agent_session
  WHERE project = ? AND archived_at IS NULL
    AND (pinned_at IS NOT NULL OR conductor_id IS NOT NULL)
  UNION ALL
  SELECT * FROM (
    SELECT ${RAIL_COLUMNS} FROM agent_session
    WHERE project = ? AND archived_at IS NULL
      AND pinned_at IS NULL AND conductor_id IS NULL
    ORDER BY updated_at DESC
    LIMIT ?
  )
  ORDER BY updated_at DESC, key`;

interface SubagentRow {
  session_key: string;
  sub_id: string;
  title: string;
  type: string | null;
  updated_at: string;
  working: number;
}

function toSubagent(row: SubagentRow): AgentSubagent {
  return {
    id: row.sub_id,
    title: row.title,
    type: row.type,
    updatedAt: row.updated_at,
    working: Boolean(row.working),
  };
}

function toCard(
  row: Pick<SessionRow, "card_board" | "card_id">,
): AgentCard | null {
  return row.card_board && row.card_id
    ? { boardId: row.card_board, card: row.card_id }
    : null;
}

function toAgentSession(
  row: RailRow,
  subagents: AgentSubagent[],
): AgentSession {
  return {
    id: row.cli_id,
    agent: row.agent,
    title: row.name ?? row.cli_title,
    cliTitle: row.cli_title,
    updatedAt: row.updated_at,
    pinnedAt: row.pinned_at === null ? null : Number(row.pinned_at),
    conductor: row.conductor_id,
    working: Boolean(row.working),
    card: toCard(row),
    subagents,
    background: {
      running: Number(row.bg_running),
      total: Number(row.bg_total),
    },
  };
}

function toStored(row: SessionRow, subagents: AgentSubagent[]): StoredSession {
  return {
    key: row.key,
    agent: row.agent,
    id: row.cli_id,
    project: row.project,
    folder: row.folder,
    cliTitle: row.cli_title,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    working: Boolean(row.working),
    card: toCard(row),
    background: {
      running: Number(row.bg_running),
      total: Number(row.bg_total),
    },
    sourcePath: row.source_path,
    name: row.name,
    pinnedAt: row.pinned_at === null ? null : Number(row.pinned_at),
    conductor:
      row.conductor_id && row.conductor_project
        ? { id: row.conductor_id, project: row.conductor_project }
        : null,
    archivedAt: row.archived_at,
    subagents,
  };
}

/** `value` when given, else `current`: `undefined` keeps, `null` clears. */
function pick<T>(value: T | undefined, current: T): T {
  return value === undefined ? current : value;
}

function numberOrNull(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function invalid(message: string): never {
  throw new SessionStoreError("invalid", message);
}

/**
 * `fields` laid over the CLI columns a row has.
 *
 * NOTE: A new transcript path drops the read position with it: an offset
 * into one file says nothing about another.
 */
function withFields(row: CliRow, fields: SessionFields): CliRow {
  const card = pick(fields.card, toCard(row));
  const sourcePath = pick(fields.sourcePath, row.source_path);
  const moved = sourcePath !== row.source_path;
  return {
    ...row,
    folder: pick(fields.folder, row.folder),
    cli_title: pick(fields.cliTitle, row.cli_title),
    updated_at: pick(fields.updatedAt, row.updated_at),
    working:
      fields.working === undefined ? row.working : fields.working ? 1 : 0,
    card_board: card?.boardId ?? null,
    card_id: card?.card ?? null,
    bg_running: fields.background?.running ?? row.bg_running,
    bg_total: fields.background?.total ?? row.bg_total,
    source_path: sourcePath,
    source_size: moved ? null : row.source_size,
    source_mtime: moved ? null : row.source_mtime,
    source_offset: moved ? null : row.source_offset,
    ingest_state: moved ? null : row.ingest_state,
  };
}

/** A row nothing has been said about yet but who it is. */
function blankRow(
  agent: TerminalAgent,
  id: string,
  origin: SessionOrigin,
  now: string,
): CliRow {
  return {
    key: sessionKey(agent, id),
    agent,
    cli_id: id,
    project: null,
    folder: null,
    cli_title: "",
    origin,
    created_at: now,
    updated_at: now,
    working: 0,
    card_board: null,
    card_id: null,
    bg_running: 0,
    bg_total: 0,
    source_path: null,
    source_size: null,
    source_mtime: null,
    source_offset: null,
    ingest_state: null,
  };
}

/**
 * One connection to Lanework's session store (FE-112).
 *
 * The rail reads it, a Pull and the transcript watcher write it, and the
 * renderer's rename, pin, conductor and archive land in it. The CLI's own
 * files are only ever read.
 *
 * NOTE: Synchronous, like the binding under it: a rail read is one indexed
 * query, cheaper than a hop to a worker and back.
 *
 * NOTE: Every write of more than one statement runs under `BEGIN IMMEDIATE`,
 * for the reason the local board's do (`local-store/store.ts`).
 */
export class SessionStore {
  readonly path: string;
  #db: SqlDatabase | null;
  #depth = 0;

  constructor(db: SqlDatabase, path: string) {
    this.#db = db;
    this.path = path;
  }

  get db(): SqlDatabase {
    if (!this.#db)
      throw new SessionStoreError("closed", "session store is closed");
    return this.#db;
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  /**
   * Run `fn` as one write: every store write it makes commits together, or
   * none does.
   */
  transaction<T>(fn: () => T): T {
    return this.#write(fn);
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  #get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  #all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  #run(sql: string, ...params: SqlValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  /** Run `fn` as one write; a write inside a write joins the outer one. */
  #write<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.#depth += 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  #row(key: string): SessionRow | undefined {
    return this.#get<SessionRow>(
      "SELECT * FROM agent_session WHERE key = ?",
      key,
    );
  }

  #put(row: CliRow): void {
    this.#run(UPSERT_SQL, ...CLI_COLUMNS.map((column) => row[column]));
  }

  #subagents(key: string): AgentSubagent[] {
    return this.#all<SubagentRow>(
      "SELECT * FROM agent_subagent WHERE session_key = ? ORDER BY updated_at DESC, sub_id",
      key,
    ).map(toSubagent);
  }

  #now(): string {
    return new Date().toISOString();
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * What `project`'s rail lists, newest first.
   *
   * Every pinned row and every conductor's own, however old, and the newest
   * `limit` of the rest; never an archived one. As the shared
   * {@link AgentSession}: `title` is the Lanework name, else the CLI's.
   */
  listRail(project: string, limit = AGENT_SESSION_LIMIT): AgentSession[] {
    const rows = this.#all<RailRow>(
      RAIL_SQL,
      project,
      project,
      Math.max(0, Math.floor(limit)),
    );
    if (!rows.length) return [];
    const subagents = new Map<string, AgentSubagent[]>();
    for (const row of this.#all<SubagentRow>(
      `SELECT * FROM agent_subagent
        WHERE session_key IN (SELECT value FROM json_each(?))
        ORDER BY session_key, updated_at DESC, sub_id`,
      JSON.stringify(rows.map((row) => row.key)),
    )) {
      const list = subagents.get(row.session_key) ?? [];
      list.push(toSubagent(row));
      subagents.set(row.session_key, list);
    }
    return rows.map((row) => toAgentSession(row, subagents.get(row.key) ?? []));
  }

  /** One row, marks and all, or null when there is none. */
  getSession(key: string): StoredSession | null {
    const row = this.#row(key);
    return row ? toStored(row, this.#subagents(key)) : null;
  }

  hasSession(key: string): boolean {
    return (
      this.#get("SELECT 1 AS found FROM agent_session WHERE key = ?", key) !==
      undefined
    );
  }

  /**
   * How many live conversations a turn runs in now, and how many have a
   * background task running: what the resource log notes beside each sample
   * (FE-115).
   */
  activityCounts(): { working: number; background: number } {
    const row = this.#get<{
      working: number | null;
      background: number | null;
    }>(
      "SELECT SUM(working) AS working, SUM(bg_running > 0) AS background FROM agent_session WHERE archived_at IS NULL",
    );
    return {
      working: Number(row?.working ?? 0),
      background: Number(row?.background ?? 0),
    };
  }

  /** How far `key`'s transcript has been read; null when there is no row. */
  getIngestState<T = unknown>(key: string): IngestState<T> | null {
    const row = this.#row(key);
    if (!row) return null;
    let state: T | null = null;
    if (row.ingest_state !== null) {
      try {
        state = JSON.parse(row.ingest_state) as T;
      } catch {
        // Unreadable reads as never read: the next ingest starts over.
        return {
          path: row.source_path,
          size: null,
          mtime: null,
          offset: null,
          state: null,
        };
      }
    }
    return {
      path: row.source_path,
      size: numberOrNull(row.source_size),
      mtime: numberOrNull(row.source_mtime),
      offset: numberOrNull(row.source_offset),
      state,
    };
  }

  // ── CLI writes ────────────────────────────────────────────────────────────

  /**
   * Write what a CLI says about a conversation, adding the row if it is new.
   *
   * Lanework's marks (name, pin, conductor, archive) are never touched, nor
   * a row's `origin` once set. A stub {@link importLegacyMarks} made takes
   * the conversation's own start as its `createdAt`.
   *
   * @throws When the agent or the id is not one a CLI writes, or there is no
   *   project.
   */
  upsertSession(input: SessionUpsert): void {
    if (!isTerminalAgent(input.agent)) invalid("an agent is required");
    if (!isAgentSessionIdOf(input.agent, input.id))
      invalid("a conversation id is required");
    if (!input.project) invalid("a project is required");
    const key = sessionKey(input.agent, input.id);
    this.#write(() => {
      const now = this.#now();
      const current = this.#row(key);
      const base =
        current ??
        blankRow(input.agent, input.id, input.origin ?? "pulled", now);
      const next = withFields(base, input);
      next.project = input.project;
      if (!current || current.project === null)
        next.created_at = input.createdAt ?? base.created_at;
      this.#put(next);
    });
  }

  /**
   * Save how far `key`'s transcript has been read, and what that read found,
   * in one write.
   *
   * @returns False when there is no such row.
   */
  saveIngest(key: string, save: IngestSave): boolean {
    return this.#write(() => {
      const current = this.#row(key);
      if (!current) return false;
      const next = withFields(current, save.fields ?? {});
      next.source_size = save.size;
      next.source_mtime = save.mtime;
      next.source_offset = save.offset;
      next.ingest_state =
        save.state === undefined ? null : JSON.stringify(save.state);
      this.#put(next);
      return true;
    });
  }

  /**
   * Replace `key`'s sub-agents with `list`.
   *
   * @returns False when there is no such row.
   */
  setSubagents(key: string, list: readonly AgentSubagent[]): boolean {
    return this.#write(() => {
      if (!this.hasSession(key)) return false;
      this.#run("DELETE FROM agent_subagent WHERE session_key = ?", key);
      for (const sub of list)
        this.#run(
          `INSERT INTO agent_subagent (session_key, sub_id, title, type, updated_at, working)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_key, sub_id) DO UPDATE SET
              title = excluded.title, type = excluded.type,
              updated_at = excluded.updated_at, working = excluded.working`,
          key,
          sub.id,
          sub.title,
          sub.type,
          sub.updatedAt,
          sub.working ? 1 : 0,
        );
      return true;
    });
  }

  /**
   * Drop a conversation from Lanework, its sub-agents with it.
   *
   * The CLI's transcript stays where it is; a later Pull of that CLI finds
   * it again.
   *
   * @returns False when there was no such row.
   */
  removeSession(key: string): boolean {
    return this.#run("DELETE FROM agent_session WHERE key = ?", key) > 0;
  }

  // ── Marks ─────────────────────────────────────────────────────────────────

  /**
   * Name a conversation in Lanework; null or empty goes back to the CLI's
   * title.
   *
   * The name is stored as given: main cleans it first (`cleanAgentName`).
   *
   * @returns False when there is no such row.
   */
  setName(key: string, name: string | null): boolean {
    return (
      this.#run(
        "UPDATE agent_session SET name = ? WHERE key = ?",
        name || null,
        key,
      ) > 0
    );
  }

  /**
   * Pin a conversation, or unpin it.
   *
   * Pinning one already pinned keeps the time it was first pinned, so it
   * holds its place.
   *
   * @param at Epoch ms; default now.
   * @returns False when there is no such row.
   */
  setPinned(key: string, pinned: boolean, at = Date.now()): boolean {
    return (
      this.#run(
        pinned
          ? "UPDATE agent_session SET pinned_at = COALESCE(pinned_at, ?) WHERE key = ?"
          : "UPDATE agent_session SET pinned_at = NULL WHERE key = ?",
        ...(pinned ? [at, key] : [key]),
      ) > 0
    );
  }

  /**
   * Make `key` a conductor's own conversation in a project, or let it go.
   *
   * One per conductor per project (FE-95): the one it had there before is
   * let go in the same write.
   *
   * @returns False when there is no such row.
   * @throws When `conductor` is not a team lead's id and a project.
   */
  setConductor(
    key: string,
    conductor: { id: string; project: string } | null,
  ): boolean {
    if (
      conductor &&
      (!LEAD_REF_PATTERN.test(conductor.id) || !conductor.project)
    )
      invalid("a valid conductor is required");
    return this.#write(() => {
      if (!this.hasSession(key)) return false;
      if (conductor)
        this.#run(
          "UPDATE agent_session SET conductor_id = NULL, conductor_project = NULL WHERE conductor_id = ? AND conductor_project = ? AND key <> ?",
          conductor.id,
          conductor.project,
          key,
        );
      this.#run(
        "UPDATE agent_session SET conductor_id = ?, conductor_project = ? WHERE key = ?",
        conductor?.id ?? null,
        conductor?.project ?? null,
        key,
      );
      return true;
    });
  }

  /**
   * Archive a conversation in Lanework, or bring it back.
   *
   * Archiving drops the pin (FE-72/D3) and keeps the name, for when it comes
   * back.
   *
   * @param at ISO; default now.
   * @returns False when there is no such row.
   */
  setArchived(key: string, archived: boolean, at = this.#now()): boolean {
    return (
      this.#run(
        archived
          ? "UPDATE agent_session SET archived_at = COALESCE(archived_at, ?), pinned_at = NULL WHERE key = ?"
          : "UPDATE agent_session SET archived_at = NULL WHERE key = ?",
        ...(archived ? [at, key] : [key]),
      ) > 0
    );
  }

  /**
   * Carry `agent-sessions.json`'s marks over (FE-24, FE-25, FE-95).
   *
   * A conversation with no row yet gets a stub: origin `pulled`, no project
   * and no transcript, so no rail lists it until a Pull fills it in.
   *
   * NOTE: A mark the store already has wins over the legacy one, so a
   * second run never undoes a rename or a pin made since. Run it once all
   * the same: a mark cleared since (an unpin, a name reset) would come back.
   * A conductor is carried over only when no other row holds it in that
   * project.
   *
   * @returns How many usable marks it read. A key that is not `agent:id`
   *   with a valid id, or a mark with nothing usable in it, is skipped.
   */
  importLegacyMarks(marks: LegacyMarks): number {
    return this.#write(() => {
      const now = this.#now();
      let count = 0;
      for (const [key, mark] of Object.entries(marks)) {
        const parsed = parseSessionKey(key);
        if (!parsed || !mark || typeof mark !== "object") continue;
        const name =
          typeof mark.name === "string" && mark.name ? mark.name : null;
        const pinnedAt =
          typeof mark.pinnedAt === "number" && Number.isFinite(mark.pinnedAt)
            ? mark.pinnedAt
            : null;
        const conductor =
          typeof mark.conductor?.id === "string" &&
          LEAD_REF_PATTERN.test(mark.conductor.id) &&
          typeof mark.conductor.project === "string" &&
          mark.conductor.project
            ? mark.conductor
            : null;
        if (name === null && pinnedAt === null && conductor === null) continue;
        if (!this.hasSession(key))
          this.#put(blankRow(parsed.agent, parsed.id, "pulled", now));
        this.#run(
          "UPDATE agent_session SET name = COALESCE(name, ?), pinned_at = COALESCE(pinned_at, ?) WHERE key = ?",
          name,
          pinnedAt,
          key,
        );
        if (conductor)
          this.#run(
            `UPDATE agent_session SET conductor_id = ?, conductor_project = ?
              WHERE key = ? AND conductor_id IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM agent_session
                  WHERE conductor_id = ? AND conductor_project = ?
                )`,
            conductor.id,
            conductor.project,
            key,
            conductor.id,
            conductor.project,
          );
        count += 1;
      }
      return count;
    });
  }
}

/**
 * Open Lanework's session store, `<home>/lw.db`.
 *
 * It creates the file and its folder when absent, and opens it in WAL mode
 * with a busy timeout and foreign keys on, migrated to the current schema.
 *
 * NOTE: A new folder is created 0700 and a new file 0600, as the local
 * board's (FE-78/D8): conversation titles are first prompts, and other users
 * on the machine have no business reading them.
 */
export function openSessionStore(options: OpenOptions = {}): SessionStore {
  const path = options.path ?? sessionStorePath();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  }
  const db = openDatabase(path);
  try {
    db.exec(
      `PRAGMA busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? 5000)}`,
    );
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return new SessionStore(db, path);
}
