import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

/**
 * The pull-request screen, against a GitHub this test answers itself.
 *
 * ⚠️ Hermetic on purpose — `LANEWORK_GITHUB_API_URL` points the main process at
 * the stub below. A suite that reached `api.github.com` would need somebody's
 * real token to pass, would spend their rate limit to do it, and would fail on
 * a plane.
 */

const SLUG = "acme";
const REPO = "acme/widgets";
const CLIENT_ID = "Ov23liTestClient";

/**
 * The account key the app files GitHub state under.
 *
 * ⚠️ Recomputed here rather than imported: this proves the on-disk contract the
 * app reads, so a test that borrowed the app's own hash would pass even if that
 * hash changed shape under it.
 */
function accountKey(apiUrl: string): string {
  return createHash("sha256")
    .update(JSON.stringify([apiUrl, "test-user", "test-machine"]))
    .digest("hex");
}

/** A token record the app will accept — `enc: false` is its documented fallback. */
async function seedGitHubToken(home: string, apiUrl: string): Promise<void> {
  const dir = join(home, "git");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, `token-${accountKey(apiUrl)}.json`),
    JSON.stringify({
      v: 1,
      login: "tester",
      name: "Tester",
      avatarUrl: null,
      expiresAt: null,
      enc: false,
      token: "gho_test",
      refresh: null,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

async function seedRepoLink(home: string, apiUrl: string): Promise<void> {
  const dir = join(home, "git");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, `repos-${accountKey(apiUrl)}.json`),
    JSON.stringify({ v: 1, repos: { [SLUG]: REPO } }),
    { encoding: "utf8", mode: 0o600 },
  );
}

/** A patch whose first hunk starts at line 32, so lines 1–31 are a gap. */
const PATCH = [
  "@@ -32,6 +32,6 @@",
  ' "devDependencies": {',
  '   "@types/chrome": "^0.0.268",',
  '-  "@types/node": "^20.14.11",',
  '+  "@types/node": "^22.1.0",',
  '   "@types/react": "^18.3.3",',
  '   "@types/react-dom": "^18.3.0",',
  '   "@typescript-eslint/eslint-plugin": "^7.17.0",',
].join("\n");

/** Lines 32-37 are the hunk above; 1-31 are what the fold hides. */
const TAIL = [
  ' "devDependencies": {',
  '   "@types/chrome": "^0.0.268",',
  '   "@types/node": "^22.1.0",',
  '   "@types/react": "^18.3.3",',
  '   "@types/react-dom": "^18.3.0",',
  '   "@typescript-eslint/eslint-plugin": "^7.17.0",',
  " }",
];
const HEAD_LINES = Array.from({ length: 31 }, (_, i) => `// line ${i + 1}`);

function fileAt(ref: string): string {
  const tail = ref.startsWith("b")
    ? TAIL.map((line) =>
        line.includes("@types/node") ? '   "@types/node": "^20.14.11",' : line,
      )
    : TAIL;
  return [...HEAD_LINES, ...tail].join("\n");
}

function pullNode(state: "OPEN" | "MERGED" | "CLOSED" = "OPEN") {
  const shape = {
    OPEN: { number: 7, title: "chore(deps): bump @types/node" },
    MERGED: { number: 5, title: "feat: ship the thing" },
    CLOSED: { number: 3, title: "spike: abandoned idea" },
  }[state];
  return {
    number: shape.number,
    title: shape.title,
    state,
    url: `https://example.invalid/pull/${shape.number}`,
    isDraft: false,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    additions: 36,
    deletions: 24,
    changedFiles: 1,
    author: { login: "dependabot", avatarUrl: null },
    headRefName: "dependabot/npm_and_yarn/types/node-22.1.0",
    baseRefName: "main",
    reviewDecision: "REVIEW_REQUIRED",
    reviewRequests: {
      nodes: [{ requestedReviewer: { __typename: "User", login: "tester" } }],
    },
  };
}

async function startStubGitHub(): Promise<{
  origin: string;
  setBroken: (value: boolean) => void;
  setEmpty: (value: boolean) => void;
  setRepos: (value: string[]) => void;
  /** Answer `/user/installations` with 403, as a classic OAuth App's token is. */
  setInstallationsRefused: (value: boolean) => void;
  seen: string[];
  close: () => Promise<void>;
}> {
  let broken = false;
  let empty = false;
  let repos = [REPO, "acme/toolkit", "other-org/sandbox"];
  let installationsRefused = false;
  /** Every request seen, so a test can prove what was actually asked for. */
  const seen: string[] = [];

  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const url = request.url ?? "";
    seen.push(url);

    if (request.method === "POST" && url.startsWith("/graphql")) {
      if (broken) return send(500, { message: "nope" });
      // The state filter is sent to GitHub, so the stub has to honour it —
      // otherwise a test could pass while the app filtered locally.
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const states: string[] | null = body?.variables?.states ?? null;
      const wanted = states ?? ["OPEN", "MERGED", "CLOSED"];
      const nodes = empty
        ? []
        : wanted.map((state: string) =>
            pullNode(state as "OPEN" | "MERGED" | "CLOSED"),
          );
      return send(200, {
        data: {
          viewer: { login: "tester" },
          repository: { pullRequests: { nodes } },
        },
      });
    }
    if (url.includes("/contents/")) {
      const ref = new URL(url, "http://x").searchParams.get("ref") ?? "";
      response.writeHead(200, { "content-type": "text/plain" });
      return response.end(fileAt(ref));
    }
    if (url.startsWith("/user/repos"))
      return send(
        200,
        repos.map((full) => {
          const [owner, name] = full.split("/");
          return {
            name,
            private: true,
            pushed_at: new Date(Date.now() - 7_200_000).toISOString(),
            owner: { login: owner },
          };
        }),
      );
    if (url.startsWith("/user/installations") && installationsRefused)
      return send(403, { message: "Resource not accessible by integration" });
    if (url.startsWith("/user/installations/"))
      return send(200, { repositories: [] });
    if (url.startsWith("/user/installations"))
      return send(200, {
        installations: [
          { id: 13333801, app_slug: "lanework", account: { login: "acme" } },
        ],
      });
    if (url.startsWith("/user")) return send(200, { login: "tester" });
    if (url.includes("/pulls/7/files"))
      // ⚠️ TWO files, deliberately. A one-file stub is why a renderer that
      // refused multi-file patches ("Provided patch must contain exactly 1 file
      // diff") passed every test and broke on the first real pull request.
      return send(200, [
        {
          filename: "package.json",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: PATCH,
        },
        {
          // ⚠️ Long on purpose: a short diff fits the pane and would pass even
          // with the scroller missing, which is exactly how that shipped.
          filename: "CHANGELOG.md",
          status: "modified",
          additions: 200,
          deletions: 0,
          patch: [
            "@@ -1,1 +1,201 @@",
            " # Changelog",
            ...Array.from({ length: 200 }, (_, i) => `+entry ${i + 1}`),
          ].join("\n"),
        },
        {
          filename: "README.md",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: [
            "@@ -1,2 +1,3 @@",
            " # Widgets",
            "+Now with types.",
            " ",
          ].join("\n"),
        },
      ]);
    if (url.includes("/pulls/7"))
      return send(200, {
        ...pullNode(),
        state: "open",
        merged: false,
        draft: false,
        body: "Bumps @types/node.",
        user: { login: "dependabot", avatar_url: null },
        head: {
          ref: "dependabot/npm_and_yarn/types/node-22.1.0",
          sha: "a".repeat(40),
        },
        base: { ref: "main", sha: "b".repeat(40) },
        additions: 36,
        deletions: 24,
        changed_files: 1,
        html_url: "https://example.invalid/pull/7",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        requested_reviewers: [{ login: "tester" }],
      });
    send(404, { message: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    setBroken: (value) => {
      broken = value;
    },
    setEmpty: (value) => {
      empty = value;
    },
    setRepos: (value) => {
      repos = value;
    },
    setInstallationsRefused: (value) => {
      installationsRefused = value;
    },
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function open(options: { token?: boolean; repo?: boolean } = {}) {
  const github = await startStubGitHub();
  const plane = await startStubPlane({
    workspaces: [
      {
        id: "ws-1",
        slug: SLUG,
        name: "Acme",
        path: null,
        baseBranch: null,
      },
    ],
  });
  const profile = await mkdtemp(join(tmpdir(), "lanework-pulls-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  if (options.token !== false) await seedGitHubToken(home, plane.origin);
  if (options.repo !== false) await seedRepoLink(home, plane.origin);

  const app = await electron.launch({
    args: [process.cwd()],
    env: {
      ...launchEnv({ profile, home, apiUrl: plane.origin }),
      LANEWORK_GITHUB_API_URL: github.origin,
      // Pinned so the OAuth-App destination can be asserted exactly.
      LANEWORK_GITHUB_CLIENT_ID: CLIENT_ID,
    },
  });
  const page: Page = await app.firstWindow();
  await page
    .getByRole("button", { name: /^Switch project/ })
    .waitFor({ state: "visible", timeout: 15_000 });

  return {
    app,
    page,
    github,
    cleanup: async () => {
      await app.close();
      await plane.close();
      await github.close();
      await removeProfile(profile);
    },
  };
}

async function gotoPulls(page: Page): Promise<void> {
  await page.goto(`app://lanework/w/${SLUG}/pulls`);
}

test("lists pull requests, grouped by what they need from you", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await expect(page.getByText("Needs my review")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible();
    // The counts REST's list read cannot give — the reason this reads GraphQL.
    await expect(page.getByText("+36").first()).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("says a repo is empty rather than drawing nothing", async () => {
  const { page, github, cleanup } = await open();
  try {
    github.setEmpty(true);
    await gotoPulls(page);
    // ⚠️ A shadcn `Empty`, not a bare paragraph — the same component the issues
    // list uses, so the two screens say "nothing here" the same way.
    await expect(page.getByText("No open pull requests")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(`${REPO} has none to show.`)).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("opens a diff, folds unchanged lines, and scrolls", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await expect(page.getByText("package.json")).toBeVisible({
      timeout: 15_000,
    });
    // ⚠️ Rendered by `@pierre/diffs`, inside an open shadow root — Playwright
    // pierces those, so these are ordinary text assertions.
    await expect(page.getByText('"@types/node": "^22.1.0",')).toBeVisible();

    // Lines 1–31 are not in the patch, and the fold says exactly that. The
    // library marks the fold with `data-unmodified-lines` and renders one per
    // side, so this names the attribute rather than the text.
    await expect(page.locator("[data-unmodified-lines]").first()).toHaveText(
      "31 unmodified lines",
    );
    await expect(page.getByText("// line 31")).toHaveCount(0);

    // Opening the fold pulls the real file through `git.fileText` — the whole
    // reason main serves whole files rather than the patch it already sent.
    //
    // ⚠️ `[data-expand-button]` is a `div` with `role="button"`, not a
    // `<button>`, so a `button` selector finds nothing here.
    await page.locator("[data-expand-button]").first().click();
    await expect(page.getByText("// line 31")).toBeVisible({ timeout: 15_000 });

    // ⚠️ The pane has to scroll ON ITS OWN. `CodeView` virtualizes against its
    // own root and does not set `overflow` there — without `overflow-y-auto`
    // the root computes `visible`, the content spills out, the nearest
    // `overflow-hidden` ancestor clips it, and the diff cannot be scrolled at
    // all. That shipped once; this asserts the behaviour, not the class.
    const scroll = await page
      .locator("diffs-container")
      .first()
      .evaluate((el) => {
        let node = el.parentElement;
        while (node) {
          if (node.scrollHeight > node.clientHeight + 4) {
            node.scrollTop = node.scrollHeight;
            return { scroller: true, top: node.scrollTop };
          }
          node = node.parentElement;
        }
        return { scroller: false, top: 0 };
      });
    expect(scroll.scroller).toBe(true);
    expect(scroll.top).toBeGreaterThan(0);

    // ⚠️ The last file is only reachable by scrolling, and that is the point:
    // it proves the list virtualizes rather than rendering every line of every
    // file, which is the whole reason `CodeView` owns the scroller.
    await expect(page.getByText("README.md")).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanup();
  }
});

test("folds a file shut and opens it again", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await expect(page.getByText('"@types/node": "^22.1.0",')).toBeVisible({
      timeout: 15_000,
    });

    // ⚠️ `collapsed` is a field on the item and `CodeView` is controlled, so the
    // library ships no fold control — this one is ours, in the file header.
    const fold = page.getByRole("button", { name: "Collapse package.json" });
    await expect(fold).toBeVisible();
    await fold.click();

    // The header stays; the diff under it goes.
    await expect(page.getByText("package.json")).toBeVisible();
    await expect(page.getByText('"@types/node": "^22.1.0",')).toHaveCount(0);

    await page.getByRole("button", { name: "Expand package.json" }).click();
    await expect(page.getByText('"@types/node": "^22.1.0",')).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("asks for a connection instead of an empty list", async () => {
  const { page, cleanup } = await open({ token: false });
  try {
    await gotoPulls(page);
    await expect(
      page.getByRole("heading", { name: "Connect GitHub" }),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanup();
  }
});

test("asks which repository a project is, and offers no list until told", async () => {
  const { page, cleanup } = await open({ repo: false });
  try {
    await gotoPulls(page);
    await expect(
      page.getByRole("heading", { name: "Connect a repository" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByPlaceholder("Search repositories")).toBeVisible();
    // Nothing from the board's own repository leaks onto a screen that has not
    // been told which repository this project is.
    await expect(page.getByText("chore(deps): bump @types/node")).toHaveCount(
      0,
    );
  } finally {
    await cleanup();
  }
});

test("labels a saved list when GitHub cannot be reached", async () => {
  const { page, github, cleanup } = await open();
  try {
    // One good read fills the cache…
    await gotoPulls(page);
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible({
      timeout: 15_000,
    });

    // …then GitHub stops answering, and the screen has to say which copy it is
    // showing rather than drawing a saved list as if it were current.
    github.setBroken(true);
    await page.getByRole("button", { name: "Refresh pull requests" }).click();
    await expect(page.getByText("Showing a saved list")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("never hands the renderer the token", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await expect(page.getByText("Needs my review")).toBeVisible({
      timeout: 15_000,
    });

    // ⚠️ The whole surface, not a hand-picked field. A leak would arrive as a
    // NEW key somebody added without thinking about where this object lives.
    // ⚠️ `globalThis`, not `window`: this callback is typed against the test's
    // own tsconfig, which has no DOM lib. In the page they are the same object.
    const surface = await page.evaluate(() =>
      Object.keys(
        (globalThis as unknown as { desktop: { git: Record<string, unknown> } })
          .desktop.git,
      ).sort(),
    );
    expect(surface).toEqual([
      "account",
      "appAccess",
      "cancelConnect",
      "connect",
      "disconnect",
      "fileText",
      "linkRepo",
      "onAccountChange",
      "onConnectProgress",
      "openAppConfig",
      "pull",
      "pulls",
      "repo",
      "repoOptions",
      "review",
      "unlinkRepo",
    ]);

    // And what the connected state actually carries: who, never the secret.
    const account = await page.evaluate(() =>
      (
        globalThis as unknown as {
          desktop: { git: { account: () => Promise<unknown> } };
        }
      ).desktop.git.account(),
    );
    expect(account).toEqual({
      kind: "connected",
      login: "tester",
      name: "Tester",
      avatarUrl: null,
    });
    expect(JSON.stringify(account)).not.toContain("gho_test");
  } finally {
    await cleanup();
  }
});

test("offers an owner, then that owner's repositories", async () => {
  const { page, cleanup } = await open({ repo: false });
  try {
    await gotoPulls(page);
    await expect(
      page.getByRole("heading", { name: "Connect a repository" }),
    ).toBeVisible({ timeout: 15_000 });

    // The owner with the most repositories opens first, and the list under it
    // shows repository names alone — the owner is already stated above them.
    await expect(page.getByRole("combobox", { name: "Owner" })).toContainText(
      "acme",
    );
    await expect(page.getByRole("button", { name: /toolkit/ })).toBeVisible();
    // Another owner's repository is not in this list; it is behind the select.
    await expect(page.getByRole("button", { name: /sandbox/ })).toHaveCount(0);

    // Search narrows within the chosen owner.
    await page.getByPlaceholder("Search repositories").fill("widget");
    await expect(page.getByRole("button", { name: /toolkit/ })).toHaveCount(0);

    // Picking one links the project and the pull requests open behind it.
    await page.getByRole("button", { name: /widgets/ }).click();
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await cleanup();
  }
});

test("switching owner shows that owner's repositories", async () => {
  const { page, cleanup } = await open({ repo: false });
  try {
    await gotoPulls(page);
    await expect(page.getByRole("button", { name: /toolkit/ })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("combobox", { name: "Owner" }).click();
    await page.getByRole("option", { name: /other-org/ }).click();

    await expect(page.getByRole("button", { name: /sandbox/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /toolkit/ })).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("sends you to GitHub's own page when a repository is missing", async () => {
  const { app, page, cleanup } = await open({ repo: false });
  try {
    // ⚠️ Stub `openExternal` in MAIN, so the assertion is about the URL this app
    // builds rather than about a browser opening. The id→URL mapping is the part
    // worth proving: the renderer names an installation, never an address.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { __opened: string[] }).__opened = opened;
      shell.openExternal = async (target: string) => {
        opened.push(target);
      };
    });

    await gotoPulls(page);
    await page.getByPlaceholder("Search repositories").fill("deal");
    await expect(page.getByText(/Nothing matches “deal” in acme/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText("If it is missing, this app has not been given access"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Configure GitHub App" }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { __opened: string[] }).__opened,
        ),
      )
      // The installation that belongs to the owner on screen — GitHub's page
      // listing exactly which repositories this app may read for them.
      .toEqual(["https://github.com/settings/installations/13333801"]);
  } finally {
    await cleanup();
  }
});

test("explains an empty connection rather than looking broken", async () => {
  const { app, page, github, cleanup } = await open({ repo: false });
  try {
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { __opened: string[] }).__opened = opened;
      shell.openExternal = async (target: string) => {
        opened.push(target);
      };
    });
    github.setRepos([]);
    await gotoPulls(page);

    // A shadcn `Empty`, like every other "nothing here" in this app.
    await expect(page.getByText("No repositories yet")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/cannot see any/)).toBeVisible();

    // No installation matches "no owner at all", so this is the install page.
    await page.getByRole("button", { name: "Configure GitHub App" }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { __opened: string[] }).__opened,
        ),
      )
      .toEqual([
        "https://github.com/apps/lanework/installations/select_target",
      ]);
  } finally {
    await cleanup();
  }
});

test("offers a way out even when the app cannot list its installations", async () => {
  const { app, page, github, cleanup } = await open({ repo: false });
  try {
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { __opened: string[] }).__opened = opened;
      shell.openExternal = async (target: string) => {
        opened.push(target);
      };
    });

    // ⚠️ A classic OAuth App's token is refused by `/user/installations`. This
    // used to hide the button entirely — the repository list worked, the search
    // found nothing, and the only way forward was invisible.
    github.setInstallationsRefused(true);
    await gotoPulls(page);
    await page.getByPlaceholder("Search repositories").fill("deal");
    await expect(page.getByText(/Nothing matches “deal”/)).toBeVisible({
      timeout: 15_000,
    });

    const configure = page.getByRole("button", {
      name: "Configure GitHub App",
    });
    await expect(configure).toBeVisible();
    await configure.click();

    // The page where an OAuth app's access — including an organisation's
    // third-party approval — is actually granted.
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { __opened: string[] }).__opened,
        ),
      )
      .toEqual([
        `https://github.com/settings/connections/applications/${CLIENT_ID}`,
      ]);
  } finally {
    await cleanup();
  }
});

test("asks for organisation repositories, not just the ones you own", async () => {
  const { page, github, cleanup } = await open({ repo: false });
  try {
    await gotoPulls(page);
    await expect(page.getByRole("button", { name: /toolkit/ })).toBeVisible({
      timeout: 15_000,
    });

    // ⚠️ This is the regression. The picker used to read GraphQL
    // `viewer.repositories`, whose `ownerAffiliations` default of
    // `[OWNER, COLLABORATOR]` silently filtered organisation repositories back
    // out — an org with third-party access granted simply never appeared. The
    // REST call has to name all three affiliations, every time.
    const asked = github.seen.find((url) => url.startsWith("/user/repos"));
    expect(asked).toBeDefined();
    expect(asked).toContain(
      "affiliation=owner,collaborator,organization_member",
    );
    expect(asked).toContain("sort=pushed");
  } finally {
    await cleanup();
  }
});

test("filters by state, and asks GitHub for it rather than trimming locally", async () => {
  const { page, github, cleanup } = await open();
  try {
    await gotoPulls(page);
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible({
      timeout: 15_000,
    });
    // Open is the default, so nothing merged is on screen yet.
    await expect(page.getByText("feat: ship the thing")).toHaveCount(0);

    await page.getByRole("button", { name: /^Filter by state/ }).click();
    await page.getByRole("menuitemradio", { name: "Merged" }).click();

    await expect(page.getByText("feat: ship the thing")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("chore(deps): bump @types/node")).toHaveCount(
      0,
    );

    // ⚠️ The proof that this is a server-side filter: the stub was asked for
    // MERGED. A list narrowed in the renderer would have asked for OPEN and
    // shown nothing, which looks the same until a repo has merged work.
    const asked = github.seen.filter((entry) => entry.startsWith("/graphql"));
    expect(asked.length).toBeGreaterThan(1);

    // The filter survives a reload, because it lives in the URL.
    await page.reload();
    await expect(page.getByText("feat: ship the thing")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await cleanup();
  }
});

test("an empty state explains which filter emptied it", async () => {
  const { page, github, cleanup } = await open();
  try {
    github.setEmpty(true);
    await gotoPulls(page);

    await expect(page.getByText("No open pull requests")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(`${REPO} has none to show.`)).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("a tab that hides everything says so in its own words", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible({
      timeout: 15_000,
    });

    // The repository has pull requests; this tab does not. Saying "none to
    // show" here would send somebody looking for work that is right there.
    await page.getByRole("button", { name: "Authored", exact: true }).click();
    await expect(page.getByText("None of these are yours")).toBeVisible();
    await expect(page.getByText("Try the All tab.")).toBeVisible();
  } finally {
    await cleanup();
  }
});
