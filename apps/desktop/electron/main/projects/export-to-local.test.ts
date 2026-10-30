// Run with `bun test apps/desktop/electron/main/projects`.
//
// FE-110/V2: "Export to local" copies every live card (task id, lane and
// order, parent, checklist ticks with their moment, streams, newest
// checkpoint) into a new local board, leaves archived cards behind, never
// writes to the cloud, and a failed read leaves the store as it was.
//
// The control plane is a stub on a loopback port that answers the four reads
// the export makes and records every request, so a write would show.
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
import { exportCloudProject } from "./export-to-local";

const BOARD = "ws-cloud";

const COLUMNS = [
  {
    key: "todo",
    name: "To-Do",
    role: "start",
    icon: "c",
    tone: "amber",
    position: 0,
  },
  {
    key: "doing",
    name: "Doing",
    role: "active",
    icon: "p",
    tone: "blue",
    position: 1,
  },
  {
    key: "done",
    name: "Done",
    role: "done",
    icon: "k",
    tone: "emerald",
    position: 2,
  },
];

const CATEGORIES = [
  {
    key: "frontend",
    name: "Frontend",
    prefix: "FE",
    format: "{prefix}-{seq}",
    pad: 2,
    tone: "sky",
    position: 0,
  },
];

type CloudItem = Record<string, unknown> & { id: string };

const card = (id: string, over: Record<string, unknown>): CloudItem => ({
  id,
  revision: 3,
  title: id,
  body: `body of ${id}`,
  type: "issue",
  columnKey: "todo",
  categoryKey: null,
  taskId: null,
  priority: "medium",
  tags: [],
  rank: "m",
  parentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  archivedAt: null,
  checklist: [],
  streams: [],
  ...over,
});

const plane = {
  items: [] as CloudItem[],
  checkpoints: new Map<string, unknown>(),
  /** Answer 503 to the card read of this id. */
  failCard: null as string | null,
  requests: [] as string[],
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
    plane.requests.push(`${req.method} ${req.url}`);
    if (req.method !== "GET") return json(res, 405, { error: "read only" });
    const url = new URL(req.url ?? "/", "http://stub");
    const base = `/v1/boards/${BOARD}`;
    if (url.pathname === `${base}/config`)
      return json(res, 200, {
        board: {
          columns: COLUMNS,
          categories: CATEGORIES,
          labels: [],
          members: [],
          tags: { max: 5, allowed: [] },
          migratedAt: null,
        },
      });
    if (url.pathname === `${base}/items`)
      // A list read: no checklist, as the service sends it.
      return json(res, 200, {
        items: plane.items
          .filter((item) => !item.archivedAt)
          .map(({ checklist: _c, ...rest }) => rest),
        cursor: null,
      });
    const checkpoint = new RegExp(`^${base}/items/([^/]+)/checkpoints$`).exec(
      url.pathname,
    );
    if (checkpoint) {
      const latest = plane.checkpoints.get(checkpoint[1] as string);
      return latest
        ? json(res, 200, { checkpoints: [latest], latest })
        : json(res, 200, { checkpoints: [], latest: null });
    }
    const one = new RegExp(`^${base}/items/([^/]+)$`).exec(url.pathname);
    if (one) {
      const id = one[1] as string;
      if (plane.failCard === id) return json(res, 503, { error: "down" });
      const item = plane.items.find((entry) => entry.id === id);
      return item
        ? json(res, 200, { item })
        : json(res, 404, { error: "no card" });
    }
    return json(res, 404, { error: "no route" });
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
  dir = mkdtempSync(join(tmpdir(), "lanew-export-"));
  store = openLocalStore({ path: join(dir, "data.sqlite") });
  plane.items = [];
  plane.checkpoints.clear();
  plane.failCard = null;
  plane.requests.length = 0;
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

const source = { id: BOARD, slug: "acme-web", name: "Acme Web" };

describe("export to local", () => {
  test("copies every live card with its task id, lane, order, parent, ticks and checkpoint", async () => {
    plane.items = [
      // The child comes first in its lane, above its own parent.
      card("child", {
        columnKey: "doing",
        rank: "a",
        parentId: "epic",
        categoryKey: "frontend",
        taskId: "FE-12",
        checklist: [
          {
            key: "D1",
            section: "decisions",
            text: "Pick one",
            checked: true,
            checkedAt: "2026-01-15T10:00:00.000Z",
            note: "approved",
            group: null,
          },
          { key: "V1", section: "verify", text: "Prove it", checked: false },
        ],
      }),
      card("epic", {
        type: "epic",
        columnKey: "doing",
        rank: "b",
        categoryKey: "frontend",
        taskId: "FE-109",
      }),
      card("shipped", { columnKey: "done", rank: "a" }),
      card("gone", { archivedAt: "2026-03-01T00:00:00.000Z" }),
    ];
    plane.checkpoints.set("child", {
      id: "cp1",
      agent: "claude-code",
      userId: "u1",
      machineId: "m1",
      createdAt: "2026-02-01T00:00:00.000Z",
      summary: "Halfway",
      nextStep: "Finish V1",
      files: ["a.ts"],
      host: "laptop",
      git: { branch: "main", head: "abc", wipRef: null },
    });

    const outcome = await exportCloudProject(store, record(), source);

    assert.equal(outcome.cards, 3);
    assert.equal(outcome.project.slug, "acme-web");
    assert.equal(outcome.project.name, "Acme Web");
    // The next mint follows the highest copied id, in the board's format.
    assert.equal(outcome.project.taskHeads.frontend, 109);
    assert.equal(outcome.project.config.tags.max, 5);

    const cards = store.listWorkItems(outcome.project.id);
    const byTitle = new Map(cards.map((entry) => [entry.title, entry]));
    assert.equal(byTitle.has("gone"), false);
    const epic = byTitle.get("epic");
    const child = byTitle.get("child");
    assert.ok(epic && child);
    assert.equal(epic.taskId, "FE-109");
    assert.equal(child.taskId, "FE-12");
    assert.equal(child.parentId, epic.id);
    assert.equal(byTitle.get("shipped")?.columnKey, "done");

    // The lane keeps the cloud's order even though the parent was written first.
    const doing = cards
      .filter((entry) => entry.columnKey === "doing")
      .sort((a, b) => (a.rank < b.rank ? -1 : 1))
      .map((entry) => entry.title);
    assert.deepEqual(doing, ["child", "epic"]);

    const detail = store.getWorkItem(child.id, {
      project: outcome.project.id,
    });
    assert.equal(detail?.createdAt, "2026-01-01T00:00:00.000Z");
    const d1 = detail?.checklist.find((item) => item.key === "D1");
    assert.equal(d1?.checked, true);
    assert.equal(d1?.checkedAt, "2026-01-15T10:00:00.000Z");
    assert.equal(d1?.note, "approved");

    const { latest } = store.listCheckpoints(child.id, {
      project: outcome.project.id,
    });
    assert.equal(latest?.summary, "Halfway");
    assert.equal(latest?.agent, "claude-code");

    // A copy only reads: not one request that could change the cloud.
    assert.ok(plane.requests.every((line) => line.startsWith("GET ")));
  });

  test("a second export makes a second board", async () => {
    plane.items = [card("one", {})];
    const first = await exportCloudProject(store, record(), source);
    const second = await exportCloudProject(store, record(), source);
    assert.notEqual(first.project.id, second.project.id);
    assert.equal(second.project.slug, "acme-web-2");
  });

  test("a failed read leaves the store as it was", async () => {
    plane.items = [card("one", {}), card("two", { rank: "n" })];
    plane.failCard = "two";
    await assert.rejects(exportCloudProject(store, record(), source));
    assert.deepEqual(store.listProjects(), []);
  });
});
