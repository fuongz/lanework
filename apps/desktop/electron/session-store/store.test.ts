// Run with `bun test apps/desktop/electron/session-store`. Written against
// `node:test`/`node:assert`, as `local-store/store.test.ts` is, so the
// desktop typecheck needs no Bun types.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { openDatabase } from "../local-store/driver";
import { sessionStorePath } from "../main/paths";
import {
  migrate,
  openSessionStore,
  SCHEMA_VERSION,
  type SessionStore,
  SessionStoreError,
  type SessionUpsert,
  sessionKey,
  userVersion,
} from "./index";

let home: string;
const previousHome = process.env.LANEWORK_HOME;
const opened: SessionStore[] = [];

function open(path?: string): SessionStore {
  const store = openSessionStore(path ? { path } : {});
  opened.push(store);
  return store;
}

/** A UUID-shaped conversation id, numbered for the reader. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** `n` minutes past a fixed hour, ISO. */
function at(n: number): string {
  return new Date(Date.UTC(2026, 9, 31, 10, n)).toISOString();
}

function session(n: number, extra: Partial<SessionUpsert> = {}): SessionUpsert {
  return {
    agent: "claude",
    id: uuid(n),
    project: "proj-a",
    folder: "/work/a",
    cliTitle: `cli ${n}`,
    updatedAt: at(n),
    ...extra,
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof SessionStoreError) return error.code;
    throw error;
  }
  return undefined;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "lanework-session-store-"));
  process.env.LANEWORK_HOME = home;
});

after(() => {
  for (const store of opened) store.close();
  if (previousHome === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("open + migrate", () => {
  test("creates <LANEWORK_HOME>/lw.db 0600 in WAL, migrated to the current version", () => {
    assert.equal(sessionStorePath(), join(home, "lw.db"));
    assert.equal(existsSync(sessionStorePath()), false);
    const store = open();
    assert.equal(store.path, join(home, "lw.db"));
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.equal(userVersion(store.db), SCHEMA_VERSION);
    const tables = store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, ["agent_session", "agent_subagent"]);
    const mode = store.db.prepare("PRAGMA journal_mode").get();
    assert.equal(String(mode?.journal_mode).toLowerCase(), "wal");
    const timeout = store.db.prepare("PRAGMA busy_timeout").get();
    assert.equal(Number(Object.values(timeout ?? {})[0]), 5000);
    const keys = store.db.prepare("PRAGMA foreign_keys").get();
    assert.equal(Number(keys?.foreign_keys), 1);
  });

  test("a new folder is 0700", () => {
    const path = join(home, "fresh", "lw.db");
    open(path);
    assert.equal(statSync(join(home, "fresh")).mode & 0o777, 0o700);
  });

  test("re-opening a migrated file is a no-op, and a newer file is refused", () => {
    const path = join(home, "newer.db");
    const first = open(path);
    assert.equal(migrate(first.db), SCHEMA_VERSION);
    first.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    const raw = openDatabase(path);
    try {
      assert.throws(() => migrate(raw), /newer than this build/);
    } finally {
      raw.close();
    }
  });

  test("the rail's query reads the covering index only", () => {
    const store = open(join(home, "plan.db"));
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT key, cli_title FROM agent_session
          WHERE project = ? AND archived_at IS NULL
            AND pinned_at IS NULL AND conductor_id IS NULL
          ORDER BY updated_at DESC LIMIT ?`,
      )
      .all("proj-a", 20)
      .map((row) => String(row.detail))
      .join("\n");
    assert.match(plan, /COVERING INDEX agent_session_rail/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
  });
});

describe("upsert", () => {
  test("adds a row, then updates the CLI's fields and keeps every mark", () => {
    const store = open(join(home, "upsert.db"));
    const key = sessionKey("claude", uuid(1));
    store.upsertSession(
      session(1, {
        origin: "lanework",
        createdAt: at(0),
        working: true,
        card: { boardId: "board", card: "FE-112" },
        background: { running: 1, total: 2 },
        sourcePath: "/cli/1.jsonl",
      }),
    );
    assert.equal(store.setName(key, "Mine"), true);
    assert.equal(store.setPinned(key, true, 111), true);
    assert.equal(
      store.setConductor(key, { id: "lead", project: "proj-a" }),
      true,
    );

    store.upsertSession(
      session(1, {
        origin: "pulled",
        createdAt: at(30),
        cliTitle: "renamed by the CLI",
        updatedAt: at(5),
        card: null,
      }),
    );
    const row = store.getSession(key);
    assert.ok(row);
    assert.equal(row.cliTitle, "renamed by the CLI");
    assert.equal(row.updatedAt, at(5));
    // Marks are never a CLI write's to change.
    assert.equal(row.name, "Mine");
    assert.equal(row.pinnedAt, 111);
    assert.deepEqual(row.conductor, { id: "lead", project: "proj-a" });
    assert.equal(row.archivedAt, null);
    // Neither is where it came from, nor when it began.
    assert.equal(row.origin, "lanework");
    assert.equal(row.createdAt, at(0));
    // Left out keeps, null clears.
    assert.equal(row.working, true);
    assert.deepEqual(row.background, { running: 1, total: 2 });
    assert.equal(row.sourcePath, "/cli/1.jsonl");
    assert.equal(row.card, null);

    assert.equal(store.setArchived(key, true, at(9)), true);
    store.upsertSession(session(1, { updatedAt: at(10) }));
    const archived = store.getSession(key);
    assert.equal(archived?.archivedAt, at(9));
    // Archiving dropped the pin and kept the name (FE-72/D3).
    assert.equal(archived?.pinnedAt, null);
    assert.equal(archived?.name, "Mine");
  });

  test("refuses an id no CLI writes, and a row with no project", () => {
    const store = open(join(home, "refuse.db"));
    assert.equal(
      code(() => store.upsertSession(session(1, { id: "x; rm -rf ~" }))),
      "invalid",
    );
    assert.equal(
      code(() =>
        store.upsertSession(session(1, { agent: "opencode", id: uuid(1) })),
      ),
      "invalid",
    );
    assert.equal(
      code(() => store.upsertSession(session(1, { project: "" }))),
      "invalid",
    );
    store.upsertSession(
      session(1, { agent: "opencode", id: "ses_0123456789abcdefghijABCDEF" }),
    );
    assert.equal(
      store.hasSession("opencode:ses_0123456789abcdefghijABCDEF"),
      true,
    );
  });

  test("one conductor per project: binding another lets the first go", () => {
    const store = open(join(home, "conductor.db"));
    store.upsertSession(session(1));
    store.upsertSession(session(2));
    const first = sessionKey("claude", uuid(1));
    const second = sessionKey("claude", uuid(2));
    store.setConductor(first, { id: "lead", project: "proj-a" });
    store.setConductor(second, { id: "lead", project: "proj-a" });
    assert.equal(store.getSession(first)?.conductor, null);
    assert.deepEqual(store.getSession(second)?.conductor, {
      id: "lead",
      project: "proj-a",
    });
    assert.equal(
      code(() => store.setConductor(first, { id: "Not A Lead", project: "p" })),
      "invalid",
    );
    assert.equal(
      store.setConductor(sessionKey("claude", uuid(9)), null),
      false,
    );
  });
});

describe("listRail", () => {
  test("pinned and conductor rows, then the newest `limit`, newest first", () => {
    const store = open(join(home, "rail.db"));
    for (let n = 1; n <= 6; n += 1) store.upsertSession(session(n));
    store.upsertSession(session(7, { project: "proj-b" }));
    store.upsertSession(
      session(8, { agent: "codex", cliTitle: "codex 8", updatedAt: at(8) }),
    );
    const key = (n: number) => sessionKey("claude", uuid(n));

    store.setPinned(key(1), true, 1);
    store.setConductor(key(2), { id: "lead", project: "proj-a" });
    store.setName(key(5), "Named");
    // The newest of all, archived: never listed.
    store.setArchived(key(6), true);
    store.setSubagents(key(5), [
      {
        id: "a1",
        title: "older",
        type: null,
        updatedAt: at(1),
        working: false,
      },
      {
        id: "a2",
        title: "newer",
        type: "Explore",
        updatedAt: at(2),
        working: true,
      },
    ]);

    const rail = store.listRail("proj-a", 2);
    assert.deepEqual(
      rail.map((entry) => `${entry.agent}:${entry.id}`),
      [sessionKey("codex", uuid(8)), key(5), key(2), key(1)],
    );
    const named = rail.find((entry) => entry.id === uuid(5));
    assert.equal(named?.title, "Named");
    assert.equal(named?.cliTitle, "cli 5");
    assert.deepEqual(
      named?.subagents.map((sub) => [sub.id, sub.type, sub.working]),
      [
        ["a2", "Explore", true],
        ["a1", null, false],
      ],
    );
    const pinned = rail.find((entry) => entry.id === uuid(1));
    assert.equal(pinned?.pinnedAt, 1);
    assert.equal(pinned?.title, "cli 1");
    assert.equal(rail.find((entry) => entry.id === uuid(2))?.conductor, "lead");
    assert.deepEqual(rail[0]?.background, { running: 0, total: 0 });

    assert.deepEqual(
      store.listRail("proj-b").map((entry) => entry.id),
      [uuid(7)],
    );
    assert.deepEqual(store.listRail("proj-none"), []);
  });
});

describe("ingest + remove", () => {
  test("saves the read position with the fields it found, and a new path starts over", () => {
    const store = open(join(home, "ingest.db"));
    const key = sessionKey("claude", uuid(1));
    assert.equal(store.getIngestState(key), null);
    assert.equal(
      store.saveIngest(key, { size: 1, mtime: 1, offset: 1, state: null }),
      false,
    );
    store.upsertSession(session(1, { sourcePath: "/cli/1.jsonl" }));
    assert.deepEqual(store.getIngestState(key), {
      path: "/cli/1.jsonl",
      size: null,
      mtime: null,
      offset: null,
      state: null,
    });
    store.setName(key, "Kept");
    assert.equal(
      store.saveIngest(key, {
        size: 2048,
        mtime: 1_700_000_000_000,
        offset: 2000,
        state: { turn: "open" },
        fields: { working: true, updatedAt: at(9) },
      }),
      true,
    );
    assert.deepEqual(store.getIngestState<{ turn: string }>(key), {
      path: "/cli/1.jsonl",
      size: 2048,
      mtime: 1_700_000_000_000,
      offset: 2000,
      state: { turn: "open" },
    });
    const row = store.getSession(key);
    assert.equal(row?.working, true);
    assert.equal(row?.updatedAt, at(9));
    assert.equal(row?.name, "Kept");

    store.upsertSession(session(1, { sourcePath: "/cli/moved.jsonl" }));
    assert.deepEqual(store.getIngestState(key), {
      path: "/cli/moved.jsonl",
      size: null,
      mtime: null,
      offset: null,
      state: null,
    });
  });

  test("removing a row takes its sub-agents with it", () => {
    const store = open(join(home, "remove.db"));
    const key = sessionKey("claude", uuid(1));
    store.upsertSession(session(1));
    store.setSubagents(key, [
      { id: "a1", title: "t", type: null, updatedAt: at(1), working: false },
    ]);
    assert.equal(store.removeSession(key), true);
    assert.equal(store.hasSession(key), false);
    const left = store.db
      .prepare("SELECT COUNT(*) AS n FROM agent_subagent")
      .get();
    assert.equal(Number(left?.n), 0);
    assert.equal(store.removeSession(key), false);
  });
});

describe("importLegacyMarks", () => {
  test("stubs the unknown, fills the known, and never undoes a newer mark", () => {
    const store = open(join(home, "import.db"));
    const known = sessionKey("claude", uuid(1));
    const renamed = sessionKey("claude", uuid(2));
    const stub = sessionKey("codex", uuid(3));
    const conductorTaken = sessionKey("claude", uuid(4));
    store.upsertSession(session(1));
    store.upsertSession(session(2));
    store.upsertSession(session(4));
    store.upsertSession(session(5));
    store.setName(renamed, "Newer");
    store.setConductor(sessionKey("claude", uuid(5)), {
      id: "lead",
      project: "proj-a",
    });

    const count = store.importLegacyMarks({
      [known]: { name: "Old name", pinnedAt: 42 },
      [renamed]: { name: "Legacy" },
      [stub]: { pinnedAt: 7, conductor: { id: "other", project: "proj-a" } },
      [conductorTaken]: { conductor: { id: "lead", project: "proj-a" } },
      "claude:not-a-uuid": { name: "skipped" },
      "shell:whatever": { name: "skipped" },
      [sessionKey("claude", uuid(6))]: {},
    });
    assert.equal(count, 4);

    assert.equal(store.getSession(known)?.name, "Old name");
    assert.equal(store.getSession(known)?.pinnedAt, 42);
    assert.equal(store.getSession(renamed)?.name, "Newer");
    // Another row holds `lead` in proj-a already.
    assert.equal(store.getSession(conductorTaken)?.conductor, null);
    assert.equal(store.hasSession(sessionKey("claude", uuid(6))), false);

    const stubbed = store.getSession(stub);
    assert.equal(stubbed?.origin, "pulled");
    assert.equal(stubbed?.project, null);
    assert.equal(stubbed?.sourcePath, null);
    assert.equal(stubbed?.pinnedAt, 7);
    assert.deepEqual(stubbed?.conductor, { id: "other", project: "proj-a" });
    // No project yet: on no rail until a Pull fills it.
    assert.equal(
      store.listRail("proj-a").some((entry) => entry.id === uuid(3)),
      false,
    );

    // The Pull that finds it fills it in, marks kept, its own start taken.
    store.upsertSession(
      session(3, {
        agent: "codex",
        createdAt: at(1),
        sourcePath: "/codex/3.jsonl",
      }),
    );
    const filled = store.getSession(stub);
    assert.equal(filled?.project, "proj-a");
    assert.equal(filled?.createdAt, at(1));
    assert.equal(filled?.origin, "pulled");
    assert.equal(filled?.pinnedAt, 7);
    assert.equal(
      store.listRail("proj-a").some((entry) => entry.id === uuid(3)),
      true,
    );

    // Again: the store's own marks still win.
    store.importLegacyMarks({ [renamed]: { name: "Legacy" } });
    assert.equal(store.getSession(renamed)?.name, "Newer");
  });
});
