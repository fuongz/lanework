import type { SqlDatabase } from "./driver";

/**
 * The local board's schema, one migration per `PRAGMA user_version`.
 *
 * ⚠️ Append only. A migration that shipped is never edited: a machine that
 * already ran it will not run it again, so an edit would split the installed
 * base into two schemas that both claim the same version. Add the next one.
 *
 * ⚠️ JSON columns hold `@lanework/protocol` shapes (`ChecklistItem[]`,
 * `Stream[]`, `Checkpoint[]`), so pushing a local card to the cloud later is a
 * copy, not a translation.
 */
export const MIGRATIONS: readonly string[] = [
  // 1 — workspace + work_item + meta (FE-52, D3).
  `
  CREATE TABLE workspace (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    repo_url    TEXT,
    config      TEXT NOT NULL DEFAULT '{}',
    task_heads  TEXT NOT NULL DEFAULT '{}',
    cloud_id    TEXT,
    synced_at   TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  );
  CREATE UNIQUE INDEX workspace_slug_live ON workspace(slug) WHERE deleted_at IS NULL;
  CREATE INDEX workspace_repo ON workspace(repo_url) WHERE deleted_at IS NULL;

  CREATE TABLE work_item (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspace(id),
    parent_id     TEXT REFERENCES work_item(id),
    task_id       TEXT,
    task_seq      INTEGER,
    category      TEXT,
    type          TEXT NOT NULL DEFAULT 'issue',
    title         TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL,
    priority      TEXT,
    tags          TEXT NOT NULL DEFAULT '[]',
    checklist     TEXT NOT NULL DEFAULT '[]',
    streams       TEXT NOT NULL DEFAULT '[]',
    checkpoint    TEXT,
    sort_key      TEXT NOT NULL,
    revision      INTEGER NOT NULL DEFAULT 1,
    change_seq    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT,
    cloud_id      TEXT
  );
  CREATE UNIQUE INDEX work_item_task_id ON work_item(workspace_id, task_id) WHERE task_id IS NOT NULL;
  CREATE INDEX work_item_lane ON work_item(workspace_id, status, sort_key);
  CREATE INDEX work_item_changes ON work_item(workspace_id, change_seq);
  CREATE INDEX work_item_parent ON work_item(parent_id);

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  INSERT INTO meta(key, value) VALUES ('change_seq', '0');
  `,
];

/** The version a fully migrated database reports. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export function userVersion(db: SqlDatabase): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}

/**
 * Brings the file up to `SCHEMA_VERSION`.
 *
 * ⚠️ Under `BEGIN IMMEDIATE`, re-reading the version INSIDE the lock: the app,
 * an MCP server and a hook can all open a fresh file at the same moment, and
 * the loser must find the work done rather than run `CREATE TABLE` twice.
 * Refuses a file newer than this build — downgrading the app must not quietly
 * write rows an older schema cannot describe.
 */
export function migrate(db: SqlDatabase): number {
  if (userVersion(db) === SCHEMA_VERSION) return SCHEMA_VERSION;
  db.exec("BEGIN IMMEDIATE");
  try {
    const from = userVersion(db);
    if (from > SCHEMA_VERSION)
      throw new Error(
        `local store is at schema ${from}, newer than this build (${SCHEMA_VERSION})`,
      );
    for (let version = from; version < SCHEMA_VERSION; version += 1) {
      db.exec(MIGRATIONS[version] as string);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return SCHEMA_VERSION;
}
