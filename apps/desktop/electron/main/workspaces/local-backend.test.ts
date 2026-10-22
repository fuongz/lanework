// Run with `bun test apps/desktop/electron/main/workspaces`. Written against
// `node:test`/`node:assert`, like the local store's own tests, so the desktop
// typecheck needs no Bun types.
//
// FE-52/V2's unit half: every board IPC a local board serves is answered from
// the store alone. `fetch` is replaced with one that fails the test, so any
// request this path makes, to any origin, shows up here.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { localStorePath } from "../../local-store";
import {
  closeLocalStore,
  findLocalWorkspace,
  localBoard,
  localStore,
  MOVED_MESSAGE,
  toWorkspace,
  watchLocalStore,
  writeLocal,
} from "./local-backend";

const previousHome = process.env.LANEWORK_HOME;
const realFetch = globalThis.fetch;
const requests: string[] = [];
let home: string;

before(() => {
  globalThis.fetch = ((input: unknown) => {
    requests.push(String(input));
    throw new Error(`local board made a request: ${String(input)}`);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  closeLocalStore();
  if (previousHome === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previousHome;
});

beforeEach(() => {
  closeLocalStore();
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), "lanew-local-backend-"));
  process.env.LANEWORK_HOME = home;
});

function board() {
  const workspace = writeLocal((store) =>
    store.createWorkspace({ name: "Local project" }),
  );
  const target = localBoard(workspace.id);
  assert.ok(target, "a local id resolves to a local board");
  return target;
}

describe("local backend", () => {
  test("never creates the store file just to look a board up", () => {
    assert.equal(localStore(), null);
    assert.equal(localBoard("0190f0f0-0000-7000-8000-000000000000"), null);
    assert.equal(existsSync(localStorePath()), false);
  });

  test("a board resolves by id only, never by a slug a cloud board may share", () => {
    const target = board();
    assert.equal(findLocalWorkspace(target.workspace.slug), null);
    assert.equal(
      findLocalWorkspace(target.workspace.slug, { bySlug: true })?.id,
      target.workspace.id,
    );
    const row = toWorkspace(target.workspace, "/tmp/project");
    assert.equal(row.origin, "local");
    assert.equal(row.movedTo, null);
    assert.equal(row.path, "/tmp/project");
  });

  test("create, edit, move, tick, replace checklist, delete — all local", () => {
    const target = board();
    const created = target.create({
      title: "Write the store",
      categoryKey: "backend",
      priority: "high",
      tags: ["db", "sqlite", "local", "extra"],
    });
    assert.equal(created.kind, "ok");
    if (created.kind !== "ok") return;
    assert.equal(created.card.taskId, "BE-01");
    assert.equal(created.card.columnKey, "backlog");
    // The board keeps three tags, and the write says which one did not land.
    assert.deepEqual(created.droppedTags, ["extra"]);

    const id = created.card.id;
    const edited = target.update(id, { title: "Write the local store" }, 1);
    assert.equal(edited.kind, "ok");
    if (edited.kind !== "ok") return;

    // A stale revision is a conflict carrying the card as it is now.
    const stale = target.update(id, { title: "Lost edit" }, 1);
    assert.equal(stale.kind, "conflict");
    if (stale.kind === "conflict")
      assert.equal(stale.current.title, "Write the local store");

    const moved = target.move(id, "todo", undefined);
    assert.equal(moved.kind, "ok");
    if (moved.kind === "ok") assert.equal(moved.card.columnKey, "todo");

    const listed = target.setChecklist(
      id,
      [
        { key: "D1", section: "decisions", text: "Use node:sqlite" },
        { key: "V1", section: "verify", text: "bun test passes" },
      ],
      moved.kind === "ok" ? moved.card.revision : 0,
    );
    assert.equal(listed.kind, "ok");
    if (listed.kind !== "ok") return;
    const ticked = target.toggle(id, "D1", true, listed.card.revision);
    assert.equal(ticked.kind, "ok");
    if (ticked.kind !== "ok") return;
    const item = ticked.card.checklist?.find((entry) => entry.key === "D1");
    assert.equal(item?.checked, true);
    assert.ok(item?.checkedAt, "a tick records when");
    assert.deepEqual(ticked.card.checklistProgress, { done: 1, total: 2 });

    assert.equal(target.lookup("be-01")?.id, id);
    assert.equal(target.search("local store")[0]?.id, id);

    const view = target.view({ groupBy: "status", filters: {} });
    assert.equal(view.cards.length, 1);
    assert.equal(view.stats?.byColumn.todo, 1);
    assert.equal(view.total, 1);
    // Every group complete: the renderer never asks for "more".
    assert.ok(Object.values(view.groups ?? {}).every((g) => g.cursor === null));
    // A list read carries no checklist, like the cloud's.
    assert.equal(view.cards[0]?.checklist, null);

    const filtered = target.view({
      groupBy: "status",
      filters: { priority: "low" },
    });
    assert.equal(filtered.cards.length, 0);
    assert.equal(filtered.total, 1);

    target.archive(id);
    target.archive(id); // already gone is a success
    assert.equal(target.view().cards.length, 0);
    const feed = target.changes(0);
    assert.ok(feed.cards.some((card) => card.id === id && card.archivedAt));

    assert.deepEqual(requests, []);
  });

  test("cloud-only fields are refused, never silently dropped", () => {
    const target = board();
    const created = target.create({ title: "A card" });
    assert.equal(created.kind, "ok");
    if (created.kind !== "ok") return;
    const answer = target.update(
      created.card.id,
      { assignees: { users: ["u1"], agents: [] } },
      created.card.revision,
    );
    assert.equal(answer.kind, "error");
    const due = target.update(
      created.card.id,
      { dueAt: "2026-10-12T00:00:00.000Z" },
      created.card.revision,
    );
    assert.equal(due.kind, "error");
  });

  test("a board that moved to the cloud refuses every write", () => {
    const target = board();
    const created = target.create({ title: "Before the move" });
    assert.equal(created.kind, "ok");
    writeLocal((store) =>
      store.updateWorkspace(target.workspace.id, {
        cloudId: "ws-cloud",
        syncedAt: new Date().toISOString(),
      }),
    );
    const moved = localBoard(target.workspace.id);
    assert.ok(moved?.moved);
    assert.equal(toWorkspace(moved.workspace).movedTo, "ws-cloud");
    const write = moved.create({ title: "After the move" });
    assert.deepEqual(write, { kind: "error", message: MOVED_MESSAGE });
    assert.throws(() => moved.purge(moved.workspace.slug), /moved/);
    // Reads still work: the old board stays readable.
    assert.equal(moved.view().cards.length, 1);
  });

  test("the watch reports another process's writes, not this one's", async () => {
    const target = board();
    const seen: string[][] = [];
    const stop = watchLocalStore((ids) => seen.push(ids), { intervalMs: 20 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Our own write: no event.
      target.create({ title: "Mine" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.deepEqual(seen, []);
      // Somebody else's (straight to the store, as the MCP server would).
      target.store.createWorkItem(target.workspace.id, { title: "Theirs" });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(seen, [[target.workspace.id]]);
    } finally {
      stop();
    }
  });
});
