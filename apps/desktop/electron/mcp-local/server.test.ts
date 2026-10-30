// Run with `bun test apps/desktop/electron/mcp-local`. Uses `node:test` and
// `node:assert` like the store's tests, so the desktop typecheck needs no Bun
// types.
//
// The end-to-end case spawns the BUILT `dist/electron/mcp-local/server.cjs`
// under Electron's own Node (`ELECTRON_RUN_AS_NODE=1`), as an agent config
// launches it. Run `bun run build` in apps/desktop first.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type LocalStore, openLocalStore } from "../local-store/index";
import { handleLine, LocalMcpSession, SERVER_NAME } from "./server";

const BOARD_TOOLS = [
  "board_summary",
  "checkpoint",
  "create_board",
  "create_review",
  "delete_review",
  "get_review",
  "lifecycle_status",
  "link_repo",
  "list_boards",
  "list_reviews",
  "review_card",
  "set_status",
  "toggle_item",
  "update_review",
];

const REMOTE = "https://example.com/acme/widgets.git";

let dir: string;
const opened: LocalStore[] = [];

function open(path: string): LocalStore {
  const store = openLocalStore({ path });
  opened.push(store);
  return store;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "lanework-mcp-"));
});

after(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Drives a session one JSON-RPC message at a time, as the stdio loop does. */
function client(session: LocalMcpSession) {
  let id = 0;
  const rpc = (method: string, params?: unknown) => {
    id += 1;
    const lines = handleLine(
      session,
      JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    );
    assert.equal(lines.length, 1);
    return JSON.parse(lines[0] as string) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
  };
  const call = (name: string, args: Record<string, unknown>) => {
    const answer = rpc("tools/call", { name, arguments: args });
    assert.ok(
      answer.result,
      `tools/call ${name} answered ${answer.error?.message}`,
    );
    const result = answer.result as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    return {
      isError: result.isError === true,
      // biome-ignore lint/suspicious/noExplicitAny: test reads answers loosely
      body: JSON.parse(result.content[0]?.text ?? "null") as any,
    };
  };
  return { rpc, call };
}

describe("offline MCP session", () => {
  let store: LocalStore;
  let session: LocalMcpSession;
  let mcp: ReturnType<typeof client>;
  let boardId: string;

  before(() => {
    store = open(join(dir, "session.sqlite"));
    session = new LocalMcpSession(store);
    mcp = client(session);
  });

  test("initialize echoes the version and names the server", () => {
    const { result } = mcp.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2.0.0" },
    });
    assert.equal(result?.protocolVersion, "2025-06-18");
    assert.deepEqual(result?.serverInfo, {
      name: SERVER_NAME,
      version: "0.1.0",
    });
    assert.ok((result?.capabilities as { tools?: unknown } | undefined)?.tools);
    assert.match(String(result?.instructions), /list_boards\(\{ repo \}\)/);
    assert.doesNotMatch(
      String(result?.instructions),
      /sign(ed)? in|log ?in|credential/i,
    );
    // A notification gets no answer.
    assert.deepEqual(
      handleLine(
        session,
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      ),
      [],
    );
    assert.deepEqual(mcp.rpc("ping").result, {});
  });

  test("tools/list is exactly the 14 board tools", () => {
    const tools = mcp.rpc("tools/list").result?.tools as {
      name: string;
      inputSchema: { required?: string[]; properties: Record<string, unknown> };
    }[];
    assert.deepEqual(tools.map((tool) => tool.name).sort(), BOARD_TOOLS);
    const create = tools.find((tool) => tool.name === "create_review");
    assert.deepEqual(create?.inputSchema.required, ["board_id", "title"]);
    for (const name of [
      "category",
      "checklist",
      "column",
      "parent_id",
      "priority",
      "streams",
      "tags",
      "type",
      "assignees",
    ])
      assert.ok(create?.inputSchema.properties[name], `create_review.${name}`);
  });

  test("an unknown method is a protocol error, a bad call is isError", () => {
    assert.equal(mcp.rpc("nope/nothing").error?.code, -32601);
    assert.equal(
      mcp.rpc("tools/call", { name: "create_account", arguments: {} }).error
        ?.code,
      -32602,
    );
    const missing = mcp.call("get_review", { board_id: "x" });
    assert.equal(missing.isError, true);
    assert.match(missing.body.message, /card is required/);
    const unknownBoard = mcp.call("board_summary", { board_id: "nope" });
    assert.equal(unknownBoard.isError, true);
    assert.equal(unknownBoard.body.error, "not_found");
    assert.deepEqual(handleLine(session, "{not json").length, 1);
  });

  test("board: create_board → list_boards({ repo }) → link_repo guard", () => {
    const created = mcp.call("create_board", {
      name: "acme/widgets",
      repo: REMOTE,
    });
    assert.equal(created.isError, false);
    boardId = created.body.board_id;
    const listed = mcp.call("list_boards", {
      repo: "git@example.com:acme/widgets",
    });
    assert.equal(listed.body.repo, "example.com/acme/widgets");
    assert.deepEqual(
      listed.body.boards.map(
        (board: { workspaceId: string }) => board.workspaceId,
      ),
      [boardId],
    );
    assert.equal(listed.body.next, "Use this board.");
    const refused = mcp.call("link_repo", {
      board_id: boardId,
      repo: "https://example.com/acme/other",
    });
    assert.equal(refused.isError, true);
    assert.equal(refused.body.error, "conflict");
    const summary = mcp.call("board_summary", { board_id: boardId });
    assert.equal(summary.body.total, 0);
    assert.ok(
      summary.body.categories.some(
        (category: { key: string }) => category.key === "frontend",
      ),
    );
  });

  test("create_review → toggle_item → set_status → get_review", () => {
    const created = mcp.call("create_review", {
      board_id: boardId,
      title: "Offline card",
      body: "Context",
      category: "frontend",
      priority: "medium",
      tags: ["local-mode"],
      assignees: { users: ["someone"], agents: ["claude-code"] },
      checklist: [
        { section: "decisions", text: "Option A", group: "pick" },
        { section: "decisions", text: "Option B", group: "pick" },
        { section: "decisions", text: "Ship it" },
        { section: "verify", text: "Typecheck" },
      ],
    });
    assert.equal(created.isError, false, JSON.stringify(created.body));
    assert.equal(created.body.item.taskId, "FE-01");
    // New cards start in the start lane, as on the cloud.
    assert.equal(created.body.item.columnKey, "todo");

    const toggled = mcp.call("toggle_item", {
      board_id: boardId,
      card: "FE-01",
      key: "D3",
      checked: true,
      note: "yes",
    });
    assert.equal(toggled.isError, false);
    const d3 = toggled.body.item.checklist.find(
      (item: { key: string }) => item.key === "D3",
    );
    assert.equal(d3.checked, true);
    assert.equal(d3.note, "yes");
    assert.deepEqual(toggled.body.pending, ["group:pick"]);

    const moved = mcp.call("set_status", {
      board_id: boardId,
      card: "FE-01",
      status: "processing",
    });
    assert.equal(moved.body.item.column, "processing");

    const got = mcp.call("get_review", { board_id: boardId, card: "fe-01" });
    assert.equal(got.isError, false);
    assert.equal(got.body.item.taskId, "FE-01");
    assert.equal(got.body.item.columnKey, "processing");
    assert.equal(got.body.checkpoint, null);
    assert.equal(got.body.dispatch, null);
  });

  test("review_card: one pick of a group unticks the others; ready", () => {
    const first = mcp.call("review_card", {
      board_id: boardId,
      card: "FE-01",
      picks: [{ key: "D1", checked: true }],
    });
    assert.equal(first.body.ready, true, JSON.stringify(first.body));
    const second = mcp.call("review_card", {
      board_id: boardId,
      card: "FE-01",
      picks: [{ key: "D2", checked: true, note: "B instead" }],
    });
    const byKey = Object.fromEntries(
      second.body.checklist.map((item: { key: string }) => [item.key, item]),
    );
    assert.equal(byKey.D1.checked, false);
    assert.equal(byKey.D2.checked, true);
    assert.equal(byKey.D2.note, "B instead");
    assert.equal(byKey.D3.checked, true, "boxes not named are left alone");
    assert.equal(second.body.ready, true);
    const stale = mcp.call("review_card", {
      board_id: boardId,
      card: "FE-01",
      picks: [{ key: "D3", checked: false }],
      revision: 1,
    });
    assert.equal(stale.isError, true);
    assert.equal(stale.body.error, "conflict");
  });

  test("checkpoint, lifecycle_status, list_reviews, streams, delete", () => {
    const saved = mcp.call("checkpoint", {
      board_id: boardId,
      card: "FE-01",
      summary: "Halfway",
      next_step: "Write the test",
      files: ["a.ts"],
      commands: [{ command: "bun run typecheck", ok: true }],
      git: { branch: "main", head: "abc", wip_ref: "refs/lanework/wip/FE-01" },
    });
    assert.equal(saved.isError, false, JSON.stringify(saved.body));
    assert.equal(saved.body.checkpoint.agent, "claude-code");
    const got = mcp.call("get_review", { board_id: boardId, card: "FE-01" });
    assert.equal(got.body.checkpoint.nextStep, "Write the test");
    assert.equal(got.body.checkpoint.git.wipRef, "refs/lanework/wip/FE-01");

    const waiting = mcp.call("create_review", {
      board_id: boardId,
      title: "Waiting card",
      category: "backend",
      checklist: [{ section: "decisions", text: "Approve" }],
    });
    assert.equal(waiting.body.item.taskId, "BE-01");
    const life = mcp.call("lifecycle_status", { board_id: boardId });
    assert.deepEqual(
      life.body.inFlight.map((card: { taskId: string }) => card.taskId),
      ["FE-01"],
    );
    assert.deepEqual(
      life.body.waiting.map((card: { taskId: string }) => card.taskId),
      ["BE-01"],
    );

    const unproved = mcp.call("create_review", {
      board_id: boardId,
      title: "Streams",
      category: "backend",
      streams: [
        { key: "W0", title: "a", goal: "b", role: "implement", owns: ["x/"] },
      ],
      checklist: [{ section: "verify", text: "V" }],
    });
    assert.equal(unproved.isError, true);
    assert.match(unproved.body.message, /W0/);
    const planned = mcp.call("create_review", {
      board_id: boardId,
      title: "Streams",
      category: "backend",
      streams: [
        { key: "W0", title: "a", goal: "b", role: "implement", owns: ["x/"] },
      ],
      checklist: [{ section: "verify", text: "V", stream: "W0" }],
    });
    assert.equal(planned.isError, false, JSON.stringify(planned.body));
    const plan = mcp.call("get_review", { board_id: boardId, card: "BE-02" });
    assert.deepEqual(plan.body.dispatch.waves, [["W0"]]);

    const listed = mcp.call("list_reviews", {
      board_id: boardId,
      task_id: "be-01",
    });
    assert.deepEqual(
      listed.body.items.map((card: { taskId: string }) => card.taskId),
      ["BE-01"],
    );
    const archived = mcp.call("delete_review", {
      board_id: boardId,
      card: "BE-01",
    });
    assert.equal(archived.isError, false);
    assert.equal(
      mcp.call("get_review", { board_id: boardId, card: "BE-01" }).isError,
      true,
    );
    assert.equal(
      mcp.call("list_reviews", { board_id: boardId, include_archived: true })
        .body.total,
      3,
    );
  });

  test("a write moves dataVersion() on another connection (the app's poll)", () => {
    const app = open(store.path);
    const before = app.dataVersion();
    mcp.call("toggle_item", {
      board_id: boardId,
      card: "FE-01",
      key: "V1",
      checked: true,
    });
    assert.ok(app.dataVersion() > before);
  });
});

describe("built server.cjs over stdio", () => {
  const bundle = join(
    import.meta.dirname,
    "../../dist/electron/mcp-local/server.cjs",
  );
  const built = existsSync(bundle);

  test("initialize → tools/list → create_board → create_review → toggle_item → set_status → get_review", {
    skip: built ? false : "run `bun run build` in apps/desktop first",
  }, async () => {
    const home = mkdtempSync(join(dir, "home-"));
    const electron = createRequire(import.meta.url)("electron") as string;
    const child = spawn(electron, [bundle], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LANEWORK_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let buffer = "";
    const waiting = new Map<number, (message: unknown) => void>();
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const message = JSON.parse(buffer.slice(0, index)) as { id: number };
        buffer = buffer.slice(index + 1);
        waiting.get(message.id)?.(message);
        index = buffer.indexOf("\n");
      }
    });
    let id = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test reads answers loosely
    const rpc = (method: string, params?: unknown): Promise<any> => {
      id += 1;
      const mine = id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${method} timed out; stderr: ${stderr}`)),
          15_000,
        );
        waiting.set(mine, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`,
        );
      });
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      const answer = await rpc("tools/call", { name, arguments: args });
      assert.ok(answer.result, JSON.stringify(answer));
      assert.ok(!answer.result.isError, answer.result.content[0].text);
      return JSON.parse(answer.result.content[0].text);
    };

    try {
      const init = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "codex-mcp-client", version: "1" },
      });
      assert.equal(init.result.serverInfo.name, "lanework");
      assert.equal(init.result.protocolVersion, "2025-06-18");
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const list = await rpc("tools/list");
      assert.deepEqual(
        list.result.tools.map((tool: { name: string }) => tool.name).sort(),
        BOARD_TOOLS,
      );
      const board = await call("create_board", {
        name: "acme/widgets",
        repo: REMOTE,
      });
      const created = await call("create_review", {
        board_id: board.board_id,
        title: "From the bundle",
        category: "frontend",
        priority: "high",
        tags: ["e2e"],
        checklist: [{ section: "decisions", text: "Go" }],
      });
      assert.equal(created.item.taskId, "FE-01");
      await call("toggle_item", {
        board_id: board.board_id,
        card: "FE-01",
        key: "D1",
        checked: true,
      });
      await call("set_status", {
        board_id: board.board_id,
        card: "FE-01",
        status: "processing",
      });
      await call("checkpoint", {
        board_id: board.board_id,
        card: "FE-01",
        summary: "via stdio",
      });
      const got = await call("get_review", {
        board_id: board.board_id,
        card: "FE-01",
      });
      assert.equal(got.item.columnKey, "processing");
      assert.equal(got.item.checklist[0].checked, true);
      assert.equal(got.checkpoint.agent, "codex");
    } finally {
      child.stdin.end();
    }
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    assert.equal(code, 0, stderr);

    // What the bundle wrote is in the file the app reads.
    const app = open(join(home, "data.sqlite"));
    const [project] = app.listProjects();
    assert.ok(project);
    assert.equal(
      app.getWorkItem("FE-01", { project: project.id })?.columnKey,
      "processing",
    );
  });
});
