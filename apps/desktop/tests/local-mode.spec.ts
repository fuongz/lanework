// FE-52: the app without an account. "Skip for now" on the sign-in step opens
// it on a SQLite store at `<LANEWORK_HOME>/data.sqlite` (D1, D5); what is made
// there survives a restart (V4); and what only the cloud can back is hidden
// until somebody signs in (D10, V5).
//
// ⚠️ Against the REAL app, booted with an isolated `LANEWORK_HOME` and a dead
// control plane: local mode must work with nothing on the other end, so a
// test that let it reach one would prove less than it claims.

import { spawn } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { Workspace } from "../shared/workspaces";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

const PROJECT = "Local notes";
const CARD = "Written with no account";

async function launch(env: Record<string, string>) {
  const app = await electron.launch({ args: [process.cwd()], env });
  return { app, page: await app.firstWindow() };
}

/** Welcome → appearance → the gate, then past it without an account. */
async function skipSignIn(page: Page) {
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to continue" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  // In the app: the gate is gone and the rail is drawn.
  await expect(
    page.getByRole("heading", { name: "Sign in to continue" }),
  ).toBeHidden();
}

/** The first project, from the empty landing page, then one card in it. */
async function createProjectAndCard(page: Page) {
  await page.getByRole("button", { name: "Create your first project" }).click();
  await page.getByLabel("New project name").fill(PROJECT);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(
    page.getByRole("button", { name: `Switch project — currently ${PROJECT}` }),
  ).toBeVisible();
  // Signed out, the board draws no "Local" bar: the rail's badge says it.
  await expect(page.getByRole("status", { name: "Local project" })).toHaveCount(
    0,
  );

  await page.keyboard.press("ControlOrMeta+n");
  const title = page.getByRole("textbox", { name: "Issue title" });
  await expect(title).toBeFocused();
  await title.fill(CARD);
  // D4: a category mints a task id on the local board, as on the cloud — and
  // only a card with one opens on its own page after Save.
  await page.getByRole("combobox", { name: "Category" }).click();
  await page.getByRole("option", { name: "Frontend" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => page.url()).toContain("/issues/FE-01");
  await expect(page.getByRole("textbox", { name: "Card title" })).toHaveValue(
    CARD,
  );
}

async function closeQuietly(app: ElectronApplication | null) {
  await app?.close().catch(() => undefined);
}

test("Skip for now opens a local board that survives a restart", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lanew-local-"));
  const home = await mkdtemp(join(tmpdir(), "lanew-local-home-"));
  const env = launchEnv({ profile, home });
  let app: ElectronApplication | null = null;
  try {
    let page: Page;
    ({ app, page } = await launch(env));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await skipSignIn(page);
    await createProjectAndCard(page);

    // D1: one SQLite file, in the app home — not in Electron's userData.
    await expect(access(join(home, "data.sqlite"))).resolves.toBeUndefined();
    expect(errors).toEqual([]);

    // Relaunch: the choice is remembered (no onboarding, no gate), and the
    // project and its card are read back off disk.
    await app.close();
    ({ app, page } = await launch(env));
    await expect(
      page.getByRole("button", {
        name: `Switch project — currently ${PROJECT}`,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Welcome to Lanework" }),
    ).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeHidden();
    await expect(page.getByText(CARD).first()).toBeVisible();
    await expect(access(join(home, "data.sqlite"))).resolves.toBeUndefined();
  } finally {
    await closeQuietly(app);
    await removeProfile(profile, home);
  }
});

test("cloud-only features are hidden in local mode and come back after sign-in", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lanew-local-d10-"));
  const home = await mkdtemp(join(tmpdir(), "lanew-local-d10-home-"));
  let app: ElectronApplication | null = null;
  const cloud: Workspace[] = [
    {
      id: "ws-cloud-project",
      slug: "cloud-project",
      name: "Cloud project",
      path: null,
      baseBranch: null,
    },
  ];
  const plane = await startStubPlane({ workspaces: cloud });
  try {
    let page: Page;
    ({ app, page } = await launch(launchEnv({ profile, home })));
    await skipSignIn(page);
    await createProjectAndCard(page);

    // Per board (D10): a local card has no thread, no followers, no files.
    await expect(
      page.getByRole("textbox", { name: "Leave a comment" }),
    ).toBeHidden();
    await expect(page.getByRole("button", { name: "Subscribe" })).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Unsubscribe" }),
    ).toBeHidden();

    // The rail offers the way in (D5): a badge beside Settings, opening it.
    await page.getByRole("button", { name: "Local mode" }).click();
    const rail = page.getByRole("region", { name: "Local mode" });
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("button", { name: "Sign in" })).toBeVisible();

    // App-wide (D10): no machine, no account, a Sign in button instead.
    await page.goto("app://lanework/settings/account");
    await expect(page.getByText("Not signed in")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }).last(),
    ).toBeVisible();
    await expect(page.getByText("Machine name")).toBeHidden();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();

    // D9: the checkpoint hook writes to the local store, so its switch stays
    // in local mode; only the machine credential row is cloud-only.
    await page.goto("app://lanework/settings/harness");
    await expect(
      page.getByRole("heading", { name: "Harness", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("switch", {
        name: "Save progress for the next agent — Claude Code",
      }),
    ).toBeVisible();
    await expect(page.getByText("In the Keychain")).toBeHidden();

    // Signing in, as far as this app can see it: a machine credential on disk
    // the control plane accepts. (The browser half is `auth.spec.ts`'s.)
    await app.close();
    app = null;
    await seedCredential(home, plane.origin);
    ({ app, page } = await launch(
      launchEnv({ profile, home, apiUrl: plane.origin }),
    ));
    // Let the app land on the route it restores before navigating away, or
    // the two navigations race and ours is aborted.
    await expect(
      page.getByRole("button", { name: /^Switch project/ }),
    ).toBeVisible();

    await page.goto("app://lanework/settings/account");
    await expect(page.getByText("Machine name")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByText("Not signed in")).toBeHidden();

    await page.goto("app://lanework/settings/agents");
    await expect(
      page.getByRole("switch", {
        name: "Save progress for the next agent — Claude Code",
      }),
    ).toBeVisible();

    // D6a: the local project stays, beside the account's, marked Local and
    // one click from the cloud. The rail no longer says "Local mode".
    await page.goto("app://lanework/settings/workspaces");
    await expect(
      page.getByRole("button", { name: `Select ${PROJECT}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Select Cloud project" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("button", { name: `Select ${PROJECT}` })
        .getByText("Local", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Sync ${PROJECT} to cloud` }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sync Cloud project to cloud" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Local mode" })).toHaveCount(
      0,
    );
  } finally {
    await closeQuietly(app);
    await plane.close();
    await removeProfile(profile, home);
  }
});

// D8/V7: Settings → Agents adds the `lanework` MCP entry. In local mode it is
// the offline server over stdio (the app's shim); once signed in, the app
// points the same entry at the cloud over HTTP. Both config files live under
// the test profile (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), never the real ones.
test("the lanework MCP entry is stdio in local mode and HTTP after sign-in", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lanew-local-mcp-"));
  const home = await mkdtemp(join(tmpdir(), "lanew-local-mcp-home-"));
  const claudeJson = join(profile, "claude", ".claude.json");
  const codexToml = join(profile, "codex", "config.toml");
  const entry = async () =>
    JSON.parse(await readFile(claudeJson, "utf8")).mcpServers?.lanework;
  let app: ElectronApplication | null = null;
  const plane = await startStubPlane({ workspaces: [] });
  try {
    let page: Page;
    ({ app, page } = await launch(launchEnv({ profile, home })));
    await skipSignIn(page);
    await page.goto("app://lanework/settings/agents");
    for (const agent of ["Claude Code", "Codex"]) {
      const toggle = page.getByRole("switch", {
        name: `Lanework MCP — ${agent}`,
      });
      await expect(toggle).toBeEnabled();
      await toggle.click();
      await expect(toggle).toBeChecked();
    }
    const shim = join(home, "bin", "lanework-mcp");
    expect(await entry()).toMatchObject({ type: "stdio", command: shim });
    expect(await readFile(codexToml, "utf8")).toContain(shim);
    await access(shim);

    await app.close();
    app = null;
    await seedCredential(home, plane.origin);
    ({ app, page } = await launch(
      launchEnv({ profile, home, apiUrl: plane.origin }),
    ));
    await expect(
      page
        .getByRole("button", {
          name: /^Switch project|Create your first project/,
        })
        .first(),
    ).toBeVisible();
    await expect.poll(entry).toMatchObject({ type: "http" });
    expect((await entry()).url).toMatch(/^https:\/\/mcp\.lanework\.dev/);
    await expect
      .poll(() => readFile(codexToml, "utf8"))
      .toMatch(/url\s*=\s*"https:\/\/mcp\.lanework\.dev/);
  } finally {
    await closeQuietly(app);
    await plane.close();
    await removeProfile(profile, home);
  }
});

/**
 * Drive the BUILT offline MCP (`dist/electron/mcp-local/server.cjs`) the way
 * an agent would, under Electron's own Node, against one app home.
 */
async function mcpCalls(
  home: string,
  calls: { name: string; arguments: Record<string, unknown> }[],
): Promise<unknown[]> {
  const electronPath = createRequire(import.meta.url)("electron") as string;
  const child = spawn(electronPath, ["dist/electron/mcp-local/server.cjs"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LANEWORK_HOME: home },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines: string[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    lines.push(...parts.filter(Boolean));
  });
  const send = (message: object) =>
    child.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "test" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  for (const [index, call] of calls.entries())
    send({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: call });

  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  return lines
    .map((line) => JSON.parse(line))
    .filter((message) => message.id > 0)
    .sort((a, b) => a.id - b.id)
    .map((message) => {
      if (message.error || message.result.isError)
        throw new Error(JSON.stringify(message.error ?? message.result));
      return JSON.parse(message.result.content[0].text);
    });
}

// V6: an agent writes through the offline MCP while the board is open, and the
// board shows it — no reload, no network.
test("a card created through the offline MCP appears on the open local board", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lanew-local-mcp-live-"));
  const home = await mkdtemp(join(tmpdir(), "lanew-local-mcp-live-home-"));
  let app: ElectronApplication | null = null;
  try {
    let page: Page;
    ({ app, page } = await launch(launchEnv({ profile, home })));
    await skipSignIn(page);
    await createProjectAndCard(page);
    await page.getByRole("link", { name: /^Issues/ }).click();
    await expect(page.getByText(CARD).first()).toBeVisible();

    const [boards] = (await mcpCalls(home, [
      { name: "list_boards", arguments: {} },
    ])) as [{ boards: { workspaceId: string; name: string }[] }];
    const board = boards.boards.find((entry) => entry.name === PROJECT);
    expect(board).toBeTruthy();
    const [created] = (await mcpCalls(home, [
      {
        name: "create_review",
        arguments: {
          board_id: board?.workspaceId,
          title: "Opened by an agent",
          category: "frontend",
          priority: "medium",
          tags: ["mcp"],
        },
      },
    ])) as [{ item: { taskId: string } }];
    expect(created.item.taskId).toBe("FE-02");

    await expect(page.getByText("Opened by an agent").first()).toBeVisible();
  } finally {
    await closeQuietly(app);
    await removeProfile(profile, home);
  }
});
