#!/usr/bin/env bun
/**
 * The board MCP parity gate (FE-152). Starts the built offline server
 * (`dist/electron/mcp-local/server.cjs`) over stdio, as an agent config does,
 * on a throwaway `LANEWORK_HOME`, and checks it against the tool contract in
 * `@lanework/contracts`:
 *
 * - `tools/list` names, descriptions, input schemas and read-only flags equal
 *   `BOARD_TOOLS`, in order, and nothing else is served;
 * - a scripted board scenario calls every board tool, and each answer has the
 *   shape `BoardToolOutputs` names for it, checked with the contract's own
 *   run-time shapes (`boardToolOutputProblems`, `BOARD_TOOL_OUTPUT_SHAPES`):
 *   the cloud's parity gate checks its server with the same ones.
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
  BOARD_INSTRUCTIONS,
  BOARD_TOOLS,
  boardToolOutputProblems,
  controlToolsFor,
  toolInputSchema,
} from "@lanework/contracts";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(desktop, "dist/electron/mcp-local/server.cjs");
const controlBundle = join(desktop, "dist/electron/mcp-control/server.cjs");
/** The env lanework-control reads (`SESSIONS_ENV`, `CONTROL_ENV`). */
const SESSIONS_TOKEN = "LANEWORK_SESSIONS_TOKEN";
const CONTROL_AS = "LANEWORK_CONTROL_AS";
const CONTROL_TOKEN = "LANEWORK_CONTROL_TOKEN";
const CONTROL_ENDPOINT = "LANEWORK_CONTROL_ENDPOINT";
const REMOTE = "https://example.com/acme/parity.git";
const TIMEOUT_MS = 15_000;

const problems = [];
const problem = (message) => problems.push(message);

// ── The server ──────────────────────────────────────────────────────────────

function startServer(home, script = bundle, extraEnv = {}) {
  const electron = createRequire(join(desktop, "package.json"))("electron");
  // NOTE: Run from a Lanework conversation, this process carries real
  // control tokens; the server must see only the ones a check passes.
  const env = { ...process.env };
  for (const name of [
    SESSIONS_TOKEN,
    CONTROL_TOKEN,
    CONTROL_ENDPOINT,
    CONTROL_AS,
  ])
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
    // An exact object shape: a missing key and an extra one are both drift.
    for (const line of boardToolOutputProblems(name, value)) problem(line);
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
  const toggled = await call("toggle_item", {
    board_id: boardId,
    card,
    key: "D1",
    checked: true,
    note: "approved",
  });
  // The pick-ONE group is still open, named as `review_card` names it.
  if (toggled.ready !== false || !toggled.open?.includes("pick (D2/D3)"))
    problem(
      `toggle_item: expected ready: false, open [pick (D2/D3)], got ${JSON.stringify({ ready: toggled.ready, open: toggled.open })}`,
    );
  // Not every decision ticked: lifecycle_status lists the card as waiting.
  const before = await call("lifecycle_status", { board_id: boardId });
  if (!before.waiting.some((entry) => entry.id === created.item.id))
    problem("lifecycle_status: the card is not waiting before review_card");
  const reviewed = await call("review_card", {
    board_id: boardId,
    card,
    picks: [{ key: "D2", checked: true }],
  });
  if (reviewed.ready !== true)
    problem(`review_card: expected ready: true, got open ${reviewed.open}`);
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
  const during = await call("lifecycle_status", { board_id: boardId });
  if (!during.inFlight.some((entry) => entry.id === created.item.id))
    problem("lifecycle_status: the card is not in flight after set_status");
  // Into a review lane: no `retro` offline (no move history to read).
  await call("set_status", { board_id: boardId, card, status: "review" });
  const after = await call("lifecycle_status", { board_id: boardId });
  if (!after.review.some((entry) => entry.id === created.item.id))
    problem("lifecycle_status: the card is not in review after set_status");
  const deleted = await call("delete_review", { board_id: boardId, card });
  if (deleted.archived !== created.item.id)
    problem(`delete_review: archived ${deleted.archived}, not the card`);

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
      label: "sessions token, plain session",
      env: { [SESSIONS_TOKEN]: "parity-sessions" },
      roles: { conductor: false, lead: false },
    },
    {
      label: "sessions token, conductor",
      env: {
        [SESSIONS_TOKEN]: "parity-sessions",
        [CONTROL_AS]: "conductor",
      },
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
    // The rules ship with the tools: word for word the cloud server's text.
    if (init.result.instructions !== BOARD_INSTRUCTIONS)
      problem("initialize instructions differ from BOARD_INSTRUCTIONS");
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
