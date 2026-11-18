#!/usr/bin/env bun
/**
 * The board MCP parity gate (FE-152). Starts the built offline server
 * (`dist/electron/mcp-local/server.cjs`) over stdio, as an agent config does,
 * on a throwaway `LANEWORK_HOME`, and checks it against the tool contract in
 * `@lanework/protocol`:
 *
 * - `tools/list` names, descriptions, input schemas and read-only flags equal
 *   `BOARD_TOOLS`, in order, and nothing else is served;
 * - a scripted board scenario calls every board tool, and each answer has the
 *   shape `BoardToolOutputs` names for it (checked by hand below, field by
 *   field: the types do not exist at run time).
 *
 * It then starts the built lanework-control server
 * (`dist/electron/mcp-control/server.cjs`, FE-155) with a fake sessions token,
 * a fake control token, both and neither, and checks that `tools/list` equals
 * `controlToolsFor` for each (none for neither). Nothing is called: the
 * tokens are fake and no app listens.
 *
 * Run with Bun (it imports the contract's TypeScript), after `bun run build`:
 * `bun apps/desktop/scripts/mcp-parity.mjs`.
 *
 * NOTE: Not a test. It runs no test file and reads nothing of the user's: the
 * board lives in a temp folder, removed on the way out.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOARD_TOOLS,
  controlToolsFor,
  toolInputSchema,
} from "@lanework/protocol";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(desktop, "dist/electron/mcp-local/server.cjs");
const controlBundle = join(desktop, "dist/electron/mcp-control/server.cjs");
/** The env lanework-control reads (`SESSIONS_ENV`, `CONTROL_ENV`). */
const SESSIONS_TOKEN = "LANEWORK_SESSIONS_TOKEN";
const CONTROL_TOKEN = "LANEWORK_CONTROL_TOKEN";
const CONTROL_ENDPOINT = "LANEWORK_CONTROL_ENDPOINT";
const REMOTE = "https://example.com/acme/parity.git";
const TIMEOUT_MS = 15_000;

const problems = [];
const problem = (message) => problems.push(message);

// ── Shapes ──────────────────────────────────────────────────────────────────
// Each mirrors a type in packages/protocol/src (boards.ts, checkpoints.ts,
// tools/board.ts). An object shape is exact: a missing key and an extra one
// are both drift.

const str = { kind: "string" };
const num = { kind: "number" };
const bool = { kind: "boolean" };
const any = { kind: "any" };
const nullable = (inner) => ({ kind: "nullable", inner });
const optional = (inner) => ({ kind: "optional", inner });
const list = (inner) => ({ kind: "list", inner });
const record = (inner) => ({ kind: "record", inner });
const obj = (fields) => ({ kind: "object", fields });
const oneOf = (...values) => ({ kind: "enum", values });
const and = (a, b) => obj({ ...a.fields, ...b.fields });

const PRIORITY = nullable(oneOf("low", "medium", "high"));
const COLUMN_ROLE = nullable(
  oneOf("intake", "start", "active", "review", "done", "archive"),
);

const BOARD_SUMMARY = obj({
  workspaceId: str,
  name: str,
  role: str,
  changeSeq: num,
  repo: nullable(str),
});
const BOARD_REF = obj({ workspaceId: str, name: str, repo: nullable(str) });
const CHECKLIST_ITEM = obj({
  key: str,
  section: oneOf("decisions", "verify"),
  text: str,
  checked: bool,
  checkedAt: nullable(str),
  note: nullable(str),
  group: nullable(str),
  stream: nullable(str),
  checkedBy: optional(any),
  evidence: optional(any),
});
const STREAM = obj({
  key: str,
  title: str,
  goal: str,
  role: oneOf("research", "implement", "test"),
  owns: list(str),
  reads: list(str),
  dependsOn: list(str),
  isolation: oneOf("worktree", "shared"),
  position: num,
});
const DISPATCH = obj({ waves: list(list(str)), briefs: record(str) });
const CARD = obj({
  id: str,
  workspaceId: str,
  seq: num,
  revision: num,
  type: oneOf("epic", "issue", "task"),
  parentId: nullable(str),
  columnKey: str,
  rank: str,
  title: str,
  body: str,
  priority: PRIORITY,
  estimate: nullable(num),
  categoryKey: nullable(str),
  taskId: nullable(str),
  tags: list(str),
  checklistProgress: obj({ done: num, total: num }),
  streams: list(STREAM),
  metadata: nullable(any),
  source: nullable(any),
  createdAt: nullable(str),
  updatedAt: nullable(str),
  startedAt: nullable(str),
  completedAt: nullable(str),
  dueAt: nullable(str),
  archivedAt: nullable(str),
  stale: optional(nullable(any)),
  changesRequested: optional(nullable(any)),
});
const CARD_DETAIL = and(
  CARD,
  obj({
    checklist: list(CHECKLIST_ITEM),
    dispatch: nullable(DISPATCH),
    assignees: obj({ users: list(str), agents: list(str) }),
    links: list(any),
    attachments: list(any),
    subscribers: list(str),
    subscribed: bool,
    favorite: bool,
    commentCount: num,
  }),
);
const CHECKPOINT_FIELDS = {
  id: str,
  agent: str,
  userId: str,
  machineId: nullable(str),
  createdAt: str,
  request: nullable(str),
  summary: str,
  nextStep: nullable(str),
  files: list(str),
  commands: list(obj({ command: str, ok: nullable(bool) })),
  host: nullable(str),
  session: nullable(str),
  git: nullable(
    obj({
      branch: nullable(str),
      head: nullable(str),
      wipRef: nullable(str),
      wipSha: nullable(str),
      diffStat: nullable(str),
    }),
  ),
};
const CHECKPOINT = obj(CHECKPOINT_FIELDS);
const LATEST_CHECKPOINT = obj({
  ...CHECKPOINT_FIELDS,
  nextStepFrom: nullable(obj({ id: str, agent: str, createdAt: str })),
});
const CARD_BRIEF = obj({
  id: str,
  taskId: nullable(str),
  title: str,
  column: str,
  priority: PRIORITY,
  revision: num,
});
const DECISIONS = { ready: bool, pending: list(str) };

/** `BoardToolOutputs`, tool by tool. */
const OUTPUTS = {
  list_boards: obj({
    repo: optional(str),
    boards: list(BOARD_SUMMARY),
    next: str,
  }),
  create_board: obj({
    board_id: str,
    board: and(BOARD_REF, obj({ slug: str })),
    next: str,
  }),
  link_repo: obj({ board: BOARD_REF, replaced: nullable(str) }),
  board_summary: obj({
    board: BOARD_REF,
    total: num,
    lanes: list(obj({ key: str, name: str, role: COLUMN_ROLE, count: num })),
    categories: list(obj({ key: str, name: str, prefix: str, next: num })),
    tagPolicy: obj({ max: num, allowed: list(str) }),
    tags: list(obj({ tag: str, count: num })),
    labels: list(obj({ key: str, name: str, tone: str, position: num })),
  }),
  list_reviews: obj({ total: num, items: list(CARD), truncated: bool }),
  get_review: obj({
    item: CARD_DETAIL,
    checkpoint: nullable(LATEST_CHECKPOINT),
    dispatch: nullable(DISPATCH),
  }),
  create_review: obj({ item: CARD_DETAIL, next: str }),
  update_review: obj({ item: CARD_DETAIL }),
  toggle_item: obj({
    ...DECISIONS,
    checklistItem: CHECKLIST_ITEM,
    card: CARD_BRIEF,
    progress: obj({ done: num, total: num }),
  }),
  review_card: obj({
    ...DECISIONS,
    revision: num,
    checklist: list(CHECKLIST_ITEM),
    next: str,
  }),
  set_status: obj({ item: CARD_BRIEF }),
  delete_review: obj({ archived: str, item: CARD_BRIEF }),
  checkpoint: obj({ checkpoint: CHECKPOINT }),
  lifecycle_status: obj({
    waiting: list(and(CARD_BRIEF, obj({ pending: list(str) }))),
    ready: list(CARD_BRIEF),
    inFlight: list(and(CARD_BRIEF, obj({ verified: str }))),
    review: list(CARD_BRIEF),
  }),
};

/** Every way `value` differs from `shape`, as `path: what` lines. */
function mismatches(shape, value, path) {
  const out = [];
  const check = (s, v, p) => {
    switch (s.kind) {
      case "any":
        return;
      case "optional":
        if (v !== undefined) check(s.inner, v, p);
        return;
      case "nullable":
        if (v !== null) check(s.inner, v, p);
        return;
      case "string":
      case "number":
      case "boolean":
        if (typeof v !== s.kind)
          out.push(`${p}: expected ${s.kind}, got ${JSON.stringify(v)}`);
        return;
      case "enum":
        if (!s.values.includes(v))
          out.push(
            `${p}: ${JSON.stringify(v)} is not one of ${s.values.join(", ")}`,
          );
        return;
      case "list":
        if (!Array.isArray(v)) out.push(`${p}: expected a list`);
        else
          for (const [i, entry] of v.entries())
            check(s.inner, entry, `${p}[${i}]`);
        return;
      case "record":
        if (typeof v !== "object" || v === null || Array.isArray(v))
          out.push(`${p}: expected an object`);
        else
          for (const [k, entry] of Object.entries(v))
            check(s.inner, entry, `${p}.${k}`);
        return;
      case "object": {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          out.push(`${p}: expected an object`);
          return;
        }
        for (const [k, field] of Object.entries(s.fields)) {
          if (!(k in v) && field.kind !== "optional")
            out.push(`${p}.${k}: missing`);
          else check(field, v[k], `${p}.${k}`);
        }
        for (const k of Object.keys(v))
          if (!(k in s.fields)) out.push(`${p}.${k}: not in the contract`);
        return;
      }
    }
  };
  check(shape, value, path);
  return out;
}

// ── The server ──────────────────────────────────────────────────────────────

function startServer(home, script = bundle, extraEnv = {}) {
  const electron = createRequire(join(desktop, "package.json"))("electron");
  // NOTE: Run from a Lanework conversation, this process carries real
  // control tokens; the server must see only the ones a check passes.
  const env = { ...process.env };
  for (const name of [SESSIONS_TOKEN, CONTROL_TOKEN, CONTROL_ENDPOINT])
    delete env[name];
  const child = spawn(electron, [script], {
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
      LANEWORK_HOME: home,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
      index = buffer.indexOf("\n");
    }
  });
  let id = 0;
  const rpc = (method, params) => {
    id += 1;
    const mine = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`${method} timed out; server stderr:\n${stderr}`)),
        TIMEOUT_MS,
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
  const stop = () =>
    new Promise((resolve) => {
      child.once("exit", (code) => resolve({ code, stderr }));
      child.stdin.end();
    });
  return {
    rpc,
    stop,
    notify: (method) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
  };
}

// ── The checks ──────────────────────────────────────────────────────────────

function checkToolList(tools, contracts = BOARD_TOOLS, label = "") {
  const want = contracts.map((tool) => tool.name);
  const got = tools.map((tool) => tool.name);
  if (JSON.stringify(got) !== JSON.stringify(want))
    problem(
      `${label}tools/list names: got [${got.join(", ")}], the contract has [${want.join(", ")}]`,
    );
  for (const contract of contracts) {
    const served = tools.find((tool) => tool.name === contract.name);
    if (!served) continue;
    if (served.description !== contract.description)
      problem(
        `${label}${contract.name}: description differs from the contract`,
      );
    const schema = toolInputSchema(contract);
    if (JSON.stringify(served.inputSchema) !== JSON.stringify(schema))
      problem(
        `${label}${contract.name}: inputSchema differs from the contract\n  served:   ${JSON.stringify(served.inputSchema)}\n  contract: ${JSON.stringify(schema)}`,
      );
    if (served.annotations?.readOnlyHint !== contract.readOnly)
      problem(
        `${label}${contract.name}: readOnlyHint ${served.annotations?.readOnlyHint}, contract readOnly ${contract.readOnly}`,
      );
  }
}

async function scenario(server) {
  const called = new Set();
  const call = async (name, args) => {
    called.add(name);
    const answer = await server.rpc("tools/call", { name, arguments: args });
    if (!answer.result)
      throw new Error(`${name}: ${answer.error?.message ?? "no result"}`);
    const value = JSON.parse(answer.result.content[0].text);
    if (answer.result.isError)
      throw new Error(`${name} refused: ${value.message}`);
    for (const line of mismatches(OUTPUTS[name], value, name)) problem(line);
    return value;
  };

  const board = await call("create_board", {
    name: "acme/parity",
    repo: REMOTE,
  });
  const boardId = board.board_id;
  await call("list_boards", {});
  await call("list_boards", { repo: REMOTE });
  await call("link_repo", {
    board_id: boardId,
    repo: "git@example.com:acme/parity-2.git",
    replace: true,
  });
  await call("board_summary", { board_id: boardId });
  const created = await call("create_review", {
    board_id: boardId,
    title: "Parity card",
    body: "Made by mcp-parity.mjs",
    category: "frontend",
    priority: "medium",
    tags: ["parity"],
    checklist: [
      { section: "decisions", text: "Go ahead" },
      { section: "decisions", text: "Option A", group: "pick" },
      { section: "decisions", text: "Option B", group: "pick" },
      { section: "verify", text: "Lead check" },
      { section: "verify", text: "W0 check", stream: "W0" },
      { section: "verify", text: "W1 check", stream: "W1" },
    ],
    streams: [
      {
        key: "W0",
        title: "Contract",
        goal: "Shared types",
        role: "implement",
        owns: ["shared/"],
      },
      {
        key: "W1",
        title: "Server",
        goal: "Use them",
        role: "implement",
        owns: ["server/"],
        depends_on: ["W0"],
      },
    ],
  });
  const card = created.item.taskId ?? created.item.id;
  await call("list_reviews", { board_id: boardId });
  await call("toggle_item", {
    board_id: boardId,
    card,
    key: "D1",
    checked: true,
    note: "approved",
  });
  // Not every decision ticked: lifecycle_status lists the card as waiting.
  await call("lifecycle_status", { board_id: boardId });
  const reviewed = await call("review_card", {
    board_id: boardId,
    card,
    picks: [{ key: "D2", checked: true }],
  });
  if (reviewed.ready !== true)
    problem(
      `review_card: expected ready: true, got pending ${reviewed.pending}`,
    );
  await call("update_review", {
    board_id: boardId,
    card,
    tags: ["parity", "gate"],
  });
  await call("set_status", { board_id: boardId, card, status: "processing" });
  await call("checkpoint", {
    board_id: boardId,
    card,
    summary: "Parity run",
    next_step: "Nothing",
    files: ["apps/desktop/scripts/mcp-parity.mjs"],
    commands: [{ command: "bun run build", ok: true }],
    git: { branch: "main", head: "0000000" },
  });
  const got = await call("get_review", { board_id: boardId, card });
  if (got.checkpoint === null)
    problem("get_review: no checkpoint after checkpoint");
  if (got.dispatch === null)
    problem("get_review: no dispatch for a card with streams");
  await call("lifecycle_status", { board_id: boardId });
  await call("delete_review", { board_id: boardId, card });

  for (const tool of BOARD_TOOLS)
    if (!called.has(tool.name)) problem(`scenario never called ${tool.name}`);

  // search_sessions moved to lanework-kit (FE-152): the board server must not serve it.
  const gone = await server.rpc("tools/call", {
    name: "search_sessions",
    arguments: { query: "x" },
  });
  if (!gone.error) problem("search_sessions: still served by the board MCP");
}

/** lanework-control's tools/list for each set of tokens (FE-155). */
async function controlParity(home) {
  const cases = [
    {
      label: "sessions token",
      env: { [SESSIONS_TOKEN]: "parity-sessions" },
      roles: { conductor: true, lead: false },
    },
    {
      label: "control token",
      env: { [CONTROL_TOKEN]: "parity-control" },
      roles: { conductor: false, lead: true },
    },
    {
      label: "both tokens",
      env: {
        [SESSIONS_TOKEN]: "parity-sessions",
        [CONTROL_TOKEN]: "parity-control",
      },
      roles: { conductor: true, lead: true },
    },
    { label: "no token", env: {}, roles: null },
  ];
  for (const { label, env, roles } of cases) {
    const server = startServer(home, controlBundle, {
      ...env,
      // Never dialled: nothing is called.
      [CONTROL_ENDPOINT]: "127.0.0.1:9",
    });
    const tag = `lanework-control (${label}): `;
    try {
      const init = await server.rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-parity", version: "1" },
      });
      if (!init.result) throw new Error(`initialize: ${init.error?.message}`);
      if (init.result.serverInfo?.name !== "lanework-control")
        problem(`${tag}serverInfo.name is ${init.result.serverInfo?.name}`);
      const unavailable = /unavailable/.test(init.result.instructions ?? "");
      if (unavailable !== (roles === null))
        problem(`${tag}instructions: ${init.result.instructions}`);
      server.notify("notifications/initialized");
      const list = await server.rpc("tools/list");
      checkToolList(
        list.result.tools,
        roles ? controlToolsFor(roles) : [],
        tag,
      );
    } catch (error) {
      problem(
        `${tag}${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      const { code, stderr } = await server.stop();
      if (code !== 0) problem(`${tag}server exited ${code}:\n${stderr}`);
    }
  }
  return cases.length;
}

async function main() {
  for (const path of [bundle, controlBundle])
    if (!existsSync(path)) {
      console.error(
        `mcp-parity: ${path} is missing; run \`bun run build\` first`,
      );
      process.exit(1);
    }
  const home = mkdtempSync(join(tmpdir(), "lanework-parity-"));
  const server = startServer(home);
  try {
    const init = await server.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-parity", version: "1" },
    });
    if (!init.result) throw new Error(`initialize: ${init.error?.message}`);
    server.notify("notifications/initialized");
    const list = await server.rpc("tools/list");
    checkToolList(list.result.tools);
    await scenario(server);
  } catch (error) {
    problem(error instanceof Error ? error.message : String(error));
  } finally {
    const { code, stderr } = await server.stop();
    if (code !== 0) problem(`server exited ${code}:\n${stderr}`);
  }
  let controlCases = 0;
  try {
    controlCases = await controlParity(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  if (problems.length > 0) {
    console.error(
      `mcp-parity: the MCP servers drift from the tool contract:\n- ${problems.join("\n- ")}`,
    );
    process.exit(1);
  }
  console.log(
    `mcp-parity: ${BOARD_TOOLS.length} board tools match the contract; lanework-control matches controlToolsFor in ${controlCases} token cases`,
  );
}

await main();
