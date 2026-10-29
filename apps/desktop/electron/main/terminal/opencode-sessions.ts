// OpenCode's conversations for a folder, read from its own database
// (FE-103, FE-104): the rail's rows, their sub-agents and whether a turn is
// open.
//
// Read-only, and nothing here imports Electron: main calls it, and a spec can
// too. OpenCode keeps every session of the machine in one SQLite file
// (`opencode.db`); version 2 writes `session_v2` and `session_message`, older
// ones `session` and `message`.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type AgentSession,
  type AgentSubagent,
  isAgentSessionIdOf,
} from "../../../shared/terminal";
import { STALE_MS } from "../transcripts/activity";

/** A title OpenCode gives a session before it names it. */
const DEFAULT_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/;

/** What OpenCode appends to a sub-agent's title: ` (@explore subagent)`. */
const SUBAGENT_SUFFIX = /\s*\(@[\w-]+ subagent\)\s*$/;

/** The most characters of a first prompt the rail is given as a title. */
const TITLE_MAX = 200;

/** A conversation's newest sub-agents listed, at most (FE-33/D4). */
const SUBAGENT_LIMIT = 20;

/**
 * Where OpenCode keeps its data: `$OPENCODE_DATA_DIR`, else
 * `$XDG_DATA_HOME/<app>`, else `~/.local/share/<app>`, `<app>` being
 * `$OPENCODE_APPNAME` or "opencode".
 *
 * NOTE: The environment counts only for the real home: a spec points `home`
 * somewhere else and must not read the machine's sessions through it.
 */
export function opencodeDataDir(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  realHome = true,
): string {
  if (realHome && env.OPENCODE_DATA_DIR) return env.OPENCODE_DATA_DIR;
  // OpenCode names its own folders `$OPENCODE_APPNAME`, "opencode" unset.
  const app = (realHome && env.OPENCODE_APPNAME?.trim()) || "opencode";
  if (realHome && env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, app);
  return join(home, ".local", "share", app);
}

/** {@link opencodeDataDir} for the agents' `home`, the environment's own. */
export function opencodeDataDirOf(home: string): string {
  return opencodeDataDir(home, process.env, home === homedir());
}

/** Which of OpenCode's two schemas a database has, and its optional columns. */
export interface OpencodeSchema {
  /** `session_v2` and `session_message`; else `session` and `message`. */
  v2: boolean;
  /** The session table's name. */
  table: "session_v2" | "session";
  /** Its columns, to leave out a filter on one an older OpenCode lacks. */
  columns: ReadonlySet<string>;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function schemaOf(db: DatabaseSync): OpencodeSchema | null {
  const v2 = hasTable(db, "session_v2");
  if (!v2 && !hasTable(db, "session")) return null;
  const table = v2 ? "session_v2" : "session";
  const columns = new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
        name: unknown;
      }[]
    ).flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
  return { v2, table, columns };
}

/**
 * Run `read` against `dataDir`'s database, opened read-only.
 *
 * The answer is `fallback`, never thrown, for a database that is missing,
 * locked or of a schema this does not know: the schema is OpenCode's own.
 *
 * NOTE: `node:sqlite` is loaded HERE, not at the top: a runtime without it
 * costs OpenCode's rows, not main's start. Every value reaches a query bound,
 * never as SQL.
 */
export async function withOpencodeDb<T>(
  dataDir: string,
  fallback: T,
  read: (db: DatabaseSync, schema: OpencodeSchema) => T,
): Promise<T> {
  const file = join(dataDir, "opencode.db");
  if (!(await stat(file).catch(() => null))?.isFile()) return fallback;
  let db: DatabaseSync | null = null;
  try {
    const driver = await import("node:sqlite");
    db = new driver.DatabaseSync(file, { readOnly: true });
    const schema = schemaOf(db);
    return schema ? read(db, schema) : fallback;
  } catch {
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {
      // Closed already: nothing is held.
    }
  }
}

/** A finite number, or null. */
export const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function tidy(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** A title OpenCode gave, unless it is its placeholder; null otherwise. */
export function opencodeTitle(title: unknown): string | null {
  if (typeof title !== "string" || DEFAULT_TITLE.test(title)) return null;
  return tidy(title) || null;
}

/** The text of a `session_message` row of type `user`, or null. */
export function opencodePromptText(data: unknown): string | null {
  if (typeof data !== "string") return null;
  try {
    const text = (JSON.parse(data) as { text?: unknown }).text;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** What the rail calls a session: its title, else its first prompt. */
function titleOf(row: { title: unknown; prompt: unknown }): string | null {
  const title = opencodeTitle(row.title);
  if (title) return title;
  const prompt = opencodePromptText(row.prompt);
  return prompt ? tidy(prompt) : null;
}

/** The newest message that says where a turn stands, as SQL picks it apart. */
interface TurnRow {
  type: unknown;
  completed: unknown;
  finish: unknown;
  status: unknown;
}

/**
 * Whether session `id` has a turn open (FE-104), schema v2 only.
 *
 * From the newest `user`, `assistant`, `idle` or `compaction` message:
 *
 * - `idle`: OpenCode closed the turn. Not working.
 * - `user`: a prompt no answer has started on yet. Working.
 * - `assistant`: working while it has no `time.completed`, or when it
 *   finished on `tool-calls` (the next step's message comes next). Any other
 *   finish (`stop`, `length`, an error) ended the turn.
 * - `compaction`: working until its `status` is `completed`.
 *
 * And only when it was written within {@link STALE_MS}: an OpenCode killed
 * mid-turn never writes its end, as a Claude or a Codex killed does not.
 *
 * NOTE: The `system`, `synthetic` and `model-switched` rows say nothing of
 * the turn, and are passed over. An older OpenCode wrote no `idle`, which the
 * `assistant` rule covers.
 */
function turnOpen(db: DatabaseSync, id: string): boolean {
  const row = db
    .prepare(
      `SELECT type,
              json_extract(data, '$.time.completed') AS completed,
              json_extract(data, '$.finish') AS finish,
              json_extract(data, '$.status') AS status
         FROM session_message
        WHERE session_id = ?
          AND type IN ('user', 'assistant', 'idle', 'compaction')
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(id) as TurnRow | undefined;
  if (!row) return false;
  if (row.type === "user") return true;
  if (row.type === "compaction") return row.status !== "completed";
  if (row.type !== "assistant") return false;
  return row.completed == null || row.finish === "tool-calls";
}

/**
 * {@link turnOpen}, for a session last written at `updated` (epoch ms).
 *
 * @param compacting `time_compacting`: set while OpenCode compacts it.
 */
export function opencodeWorking(
  db: DatabaseSync,
  schema: OpencodeSchema,
  id: string,
  updated: number,
  compacting: unknown = null,
): boolean {
  // NOTE: The legacy schema keeps its turns in `message` and `part`, with no
  // word on whether one is open: never working.
  if (!schema.v2 || Date.now() - updated > STALE_MS) return false;
  if (num(compacting) !== null) return true;
  try {
    return turnOpen(db, id);
  } catch {
    return false;
  }
}

/** A sub-agent row of {@link subagentsOf}. */
interface ChildRow {
  id: unknown;
  root: unknown;
  title: unknown;
  agent: unknown;
  updated: unknown;
  compacting: unknown;
}

/** A sub-agent's title, without the ` (@explore subagent)` OpenCode adds. */
export function opencodeSubagentTitle(title: unknown): string | null {
  const named = opencodeTitle(title);
  return named ? named.replace(SUBAGENT_SUFFIX, "").trim() || null : null;
}

/**
 * The sessions spawned under each of `roots`, newest first, by root.
 *
 * Nested ones are flattened under the conversation at the root (FE-33/D6),
 * through every level of `parent_id`.
 */
export function opencodeChildren(
  db: DatabaseSync,
  schema: OpencodeSchema,
  roots: readonly string[],
  limit = SUBAGENT_LIMIT,
): Map<string, AgentSubagent[]> {
  const out = new Map<string, AgentSubagent[]>();
  if (roots.length === 0) return out;
  const t = schema.table;
  const compacting = schema.columns.has("time_compacting")
    ? "c.time_compacting"
    : "NULL";
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id, root) AS (
         SELECT id, parent_id FROM ${t}
          WHERE parent_id IN (${roots.map(() => "?").join(", ")})
         UNION ALL
         SELECT s.id, tree.root FROM ${t} s JOIN tree ON s.parent_id = tree.id
       )
       SELECT c.id AS id, tree.root AS root, c.title AS title,
              c.agent AS agent, c.time_updated AS updated,
              ${compacting} AS compacting
         FROM tree JOIN ${t} c ON c.id = tree.id
        ORDER BY c.time_updated DESC`,
    )
    .all(...roots) as unknown as ChildRow[];
  for (const row of rows) {
    if (typeof row.root !== "string") continue;
    if (!isAgentSessionIdOf("opencode", row.id)) continue;
    const siblings = out.get(row.root) ?? [];
    if (siblings.length >= limit) continue;
    const updated = num(row.updated) ?? 0;
    siblings.push({
      id: row.id,
      title: opencodeSubagentTitle(row.title) ?? "Sub-agent",
      type: typeof row.agent === "string" && row.agent ? row.agent : null,
      updatedAt: new Date(updated).toISOString(),
      working: opencodeWorking(db, schema, row.id, updated, row.compacting),
    });
    out.set(row.root, siblings);
  }
  return out;
}

interface Row {
  id: unknown;
  title: unknown;
  updated: unknown;
  compacting: unknown;
  prompt: unknown;
}

/** The first prompt of each session, in the schema `db` has. */
function query(schema: OpencodeSchema, where: string): string {
  const archived = schema.columns.has("time_archived")
    ? "AND s.time_archived IS NULL"
    : "";
  const compacting = schema.columns.has("time_compacting")
    ? "s.time_compacting"
    : "NULL";
  return schema.v2
    ? `SELECT s.id AS id, s.title AS title, s.time_updated AS updated,
              ${compacting} AS compacting,
              (SELECT m.data FROM session_message m
                WHERE m.session_id = s.id AND m.type = 'user'
                ORDER BY m.seq LIMIT 1) AS prompt
         FROM session_v2 s
        WHERE s.directory = ? AND s.parent_id IS NULL ${archived} ${where}
        ORDER BY s.time_updated DESC`
    : `SELECT s.id AS id, s.title AS title, s.time_updated AS updated,
              ${compacting} AS compacting, NULL AS prompt
         FROM session s
        WHERE s.directory = ? AND s.parent_id IS NULL ${archived} ${where}
        ORDER BY s.time_updated DESC`;
}

/**
 * `folder`'s newest OpenCode conversations, top-level only, each with the
 * sessions it spawned as its sub-agents (FE-104).
 *
 * At most `limit`, plus every one in `keep` (`opencode:<id>`): the pinned
 * ones stay however old they are (FE-25/D1). One archived in OpenCode
 * (`time_archived`) is not listed, as OpenCode's own list leaves it out.
 *
 * The answer is empty, never thrown, for a database that is missing, locked
 * or of a schema this does not know.
 *
 * NOTE: No `card`: OpenCode's MCP calls are rows of its database, not lines
 * of a transcript `transcriptCard` can read.
 */
export function opencodeSessions(
  dataDir: string,
  folder: string,
  keep: ReadonlySet<string>,
  limit: number,
): Promise<AgentSession[]> {
  return withOpencodeDb(dataDir, [] as AgentSession[], (db, schema) => {
    // A few spare, for the ones that turn out untitled and empty.
    const newest = db
      .prepare(`${query(schema, "")} LIMIT ?`)
      .all(folder, limit * 2) as unknown as Row[];
    const pinned = [...keep]
      .filter((key) => key.startsWith("opencode:"))
      .map((key) => key.slice("opencode:".length))
      .filter((id) => isAgentSessionIdOf("opencode", id))
      .filter((id) => !newest.some((row) => row.id === id));
    const kept =
      pinned.length > 0
        ? (db
            .prepare(
              query(
                schema,
                `AND s.id IN (${pinned.map(() => "?").join(", ")})`,
              ),
            )
            .all(folder, ...pinned) as unknown as Row[])
        : [];
    const picked: { row: Row & { id: string }; title: string }[] = [];
    for (const row of [...newest, ...kept]) {
      if (!isAgentSessionIdOf("opencode", row.id)) continue;
      if (picked.length >= limit && !keep.has(`opencode:${row.id}`)) continue;
      const title = titleOf(row);
      // Never typed into: nothing to go back to, as Codex's unwritten ones.
      if (!title) continue;
      picked.push({ row: row as Row & { id: string }, title });
    }
    let children = new Map<string, AgentSubagent[]>();
    try {
      children = opencodeChildren(
        db,
        schema,
        picked.map(({ row }) => row.id),
      );
    } catch {
      // A schema without `parent_id` or `agent`: rows without sub-agents.
    }
    return picked.map(({ row, title }): AgentSession => {
      const updated = num(row.updated) ?? 0;
      return {
        id: row.id,
        agent: "opencode",
        title,
        cliTitle: title,
        updatedAt: new Date(updated).toISOString(),
        pinnedAt: null,
        conductor: null,
        working: opencodeWorking(db, schema, row.id, updated, row.compacting),
        card: null,
        subagents: children.get(row.id) ?? [],
        // OpenCode keeps no background tasks of the kind Claude does.
        background: { running: 0, total: 0 },
      };
    });
  });
}

/** A session of {@link opencodeSessionIn}. */
export interface OpencodeSessionRow {
  id: string;
  /** Its parent's id; null for a conversation of its own. */
  parent: string | null;
  title: string | null;
  agent: string | null;
  /** `{ id, providerID, variant? }` as OpenCode stores it, parsed; or null. */
  model: Record<string, unknown> | null;
  created: number;
  updated: number;
  working: boolean;
  /** The row's own numbers, as OpenCode totals them. */
  cost: number | null;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
  additions: number | null;
  deletions: number | null;
}

/**
 * Session `id`, when it is one of `folder`'s, read inside `db`.
 *
 * NOTE: The folder is the session's own `directory`: a sub-agent passes when
 * it was spawned there, whatever its parent says.
 *
 * @returns null when there is no such session in `folder`.
 */
export function opencodeSessionIn(
  db: DatabaseSync,
  schema: OpencodeSchema,
  folder: string,
  id: string,
): OpencodeSessionRow | null {
  if (!isAgentSessionIdOf("opencode", id)) return null;
  const has = (column: string) =>
    schema.columns.has(column) ? `s.${column}` : "NULL";
  const row = db
    .prepare(
      `SELECT s.id AS id, s.parent_id AS parent, s.title AS title,
              ${has("agent")} AS agent, ${has("model")} AS model,
              s.time_created AS created, s.time_updated AS updated,
              ${has("time_compacting")} AS compacting,
              ${has("cost")} AS cost,
              ${has("tokens_input")} AS input,
              ${has("tokens_output")} AS output,
              ${has("tokens_reasoning")} AS reasoning,
              ${has("tokens_cache_read")} AS cache_read,
              ${has("tokens_cache_write")} AS cache_write,
              ${has("summary_additions")} AS additions,
              ${has("summary_deletions")} AS deletions
         FROM ${schema.table} s
        WHERE s.id = ? AND s.directory = ?`,
    )
    .get(id, folder) as Record<string, unknown> | undefined;
  if (!row) return null;
  let model: Record<string, unknown> | null = null;
  if (typeof row.model === "string") {
    try {
      const parsed = JSON.parse(row.model) as unknown;
      if (parsed && typeof parsed === "object")
        model = parsed as Record<string, unknown>;
    } catch {
      // Not JSON: no model to name.
    }
  }
  const updated = num(row.updated) ?? 0;
  const input = num(row.input);
  return {
    id,
    parent: typeof row.parent === "string" ? row.parent : null,
    title: typeof row.title === "string" ? row.title : null,
    agent: typeof row.agent === "string" && row.agent ? row.agent : null,
    model,
    created: num(row.created) ?? updated,
    updated,
    working: opencodeWorking(db, schema, id, updated, row.compacting),
    cost: num(row.cost),
    tokens:
      input === null
        ? null
        : {
            input,
            output: num(row.output) ?? 0,
            reasoning: num(row.reasoning) ?? 0,
            cacheRead: num(row.cache_read) ?? 0,
            cacheWrite: num(row.cache_write) ?? 0,
          },
    additions: num(row.additions),
    deletions: num(row.deletions),
  };
}

/**
 * Whether `id` is a top-level conversation of `folder`'s in OpenCode's
 * database: the one check a delete makes before it asks OpenCode.
 */
export function opencodeOwns(
  dataDir: string,
  folder: string,
  id: string,
): Promise<boolean> {
  return withOpencodeDb(dataDir, false, (db, schema) => {
    const row = opencodeSessionIn(db, schema, folder, id);
    return row !== null && row.parent === null;
  });
}

/** One session of `folder`'s written since a watch last looked. */
export interface OpencodeChange {
  id: string;
  /** The conversation at its root; null for a conversation itself. */
  root: string | null;
  updated: number;
  working: boolean;
  /** Its newest message is an `idle` OpenCode wrote as `succeeded`. */
  succeeded: boolean;
}

/**
 * `folder`'s sessions written at or after `since` (epoch ms), sub-agents
 * with the conversation at their root: what the activity watch reports.
 */
export function opencodeChanges(
  dataDir: string,
  folder: string,
  since: number,
): Promise<OpencodeChange[]> {
  return withOpencodeDb(dataDir, [] as OpencodeChange[], (db, schema) => {
    const t = schema.table;
    const compacting = schema.columns.has("time_compacting")
      ? "s.time_compacting"
      : "NULL";
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.parent_id AS parent, s.time_updated AS updated,
                ${compacting} AS compacting
           FROM ${t} s
          WHERE s.directory = ? AND s.time_updated >= ?
          ORDER BY s.time_updated DESC
          LIMIT 64`,
      )
      .all(folder, since) as unknown as Record<string, unknown>[];
    const rootOf = db.prepare(
      `SELECT parent_id AS parent FROM ${t} WHERE id = ?`,
    );
    const out: OpencodeChange[] = [];
    for (const row of rows) {
      if (!isAgentSessionIdOf("opencode", row.id)) continue;
      // Up to the conversation at the root, a few levels at most.
      let root: string | null = null;
      let parent = typeof row.parent === "string" ? row.parent : null;
      for (let depth = 0; parent && depth < 8; depth++) {
        root = parent;
        const up = rootOf.get(parent) as { parent?: unknown } | undefined;
        parent = typeof up?.parent === "string" ? up.parent : null;
      }
      if (root !== null && !isAgentSessionIdOf("opencode", root)) continue;
      const updated = num(row.updated) ?? 0;
      const working = opencodeWorking(
        db,
        schema,
        row.id,
        updated,
        row.compacting,
      );
      let succeeded = false;
      if (!working && schema.v2) {
        const last = db
          .prepare(
            `SELECT type, json_extract(data, '$.outcome') AS outcome,
                    json_extract(data, '$.finish') AS finish
               FROM session_message
              WHERE session_id = ?
                AND type IN ('user', 'assistant', 'idle')
              ORDER BY seq DESC LIMIT 1`,
          )
          .get(row.id) as Record<string, unknown> | undefined;
        succeeded =
          (last?.type === "idle" && last.outcome === "succeeded") ||
          (last?.type === "assistant" && last.finish === "stop");
      }
      out.push({ id: row.id, root, updated, working, succeeded });
    }
    return out;
  });
}
