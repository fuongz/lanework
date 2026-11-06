import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  type Page,
  test,
} from "@playwright/test";
import { claudeProjectDir } from "../electron/main/terminal/agent-sessions";
import { conversationChannels } from "../shared/conversation";
import type { DesktopTerminalApi } from "../shared/terminal";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

/**
 * The app's best screens, for a post — not for QA.
 *
 * ⚠️ NOT a test — it asserts nothing and is excluded from `production`, like
 * `gallery.spec.ts`. The gallery shows every state (errors, empties) at 1x;
 * this shows five full screens with believable data, light mode, at 2x —
 * each twice: the raw window, and the same window framed on a backdrop with
 * the macOS traffic lights drawn back in (a page screenshot cannot see them).
 *
 * - The project is a LOCAL board, so every shot carries the rail's
 *   "Continue anywhere" card.
 * - The sessions are pulled once, before the first shot, so the rail's
 *   Sessions list is the same in every picture: the five newest, then its
 *   "Show N more".
 *
 * ⚠️ It drives the REAL built app — run `bun run build` first:
 *
 *   bun run showcase
 *
 * Out: `.agents/artifacts/showcase/` — `raw/*.png` and `framed/*.jpg`
 * (JPEG, so a 3200px shot stays under X's 5 MB image limit).
 */
const OUT = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  ".agents",
  "artifacts",
  "showcase",
);

/** The window's content size, in CSS px. 16:10, and fits a 14" MacBook. */
const WIDTH = 1440;
const HEIGHT = 900;

const PROJECT_NAME = "Lanework";
const REPO = "fuongz/lanework";
const ME = "phuong";
const CHAT_ID = "5ca1ab1e-2222-4333-8444-555555555555";
const CHAT_TITLE = "End idle chat engines";

// ── The board ────────────────────────────────────────────────────────────────
type Seed = [
  title: string,
  column: string,
  category: string,
  priority: "low" | "medium" | "high" | null,
  tags: string[],
  users: string[],
];

/** Card 0 is the one the detail shot opens. */
const SEEDS: Seed[] = [
  [
    "End idle chat engines, with a power saver setting",
    "processing",
    "frontend",
    "high",
    ["conversation", "power"],
    ["test-user"],
  ],
  [
    "Conductors: a saved team lead per repo",
    "processing",
    "product-design",
    "high",
    ["conductor"],
    ["u-linh"],
  ],
  [
    "Stream a card's checklist to sub-agents",
    "processing",
    "backend",
    "medium",
    ["streams", "mcp"],
    ["u-sam"],
  ],
  [
    "Pull request diff remembers the scroll position",
    "review",
    "frontend",
    "medium",
    ["pulls"],
    ["test-user"],
  ],
  [
    "Checkpoints survive a laptop-to-cloud handoff",
    "review",
    "backend",
    "high",
    ["checkpoint"],
    ["u-sam"],
  ],
  [
    "Init Git beside Open Settings on a bare folder",
    "done",
    "frontend",
    "low",
    ["files"],
    ["u-linh"],
  ],
  [
    "Local and cloud boards in one project switcher",
    "done",
    "product-design",
    "medium",
    ["projects"],
    ["test-user"],
  ],
  [
    "Sign and notarize the macOS build in CI",
    "done",
    "infrastructure",
    "high",
    ["release"],
    ["u-sam"],
  ],
  [
    "Command palette jumps by task id",
    "todo",
    "frontend",
    "medium",
    ["palette"],
    [],
  ],
  [
    "Voice dictation in the composer",
    "todo",
    "product-design",
    "low",
    ["composer"],
    ["u-linh"],
  ],
  ["Rate-limit the MCP per machine", "todo", "backend", "medium", ["mcp"], []],
  [
    "Agent guide: resuming a card from its checkpoint",
    "todo",
    "documentation",
    "low",
    ["docs"],
    ["test-user"],
  ],
  [
    "Windows build behind a flag",
    "backlog",
    "infrastructure",
    "low",
    ["release"],
    [],
  ],
  ["Per-lane WIP limits", "backlog", "product-design", null, ["board"], []],
];

const DETAIL_BODY = `## Context

A chat keeps its \`claude -p\` engine alive after the tab closes. On a laptop that
is a process per conversation, waking the CPU for nothing.

- End an engine after **10 minutes** with no turn in flight
- Resume transparently on the next prompt — the transcript is the state
- A **Power saver** setting shortens the timeout to 2 minutes

## Out of scope

Terminal sessions; they belong to the user's shell.

| File | Change |
| --- | --- |
| \`electron/main/conversation/idle.ts\` | the idle timer |
| \`src/routes/settings/power.tsx\` | the setting |`;

/** Card 0's checklist: decisions approved, verification under way. */
const DETAIL_CHECKLIST = [
  ["decisions", "Idle timeout is 10 min, 2 min with Power saver", true],
  ["decisions", "Resume from the transcript, not a kept process", true],
  ["decisions", "Follow macOS Low Power Mode", true],
  ["verify", "bun run gate is green", true],
  ["verify", "Activity Monitor shows no claude after 10 min", true],
  ["verify", "The next prompt answers within 2 s", false],
] as const;

// ── The repository ───────────────────────────────────────────────────────────

const IDLE_V1 = `import type { Engine } from "./engine";

/** End an engine nobody has talked to for \`ms\`. */
export function watchIdle(engine: Engine, ms: number) {
  let timer = setTimeout(() => engine.end("idle"), ms);
  engine.on("turn", () => {
    clearTimeout(timer);
    timer = setTimeout(() => engine.end("idle"), ms);
  });
}
`;

const IDLE_V2 = `import type { Engine } from "./engine";
import { powerSaver } from "../power";

const DEFAULT_MS = 10 * 60_000;
const SAVER_MS = 2 * 60_000;

/**
 * End an engine nobody has talked to. A turn in flight is never cut:
 * the timer restarts when the turn ends, not when it starts.
 */
export function watchIdle(engine: Engine) {
  const timeout = () => (powerSaver() ? SAVER_MS : DEFAULT_MS);
  let timer = setTimeout(() => engine.end("idle"), timeout());
  engine.on("turn:start", () => clearTimeout(timer));
  engine.on("turn:end", () => {
    clearTimeout(timer);
    timer = setTimeout(() => engine.end("idle"), timeout());
  });
  return () => clearTimeout(timer);
}
`;

const POWER = `import { powerMonitor } from "electron";
import { settings } from "./settings";

/** Power saver: the setting, or macOS Low Power Mode when it follows the OS. */
export function powerSaver(): boolean {
  const mode = settings.get("powerSaver");
  if (mode === "on") return true;
  if (mode === "off") return false;
  return powerMonitor.isOnBatteryPower();
}
`;

const SETTINGS_PAGE = `import { SettingsRow, SettingsSection } from "@/components/settings";
import { Select } from "@/components/ui/select";

export function PowerSettings() {
  return (
    <SettingsSection title="Power">
      <SettingsRow
        label="Power saver"
        description="End idle chat engines after 2 minutes instead of 10."
      >
        <Select
          name="powerSaver"
          options={[
            { value: "auto", label: "On battery" },
            { value: "on", label: "Always" },
            { value: "off", label: "Never" },
          ]}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
`;

function git(repo: string, args: string[], env: Record<string, string> = {}) {
  execFileSync("git", args, {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
}

/** Commit everything as `author`, `hoursAgo` back. */
function commit(
  repo: string,
  author: [string, string],
  hoursAgo: number,
  message: string,
) {
  const date = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", message], {
    GIT_AUTHOR_NAME: author[0],
    GIT_AUTHOR_EMAIL: author[1],
    GIT_COMMITTER_NAME: author[0],
    GIT_COMMITTER_EMAIL: author[1],
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

async function put(repo: string, path: string, text: string) {
  await mkdir(join(repo, path, ".."), { recursive: true });
  await writeFile(join(repo, path), text);
}

const SCAFFOLD: [string, string][] = [
  [
    "tsconfig.json",
    `${JSON.stringify({ compilerOptions: { strict: true, module: "esnext", jsx: "react-jsx" } }, null, 2)}\n`,
  ],
  ["biome.jsonc", '{\n  "formatter": { "indentStyle": "space" }\n}\n'],
  [".gitignore", "node_modules/\ndist/\n.agents/artifacts/\n"],
  [
    "AGENTS.md",
    "# Instructions for AI agents\n\nRecord your work on the lanework board.\n",
  ],
  [
    "electron/main/index.ts",
    'import { app } from "electron";\n\napp.whenReady().then(() => import("./window"));\n',
  ],
  [
    "electron/main/window.ts",
    'import { BrowserWindow } from "electron";\n\nexport const window = new BrowserWindow({ width: 1120, height: 760 });\n',
  ],
  [
    "electron/preload/index.ts",
    'import { contextBridge } from "electron";\n\ncontextBridge.exposeInMainWorld("desktop", {});\n',
  ],
  [
    "src/main.tsx",
    'import { createRoot } from "react-dom/client";\nimport { App } from "./app";\n\ncreateRoot(document.body).render(<App />);\n',
  ],
  ["src/app.tsx", "export function App() {\n  return <main />;\n}\n"],
  [
    "src/components/ui/button.tsx",
    'export function Button(props: React.ComponentProps<"button">) {\n  return <button type="button" {...props} />;\n}\n',
  ],
  [
    "src/components/ui/select.tsx",
    "export function Select() {\n  return null;\n}\n",
  ],
  ["src/stores/board.ts", "export const board = { cards: [] };\n"],
  ["src/stores/session.ts", "export const session = { principal: null };\n"],
  ["docs/agents/lanes.md", "# Lanes\n\ntodo, processing, review, done.\n"],
];

/** A checkout with a short, believable history and work in progress. */
async function makeRepo(repo: string): Promise<string> {
  const phuong: [string, string] = ["Phuong Phung", "phuong@example.com"];
  const linh: [string, string] = ["Linh Tran", "linh@example.com"];
  const sam: [string, string] = ["Sam Patel", "sam@example.com"];
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["remote", "add", "origin", `https://github.com/${REPO}.git`]);

  await put(
    repo,
    "README.md",
    "# Lanework\n\nA board your coding agents work from.\n",
  );
  await put(
    repo,
    "package.json",
    `${JSON.stringify({ name: "lanework", private: true, scripts: { gate: "bun run typecheck && bun run build" } }, null, 2)}\n`,
  );
  // Enough of a tree that the Files shot reads as a real project.
  for (const [path, text] of SCAFFOLD) await put(repo, path, text);
  commit(repo, phuong, 96, "chore: scaffold the desktop app");
  await put(
    repo,
    "src/board/issues.tsx",
    "export function Issues() {\n  return null;\n}\n",
  );
  commit(
    repo,
    linh,
    72,
    "feat(board): issues as an inbox list, grouped by status",
  );
  await put(
    repo,
    "electron/main/conversation/engine.ts",
    "export interface Engine {\n  end(reason: string): void;\n  on(event: string, listener: () => void): void;\n}\n",
  );
  commit(repo, sam, 50, "feat(chat): render a Claude transcript as a chat");
  await put(repo, "electron/main/conversation/idle.ts", IDLE_V1);
  commit(repo, phuong, 30, "feat(conversation): end idle chat engines");
  await put(repo, "electron/main/conversation/idle.ts", IDLE_V2);
  await put(repo, "electron/main/power.ts", POWER);
  commit(
    repo,
    phuong,
    3,
    "feat(conversation): a power saver that shortens the idle timeout (FE-126)",
  );
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
    .toString()
    .trim();
  await put(
    repo,
    "docs/agents/checkpoint-hook.md",
    "# Checkpoint hook\n\nRuns after every turn.\n",
  );
  commit(repo, linh, 1, "docs(agents): document the checkpoint hook");

  // Work in progress — what the Changes shot shows.
  await put(repo, "src/routes/settings/power.tsx", SETTINGS_PAGE);
  await put(
    repo,
    "README.md",
    "# Lanework\n\nA board your coding agents work from.\n\n## Power saver\n\nIdle chat engines end after 10 minutes — 2 with Power saver on.\n",
  );
  return sha;
}

// ── The Claude conversation ──────────────────────────────────────────────────

const jsonl = (lines: unknown[]) =>
  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

async function seedChat(agentHome: string, repo: string) {
  const file = join(
    agentHome,
    ".claude",
    "projects",
    claudeProjectDir(repo),
    `${CHAT_ID}.jsonl`,
  );
  await mkdir(join(file, ".."), { recursive: true });
  const start = Date.now() - 40 * 60_000;
  const at = (s: number) => new Date(start + s * 1000).toISOString();
  const common = {
    sessionId: CHAT_ID,
    cwd: repo,
    gitBranch: "feat/power-saver",
  };
  const usage = (output: number) => ({
    input_tokens: 14,
    cache_creation_input_tokens: 3_120,
    cache_read_input_tokens: 41_870,
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
  const turnEnd = (n: number) => ({
    ...common,
    type: "system",
    subtype: "turn_duration",
    timestamp: at(n),
  });
  const tool = (
    n: number,
    uuid: string,
    id: string,
    toolId: string,
    name: string,
    input: unknown,
  ) =>
    assistant(n, uuid, id, [{ type: "tool_use", id: toolId, name, input }], 90);
  const result = (n: number, uuid: string, toolId: string, content: string) =>
    user(n, uuid, [{ type: "tool_result", tool_use_id: toolId, content }]);

  const plan = [
    "Each chat keeps its engine running until the app quits — I found **4 idle `claude` processes** after closing their tabs.",
    "",
    "### What I'll change",
    "",
    "| Where | Change | Why |",
    "| --- | --- | --- |",
    "| `idle.ts` | restart the timer on `turn:end` | a long turn is never cut |",
    "| `power.ts` | `powerSaver()` reads the setting | 2 min instead of 10 |",
    "| `settings/power.tsx` | a **Power saver** select | On battery, Always, Never |",
    "",
    "The engine resumes from the transcript on the next prompt, so ending it loses nothing:",
    "",
    "```ts",
    'engine.on("turn:end", () => {',
    "  clearTimeout(timer);",
    '  timer = setTimeout(() => engine.end("idle"), timeout());',
    "});",
    "```",
  ].join("\n");

  await writeFile(
    file,
    jsonl([
      { type: "mode", mode: "normal", sessionId: CHAT_ID },
      user(
        0,
        "u-1",
        "Chat engines keep running after I close a chat. End them when they're idle, and add a power saver setting (FE-126).",
      ),
      assistant(
        2,
        "a-1",
        "msg_1",
        [
          {
            type: "text",
            text: "Let me look at how an engine's lifetime is managed today.",
          },
        ],
        40,
      ),
      tool(3, "a-2", "msg_1", "t-read", "Read", {
        file_path: join(repo, "electron/main/conversation/idle.ts"),
      }),
      tool(4, "a-3", "msg_1", "t-grep", "Grep", {
        pattern: "engine\\.end\\(",
        path: join(repo, "electron"),
      }),
      tool(5, "a-4", "msg_1", "t-bash", "Bash", {
        command: "pgrep -fl 'claude -p' | wc -l",
        description: "Count running chat engines",
      }),
      result(6, "u-r1", "t-read", IDLE_V1),
      result(7, "u-r2", "t-grep", "electron/main/conversation/idle.ts:5"),
      result(8, "u-r3", "t-bash", "4"),
      assistant(14, "a-5", "msg_2", [{ type: "text", text: plan }], 520),
      turnEnd(14),
      user(60, "u-2", "Looks right. Go ahead."),
      tool(64, "a-6", "msg_3", "t-edit", "Edit", {
        file_path: join(repo, "electron/main/conversation/idle.ts"),
        old_string: IDLE_V1,
        new_string: IDLE_V2,
      }),
      result(
        65,
        "u-r4",
        "t-edit",
        "The file electron/main/conversation/idle.ts has been updated.",
      ),
      tool(66, "a-7", "msg_3", "t-write", "Write", {
        file_path: join(repo, "electron/main/power.ts"),
        content: POWER,
      }),
      result(
        67,
        "u-r5",
        "t-write",
        "File created successfully at: electron/main/power.ts",
      ),
      tool(70, "a-8", "msg_3", "t-gate", "Bash", {
        command: "bun run gate",
        description: "Typecheck and build",
      }),
      result(98, "u-r6", "t-gate", "✓ typecheck  ✓ lint  ✓ build  (28.4s)"),
      assistant(
        100,
        "a-9",
        "msg_4",
        [
          {
            type: "text",
            text: "Done — `bun run gate` is green. An idle engine now ends after 10 minutes (2 with **Power saver**), and the next prompt resumes it from the transcript. I left the settings page for you to review in **Changes**.",
          },
        ],
        84,
      ),
      turnEnd(100),
      { type: "ai-title", aiTitle: CHAT_TITLE, sessionId: CHAT_ID },
    ]),
  );
}

/**
 * More conversations, so the rail's Sessions list looks lived in: a prompt
 * and an answer each, spread over the last few days.
 */
const SESSIONS: [title: string, prompt: string, minutesAgo: number][] = [
  ["Fix flaky login test on CI", "Why does the login test flake on CI?", 95],
  [
    "Draft the conductor's lead prompt",
    "Write the team lead's instructions for the release conductor.",
    260,
  ],
  [
    "Diff gutter contrast in dark mode",
    "The diff gutter is too faint in dark mode. Fix the token.",
    540,
  ],
  [
    "Speed up History for 10k commits",
    "History takes 3 s on a 10k-commit repo. Profile it.",
    1_300,
  ],
  [
    "Document the checkpoint hook",
    "Write docs/agents/checkpoint-hook.md from the code.",
    1_700,
  ],
  [
    "Bump Electron to 39.2",
    "Bump Electron to 39.2 and fix what breaks.",
    2_900,
  ],
  [
    "Sketch a Linux AppImage build",
    "What would a Linux AppImage build need?",
    4_400,
  ],
  [
    "Rename workspace to project",
    "Say project instead of workspace across the app.",
    6_000,
  ],
];

async function seedSessions(agentHome: string, repo: string) {
  await Promise.all(
    SESSIONS.map(async ([title, prompt, ago], i) => {
      const id = `5e55${String(i).padStart(4, "0")}-2222-4333-8444-555555555555`;
      const file = join(
        agentHome,
        ".claude",
        "projects",
        claudeProjectDir(repo),
        `${id}.jsonl`,
      );
      const at = (s: number) =>
        new Date(Date.now() - ago * 60_000 + s * 1000).toISOString();
      const common = { sessionId: id, cwd: repo, gitBranch: "main" };
      await writeFile(
        file,
        jsonl([
          {
            ...common,
            type: "user",
            uuid: `${id}-u`,
            timestamp: at(0),
            message: { role: "user", content: prompt },
          },
          {
            ...common,
            type: "assistant",
            uuid: `${id}-a`,
            timestamp: at(20),
            message: {
              id: `msg_${i}`,
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              content: [{ type: "text", text: "On it." }],
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          },
          { type: "ai-title", aiTitle: title, sessionId: id },
        ]),
      );
    }),
  );
}

// ── GitHub, through a fake `gh` ──────────────────────────────────────────────

const FAKE_GH = join(import.meta.dirname, "fixtures", "fake-gh.mjs");

/** The repo's open GitHub issues, which the Issues screen lists too. */
const ISSUES = [
  [
    "Chat engine keeps running after the tab closes",
    "maya-codes",
    [
      ["bug", "d73a4a"],
      ["conversation", "1d76db"],
    ],
    4,
    1,
  ],
  [
    "Support Codex goals in the conductor view",
    "jkowalski",
    [["enhancement", "a2eeef"]],
    7,
    5,
  ],
  [
    "Dark mode: diff gutter is too low-contrast",
    "riya-dev",
    [
      ["bug", "d73a4a"],
      ["design", "f9d0c4"],
    ],
    2,
    9,
  ],
  [
    "Linux build (AppImage)",
    "tomas-h",
    [
      ["enhancement", "a2eeef"],
      ["release", "fbca04"],
    ],
    12,
    20,
  ],
  [
    "Docs: how checkpoints hand a card between machines",
    "sam-patel",
    [["documentation", "0075ca"]],
    1,
    30,
  ],
].map(([title, author, labels, comments, hoursAgo], i) => ({
  number: 131 - i * 3,
  title,
  url: `https://github.com/${REPO}/issues/${131 - i * 3}`,
  state: "OPEN",
  author: { login: author },
  labels: (labels as string[][]).map(([name, color]) => ({ name, color })),
  assignees: i === 0 ? [{ login: ME }] : [],
  comments,
  createdAt: new Date(
    Date.now() - ((hoursAgo as number) + 48) * 3_600_000,
  ).toISOString(),
  updatedAt: new Date(
    Date.now() - (hoursAgo as number) * 3_600_000,
  ).toISOString(),
  body: "",
}));

/** A fake `gh` that knows the repo and its open issues — nothing to fail on. */
async function startFakeGh(profile: string) {
  const dir = join(profile, "gh");
  await mkdir(dir, { recursive: true });
  const bin = join(dir, "gh");
  await writeFile(
    bin,
    [
      "#!/bin/sh",
      `export FAKE_GH_STATE='${dir}'`,
      `exec '${process.execPath}' '${FAKE_GH}' "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    join(dir, "scenario.json"),
    JSON.stringify({
      account: "ok",
      user: { login: ME, avatar_url: null },
      repos: {
        [REPO]: {
          nameWithOwner: REPO,
          url: `https://github.com/${REPO}`,
          parent: null,
          viewerPermission: "WRITE",
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
        },
      },
      pulls: { [REPO]: [] },
      issues: { [REPO]: ISSUES },
      diffs: {},
      commits: {},
      contents: {},
      fail: [],
    }),
  );
  return bin;
}

// ── Capture ──────────────────────────────────────────────────────────────────

const shots: string[] = [];

/**
 * Hide what reads as noise in a post: the "doesn't trust this folder" notice
 * (the fixture folder is a temp dir) and the mouse's hover state.
 */
async function tidy(page: Page) {
  await page.mouse.move(WIDTH - 4, HEIGHT - 4);
  await page.evaluate(() => {
    const doc = (
      globalThis as unknown as {
        document: {
          querySelectorAll(s: string): ArrayLike<{
            textContent: string | null;
            closest(s: string): { style: { display: string } } | null;
            style: { display: string };
          }>;
        };
      }
    ).document;
    for (const node of Array.from(doc.querySelectorAll("p, div, span")))
      if (
        /trust this folder/i.test(node.textContent ?? "") &&
        (node.textContent ?? "").length < 200
      )
        (
          node.closest("[role=status], [role=note], [data-slot]") ?? node
        ).style.display = "none";
  });
}

async function capture(page: Page, name: string) {
  await tidy(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, "raw", `${name}.png`) });
  shots.push(name);
}

/** The backdrop page: one shot, framed, with the window chrome drawn back. */
function frameHtml(file: string): string {
  const scale = 0.92;
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1600px;height:1000px;overflow:hidden}
body{background:radial-gradient(1200px 700px at 12% 8%, #ffe1cc 0%, transparent 60%), radial-gradient(1000px 700px at 92% 95%, #dcd6ff 0%, transparent 60%), #f4f2ef;display:grid;place-items:center}
.win{position:relative;width:${WIDTH * scale}px;height:${HEIGHT * scale}px;border-radius:12px;overflow:hidden;
  box-shadow:0 0 0 0.5px rgba(0,0,0,.18),0 30px 80px -10px rgba(0,0,0,.28),0 12px 28px -8px rgba(0,0,0,.18)}
.win img{display:block;width:100%;height:100%}
.lights{position:absolute;left:${20 * scale}px;top:${15 * scale}px;display:flex;gap:${8 * scale}px}
.lights i{width:${12 * scale}px;height:${12 * scale}px;border-radius:50%;box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.2)}
</style><div class="win"><img src="${file}"><div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div></div>`;
}

async function frameAll(app: ElectronApplication) {
  await mkdir(join(OUT, "framed"), { recursive: true });
  for (const name of shots) {
    const html = join(OUT, "framed", `.${name}.html`);
    await writeFile(html, frameHtml(`../raw/${name}.png`));
    const opened = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow }, url) => {
      const win = new BrowserWindow({
        useContentSize: true,
        width: 1600,
        height: 1000,
        frame: false,
        show: true,
      });
      void win.loadURL(url);
    }, `file://${html}`);
    const page = await opened;
    await page.waitForLoadState("load");
    await page.waitForFunction(
      () =>
        (
          globalThis as unknown as {
            document: { images: ArrayLike<{ complete: boolean }> };
          }
        ).document.images[0]?.complete,
    );
    await page.screenshot({
      path: join(OUT, "framed", `${name}.jpg`),
      type: "jpeg",
      quality: 92,
    });
    await page.close();
  }
}

/** The renderer's `window.desktop`, the parts this file calls. */
interface Desktop {
  terminal: DesktopTerminalApi;
  projects: {
    folder: { choose(): Promise<{ id: string }[]> };
    create(
      name: string,
      folders: string[],
      destination: { kind: "local" },
    ): Promise<{
      projects: { id: string; slug: string; name: string; origin?: string }[];
    }>;
    board: {
      create(
        id: string,
        draft: Record<string, unknown>,
      ): Promise<
        | {
            kind: "ok";
            card: { id: string; taskId: string | null; revision: number };
          }
        | { kind: string }
      >;
      setChecklist(
        id: string,
        cardId: string,
        items: Record<string, unknown>[],
        revision: number,
      ): Promise<unknown>;
    };
  };
}

test("showcase", async () => {
  test.setTimeout(240_000);
  // A fresh set: an older run's shots would sit beside these and mislead.
  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, "raw"), { recursive: true });

  // Signed in, but with no cloud project: the local board is the only one,
  // and its rail card offers "Sync to cloud".
  const plane = await startStubPlane({ projects: [] });
  const profile = await mkdtemp(join(tmpdir(), "lanework-showcase-"));
  const home = join(profile, "home");
  const agentHome = join(profile, "agent-home");
  const repoRoot = await realpath(
    await mkdtemp(join(tmpdir(), "lanework-showcase-repo-")),
  );
  const repo = join(repoRoot, "lanework");
  await mkdir(repo, { recursive: true });
  await seedCredential(home, plane.origin);
  const commitSha = await makeRepo(repo);
  await seedChat(agentHome, repo);
  await seedSessions(agentHome, repo);
  // Claude's own trust record, so the chat has no "trust this folder" notice.
  await mkdir(join(profile, "claude"), { recursive: true });
  await writeFile(
    join(profile, "claude", ".claude.json"),
    JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
  );
  const ghBin = await startFakeGh(profile);

  const app = await electron.launch({
    // 2x on any display, not only a Retina one.
    args: ["--force-device-scale-factor=2", process.cwd()],
    env: {
      ...launchEnv({ profile, home, apiUrl: plane.origin }),
      LANEWORK_TEST_AGENT_HOME: agentHome,
      LANEWORK_TERMINAL_SHELL: "/bin/sh",
      LANEWORK_TERMINAL_AGENTS: "claude",
      LANEWORK_GH_PATH: ghBin,
      // What the folder chooser "returns" when the project is made.
      LANEWORK_TEST_FOLDERS: repo,
    },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(
      ({ BrowserWindow, nativeTheme }, size) => {
        nativeTheme.themeSource = "light";
        BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h);
      },
      { w: WIDTH, h: HEIGHT },
    );
    // No network: link previews answer from here.
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, url: string) => ({
        url,
        title: url,
        icon: null,
      }));
    }, conversationChannels.linkPreview);
    await page
      .getByRole("button", { name: /^Switch project/ })
      .waitFor({ timeout: 20_000 });

    // ── The local project: made as the New project dialog makes it ──────────
    const made = await page.evaluate(
      async ({ name, seeds, body, checklist }) => {
        const { projects, terminal } = (
          window as unknown as { desktop: Desktop }
        ).desktop;
        const picked = await projects.folder.choose();
        const snapshot = await projects.create(
          name,
          picked.map((folder) => folder.id),
          { kind: "local" },
        );
        const project = snapshot.projects.find(
          (entry) => entry.name === name && entry.origin === "local",
        );
        if (!project) throw new Error("no local project");
        let detail: string | null = null;
        for (const [
          i,
          [title, columnKey, categoryKey, priority, tags],
        ] of seeds.entries()) {
          const write = await projects.board.create(project.id, {
            title,
            body: i === 0 ? body : null,
            columnKey,
            categoryKey,
            priority,
            tags,
          });
          if (i !== 0 || write.kind !== "ok" || !("card" in write)) continue;
          detail = write.card.taskId;
          await projects.board.setChecklist(
            project.id,
            write.card.id,
            checklist.map(([section, text, checked]) => ({
              section,
              text,
              checked,
            })),
            write.card.revision,
          );
        }
        // Every session in now, so the rail lists the same ones in every shot.
        const { pulled } = await terminal.pullAgentSessions(project.id, [
          "claude",
        ]);
        if (!pulled) throw new Error("the Pull read no Claude session");
        window.dispatchEvent(new Event("focus"));
        return { slug: project.slug, detail };
      },
      {
        name: PROJECT_NAME,
        seeds: SEEDS,
        body: DETAIL_BODY,
        checklist: DETAIL_CHECKLIST,
      },
    );
    const base = `app://lanework/w/${made.slug}`;
    const banner = page.getByRole("region", {
      name: "Sync this project to the cloud",
    });
    const sessions = page.getByRole("button", {
      // The newest after the chat: the rail shows five, then "Show N more".
      name: `Open “${SESSIONS[0][0]}”`,
    });

    // ── 1. The board, with an issue open ────────────────────────────────────
    await page.goto(`${base}/issues/${made.detail}`);
    await banner.waitFor({ timeout: 15_000 });
    await sessions.waitFor({ timeout: 15_000 });
    await page
      .getByText("Idle timeout is 10 min")
      .first()
      .waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    await capture(page, "01-board-issue");

    // ── 2. Files, with a file open ──────────────────────────────────────────
    await page.goto(`${base}/files`);
    await page
      .getByRole("complementary", { name: "Files" })
      .waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.keyboard.press("ControlOrMeta+p");
    await page.getByPlaceholder("Go to file…").fill("idle.ts");
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await page.getByText("const SAVER_MS").first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await capture(page, "02-files");

    // ── 3. Changes, with a file's diff ──────────────────────────────────────
    await page.goto(`${base}/changes`);
    const changed = page.getByRole("complementary", { name: "Changed files" });
    await changed.getByText("power.tsx").first().waitFor({ timeout: 15_000 });
    await changed.getByText("power.tsx").first().click();
    await page.getByText("Power saver").first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    await capture(page, "03-changes");

    // ── 4. History, with a commit open ──────────────────────────────────────
    await page.goto(`${base}/history/${commitSha}`);
    await page
      .getByRole("button", { name: "Commit SHA" })
      .waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1200);
    await capture(page, "04-history");

    // ── 5. A Claude conversation ────────────────────────────────────────────
    await page.goto(`${base}/agents/chat/${CHAT_ID}`);
    const chat = page.getByRole("region", { name: `Claude — ${CHAT_TITLE}` });
    await chat.getByRole("table").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await chat
      .getByRole("table")
      .evaluate((node) => node.scrollIntoView({ block: "start" }));
    await capture(page, "05-agent-chat");

    await frameAll(app);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile, repoRoot);
  }
});
