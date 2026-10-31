import type { SqlDatabase } from "../local-store/driver";
import { userVersion } from "../local-store/schema";

/**
 * Lanework's session store schema, one migration per `PRAGMA user_version`.
 *
 * NOTE: Append only, as the local board's (`local-store/schema.ts`). A
 * migration that shipped is never edited; add the next one.
 *
 * NOTE: `key` is `agent:id`, the key the rail and the marks have always used,
 * so a conversation is one row however many projects list its folder.
 */
const MIGRATIONS: readonly string[] = [
  // 1: agent_session + agent_subagent (FE-112).
  `
  CREATE TABLE agent_session (
    key                TEXT PRIMARY KEY,
    agent              TEXT NOT NULL,
    cli_id             TEXT NOT NULL,
    project            TEXT,
    folder             TEXT,
    cli_title          TEXT NOT NULL DEFAULT '',
    name               TEXT,
    origin             TEXT NOT NULL CHECK (origin IN ('lanework', 'pulled')),
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    pinned_at          INTEGER,
    conductor_id       TEXT,
    conductor_project  TEXT,
    archived_at        TEXT,
    working            INTEGER NOT NULL DEFAULT 0,
    card_board         TEXT,
    card_id            TEXT,
    bg_running         INTEGER NOT NULL DEFAULT 0,
    bg_total           INTEGER NOT NULL DEFAULT 0,
    source_path        TEXT,
    source_size        INTEGER,
    source_mtime       INTEGER,
    source_offset      INTEGER,
    ingest_state       TEXT
  );
  CREATE INDEX agent_session_rail ON agent_session(
    project, archived_at, pinned_at, updated_at DESC,
    conductor_id, key, agent, cli_id, cli_title, name,
    working, card_board, card_id, bg_running, bg_total
  );
  CREATE UNIQUE INDEX agent_session_conductor
    ON agent_session(conductor_id, conductor_project)
    WHERE conductor_id IS NOT NULL;

  CREATE TABLE agent_subagent (
    session_key  TEXT NOT NULL REFERENCES agent_session(key) ON DELETE CASCADE,
    sub_id       TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    type         TEXT,
    updated_at   TEXT NOT NULL,
    working      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_key, sub_id)
  );
  `,
];

/** The version a fully migrated database reports. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Bring the file up to {@link SCHEMA_VERSION}.
 *
 * NOTE: Under `BEGIN IMMEDIATE`, the version re-read inside the lock, as the
 * local board migrates: two windows opening a fresh file at once must not
 * both run `CREATE TABLE`.
 *
 * @returns The version the file is at now.
 * @throws When the file is newer than this build.
 */
export function migrate(db: SqlDatabase): number {
  if (userVersion(db) === SCHEMA_VERSION) return SCHEMA_VERSION;
  db.exec("BEGIN IMMEDIATE");
  try {
    const from = userVersion(db);
    if (from > SCHEMA_VERSION)
      throw new Error(
        `session store is at schema ${from}, newer than this build (${SCHEMA_VERSION})`,
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
