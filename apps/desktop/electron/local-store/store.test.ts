// Run with `bun test apps/desktop/electron/local-store`. Written against
// `node:test`/`node:assert` (which Bun implements) so the desktop typecheck
// needs no Bun types. Under Bun the store runs on `bun:sqlite` (see
// `driver.ts`).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  type LocalStore,
  LocalStoreError,
  localStorePath,
  migrate,
  openDatabase,
  openLocalStore,
  SCHEMA_VERSION,
  userVersion,
} from "./index";

let home: string;
const previousHome = process.env.LANEWORK_HOME;
const opened: LocalStore[] = [];

function open(path?: string): LocalStore {
  const store = openLocalStore(path ? { path } : {});
  opened.push(store);
  return store;
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof LocalStoreError) return error.code;
    throw error;
  }
  return undefined;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "lanework-local-store-"));
  process.env.LANEWORK_HOME = home;
});

after(() => {
  for (const store of opened) store.close();
  if (previousHome === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("open + migrate", () => {
  test("creates <LANEWORK_HOME>/data.sqlite and migrates an empty file to the current version", () => {
    assert.equal(localStorePath(), join(home, "data.sqlite"));
    assert.equal(existsSync(localStorePath()), false);
    const store = open();
    assert.equal(store.path, join(home, "data.sqlite"));
    assert.equal(existsSync(store.path), true);
    assert.equal(userVersion(store.db), SCHEMA_VERSION);
    assert.ok(SCHEMA_VERSION >= 1);
    const tables = store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, ["meta", "project_issues", "projects"]);
    const mode = store.db.prepare("PRAGMA journal_mode").get();
    assert.equal(String(mode?.journal_mode).toLowerCase(), "wal");
    const timeout = store.db.prepare("PRAGMA busy_timeout").get();
    assert.equal(Number(Object.values(timeout ?? {})[0]), 5000);
    assert.equal(store.dataVersion(), 0);
  });

  test("re-opening a migrated file is a no-op, and a newer file is refused", () => {
    const path = join(home, "newer.sqlite");
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
});

describe("projects", () => {
  test("create, slug, update, link repo, find by any remote spelling, tombstone", () => {
    const store = open(join(home, "ws.sqlite"));
    const a = store.createProject({
      name: "My Board",
      repo: "git@github.com:Fuongz/Lanework.git",
    });
    assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    assert.equal(a.slug, "my-board");
    assert.equal(a.repo, "github.com/fuongz/lanework");
    assert.deepEqual(
      a.config.columns.map((column) => column.key),
      ["backlog", "todo", "processing", "done", "dropped"],
    );
    assert.deepEqual(a.taskHeads, {});

    const b = store.createProject({ name: "My Board" });
    assert.equal(b.slug, "my-board-2");

    for (const remote of [
      "https://github.com/fuongz/lanework",
      "https://github.com/fuongz/lanework.git",
      "ssh://git@github.com/fuongz/lanework.git",
    ])
      assert.deepEqual(
        store.findProjectsByRepo(remote).map((project) => project.id),
        [a.id],
      );

    // A repo links to one board: linking it elsewhere moves it.
    store.linkRepo(b.id, "https://github.com/fuongz/lanework");
    assert.equal(store.getProject(a.id)?.repo, null);
    assert.deepEqual(
      store
        .boardSummaries("git@github.com:fuongz/lanework.git")
        .map((row) => row.workspaceId),
      [b.id],
    );
    assert.equal(
      code(() => store.linkRepo(a.id, "not a remote")),
      "invalid",
    );

    const renamed = store.updateProject(a.id, {
      name: "Renamed",
      slug: "renamed",
    });
    assert.equal(renamed.name, "Renamed");
    assert.equal(store.getProject("renamed")?.id, a.id);

    const config = store.boardConfig(a.id);
    assert.equal(config.workspaceId, a.id);
    assert.equal(
      config.categories.find((c) => c.key === "frontend")?.prefix,
      "FE",
    );

    store.deleteProject(a.id);
    assert.equal(store.getProject(a.id), null);
    assert.deepEqual(
      store.listProjects().map((w) => w.id),
      [b.id],
    );
    assert.equal(store.listProjects({ includeDeleted: true }).length, 2);
    // The slug of a tombstoned project is free again.
    assert.equal(
      store.createProject({ name: "x", slug: "renamed" }).slug,
      "renamed",
    );
    assert.equal(
      code(() => store.createWorkItem(a.id, { title: "t" })),
      "not_found",
    );
  });
});

describe("work items", () => {
  let store: LocalStore;
  let ws: string;
  before(() => {
    store = open(join(home, "items.sqlite"));
    ws = store.createProject({ name: "Items" }).id;
  });

  test("create lands in the intake lane, in order, with protocol shapes", () => {
    const one = store.createWorkItem(ws, {
      title: "  First  ",
      categoryKey: "frontend",
      priority: "high",
      tags: ["UI", "ui", "Local Mode"],
      checklist: [
        { text: "decide" },
        { key: "D1", text: "keyed" },
        { section: "verify", text: "prove" },
      ],
    });
    assert.equal(one.title, "First");
    assert.equal(one.columnKey, "backlog");
    assert.equal(one.type, "issue");
    assert.equal(one.revision, 1);
    assert.deepEqual(one.tags, ["ui", "local-mode"]);
    // A minted key skips the one the list already claims.
    assert.deepEqual(
      one.checklist.map((item) => item.key),
      ["D2", "D1", "V1"],
    );
    assert.deepEqual(one.checklistProgress, { done: 0, total: 3 });
    assert.equal(one.archivedAt, null);
    assert.deepEqual(one.streams, []);
    assert.equal(one.dispatch, null);

    const two = store.createWorkItem(ws, {
      title: "Second",
      columnKey: "todo",
    });
    const three = store.createWorkItem(ws, {
      title: "Third",
      columnKey: "todo",
    });
    const between = store.createWorkItem(ws, {
      title: "Between",
      columnKey: "todo",
      placement: { after: two.id },
    });
    assert.deepEqual(
      store.listWorkItems(ws, { column: "todo" }).map((card) => card.title),
      ["Second", "Between", "Third"],
    );
    assert.ok(between.rank > two.rank && between.rank < three.rank);

    assert.equal(
      code(() => store.createWorkItem(ws, { title: "" })),
      "invalid",
    );
    assert.equal(
      code(() => store.createWorkItem(ws, { title: "t", columnKey: "nope" })),
      "invalid",
    );
    assert.equal(
      code(() =>
        store.createWorkItem(ws, { title: "t", tags: ["a", "b", "c", "d"] }),
      ),
      "invalid",
    );
  });

  test("get by uuid or task id, update with revision, list filters", () => {
    const card = store.createWorkItem(ws, {
      title: "Edit me",
      categoryKey: "backend",
    });
    assert.equal(store.getWorkItem(card.id)?.title, "Edit me");
    assert.equal(
      store.getWorkItem(card.taskId as string, { project: ws })?.id,
      card.id,
    );
    assert.equal(
      store.getWorkItem((card.taskId as string).toLowerCase(), {
        project: ws,
      })?.id,
      card.id,
    );
    assert.equal(store.getWorkItem("BE-99", { project: ws }), null);

    const updated = store.updateWorkItem(
      card.id,
      { title: "Edited", body: "body", priority: "low", tags: ["x"] },
      { ifRevision: 1 },
    );
    assert.equal(updated.revision, 2);
    assert.equal(updated.title, "Edited");
    assert.equal(updated.priority, "low");
    assert.equal(
      code(() =>
        store.updateWorkItem(card.id, { title: "stale" }, { ifRevision: 1 }),
      ),
      "conflict",
    );

    assert.ok(
      store.listWorkItems(ws, { tag: "x" }).every((row) => row.id === card.id),
    );
    assert.deepEqual(
      store.listWorkItems(ws, { category: "backend" }).map((row) => row.id),
      [card.id],
    );
    const child = store.createWorkItem(ws, {
      title: "Child",
      parentId: card.id,
    });
    assert.deepEqual(
      store.listWorkItems(ws, { parent: card.id }).map((row) => row.id),
      [child.id],
    );
    assert.equal(
      code(() => store.updateWorkItem(card.id, { parentId: child.id })),
      "invalid",
    );
  });

  test("toggle checklist, set status, streams + dispatch", () => {
    const card = store.createWorkItem(ws, {
      title: "Plan",
      categoryKey: "frontend",
      streams: [
        { title: "Contract", goal: "g0", role: "implement", owns: ["a.ts"] },
        {
          title: "UI",
          goal: "g1",
          role: "implement",
          owns: ["ui/"],
          depends_on: ["W0"],
        },
      ],
      checklist: [
        { text: "pick", group: "g" },
        { section: "verify", text: "unit", stream: "W0" },
      ],
    });
    assert.deepEqual(
      card.streams.map((s) => s.key),
      ["W0", "W1"],
    );
    assert.deepEqual(card.dispatch?.waves, [["W0"], ["W1"]]);
    assert.match(card.dispatch?.briefs.W0 ?? "", /V1: unit/);

    const ticked = store.toggleChecklistItem(card.id, "D1", {
      checked: true,
      note: "yes",
    });
    const item = ticked.checklist.find((entry) => entry.key === "D1");
    assert.equal(item?.checked, true);
    assert.ok(item?.checkedAt);
    assert.equal(item?.note, "yes");
    assert.deepEqual(ticked.checklistProgress, { done: 1, total: 2 });
    assert.equal(
      code(() => store.toggleChecklistItem(card.id, "D9", { checked: true })),
      "not_found",
    );
    assert.equal(
      code(() => store.toggleChecklistItem(card.id, "D1", { stream: "W0" })),
      "invalid",
    );

    // Replacing the checklist keeps a tick the input does not mention.
    const replaced = store.updateWorkItem(card.id, {
      checklist: [{ key: "D1", text: "pick again" }, { text: "new" }],
    });
    assert.equal(replaced.checklist[0]?.checked, true);
    assert.equal(replaced.checklist[1]?.key, "D2");

    assert.equal(
      code(() =>
        store.createWorkItem(ws, {
          title: "bad",
          streams: [
            { title: "a", goal: "a", role: "test", owns: ["x"] },
            { title: "b", goal: "b", role: "test", owns: ["x"] },
          ],
        }),
      ),
      "invalid",
    );

    const moved = store.setStatus(card.id, "processing");
    assert.equal(moved.columnKey, "processing");
    assert.equal(
      code(() => store.setStatus(card.id, "nowhere")),
      "invalid",
    );
  });

  test("checkpoints keep the newest 5, carry nextStep forward, clear on done", () => {
    const card = store.createWorkItem(ws, {
      title: "Cp",
      categoryKey: "frontend",
    });
    store.addCheckpoint(
      card.id,
      { summary: "first", nextStep: "do X" },
      { agent: "claude" },
    );
    for (let index = 2; index <= 7; index += 1)
      store.addCheckpoint(card.id, { summary: `n${index}`, files: ["a.ts"] });
    const { checkpoints, latest } = store.listCheckpoints(card.id);
    assert.equal(checkpoints.length, 5);
    assert.deepEqual(
      checkpoints.map((entry) => entry.summary),
      ["n7", "n6", "n5", "n4", "n3"],
    );
    assert.equal(latest?.summary, "n7");
    // "first" fell off, so nothing older carries a next step.
    assert.equal(latest?.nextStep, null);

    store.addCheckpoint(card.id, { summary: "with step", nextStep: "do Y" });
    store.addCheckpoint(card.id, { summary: "after" });
    const carried = store.listCheckpoints(card.id).latest;
    assert.equal(carried?.summary, "after");
    assert.equal(carried?.nextStep, "do Y");
    assert.equal(carried?.nextStepFrom?.agent, "agent");

    // A checkpoint is not an edit.
    assert.equal(store.getWorkItem(card.id)?.revision, 1);
    assert.equal(
      code(() => store.addCheckpoint(card.id, { summary: "  " })),
      "invalid",
    );

    store.setStatus(card.id, "done");
    assert.equal(store.listCheckpoints(card.id).checkpoints.length, 0);
    assert.equal(
      code(() => store.addCheckpoint(card.id, { summary: "late" })),
      "conflict",
    );
  });
});

describe("task ids", () => {
  test("minted per category, restore-compatible, never reused", () => {
    const store = open(join(home, "ids.sqlite"));
    const ws = store.createProject({ name: "Ids" }).id;
    const mint = (categoryKey: string | null) =>
      store.createWorkItem(ws, { title: "t", categoryKey }).taskId;

    assert.equal(mint("frontend"), "FE-01");
    assert.equal(mint("frontend"), "FE-02");
    assert.equal(mint("backend"), "BE-01");
    assert.equal(mint("infrastructure"), "INF-01");
    assert.equal(mint(null), null);

    // review-import's restore.taskId/taskSeq: the head jumps past it.
    const restored = store.createWorkItem(ws, {
      title: "imported",
      categoryKey: "frontend",
      columnKey: "done",
      restore: {
        taskId: "FE-07",
        taskSeq: 7,
        createdAt: "2026-01-02T00:00:00.000Z",
        checklist: [
          {
            key: "D1",
            text: "old",
            checked: true,
            checkedAt: "2026-01-03T00:00:00.000Z",
          },
        ],
      },
    });
    assert.equal(restored.taskId, "FE-07");
    assert.equal(restored.createdAt, "2026-01-02T00:00:00.000Z");
    assert.equal(restored.checklist[0]?.checkedAt, "2026-01-03T00:00:00.000Z");
    assert.equal(mint("frontend"), "FE-08");
    assert.deepEqual(store.getProject(ws)?.taskHeads, {
      frontend: 8,
      backend: 1,
      infrastructure: 1,
    });

    // A restore below the head keeps the head where it is.
    store.createWorkItem(ws, {
      title: "older",
      categoryKey: "frontend",
      restore: { taskId: "FE-05", taskSeq: 5 },
    });
    assert.equal(mint("frontend"), "FE-09");

    assert.equal(
      code(() =>
        store.createWorkItem(ws, {
          title: "dup",
          categoryKey: "frontend",
          restore: { taskId: "FE-07", taskSeq: 7 },
        }),
      ),
      "conflict",
    );
    assert.equal(
      code(() =>
        store.createWorkItem(ws, {
          title: "half",
          categoryKey: "frontend",
          restore: { taskId: "FE-30" },
        }),
      ),
      "invalid",
    );

    // A card with no category gets its id when it gets one; a recategorized
    // card keeps its id.
    const bare = store.createWorkItem(ws, { title: "bare" });
    assert.equal(
      store.updateWorkItem(bare.id, { categoryKey: "documentation" }).taskId,
      "DOC-01",
    );
    assert.equal(
      store.updateWorkItem(bare.id, { categoryKey: "backend" }).taskId,
      "DOC-01",
    );

    // Tombstoned ids stay taken.
    const gone = store.createWorkItem(ws, {
      title: "gone",
      categoryKey: "backend",
    });
    assert.equal(gone.taskId, "BE-02");
    store.deleteWorkItem(gone.id);
    assert.equal(mint("backend"), "BE-03");

    // Separate projects count separately.
    const other = store.createProject({ name: "Other" }).id;
    assert.equal(
      store.createWorkItem(other, { title: "t", categoryKey: "frontend" })
        .taskId,
      "FE-01",
    );
  });
});

describe("tombstones + change feed", () => {
  test("delete hides a card, keeps the row, shows in the feed, and restores", () => {
    const store = open(join(home, "tomb.sqlite"));
    const ws = store.createProject({ name: "Tomb" }).id;
    const card = store.createWorkItem(ws, {
      title: "doomed",
      categoryKey: "frontend",
    });
    store.addCheckpoint(card.id, { summary: "wip" });
    const since = store.dataVersion();

    const deleted = store.deleteWorkItem(card.id, { ifRevision: 1 });
    assert.ok(deleted.archivedAt);
    assert.equal(store.getWorkItem(card.id), null);
    assert.equal(store.getWorkItem("FE-01", { project: ws }), null);
    assert.deepEqual(store.listWorkItems(ws), []);
    const listed = store.listWorkItems(ws, { includeDeleted: true });
    assert.equal(listed.length, 1);
    assert.ok(listed[0]?.archivedAt);
    assert.equal(
      code(() => store.updateWorkItem(card.id, { title: "x" })),
      "not_found",
    );

    const changes = store.listChanges(ws, since);
    assert.deepEqual(
      changes.items.map((item) => item.id),
      [card.id],
    );
    assert.ok(changes.items[0]?.archivedAt);
    assert.equal(changes.head, store.dataVersion());

    const back = store.restoreWorkItem(card.id);
    assert.equal(back.archivedAt, null);
    assert.equal(store.listCheckpoints(card.id).checkpoints.length, 0);
    assert.equal(store.listWorkItems(ws).length, 1);
  });
});

describe("concurrency (WAL)", () => {
  test("dataVersion moves for a write from another connection", () => {
    const path = join(home, "version.sqlite");
    const a = open(path);
    const b = open(path);
    const ws = a.createProject({ name: "V" }).id;
    const seen = b.dataVersion();
    a.createWorkItem(ws, { title: "x" });
    assert.ok(b.dataVersion() > seen);
    assert.equal(b.listWorkItems(ws).length, 1);
  });

  test("two processes and this one write the same file at once without SQLITE_BUSY", async () => {
    const path = join(home, "busy.sqlite");
    const store = open(path);
    const ws = store.createProject({ name: "Busy" }).id;
    const perWriter = 60;
    const fixture = join(import.meta.dirname, "writer.fixture.ts");
    const run = (label: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          [fixture, path, ws, String(perWriter), label],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
        });
        child.stderr.on("data", (chunk) => {
          out += chunk;
        });
        child.on("close", (exit) => resolve({ code: exit, out }));
      });

    const writers = [run("A"), run("B")];
    // This connection writes too while the children run.
    let local = 0;
    const deadline = Date.now() + 20_000;
    let done = false;
    void Promise.all(writers).then(() => {
      done = true;
    });
    while (!done && Date.now() < deadline) {
      store.createWorkItem(ws, {
        title: `main ${local}`,
        categoryKey: "frontend",
      });
      local += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const results = await Promise.all(writers);
    for (const result of results) {
      assert.equal(result.code, 0, result.out);
      assert.doesNotMatch(result.out, /SQLITE_BUSY|database is locked/i);
    }

    const cards = store.listWorkItems(ws);
    assert.equal(cards.length, perWriter * 2 + local);
    const ids = cards.map((card) => card.taskId);
    assert.equal(new Set(ids).size, ids.length, "every task id is unique");
    const seqs = ids
      .map((id) => Number(String(id).replace("FE-", "")))
      .sort((x, y) => x - y);
    assert.deepEqual(
      seqs,
      Array.from({ length: seqs.length }, (_, index) => index + 1),
      "no gaps: FE-01 … FE-n",
    );
    assert.equal(store.getProject(ws)?.taskHeads.frontend, seqs.length);
    const withCheckpoint = cards.filter(
      (card) => store.listCheckpoints(card.id).checkpoints.length === 1,
    );
    assert.equal(withCheckpoint.length, perWriter * 2);
  });
});
