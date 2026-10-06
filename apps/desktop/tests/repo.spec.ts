// Repository › Changes and History against a real git repository (FE-22 V2).
// The first cases drive `worktree.ts` directly under Node; the rest boot the
// app on a project linked to a temporary repository and click through it.
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
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
import * as worktree from "../electron/main/git/worktree";
import { writeFolders } from "../electron/main/workspaces/store";
import type { Workspace } from "../shared/workspaces";
import {
  agentStandIn,
  CLAUDE_EDITS_ID,
  seedClaudeEdits,
} from "./agent-fixtures";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

test.skip(process.platform === "win32", "These drive a POSIX git.");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/** A repository with one commit, then a modified, a deleted and a new file. */
async function makeRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "lanew-git-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "tester@example.com");
  git(repo, "config", "user.name", "Tester");
  // ⚠️ The developer's global config may sign every commit (an SSH or GPG
  // key behind an agent). A test repository must not wait on that agent —
  // under a full run it timed out and failed the commit.
  git(repo, "config", "commit.gpgsign", "false");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "router.tsx"), "a\nb\nc\n");
  await writeFile(join(repo, "notes.md"), "keep\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init: first commit");
  await writeFile(join(repo, "src", "router.tsx"), "a\nB\nc\nd\n");
  await rm(join(repo, "notes.md"));
  await writeFile(join(repo, "scratch.txt"), "new\n");
  return repo;
}

test("status, stage, commit and restore on a real repository", async () => {
  const repo = await makeRepo();
  try {
    const state = await worktree.status(repo);
    if (state.kind !== "ready") throw new Error(state.kind);
    expect(state.branch.name).toBe("main");
    expect(
      state.files.map((file) => [
        file.path,
        file.status,
        file.additions,
        file.deletions,
      ]),
    ).toEqual([
      ["notes.md", "deleted", 0, 1],
      ["scratch.txt", "untracked", 1, 0],
      ["src/router.tsx", "modified", 2, 1],
    ]);

    // A path git did not just call changed is refused, never handed to git.
    await expect(worktree.stage(repo, ["../outside"])).rejects.toThrow(
      "has no change to act on",
    );

    await worktree.stage(repo, ["src/router.tsx"]);
    await worktree.commit(repo, "feat: router\n\nwhy it changed", "staged");
    const history = await worktree.log(repo, 0);
    expect(history.commits.map((commit) => commit.subject)).toEqual([
      "feat: router",
      "init: first commit",
    ]);
    expect(history.commits[0]?.body).toBe("why it changed");

    const shown = await worktree.show(repo, history.commits[0]?.sha ?? "");
    expect(shown.files).toMatchObject([
      { path: "src/router.tsx", additions: 2, deletions: 1 },
    ]);

    // Restore puts a tracked file back and DELETES an untracked one.
    await worktree.restore(repo, ["notes.md", "scratch.txt"]);
    const after = await worktree.status(repo);
    expect(after.kind === "ready" && after.files).toEqual([]);
    expect((await readdir(repo)).sort()).toEqual([".git", "notes.md", "src"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("lists branches and switches without forcing", async () => {
  const repo = await makeRepo();
  try {
    git(repo, "stash", "-u");
    git(repo, "branch", "feature/login");
    const list = await worktree.branches(repo);
    expect(list.current).toBe("main");
    expect(list.local.sort()).toEqual(["feature/login", "main"]);

    await worktree.switchBranch(repo, "feature/login");
    expect((await worktree.branches(repo)).current).toBe("feature/login");

    // Only a name the list just gave is accepted.
    await expect(worktree.switchBranch(repo, "--orphan")).rejects.toThrow(
      "is not a branch",
    );

    // Uncommitted work the other branch would overwrite: git refuses.
    await writeFile(join(repo, "notes.md"), "edited on login\n");
    git(repo, "commit", "-qam", "login notes");
    git(repo, "switch", "-q", "main");
    await writeFile(join(repo, "notes.md"), "edited on main\n");
    await expect(worktree.switchBranch(repo, "feature/login")).rejects.toThrow(
      /overwritten/,
    );
    expect((await worktree.branches(repo)).current).toBe("main");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a folder that is not a repository says so", async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "lanew-plain-")));
  try {
    expect(await worktree.locate(folder)).toEqual({
      kind: "not-repo",
      path: folder,
    });
    expect(await worktree.locate(null)).toEqual({ kind: "none" });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

/** `makeRepo` with a bare `origin` it has pushed `main` to and tracks. */
async function makeTrackedRepo(): Promise<{ repo: string; origin: string }> {
  const repo = await makeRepo();
  const origin = await realpath(await mkdtemp(join(tmpdir(), "lanew-origin-")));
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  return { repo, origin };
}

test("sync publishes a new branch, pushes, pulls and refuses bad remotes", async () => {
  const { repo, origin } = await makeTrackedRepo();
  try {
    const state = await worktree.status(repo);
    if (state.kind !== "ready") throw new Error(state.kind);
    expect(state.remotes).toEqual(["origin"]);
    expect(state.branch).toMatchObject({ ahead: 0, behind: 0 });

    await expect(
      worktree.sync(repo, "fetch", "--upload-pack=x"),
    ).rejects.toThrow("is not a remote");

    // A branch with no upstream is published, and tracks what it was pushed to.
    git(repo, "switch", "-q", "-c", "feature");
    git(repo, "commit", "-qam", "feat: on a branch");
    await worktree.sync(repo, "push", null);
    expect(git(repo, "rev-parse", "--abbrev-ref", "@{u}").trim()).toBe(
      "origin/feature",
    );
    expect(git(origin, "log", "-1", "--format=%s", "feature").trim()).toBe(
      "feat: on a branch",
    );

    // Somebody else pushes; a fetch shows it behind, a pull brings it in.
    const other = await realpath(await mkdtemp(join(tmpdir(), "lanew-other-")));
    try {
      git(other, "clone", "-q", "-b", "feature", origin, ".");
      git(
        other,
        "-c",
        "user.email=o@example.com",
        "-c",
        "user.name=O",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "chore: theirs",
      );
      git(other, "push", "-q");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
    await worktree.sync(repo, "fetch", "origin");
    const behind = await worktree.status(repo);
    expect(behind.kind === "ready" && behind.branch.behind).toBe(1);
    git(repo, "stash", "-q", "-u");
    await worktree.sync(repo, "pull-rebase", null);
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("chore: theirs");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(origin, { recursive: true, force: true });
  }
});

const workspaces: Workspace[] = [
  {
    id: "ws-alpha",
    slug: "alpha",
    name: "Alpha",
    path: null,
    baseBranch: null,
  },
];

const beta: Workspace = {
  id: "ws-beta",
  slug: "beta",
  name: "Beta",
  path: null,
  baseBranch: null,
};

/**
 * Boot on Alpha at `folder`; `betaFolder` also links a second project, and
 * `env` adds to the app's environment.
 */
async function open(
  folder: string,
  betaFolder?: string,
  env: Record<string, string> = {},
) {
  const plane = await startStubPlane({
    workspaces: betaFolder ? [...workspaces, beta] : workspaces,
  });
  for (const id of betaFolder ? ["ws-alpha", "ws-beta"] : ["ws-alpha"])
    plane.setBoard(id, {
      columns: [{ key: "todo", name: "To-Do", role: "start" }],
      cards: [],
    });
  const profile = await mkdtemp(join(tmpdir(), "lanew-repo-ui-"));
  const home = join(profile, "home");
  await mkdir(home, { recursive: true });
  await seedCredential(home, plane.origin);
  const previous = process.env.LANEWORK_HOME;
  process.env.LANEWORK_HOME = home;
  await writeFolders(
    {
      machineId: "test-machine",
      userId: "test-user",
      apiUrl: plane.origin,
      name: "test-machine",
      secret: "lw_mch_test-secret",
      owner: null,
    } satisfies MachineRecord,
    "alpha",
    [folder],
  );
  if (betaFolder)
    await writeFolders(
      {
        machineId: "test-machine",
        userId: "test-user",
        apiUrl: plane.origin,
        name: "test-machine",
        secret: "lw_mch_test-secret",
        owner: null,
      } satisfies MachineRecord,
      "beta",
      [betaFolder],
    );
  if (previous === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previous;

  const app = await electron.launch({
    args: [process.cwd()],
    env: { ...launchEnv({ profile, home, apiUrl: plane.origin }), ...env },
  });
  const page: Page = await app.firstWindow();
  await page
    .getByRole("button", { name: /^Switch project/ })
    .waitFor({ state: "visible", timeout: 15_000 });
  return {
    page,
    cleanup: async () => {
      await app.close();
      await plane.close();
      await removeProfile(profile);
    },
  };
}

test("Changes stages and commits, and History shows the commit", async () => {
  const repo = await makeRepo();
  const { page, cleanup } = await open(repo);
  try {
    await page.goto("app://lanework/w/alpha/changes");
    const list = page.getByRole("complementary", { name: "Changed files" });
    await expect(list.getByText("router.tsx")).toBeVisible({ timeout: 15_000 });
    await expect(list.getByText("+2").first()).toBeVisible();
    // The diff is drawn by `@pierre/diffs` in an open shadow root.
    await expect(page.getByText("B", { exact: true }).first()).toBeVisible();

    // Nothing staged: the button commits every tracked change.
    await expect(
      page.getByRole("button", { name: /Commit Tracked/ }),
    ).toBeVisible();
    await list.getByRole("checkbox", { name: "Stage src/router.tsx" }).click();
    await expect(
      list.getByRole("checkbox", { name: "Unstage src/router.tsx" }),
    ).toBeChecked();
    await expect(page.getByRole("button", { name: /^Commit/ })).toHaveText(
      /^Commit⌘↩$/,
    );

    // The placeholder is the message when the box is left empty.
    await expect(page.getByLabel("Commit message")).toHaveAttribute(
      "placeholder",
      "Update router.tsx",
    );
    await page.getByLabel("Commit message").fill("feat: route B");
    await page.getByLabel("Commit message").press("Meta+Enter");
    await expect(list.getByText("router.tsx")).toHaveCount(0, {
      timeout: 15_000,
    });
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("feat: route B");

    // Restoring a new file says it will be DELETED.
    await list
      .getByRole("button", { name: "Discard changes to scratch.txt" })
      .click();
    await expect(page.getByRole("alertdialog")).toContainText(
      "deleted from disk",
    );
    await page.getByRole("button", { name: "Keep" }).click();

    await page.getByRole("link", { name: "History" }).click();
    await page.getByRole("link", { name: /feat: route B/ }).click();
    await expect(page.getByRole("button", { name: "Commit SHA" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("tester@example.com")).toBeVisible();
    await expect(page.getByText("src/").first()).toBeVisible();
  } finally {
    await cleanup();
    await rm(repo, { recursive: true, force: true });
  }
});

test("switching projects never shows the last one's history, and a return is instant", async () => {
  const alpha = await makeRepo();
  const other = await makeRepo();
  git(alpha, "commit", "-qam", "feat: only in alpha");
  git(other, "commit", "-qam", "feat: only in beta");
  const { page, cleanup } = await open(alpha, other);
  const switchTo = async (name: string) => {
    await page.getByRole("button", { name: /^Switch project/ }).click();
    await page.getByRole("option", { name }).first().click();
    await expect(
      page.getByRole("button", { name: `Switch project — currently ${name}` }),
    ).toBeVisible();
  };
  try {
    await page.goto("app://lanework/w/alpha/history");
    await expect(
      page.getByRole("link", { name: /feat: only in alpha/ }),
    ).toBeVisible({ timeout: 15_000 });

    // Every change to the page: which project the rail names, and what the
    // repository screen showed — each frame, not only where it settled.
    // ⚠️ The rail's project, not the URL: the location moves a tick before
    // the old screen unmounts, and that tick is the old project's own screen.
    await page.evaluate(() => {
      const seen: { project: string; text: string }[] = [];
      (window as unknown as { seen: typeof seen }).seen = seen;
      new MutationObserver(() =>
        seen.push({
          project:
            document
              .querySelector('[aria-label^="Switch project"]')
              ?.getAttribute("aria-label") ?? "",
          text:
            location.pathname.includes("/history") ||
            location.pathname.includes("/changes")
              ? (document.querySelector("main")?.textContent ??
                document.body.textContent ??
                "")
              : "",
        }),
      ).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });

    await switchTo("Beta");
    await page.getByRole("link", { name: "History" }).click();
    await expect(
      page.getByRole("link", { name: /feat: only in beta/ }),
    ).toBeVisible({ timeout: 15_000 });

    const mark = await page.evaluate(
      () => (window as unknown as { seen: unknown[] }).seen.length,
    );
    await switchTo("Alpha");
    await expect.poll(() => page.url()).toContain("/w/alpha/history");
    await expect(
      page.getByRole("link", { name: /feat: only in alpha/ }),
    ).toBeVisible();

    const seen = await page.evaluate(
      () =>
        (window as unknown as { seen: { project: string; text: string }[] })
          .seen,
    );
    expect(
      seen.filter(
        (frame) =>
          frame.project.endsWith("Beta") &&
          frame.text.includes("only in alpha"),
      ),
    ).toEqual([]);
    // Back on Alpha, its history was on screen from the first frame.
    expect(
      seen
        .slice(mark)
        .filter(
          (frame) =>
            frame.project.endsWith("Alpha") &&
            /Reading the (history|repository)/.test(frame.text),
        ),
    ).toEqual([]);
  } finally {
    await cleanup();
    await rm(alpha, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("the sync button pushes local commits, then offers Fetch", async () => {
  const { repo, origin } = await makeTrackedRepo();
  git(repo, "commit", "-qm", "chore: first unpushed", "--allow-empty");
  git(repo, "commit", "-qam", "feat: unpushed");
  const { page, cleanup } = await open(repo);
  try {
    await page.goto("app://lanework/w/alpha/changes");
    // The rail's History row counts what the push will send.
    const badge = page.getByRole("img", { name: "2 commits not pushed yet" });
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText("2");
    const push = page.getByRole("button", { name: "↑2 Push" });
    await expect(push).toBeVisible();
    await push.click();
    await expect(page.getByRole("button", { name: "Fetch" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("img", { name: /not pushed yet/ })).toHaveCount(
      0,
    );
    expect(git(origin, "log", "-1", "--format=%s", "main").trim()).toBe(
      "feat: unpushed",
    );

    // The rest lives in the menu; Force Push asks before it does anything.
    await page.getByRole("button", { name: "More sync actions" }).click();
    for (const item of ["Pull", "Pull (Rebase)", "Push", "Force Push"])
      await expect(
        page.getByRole("menuitem", { name: item, exact: true }),
      ).toBeVisible();
    await page.getByRole("menuitem", { name: "Force Push" }).click();
    await expect(page.getByRole("alertdialog")).toContainText(
      "Force push main?",
    );
    await page.getByRole("button", { name: "Cancel" }).click();
  } finally {
    await cleanup();
    await rm(repo, { recursive: true, force: true });
    await rm(origin, { recursive: true, force: true });
  }
});

test("the rail switches branch, folders fold, and restore has a tooltip", async () => {
  const repo = await makeRepo();
  git(repo, "branch", "feature/login");
  const { page, cleanup } = await open(repo);
  try {
    await page.goto("app://lanework/w/alpha/changes");
    const list = page.getByRole("complementary", { name: "Changed files" });
    await expect(list.getByText("router.tsx")).toBeVisible({ timeout: 15_000 });

    // A folder row folds its files away and says how many it is hiding.
    await list.getByRole("button", { name: "Collapse src" }).click();
    await expect(list.getByText("router.tsx")).toHaveCount(0);
    await list.getByRole("button", { name: "Expand src" }).click();
    await expect(list.getByText("router.tsx")).toBeVisible();

    // ⚠️ Retried as a pair: the button only appears under a hovered row, and
    // a pointer that lands on it mid-fade can miss the tooltip's enter event.
    const restore = list.getByRole("button", {
      name: "Discard changes to src/router.tsx",
    });
    const tip = page.locator('[data-slot="tooltip-content"]');
    await expect(async () => {
      await list.getByText("router.tsx").hover();
      await restore.hover();
      await expect(tip).toHaveText("Discard changes", { timeout: 1_500 });
    }).toPass({ timeout: 10_000 });

    const switcher = page.getByRole("button", {
      name: "Switch branch — currently main",
    });
    await expect(switcher).toBeVisible();
    await switcher.click();
    await page.getByPlaceholder("Switch branch…").fill("login");
    await page.getByRole("option", { name: "feature/login" }).click();
    await expect(
      page.getByRole("button", {
        name: "Switch branch — currently feature/login",
      }),
    ).toBeVisible({ timeout: 15_000 });
    expect(git(repo, "branch", "--show-current").trim()).toBe("feature/login");
  } finally {
    await cleanup();
    await rm(repo, { recursive: true, force: true });
  }
});

test("the rail counts changes with the board, before Changes is opened", async () => {
  const repo = await makeRepo();
  const { page, cleanup } = await open(repo);
  try {
    await page.goto("app://lanework/w/alpha/issues");
    // router.tsx +2 −1, notes.md −1, scratch.txt +1.
    await expect(page.getByRole("link", { name: "Changes +3 −2" })).toBeVisible(
      {
        timeout: 15_000,
      },
    );
  } finally {
    await cleanup();
    await rm(repo, { recursive: true, force: true });
  }
});

test("a long branch name truncates instead of scrolling the rail sideways", async () => {
  const repo = await makeRepo();
  git(
    repo,
    "switch",
    "-q",
    "-c",
    "feat/meta-reels-publishing-with-a-very-long-name",
  );
  const { page, cleanup } = await open(repo);
  try {
    await page.goto("app://lanework/w/alpha/issues");
    const nav = page.getByRole("navigation", { name: "Repository" });
    await expect(
      nav.getByRole("button", {
        name: /^Switch branch — currently feat\/meta/,
      }),
    ).toBeVisible({ timeout: 15_000 });
    const overflow = await nav.evaluate((el) => {
      const scroller = el.parentElement as HTMLElement;
      return scroller.scrollWidth - scroller.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await cleanup();
    await rm(repo, { recursive: true, force: true });
  }
});

test("a project whose folder is not a repository gets an empty state", async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "lanew-plain-")));
  const { page, cleanup } = await open(folder);
  try {
    await page.goto("app://lanework/w/alpha/changes");
    await expect(page.getByText("Not a git repository")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("link", { name: "Open Settings" }),
    ).toBeVisible();
  } finally {
    await cleanup();
    await rm(folder, { recursive: true, force: true });
  }
});

test("FE-39: Changes marks the one file a conversation edited since HEAD, and its Files list opens that diff", async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "lanew-git-")));
  // HEAD is committed at tick 4: after the conversation created `src/new.ts`
  // (tick 3), before its sub-agent edited `src/router.tsx` (tick 6).
  const committed = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-09-27T01:00:04Z",
    GIT_COMMITTER_DATE: "2026-09-27T01:00:04Z",
  };
  const at = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: repo,
      env: committed,
      encoding: "utf8",
    });
  at("init", "-q", "-b", "main");
  at("config", "user.email", "tester@example.com");
  at("config", "user.name", "Tester");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "router.tsx"), "a\n");
  await writeFile(join(repo, "src", "new.ts"), "new\n");
  await writeFile(join(repo, "notes.md"), "keep\n");
  at("add", "-A");
  at("commit", "-qm", "init");
  // Two changed files; only the router is a conversation's.
  await writeFile(join(repo, "src", "router.tsx"), "a\nB\n");
  await writeFile(join(repo, "notes.md"), "keep\nmore\n");
  const scratch = await mkdtemp(join(tmpdir(), "lanew-agents-"));
  const agentHome = join(scratch, "home");
  await seedClaudeEdits(agentHome, repo);
  const { page, cleanup } = await open(repo, undefined, {
    LANEWORK_TEST_AGENT_HOME: agentHome,
    LANEWORK_TERMINAL_SHELL: "/bin/sh",
    LANEWORK_TERMINAL_AGENTS: "claude",
    LANEWORK_CLAUDE_BIN: await agentStandIn(scratch, "claude"),
  });
  try {
    await page.goto("app://lanework/w/alpha/changes");
    const list = page.getByRole("complementary", { name: "Changed files" });
    await expect(list.getByText("notes.md")).toBeVisible({ timeout: 15_000 });
    const mark = list.getByRole("button", {
      name: "Edited by “Wire the router” in Claude",
    });
    await expect(mark).toBeVisible({ timeout: 15_000 });
    await expect(mark.locator("xpath=..")).toContainText("router.tsx");
    await expect(list.getByRole("button", { name: /^Edited by/ })).toHaveCount(
      1,
    );

    // Hover names the conversation. ⚠️ Retried as a pair, as the Changes
    // list's other tooltips are: a pointer landing mid-render can miss it.
    const tip = page.locator('[data-slot="tooltip-content"]');
    await expect(async () => {
      await list.getByText("notes.md").hover();
      await mark.hover();
      await expect(tip).toHaveText("Wire the router", { timeout: 1_500 });
    }).toPass({ timeout: 10_000 });

    // A click opens it, the way its row on the rail does.
    await mark.click();
    const agent = page.getByRole("region", {
      name: "Claude — Wire the router",
    });
    await expect(agent.locator(".xterm-rows")).toContainText(
      `ran-claude---resume-${CLAUDE_EDITS_ID}`,
    );

    // Its Changes: git's count of what it edited — the router's one line,
    // not notes.md's. The router opens its diff; `src/new.ts` (committed
    // since) and `src/helper.ts` (never on disk here) have nothing to show.
    const changes = agent.getByTestId("agent-changes");
    await expect(changes).toHaveAccessibleName(
      "Changes: 3 files edited, +1 −0 in git",
    );
    await expect(changes).toContainText("+1");
    await changes.click();
    const files = page.locator('[data-slot="popover-content"]');
    await expect(files.getByText("via general-purpose")).toBeVisible();
    await expect(files.locator('[title^="3 edits, the last"]')).toBeVisible();
    await expect(files.locator('[aria-disabled="true"]')).toHaveCount(2);
    await expect(files).toContainText("through the shell");
    await files
      .getByRole("button", { name: "Open the diff of src/router.tsx" })
      .click();
    await expect(page).toHaveURL(/\/w\/alpha\/changes$/);
    await expect(list.locator("[data-active]")).toContainText("router.tsx");
  } finally {
    await cleanup();
    await rm(repo, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});
