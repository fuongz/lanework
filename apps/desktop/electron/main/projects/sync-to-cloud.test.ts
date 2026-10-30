// Run with `bun test apps/desktop/electron/main/projects`.
//
// FE-52/V3: "Sync to cloud" moves every card (task id, checklist ticks, lane,
// parent), and a failure part way through leaves the local board as it was,
// still writable, and resumable into the same cloud board.
//
// The control plane is a stub on a loopback port that behaves like the real
// import surface where it matters:
// - records are keyed on `source.ref`, so a re-run skips what landed;
// - receipts carry `itemId`;
// - the seal counts the board.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from "node:test";
import { type LocalStore, openLocalStore } from "../../local-store";
import type { MachineRecord } from "../auth/store";
import { type SyncRecord, syncLocalProject } from "./sync-to-cloud";

type Item = {
  itemId: string;
  ref: string;
  title: string;
  columnKey: string;
  categoryKey: string | null;
  taskId: string | null;
  parentId: string | null;
  checklist: { key: string; checked?: boolean; checkedAt?: string }[];
};

const plane = {
  taken: new Set<string>(["taken"]),
  boards: new Map<
    string,
    { items: Item[]; migratedAt: string | null; columns: unknown[] }
  >(),
  created: [] as string[],
  /** Fail the Nth import batch from now (1-based); 0 = never. */
  failBatch: 0,
  batches: 0,
  sealed: [] as number[],
};

let server: Server;
let origin: string;

function json(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "POST" && req.url === "/v1/sync/state/workspace") {
        if (plane.taken.has(body.slug))
          return json(res, 409, { error: "taken" });
        plane.taken.add(body.slug);
        plane.created.push(body.slug);
        return json(res, 201, {
          project: {
            id: `ws-${body.slug}`,
            slug: body.slug,
            name: body.name,
            path: null,
            baseBranch: null,
          },
        });
      }
      const match = /^\/v1\/boards\/([^/]+)(\/.*)$/.exec(req.url ?? "");
      if (!match) return json(res, 404, { error: "no route" });
      const [, id, rest] = match as unknown as [string, string, string];
      const state = plane.boards.get(id);
      if (req.method === "PUT" && rest === "/config") {
        plane.boards.set(id, {
          items: state?.items ?? [],
          migratedAt: state?.migratedAt ?? null,
          columns: body.columns,
        });
        return json(res, 200, { board: null, seq: 1 });
      }
      if (!state) return json(res, 404, { error: "no board" });
      if (req.method === "GET" && rest === "/config")
        return json(res, 200, {
          board: {
            columns: state.columns,
            categories: [],
            labels: [],
            members: [],
            migratedAt: state.migratedAt,
          },
        });
      if (req.method === "POST" && rest === "/import") {
        plane.batches += 1;
        if (plane.failBatch && plane.batches === plane.failBatch)
          return json(res, 503, { error: "unavailable" });
        const receipts = (body.records as SyncRecord[]).map((record) => {
          const ref = record.source.ref;
          const existing = state.items.find((item) => item.ref === ref);
          if (existing)
            return {
              ref,
              status: "skipped",
              itemId: existing.itemId,
              taskId: existing.taskId,
            };
          if (
            record.parentId &&
            !state.items.some((item) => item.itemId === record.parentId)
          )
            return {
              ref,
              status: "failed",
              error: "parent not on this board",
            };
          const item: Item = {
            itemId: `cloud-${state.items.length + 1}`,
            ref,
            title: record.title,
            columnKey: record.columnKey,
            categoryKey: record.categoryKey,
            taskId: record.restore?.taskId ?? null,
            parentId: record.parentId ?? null,
            checklist: record.restore?.checklist ?? [],
          };
          state.items.push(item);
          return {
            ref,
            status: "imported",
            itemId: item.itemId,
            taskId: item.taskId,
          };
        });
        const summary: Record<string, number> = {};
        for (const receipt of receipts)
          summary[receipt.status] = (summary[receipt.status] ?? 0) + 1;
        return json(res, 200, { receipts, summary, head: 1 });
      }
      if (req.method === "POST" && rest === "/migrated") {
        plane.sealed.push(body.items);
        if (body.items !== state.items.length)
          return json(res, 409, {
            error: "count mismatch",
            expected: body.items,
            actual: state.items.length,
          });
        state.migratedAt = "2026-10-12T00:00:00.000Z";
        return json(res, 200, {
          migratedAt: state.migratedAt,
          items: body.items,
          seq: 2,
        });
      }
      return json(res, 404, { error: "no route" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let dir: string;
let store: LocalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lanew-sync-"));
  store = openLocalStore({ path: join(dir, "data.sqlite") });
  plane.boards.clear();
  plane.created.length = 0;
  plane.failBatch = 0;
  plane.batches = 0;
  plane.sealed.length = 0;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const record = (): MachineRecord => ({
  machineId: "m1",
  secret: "lw_mch_test",
  apiUrl: origin,
  name: "test",
  userId: "u1",
  owner: null,
});

describe("sync to cloud", () => {
  test("moves every card with its task id, ticks, lane and parent, then goes read-only", async () => {
    const project = store.createProject({ name: "Taken" }); // slug `taken` clashes
    const epic = store.createWorkItem(project.id, {
      title: "Epic",
      type: "epic",
      categoryKey: "frontend",
      columnKey: "processing",
      restore: { taskId: "FE-07", taskSeq: 7 },
    });
    const child = store.createWorkItem(project.id, {
      title: "Child",
      categoryKey: "frontend",
      columnKey: "todo",
      parentId: epic.id,
      checklist: [
        { key: "D1", section: "decisions", text: "Pick one" },
        { key: "V1", section: "verify", text: "Prove it" },
      ],
    });
    store.toggleChecklistItem(child.id, "D1", { checked: true });
    store.createWorkItem(project.id, {
      title: "No category",
      columnKey: "done",
    });

    const outcome = await syncLocalProject(store, record(), project.id);

    // The account already had `taken`: the move found the next free key.
    assert.deepEqual(plane.created, ["taken-2"]);
    assert.equal(outcome.cloudId, "ws-taken-2");
    assert.equal(outcome.cards, 3);
    assert.deepEqual(plane.sealed, [3]);

    const items = plane.boards.get("ws-taken-2")?.items ?? [];
    const cloudEpic = items.find((item) => item.ref === epic.id);
    const cloudChild = items.find((item) => item.ref === child.id);
    assert.equal(cloudEpic?.taskId, "FE-07");
    assert.equal(cloudEpic?.columnKey, "processing");
    assert.equal(cloudChild?.taskId, "FE-08");
    assert.equal(cloudChild?.columnKey, "todo");
    // The parent link is re-addressed to the parent's cloud id.
    assert.equal(cloudChild?.parentId, cloudEpic?.itemId);
    const tick = cloudChild?.checklist.find((item) => item.key === "D1");
    assert.equal(tick?.checked, true);
    assert.ok(tick?.checkedAt, "a tick travels with when it was made");
    assert.equal(
      cloudChild?.checklist.find((item) => item.key === "V1")?.checked,
      undefined,
    );

    const after = store.getProject(project.id);
    assert.equal(after?.cloudId, "ws-taken-2");
    assert.ok(after?.syncedAt, "the local board is marked as moved");
    const pointers = store.db
      .prepare("SELECT id, cloud_id FROM project_issues WHERE project_id = ?")
      .all(project.id) as { id: string; cloud_id: string | null }[];
    assert.ok(pointers.every((row) => row.cloud_id?.startsWith("cloud-")));

    await assert.rejects(
      syncLocalProject(store, record(), project.id),
      /already moved/,
    );
  });

  test("a failure part way leaves the local board intact, and a re-run finishes into the same board", async () => {
    const project = store.createProject({ name: "Big board" });
    for (let n = 1; n <= 60; n += 1)
      store.createWorkItem(project.id, {
        title: `Card ${n}`,
        categoryKey: "backend",
        columnKey: "todo",
      });
    const before = store
      .listWorkItems(project.id)
      .map((card) => [card.id, card.revision]);

    // The second batch (cards 51-60) fails: the first 50 have landed.
    plane.failBatch = 2;
    await assert.rejects(
      syncLocalProject(store, record(), project.id),
      /Nothing on this machine was changed/,
    );
    assert.equal(plane.boards.get("ws-big-board")?.items.length, 50);
    assert.deepEqual(
      plane.sealed,
      [],
      "nothing is sealed over a partial upload",
    );

    const stopped = store.getProject(project.id);
    assert.equal(stopped?.syncedAt, null, "not marked as moved");
    assert.equal(
      stopped?.cloudId,
      "ws-big-board",
      "but remembers the board it was filling",
    );
    assert.deepEqual(
      store.listWorkItems(project.id).map((card) => [card.id, card.revision]),
      before,
      "every local card is exactly as it was",
    );
    // …and still writable.
    store.createWorkItem(project.id, {
      title: "Written after the failure",
      categoryKey: "backend",
    });

    plane.failBatch = 0;
    const outcome = await syncLocalProject(store, record(), project.id);
    assert.deepEqual(plane.created, ["big-board"], "no second project");
    assert.equal(outcome.cloudId, "ws-big-board");
    const items = plane.boards.get("ws-big-board")?.items ?? [];
    assert.equal(
      items.length,
      61,
      "the 50 that landed were skipped, not duplicated",
    );
    assert.equal(new Set(items.map((item) => item.ref)).size, 61);
    assert.deepEqual(plane.sealed, [61]);
    assert.ok(store.getProject(project.id)?.syncedAt);
  });

  test("a seal the cloud refuses leaves the local board writable", async () => {
    const project = store.createProject({ name: "Sealed out" });
    store.createWorkItem(project.id, { title: "One" });
    // Somebody else put a card on the cloud board between the import and the
    // seal.
    const originalSet = plane.boards.set.bind(plane.boards);
    plane.boards.set = (key, value) => {
      value.items.push({
        itemId: "stray",
        ref: "stray",
        title: "Stray",
        columnKey: "backlog",
        categoryKey: null,
        taskId: null,
        parentId: null,
        checklist: [],
      });
      plane.boards.set = originalSet;
      return originalSet(key, value);
    };
    await assert.rejects(
      syncLocalProject(store, record(), project.id),
      /did not seal/,
    );
    assert.equal(store.getProject(project.id)?.syncedAt, null);
  });
});
