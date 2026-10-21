import { createRequire } from "node:module";
import { join } from "node:path";

// The one seam between the store and a SQLite binding.
//
// Production is `node:sqlite` (Electron 44 ships Node 24): no native module
// to rebuild per Electron ABI, and the same binding in the main process, the
// MCP entry and the checkpoint hook.
//
// NOTE: `bun test` has no `node:sqlite`, so under Bun, and only under Bun,
// the store opens `bun:sqlite` instead. Both are the same SQLite with the
// same file format and locking. The store speaks only positional `?`
// parameters and plain `exec`/`prepare`, the subset where the two bindings
// agree.
//
// NOTE: Neither binding is imported statically. A static `node:sqlite` import
// breaks `bun test` at load time, and a static `bun:sqlite` import breaks
// every esbuild bundle of the main process. `process.getBuiltinModule` and a
// runtime-built `require` are both opaque to the bundler.

export type SqlValue = string | number | bigint | null;

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number | bigint };
  /** The row, or `undefined` when there is none, from either binding. */
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

interface RawStatement {
  run(...params: SqlValue[]): { changes: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

interface RawDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): RawStatement;
  close(): void;
}

/** Which binding this process gets. */
function sqliteDriverName(): "node:sqlite" | "bun:sqlite" {
  return "Bun" in globalThis ? "bun:sqlite" : "node:sqlite";
}

function openRaw(path: string): RawDatabase {
  if (sqliteDriverName() === "bun:sqlite") {
    const load = createRequire(join(process.cwd(), "noop.js"));
    const { Database } = load("bun:sqlite") as {
      Database: new (
        path: string,
        options?: { create?: boolean },
      ) => RawDatabase;
    };
    return new Database(path, { create: true });
  }
  const sqlite = process.getBuiltinModule("node:sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (!sqlite)
    throw new Error(
      "node:sqlite is not available in this runtime (needs Node 22.5 or later)",
    );
  return new sqlite.DatabaseSync(path) as unknown as RawDatabase;
}

/**
 * Open the database file at `path`, creating it when absent.
 *
 * Prepared statements are cached by their SQL until the database closes.
 */
export function openDatabase(path: string): SqlDatabase {
  const raw = openRaw(path);
  const cache = new Map<string, SqlStatement>();
  return {
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      const cached = cache.get(sql);
      if (cached) return cached;
      const statement = raw.prepare(sql);
      const wrapped: SqlStatement = {
        run: (...params) => statement.run(...params),
        get: (...params) =>
          (statement.get(...params) ?? undefined) as
            | Record<string, unknown>
            | undefined,
        all: (...params) =>
          statement.all(...params) as Record<string, unknown>[],
      };
      cache.set(sql, wrapped);
      return wrapped;
    },
    close() {
      cache.clear();
      raw.close();
    },
  };
}
