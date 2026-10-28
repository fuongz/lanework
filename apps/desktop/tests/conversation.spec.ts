// A Claude conversation as a chat (FE-62), end to end: read from the
// transcript Claude wrote, sent to through a headless stand-in CLI that
// speaks stream-json, handed to a terminal and back — and a long one that
// stays responsive while it grows.
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { MachineRecord } from "../electron/main/auth/store";
import { claudeProjectDir } from "../electron/main/terminal/agent-sessions";
import { writeFolders } from "../electron/main/workspaces/store";
import { conversationChannels } from "../shared/conversation";
import type { Workspace } from "../shared/workspaces";
import { claudeRowName } from "./agent-fixtures";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

test.skip(process.platform === "win32", "These drive a POSIX shell.");

/** Where the V4 screenshots go (gitignored). */
const SHOTS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  ".agents",
  "artifacts",
  "fe62-v4",
);

const CHAT_ID = "88888888-2222-4333-8444-555555555555";
const LONG_ID = "99999999-2222-4333-8444-555555555555";
const TITLE = "Flaky login test on CI";
const LONG_TITLE = "Six hundred turns";

const workspaces: Workspace[] = [
  {
    id: "ws-alpha",
    slug: "alpha",
    name: "Alpha",
    path: null,
    baseBranch: null,
  },
];

const board = {
  columns: [{ key: "todo", name: "To-Do", role: "start" }],
  cards: [],
};

const jsonl = (lines: unknown[]) =>
  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

/** A second past 09:30 today, for line `n`. */
const at = (n: number) =>
  new Date(Date.parse("2026-10-16T09:30:00.000Z") + n * 1000).toISOString();

function transcriptOf(agentHome: string, repo: string, id: string): string {
  return join(
    agentHome,
    ".claude",
    "projects",
    claudeProjectDir(repo),
    `${id}.jsonl`,
  );
}

/** A profile whose Alpha project is linked to a real folder on disk. */
async function seedProfile(origin: string) {
  const profile = await mkdtemp(join(tmpdir(), "lanew-chat-"));
  const home = join(profile, "home");
  const repo = await realpath(await mkdtemp(join(tmpdir(), "lanew-repo-")));
  await mkdir(home, { recursive: true });
  await seedCredential(home, origin);
  const previous = process.env.LANEWORK_HOME;
  process.env.LANEWORK_HOME = home;
  await writeFolders(
    {
      machineId: "test-machine",
      userId: "test-user",
      apiUrl: origin,
      name: "test-machine",
      secret: "lw_mch_test-secret",
      owner: null,
    } satisfies MachineRecord,
    "alpha",
    [repo],
  );
  if (previous === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previous;
  return { profile, home, repo, agentHome: join(profile, "agent-home") };
}

/**
 * A stand-in `claude` for both of the app's ways to run it.
 *
 * - `-p --input-format stream-json …` (the composer's engine): an init line,
 *   then for each stdin user line the replayed user line, two text deltas,
 *   an assistant "pong" and a `result` — and the same user/assistant lines
 *   appended to the transcript, as the real CLI writes them, so a re-read
 *   shows the turn.
 * - anything else (a terminal's resume): prints `ran-claude-<args>` and waits
 *   for `/exit`, as the other specs' stand-ins do.
 *
 * Every launch's arguments go to `log`, one JSON array per line. Run by the
 * test runner's own node, by absolute path: a login shell's PATH may not
 * have one.
 */
async function claudeStandIn(dir: string, transcript: string, log: string) {
  const file = join(dir, "claude-stand-in.cjs");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const TRANSCRIPT = ${JSON.stringify(transcript)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (!args.includes("-p")) {
  process.stdout.write("ran-claude-" + args.join("-") + "\\r\\n");
  let typed = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    typed += chunk;
    if (/\\/exit[\\r\\n]/.test(typed)) process.exit(0);
  });
} else {
  const id = args[args.indexOf("--resume") + 1];
  const model = args[args.indexOf("--model") + 1];
  const cwd = process.cwd();
  const out = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
  const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  out({ type: "system", subtype: "init", session_id: id, model, cwd, permissionMode: "default", tools: [] });
  let queue = Promise.resolve();
  const turn = async (message) => {
    const content = message.message.content;
    const userLine = { type: "user", uuid: randomUUID(), sessionId: id, cwd, timestamp: new Date().toISOString(), message: { role: "user", content } };
    out({ ...userLine, parent_tool_use_id: null, session_id: id, isReplay: true });
    await later(80);
    const messageId = "msg_" + randomUUID().slice(0, 8);
    const base = { id: messageId, type: "message", role: "assistant", model, stop_reason: null };
    out({ type: "stream_event", event: { type: "message_start", message: { ...base, content: [] } }, parent_tool_use_id: null, session_id: id });
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null, session_id: id });
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "po" } }, parent_tool_use_id: null, session_id: id });
    await later(80);
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ng" } }, parent_tool_use_id: null, session_id: id });
    await later(80);
    const assistantLine = {
      type: "assistant", uuid: randomUUID(), sessionId: id, cwd, timestamp: new Date().toISOString(),
      message: { ...base, stop_reason: "end_turn", content: [{ type: "text", text: "pong" }],
        usage: { input_tokens: 6, cache_creation_input_tokens: 180, cache_read_input_tokens: 24100, output_tokens: 3 } },
    };
    fs.appendFileSync(TRANSCRIPT, [userLine, assistantLine, { type: "system", subtype: "turn_duration", durationMs: 240, timestamp: new Date().toISOString() }].map((line) => JSON.stringify(line)).join("\\n") + "\\n");
    out({ ...assistantLine, parent_tool_use_id: null, session_id: id });
    await later(40);
    out({ type: "result", subtype: "success", is_error: false, result: "pong", duration_ms: 240, num_turns: 1, session_id: id });
  };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
      const text = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!text.trim()) continue;
      const message = JSON.parse(text);
      if (message.type === "control_request")
        out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
      else if (message.type === "user") queue = queue.then(() => turn(message));
    }
  });
  process.stdin.on("end", () => queue.then(() => process.exit(0)));
}
`;
  await writeFile(file, script, { mode: 0o755 });
  return file;
}

/**
 * A realistic conversation for `repo`: three prompts (so the TOC shows), a
 * folded tool group (a Read and a Bash, with results), a markdown table, a
 * link, an Edit — and per-message usage for the Usage tooltip.
 */
async function seedChat(agentHome: string, repo: string) {
  const file = transcriptOf(agentHome, repo, CHAT_ID);
  await mkdir(join(file, ".."), { recursive: true });
  const common = {
    sessionId: CHAT_ID,
    cwd: repo,
    gitBranch: "fix/login-flake",
  };
  const usage = (output: number) => ({
    input_tokens: 12,
    cache_creation_input_tokens: 2_380,
    cache_read_input_tokens: 25_310,
    output_tokens: output,
  });
  const assistant = (
    n: number,
    uuid: string,
    id: string,
    content: unknown[],
    output: number,
  ) => ({
    ...common,
    type: "assistant",
    uuid,
    timestamp: at(n),
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content,
      stop_reason: "end_turn",
      usage: usage(output),
    },
  });
  const user = (n: number, uuid: string, content: unknown) => ({
    ...common,
    type: "user",
    uuid,
    timestamp: at(n),
    message: { role: "user", content },
  });
  const table = [
    "The flake is a race, not a slow CI box: the test reads the session cookie before the login response has set it.",
    "",
    "### What the 20 runs showed",
    "",
    "| Run | Result | Time | Cookie set before assert |",
    "| --- | --- | --- | --- |",
    "| 1–12 | pass | 1.2 s | yes |",
    "| 13 | **fail** | 5.0 s | no |",
    "| 14–20 | pass | 1.3 s | yes |",
    "",
    "The fix is to wait for the `/api/session` response instead of a fixed `sleep(500)`:",
    "",
    "```ts",
    'await page.waitForResponse((r) => r.url().endsWith("/api/session"));',
    "```",
  ].join("\n");
  await writeFile(
    file,
    jsonl([
      { type: "mode", mode: "normal", sessionId: CHAT_ID },
      user(0, "u-1", "Why does the login test flake on CI?"),
      assistant(
        2,
        "a-1",
        "msg_1",
        [
          {
            type: "text",
            text: "Let me read the test and run it a few times.",
          },
        ],
        40,
      ),
      assistant(
        3,
        "a-2",
        "msg_1",
        [
          {
            type: "tool_use",
            id: "toolu_read",
            name: "Read",
            input: { file_path: join(repo, "tests/login.spec.ts") },
          },
        ],
        80,
      ),
      assistant(
        4,
        "a-3",
        "msg_1",
        [
          {
            type: "tool_use",
            id: "toolu_bash",
            name: "Bash",
            input: {
              command: "bun run test -- login --repeat-each 20",
              description: "Run the login test 20 times",
            },
          },
        ],
        120,
      ),
      user(5, "u-r1", [
        {
          type: "tool_result",
          tool_use_id: "toolu_read",
          content: "1\timport { test } from '@playwright/test';\n2\t…",
        },
      ]),
      user(9, "u-r2", [
        {
          type: "tool_result",
          tool_use_id: "toolu_bash",
          content: "19 passed, 1 failed (run 13: expected cookie 'sid')",
        },
      ]),
      assistant(12, "a-4", "msg_2", [{ type: "text", text: table }], 412),
      {
        ...common,
        type: "system",
        subtype: "turn_duration",
        timestamp: at(12),
      },
      user(30, "u-2", "Where is the upstream fix discussed?"),
      assistant(
        34,
        "a-5",
        "msg_3",
        [
          {
            type: "text",
            text: "It is tracked upstream on https://github.com/ — the maintainers suggest waiting on the response, which is what I proposed.",
          },
        ],
        64,
      ),
      {
        ...common,
        type: "system",
        subtype: "turn_duration",
        timestamp: at(34),
      },
      user(60, "u-3", "Great, apply the fix"),
      assistant(
        62,
        "a-6",
        "msg_4",
        [
          {
            type: "tool_use",
            id: "toolu_edit",
            name: "Edit",
            input: {
              file_path: join(repo, "tests/login.spec.ts"),
              old_string: "await sleep(500);",
              new_string:
                'await page.waitForResponse((r) => r.url().endsWith("/api/session"));',
            },
          },
        ],
        90,
      ),
      user(63, "u-r3", [
        {
          type: "tool_result",
          tool_use_id: "toolu_edit",
          content: "The file tests/login.spec.ts has been updated.",
        },
      ]),
      assistant(
        66,
        "a-7",
        "msg_5",
        [
          {
            type: "text",
            text: "Done — `tests/login.spec.ts` now waits for the session response. 20 of 20 runs pass locally.",
          },
        ],
        58,
      ),
      {
        ...common,
        type: "system",
        subtype: "turn_duration",
        timestamp: at(66),
      },
      { type: "ai-title", aiTitle: TITLE, sessionId: CHAT_ID },
    ]),
  );
  return file;
}

/** `n` prompts, each answered — 2n turns — every tenth with a tool call. */
async function seedLong(agentHome: string, repo: string, n: number) {
  const file = transcriptOf(agentHome, repo, LONG_ID);
  await mkdir(join(file, ".."), { recursive: true });
  const common = { sessionId: LONG_ID, cwd: repo };
  const rows: unknown[] = [
    { type: "mode", mode: "normal", sessionId: LONG_ID },
  ];
  for (let i = 1; i <= n; i++) {
    rows.push({
      ...common,
      type: "user",
      uuid: `long-u-${i}`,
      timestamp: at(i * 10),
      message: { role: "user", content: `Question number ${i}` },
    });
    if (i % 10 === 0) {
      rows.push({
        ...common,
        type: "assistant",
        uuid: `long-t-${i}`,
        timestamp: at(i * 10 + 1),
        message: {
          id: `msg_t${i}`,
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `toolu_${i}`,
              name: "Bash",
              input: { command: `echo ${i}` },
            },
          ],
        },
      });
      rows.push({
        ...common,
        type: "user",
        uuid: `long-r-${i}`,
        timestamp: at(i * 10 + 2),
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: `toolu_${i}`, content: `${i}` },
          ],
        },
      });
    }
    rows.push({
      ...common,
      type: "assistant",
      uuid: `long-a-${i}`,
      timestamp: at(i * 10 + 3),
      message: {
        id: `msg_${i}`,
        role: "assistant",
        model: "claude-opus-5-5",
        content: [
          {
            type: "text",
            text: `Answer number ${i}.\n\n- one point\n- another, with \`code\`\n\nA closing paragraph long enough to wrap onto a second line in the chat column so each turn has some height.`,
          },
        ],
        usage: { input_tokens: 10, output_tokens: 50 },
      },
    });
    rows.push({ ...common, type: "system", subtype: "turn_duration" });
  }
  rows.push({ type: "ai-title", aiTitle: LONG_TITLE, sessionId: LONG_ID });
  await writeFile(file, jsonl(rows));
  return file;
}

function boot(
  profile: string,
  home: string,
  origin: string,
  extra: Record<string, string> = {},
) {
  return electron.launch({
    args: [process.cwd()],
    env: {
      ...launchEnv({ profile, home, apiUrl: origin }),
      LANEWORK_TERMINAL_SHELL: "/bin/sh",
      LANEWORK_TERMINAL_AGENTS: "claude",
      ...extra,
    },
  });
}

async function switchTo(page: Page, name: string) {
  await page.getByRole("button", { name: /^Switch project/ }).click();
  await page.getByRole("option", { name }).first().click();
  await expect(
    page.getByRole("button", { name: `Switch project — currently ${name}` }),
  ).toBeVisible();
}

/**
 * Answer every link preview in main with a fixed title and a drawn icon —
 * no network in a test. Installed before any chat draws a link: the
 * renderer keeps what it was told for the session.
 */
async function stubLinkPreviews(app: ElectronApplication) {
  const icon = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="#24292f"/><circle cx="8" cy="7" r="3.2" fill="#fff"/></svg>',
  ).toString("base64")}`;
  await app.evaluate(
    ({ ipcMain }, { channel, icon }) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, url: string) => ({
        url,
        title: "GitHub · Build and ship software on a single platform",
        icon,
      }));
    },
    { channel: conversationChannels.linkPreview, icon },
  );
}

async function setTheme(
  app: ElectronApplication,
  page: Page,
  theme: "dark" | "light",
) {
  await app.evaluate(({ nativeTheme }, value) => {
    nativeTheme.themeSource = value;
  }, theme);
  const html = page.locator("html");
  if (theme === "dark") await expect(html).toHaveClass(/\bdark\b/);
  else await expect(html).not.toHaveClass(/\bdark\b/);
  // The swap suppresses transitions for two frames; let it paint.
  await page.waitForTimeout(150);
}

test("V5: a Claude conversation opens as a chat, sends a prompt and switches to the terminal and back", async () => {
  test.setTimeout(90_000);
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  const { profile, home, repo, agentHome } = await seedProfile(plane.origin);
  const transcript = await seedChat(agentHome, repo);
  const log = join(profile, "claude-args.log");
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_CLAUDE_BIN: await claudeStandIn(profile, transcript, log),
  });
  await mkdir(SHOTS, { recursive: true });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1320, 900);
    });
    await stubLinkPreviews(app);
    await switchTo(page, "Alpha");

    // ─── The chat, read from the transcript ─────────────────────────────────
    await page
      .getByRole("button", { name: claudeRowName(TITLE), exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/agents/chat/${CHAT_ID}$`));
    const chat = page.getByRole("region", { name: `Claude — ${TITLE}` });
    await expect(
      page.locator('[data-slot="window-titlebar"]').getByRole("heading"),
    ).toHaveText(TITLE);
    for (const prompt of [
      "Why does the login test flake on CI?",
      "Where is the upstream fix discussed?",
      "Great, apply the fix",
    ])
      await expect(chat.getByText(prompt, { exact: true })).toBeVisible();
    await expect(
      chat.getByText("Let me read the test and run it a few times."),
    ).toBeVisible();
    // The markdown reply: its table drawn as one.
    const table = chat.getByRole("table");
    await expect(table).toBeVisible();
    await expect(
      table.getByRole("row").filter({ hasText: "fail" }),
    ).toContainText("5.0 s");
    // The link: its page title and favicon, from main (stubbed).
    const link = chat.getByRole("link", {
      name: "GitHub · Build and ship software on a single platform",
    });
    await expect(link).toBeVisible();
    await expect(link.locator("img")).toHaveAttribute("src", /^data:image/);

    // The folded group: one row, closed; a click opens its calls.
    const group = chat.getByRole("button", {
      name: "Read login.spec.ts, ran a command",
    });
    await expect(group).toHaveAttribute("aria-expanded", "false");
    await expect(
      chat.getByRole("button", {
        name: "bun run test -- login --repeat-each 20",
      }),
    ).toHaveCount(0);
    await group.click();
    await expect(group).toHaveAttribute("aria-expanded", "true");
    const call = chat.getByRole("button", { name: /--repeat-each 20/ });
    await expect(call).toBeVisible();
    // A call opens to its input and its output.
    await call.click();
    await expect(chat.getByText("19 passed, 1 failed")).toBeVisible();
    await call.click();
    await group.click();
    await expect(group).toHaveAttribute("aria-expanded", "false");

    // ─── V4 evidence: both themes, the menus, the TOC card, Usage ─────────
    // The link's reply in the middle of the view, the table above it.
    await link.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await setTheme(app, page, "dark");
    await page.screenshot({ path: join(SHOTS, "chat-dark.png") });
    await setTheme(app, page, "light");
    await page.screenshot({ path: join(SHOTS, "chat-light.png") });
    await setTheme(app, page, "dark");

    const modelPill = chat.getByRole("button", { name: /^Model: / });
    await modelPill.click();
    const effort = page.getByRole("menuitem", { name: /^Effort/ });
    await expect(effort).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "model-menu.png") });
    await effort.hover();
    await expect(page.getByRole("menuitemradio").first()).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "effort-submenu.png") });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(effort).toHaveCount(0);

    const permissionPill = chat.getByRole("button", { name: /^Permissions: / });
    await permissionPill.click();
    await expect(page.getByRole("menuitem").first()).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "permission-menu.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem")).toHaveCount(0);

    const toc = chat.getByRole("navigation", {
      name: "Prompts in this conversation",
    });
    await toc
      .getByRole("button", { name: "Where is the upstream fix discussed?" })
      .hover();
    const card = toc.getByRole("tooltip");
    await expect(card).toContainText("Where is the upstream fix discussed?");
    await expect(card).not.toContainText("discussed?:");
    await expect(card).toContainText("It is tracked upstream");
    await page.screenshot({ path: join(SHOTS, "toc-hover.png") });
    await page.mouse.move(400, 300);

    // Usage: the reply with the table, hovered, then its Usage action.
    const tableTurn = page.locator('[data-turn="a-1"]');
    await tableTurn.hover();
    await tableTurn.getByRole("button", { name: "Usage" }).hover();
    await expect(page.getByText(/Cache hit \d+%/)).toBeVisible();
    await expect(page.getByText(/input .* output .* cached/)).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "usage-tooltip.png") });
    await page.mouse.move(10, 10);
    await setTheme(app, page, "light");

    // ─── Send from the composer through the stand-in CLI ────────────────────
    const box = chat.getByRole("textbox", { name: "Message Claude" });
    await box.fill("ping from the composer");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      chat.getByText("ping from the composer", { exact: true }),
    ).toBeVisible();
    await expect(chat.getByText("pong", { exact: true })).toBeVisible();
    // In the transcript now, read back: the bubble is the transcript's, not
    // the optimistic one, and there is one of each.
    await expect(chat.getByText("Sending…")).toHaveCount(0);
    await expect(
      chat.getByText("ping from the composer", { exact: true }),
    ).toHaveCount(1);
    await expect(chat.getByText("pong", { exact: true })).toHaveCount(1);
    expect(await readFile(transcript, "utf8")).toContain(
      "ping from the composer",
    );
    // ⚠️ The engine's run, not the first: the harness probe (FE-61) also
    // asks this stand-in for `--version`.
    const engineArgs = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args.includes("-p"));
    expect(engineArgs[0]).toEqual(
      expect.arrayContaining([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--resume",
        CHAT_ID,
        "--permission-prompt-tool",
        "stdio",
      ]),
    );
    await page.screenshot({ path: join(SHOTS, "chat-after-send.png") });

    // ─── Terminal, and back to the chat ─────────────────────────────────────
    // The chat's Terminal button lives in the rail row's menu now.
    await page
      .getByRole("button", { name: claudeRowName(TITLE), exact: true })
      .click({ button: "right" });
    const terminal = page.getByRole("menuitem", { name: "Open in terminal" });
    await expect(terminal).not.toHaveAttribute("aria-disabled", "true");
    await terminal.click();
    await expect(page).toHaveURL(/\/agents\/(?!chat\/)[^/]+$/);
    const region = page.getByRole("region", { name: `Claude — ${TITLE}` });
    await expect(region.locator(".xterm-rows")).toContainText(
      `ran-claude---resume-${CHAT_ID}`,
    );
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/chat/${CHAT_ID}$`));
    await expect(chat.getByText("pong", { exact: true })).toBeVisible();
    // The tab still runs it: the chat waits, one writer at a time.
    await expect(chat.getByText("Running in Terminal")).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

/** One more prompt and its answer, appended as Claude would write them. */
function appendTurn(transcript: string, repo: string) {
  return appendFile(
    transcript,
    jsonl([
      {
        type: "user",
        uuid: "long-u-extra",
        sessionId: LONG_ID,
        cwd: repo,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "One more after all that" },
      },
      {
        type: "assistant",
        uuid: "long-a-extra",
        sessionId: LONG_ID,
        cwd: repo,
        timestamp: new Date().toISOString(),
        message: {
          id: "msg_extra",
          role: "assistant",
          content: [{ type: "text", text: "The appended reply." }],
        },
      },
      { type: "system", subtype: "turn_duration", sessionId: LONG_ID },
    ]),
  );
}

/** Boot on a profile holding a long conversation of `prompts` prompts. */
async function openLong(prompts: number) {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-alpha", board);
  const { profile, home, repo, agentHome } = await seedProfile(plane.origin);
  const transcript = await seedLong(agentHome, repo, prompts);
  const app = await boot(profile, home, plane.origin, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_CLAUDE_BIN: join(profile, "no-such-claude"),
  });
  const page = await app.firstWindow();
  await switchTo(page, "Alpha");
  const row = page.getByRole("button", {
    name: claudeRowName(LONG_TITLE),
    exact: true,
  });
  await expect(row).toBeVisible();
  const chat = page.getByRole("region", { name: `Claude — ${LONG_TITLE}` });
  return {
    page,
    row,
    chat,
    repo,
    transcript,
    close: async () => {
      await app.close();
      await plane.close();
      await removeProfile(profile);
    },
  };
}

test("V6: a long conversation stays responsive", async () => {
  test.setTimeout(90_000);
  const PROMPTS = 300;
  const { page, row, chat, repo, transcript, close } = await openLong(PROMPTS);
  try {
    const started = Date.now();
    await row.click();
    const lastReply = chat.getByText(`Answer number ${PROMPTS}.`, {
      exact: true,
    });
    await expect(lastReply).toBeInViewport({ timeout: 5_000 });
    const opened = Date.now() - started;
    console.log(`V6: ${PROMPTS * 2} turns, last reply in view in ${opened} ms`);
    expect(opened).toBeLessThan(5_000);
    const turns = page.locator("[data-turn]");
    await expect(turns).toHaveCount(PROMPTS * 2);

    // An early turn, marked — it must be the same element after a re-read.
    const early = "long-a-2";
    await page.evaluate((id) => {
      const node = document.querySelector(`[data-turn="${id}"]`);
      if (!node) throw new Error(`no turn ${id}`);
      node.setAttribute("data-marked", "yes");
      (window as unknown as { __marked: Element }).__marked = node;
    }, early);

    // One more turn written: main's watcher re-reads, the turn appears.
    await appendTurn(transcript, repo);
    const appended = chat.getByText("The appended reply.", { exact: true });
    await expect(turns).toHaveCount(PROMPTS * 2 + 2, { timeout: 10_000 });
    await expect(appended).toBeAttached();
    expect(
      await page.evaluate((id) => {
        const node = document.querySelector(`[data-turn="${id}"]`);
        return {
          marked: node?.getAttribute("data-marked") ?? null,
          same: node === (window as unknown as { __marked: Element }).__marked,
        };
      }, early),
    ).toEqual({ marked: "yes", same: true });

    // To the top, then back to the end by ⌄.
    const down = chat.getByRole("button", { name: "Scroll to the end" });
    await chat
      .locator(".overflow-y-auto")
      .first()
      .evaluate((node) => {
        node.scrollTop = 0;
      });
    await expect(
      chat.getByText("Question number 1", { exact: true }),
    ).toBeInViewport();
    await expect(down).toBeVisible();
    await down.click();
    await expect(appended).toBeInViewport();
    await expect(down).toHaveCount(0);
  } finally {
    await close();
  }
});

/**
 * ⚠️ Fails on the FE-62 build this was written against: the composer mounts
 * after the first read (its settings load on their own), the scroller loses
 * its height, and the scroll event that follows finds the reader ~50–130 px
 * from the end — so the view opens with ⌄ showing and does not follow a new
 * turn. `conversation-view.tsx` observes only the content's size, not the
 * scroller's.
 */
test("V6: a long conversation opens at its end and follows a new turn", async () => {
  test.setTimeout(60_000);
  const { row, chat, repo, transcript, close } = await openLong(60);
  try {
    await row.click();
    await expect(
      chat.getByText("Answer number 60.", { exact: true }),
    ).toBeInViewport();
    await expect(
      chat.getByRole("textbox", { name: "Message Claude" }),
    ).toBeVisible();
    // Settled at the end: nothing below to scroll to.
    const down = chat.getByRole("button", { name: "Scroll to the end" });
    await expect(down).toHaveCount(0);
    await appendTurn(transcript, repo);
    await expect(
      chat.getByText("The appended reply.", { exact: true }),
    ).toBeInViewport({ timeout: 10_000 });
    await expect(down).toHaveCount(0);
  } finally {
    await close();
  }
});
