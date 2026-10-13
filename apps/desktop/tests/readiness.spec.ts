// FE-30: whether a project's folder is ready for an agent to work its board.
// The rules are driven directly under Node (V1); the last cases boot the app
// on real folders and click through the indicator (V2, V3).
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { MachineRecord } from "../electron/main/auth/store";
import {
  applyFix,
  boardLinkOf,
  buildReport,
  claudeHasLanework,
  codexHasLanework,
  hasLaneworkNotes,
  importsAgentsMd,
  type ReadinessFacts,
} from "../electron/main/readiness/checks";
import { writeFolders } from "../electron/main/workspaces/store";
import { AGENT_NOTES, MCP_URL } from "../shared/agent-notes";
import type { Workspace } from "../shared/workspaces";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

const FOLDER = "/Users/ana/code/alpha";

test("board notes are recognised however they are worded", () => {
  expect(hasLaneworkNotes(null)).toBe(false);
  expect(hasLaneworkNotes("# Contributing\n\nRun the tests.")).toBe(false);
  expect(hasLaneworkNotes(AGENT_NOTES)).toBe(true);
  expect(hasLaneworkNotes("## Lanework\n\nCards go on the board.")).toBe(true);
  expect(hasLaneworkNotes(`MCP lives at ${MCP_URL}.`)).toBe(true);
  expect(hasLaneworkNotes("Call list_boards first.")).toBe(true);

  expect(importsAgentsMd("@AGENTS.md\n")).toBe(true);
  expect(importsAgentsMd("# Notes\n\n  @./AGENTS.md  \n")).toBe(true);
  expect(importsAgentsMd("See @AGENTS.md for more.")).toBe(false);
  expect(importsAgentsMd(null)).toBe(false);
});

test("Claude Code's three MCP scopes each count, and only for this folder", () => {
  const server = { type: "http", url: MCP_URL };
  const none = { folder: FOLDER, mcpJson: null, claudeJson: null };
  expect(claudeHasLanework(none)).toBe(false);
  // project: .mcp.json in the folder
  expect(
    claudeHasLanework({
      ...none,
      mcpJson: JSON.stringify({ mcpServers: { lanework: server } }),
    }),
  ).toBe(true);
  // user: ~/.claude.json's top level — by URL, whatever it is called
  expect(
    claudeHasLanework({
      ...none,
      claudeJson: JSON.stringify({ mcpServers: { board: server } }),
    }),
  ).toBe(true);
  // local: ~/.claude.json's entry for THIS folder, and not another one
  const local = (path: string) =>
    JSON.stringify({
      projects: { [path]: { mcpServers: { lanework: server } } },
    });
  expect(claudeHasLanework({ ...none, claudeJson: local(FOLDER) })).toBe(true);
  expect(
    claudeHasLanework({ ...none, claudeJson: local("/Users/ana/code/beta") }),
  ).toBe(false);
  // Some other server, and a file that is not JSON, are not ours.
  expect(
    claudeHasLanework({
      ...none,
      mcpJson: JSON.stringify({
        mcpServers: { github: { url: "https://api.github.com" } },
      }),
      claudeJson: "{ not json",
    }),
  ).toBe(false);
});

test("Codex's config.toml is read for a lanework server", () => {
  expect(codexHasLanework(null)).toBe(false);
  expect(codexHasLanework("[features]\nhooks = true\n")).toBe(false);
  expect(codexHasLanework(`[mcp_servers.lanework]\nurl = "${MCP_URL}"\n`)).toBe(
    true,
  );
  expect(codexHasLanework('[mcp_servers."lanework"]\n')).toBe(true);
  expect(
    codexHasLanework(`[mcp_servers.board]\nurl = "${MCP_URL}" # ours\n`),
  ).toBe(true);
  // The URL outside an mcp_servers table is somebody's comment, not a server.
  expect(codexHasLanework(`[notes]\nlink = "${MCP_URL}"\n`)).toBe(false);
});

test("which board a repo is linked to", () => {
  expect(boardLinkOf([], "ws-a")).toEqual({ kind: "none" });
  expect(boardLinkOf([{ workspaceId: "ws-a", name: "A" }], "ws-a")).toEqual({
    kind: "this",
  });
  expect(boardLinkOf([{ workspaceId: "ws-b", name: "B" }], "ws-a")).toEqual({
    kind: "other",
    name: "B",
  });
});

const ready: ReadinessFacts = {
  slug: "alpha",
  folder: {
    kind: "linked",
    path: FOLDER,
    remote: "git@github.com:acme/alpha.git",
    board: { kind: "this" },
    agentsMd: AGENT_NOTES,
    claudeMd: "@AGENTS.md\n",
    claudeMcp: true,
    legacyReviews: false,
  },
  claude: { used: true, hook: true },
  codex: { used: true, hook: true, mcp: true },
  checkedAt: "2026-09-27T00:00:00.000Z",
};

const failed = (facts: ReadinessFacts) =>
  buildReport(facts)
    .checks.filter((check) => !check.ok)
    .map((check) => [check.id, check.level]);

test("a ready folder passes every check that applies", () => {
  const report = buildReport(ready);
  expect(report.checks.map((check) => check.id)).toEqual([
    "folder",
    "remote",
    "board",
    "agents-md",
    "claude-md",
    "claude-mcp",
    "codex-mcp",
    "hook",
  ]);
  expect(failed(ready)).toEqual([]);
  expect(report.folder).toBe(FOLDER);
});

test("each missing piece is reported at its own level", () => {
  const linked = ready.folder as Extract<
    ReadinessFacts["folder"],
    { kind: "linked" }
  >;
  // No folder: nothing about the folder's files is claimed at all.
  expect(
    buildReport({ ...ready, folder: { kind: "none" } }).checks.map(
      (check) => check.id,
    ),
  ).toEqual(["folder", "codex-mcp", "hook"]);
  expect(
    failed({ ...ready, folder: { kind: "missing", path: FOLDER } }),
  ).toEqual([["folder", "blocker"]]);

  // No remote: no board question either — there is nothing to ask about.
  const noRemote = buildReport({
    ...ready,
    folder: { ...linked, remote: null },
  });
  expect(noRemote.checks.some((check) => check.id === "board")).toBe(false);
  expect(failed({ ...ready, folder: { ...linked, remote: null } })).toEqual([
    ["remote", "blocker"],
  ]);

  // The service could not be asked: left out, never failed.
  expect(
    buildReport({ ...ready, folder: { ...linked, board: { kind: "unknown" } } })
      .checks.map((check) => check.id)
      .includes("board"),
  ).toBe(false);
  const other = buildReport({
    ...ready,
    folder: { ...linked, board: { kind: "other", name: "Beta" } },
  }).checks.find((check) => check.id === "board");
  expect(other?.ok).toBe(false);
  expect(other?.detail).toContain("“Beta”");

  expect(
    failed({
      ...ready,
      folder: {
        ...linked,
        agentsMd: "# Notes\n",
        claudeMd: null,
        claudeMcp: false,
        legacyReviews: true,
      },
      codex: { used: true, hook: false, mcp: false },
    }),
  ).toEqual([
    ["agents-md", "warning"],
    ["claude-md", "info"],
    ["claude-mcp", "blocker"],
    ["codex-mcp", "blocker"],
    ["hook", "info"],
    ["legacy-reviews", "info"],
  ]);

  // A CLI never run on this machine is not asked about.
  const noCodex = buildReport({
    ...ready,
    codex: { used: false, hook: false, mcp: false },
  });
  expect(noCodex.checks.some((check) => check.id === "codex-mcp")).toBe(false);
});

test("fixes append or add one key, and never rewrite what is there", () => {
  const fresh = applyFix("agents-md", null);
  expect(fresh.startsWith("# Instructions for AI agents\n\n")).toBe(true);
  expect(hasLaneworkNotes(fresh)).toBe(true);
  const kept = applyFix("agents-md", "# Ours\n\nKeep this.\n\n\n");
  expect(kept).toBe(`# Ours\n\nKeep this.\n\n${AGENT_NOTES}\n`);

  expect(applyFix("claude-md", null)).toBe("@AGENTS.md\n");
  expect(applyFix("claude-md", "# Claude\n")).toBe("# Claude\n\n@AGENTS.md\n");
  expect(importsAgentsMd(applyFix("claude-md", "# Claude\n"))).toBe(true);

  const json = JSON.parse(
    applyFix(
      "mcp-json",
      JSON.stringify({
        mcpServers: { github: { url: "https://api.github.com" } },
        other: 1,
      }),
    ),
  );
  expect(json).toEqual({
    mcpServers: {
      github: { url: "https://api.github.com" },
      lanework: { type: "http", url: MCP_URL },
    },
    other: 1,
  });
  expect(() => applyFix("mcp-json", "[1, 2]")).toThrow("is not a JSON object");
});

// ── The app ─────────────────────────────────────────────────────────────────

test.describe("in the app", () => {
  test.skip(process.platform === "win32", "These drive a POSIX git.");

  const workspaces: Workspace[] = [
    {
      id: "ws-alpha",
      slug: "alpha",
      name: "Alpha",
      path: null,
      baseBranch: null,
    },
    { id: "ws-beta", slug: "beta", name: "Beta", path: null, baseBranch: null },
  ];

  /** A git folder with an origin remote, linked to the board. */
  async function makeFolder(notes: boolean): Promise<string> {
    const folder = await realpath(
      await mkdtemp(join(tmpdir(), "lanew-ready-")),
    );
    execFileSync("git", ["init", "-q"], { cwd: folder });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/alpha.git"],
      { cwd: folder },
    );
    if (notes) await writeFile(join(folder, "AGENTS.md"), `${AGENT_NOTES}\n`);
    await writeFile(join(folder, "CLAUDE.md"), "@AGENTS.md\n");
    return folder;
  }

  async function open(folders: Record<string, string>) {
    const plane = await startStubPlane({ workspaces });
    for (const workspace of workspaces)
      plane.setBoard(workspace.id as string, {
        columns: [{ key: "todo", name: "To-Do", role: "start" }],
        cards: [],
      });
    plane.setRepoBoards([
      { workspaceId: "ws-alpha", name: "Alpha" },
      { workspaceId: "ws-beta", name: "Beta" },
    ]);
    const profile = await mkdtemp(join(tmpdir(), "lanew-ready-ui-"));
    const home = join(profile, "home");
    await mkdir(home, { recursive: true });
    await seedCredential(home, plane.origin);
    // Both CLIs "used" and both able to reach the board, so the one thing
    // left to report is the folder's own notes.
    await mkdir(join(profile, "claude"), { recursive: true });
    await writeFile(
      join(profile, "claude", ".claude.json"),
      JSON.stringify({
        mcpServers: { lanework: { type: "http", url: MCP_URL } },
      }),
    );
    await mkdir(join(profile, "codex"), { recursive: true });
    await writeFile(
      join(profile, "codex", "config.toml"),
      `[mcp_servers.lanework]\nurl = "${MCP_URL}"\n`,
    );
    const previous = process.env.LANEWORK_HOME;
    process.env.LANEWORK_HOME = home;
    const record = {
      machineId: "test-machine",
      userId: "test-user",
      apiUrl: plane.origin,
      name: "test-machine",
      secret: "lw_mch_test-secret",
      owner: null,
    } satisfies MachineRecord;
    for (const [slug, folder] of Object.entries(folders))
      await writeFolders(record, slug, [folder]);
    if (previous === undefined) delete process.env.LANEWORK_HOME;
    else process.env.LANEWORK_HOME = previous;

    const app = await electron.launch({
      args: [process.cwd()],
      env: launchEnv({ profile, home, apiUrl: plane.origin }),
    });
    const page: Page = await app.firstWindow();
    await page
      .getByRole("button", { name: /^Switch project/ })
      .waitFor({ state: "visible", timeout: 15_000 });
    return {
      page,
      plane,
      cleanup: async () => {
        await app.close();
        await plane.close();
        await removeProfile(profile);
      },
    };
  }

  /** Settings › Projects, managing the project `slug` (the open one). */
  async function openReadiness(page: Page, slug: string) {
    await page.goto(`app://lanework/w/${slug}/issues`);
    await page.goto("app://lanework/settings/workspaces");
    await expect(
      page.getByRole("heading", { name: "Ready for agents" }),
    ).toBeVisible({ timeout: 15_000 });
  }
  const fixAgents = (page: Page) =>
    page.getByRole("button", { name: "Fix AGENTS.md" });

  test("a folder without AGENTS.md is flagged, and Fix makes it ready", async () => {
    const folder = await makeFolder(false);
    const { page, cleanup } = await open({ alpha: folder });
    try {
      await openReadiness(page, "alpha");
      await fixAgents(page).click({ timeout: 15_000 });

      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Create AGENTS.md")).toBeVisible();
      await expect(dialog.getByText("## Lanework board")).toBeVisible();
      // Nothing is written until Apply.
      await expect(
        readFile(join(folder, "AGENTS.md"), "utf8"),
      ).rejects.toThrow();
      await dialog.getByRole("button", { name: "Apply" }).click();

      await expect(dialog).toBeHidden();
      await expect(fixAgents(page)).toBeHidden();
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
        AGENT_NOTES,
      );
    } finally {
      await cleanup();
      await rm(folder, { recursive: true, force: true });
    }
  });

  test("BE-20: a repo on another board is moved here from the check, confirming a board on a different repo", async () => {
    const folder = await makeFolder(true);
    const { page, plane, cleanup } = await open({ alpha: folder });
    try {
      // The repo is on Beta, and Alpha itself is on another repo.
      plane.setRepoBoards([{ workspaceId: "ws-beta", name: "Beta" }]);
      plane.setBoardRepo("github.com/acme/old");
      await page.goto("app://lanework/w/beta/issues");
      await openReadiness(page, "alpha");
      await expect(page.getByText(/file their cards on “Beta”/)).toBeVisible({
        timeout: 15_000,
      });
      await page
        .getByRole("button", { name: "Link here", exact: true })
        .click();

      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Move this repo here from “Beta”?");
      await expect(dialog).toContainText("stay there");
      await dialog.getByRole("button", { name: "Link here" }).click();
      // The service refused: Alpha is on another repo. Asked again, by name.
      await expect(dialog).toContainText("Move this board off its repo?");
      await expect(dialog).toContainText("github.com/acme/old");
      await dialog.getByRole("button", { name: "Move it here" }).click();
      await expect(dialog).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Link here", exact: true }),
      ).toBeHidden();
      expect(plane.repoMoves()).toEqual([
        {
          workspaceId: "ws-alpha",
          repo: "git@github.com:acme/alpha.git",
          replace: false,
        },
        {
          workspaceId: "ws-alpha",
          repo: "git@github.com:acme/alpha.git",
          replace: true,
        },
      ]);
    } finally {
      await cleanup();
      await rm(folder, { recursive: true, force: true });
    }
  });

  test("switching projects shows the new project's readiness, not the last one's", async () => {
    const broken = await makeFolder(false);
    const fine = await makeFolder(true);
    const { page, cleanup } = await open({ alpha: broken, beta: fine });
    try {
      await openReadiness(page, "alpha");
      await expect(fixAgents(page)).toBeVisible({ timeout: 15_000 });
      await openReadiness(page, "beta");
      await expect(
        page.getByRole("button", { name: "Rename Beta" }),
      ).toBeVisible();
      await expect(fixAgents(page)).toBeHidden();
      // And back: alpha's report is still alpha's.
      await openReadiness(page, "alpha");
      await expect(fixAgents(page)).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanup();
      await rm(broken, { recursive: true, force: true });
      await rm(fine, { recursive: true, force: true });
    }
  });
});
