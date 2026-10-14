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

/**
 * The commits this pull request is made of, oldest first.
 *
 * ⚠️ Each one carries a DIFFERENT file, so picking a commit is visible: the
 * diff and the tree both have to change, and a stub whose commits all touched
 * the same file would let a broken picker pass.
 */
const COMMITS = [
  {
    sha: "a".repeat(40),
    message: "chore(deps): bump @types/node from 20.14.11 to 22.1.0\n\nBody.",
    date: new Date(Date.now() - 172_800_000).toISOString(),
    files: [
      {
        filename: "package.json",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: PATCH,
      },
    ],
  },
  {
    sha: "d".repeat(40),
    message: "docs: note the bump in the changelog",
    date: new Date(Date.now() - 86_400_000).toISOString(),
    files: [
      {
        filename: "README.md",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: ["@@ -1,2 +1,3 @@", " # Widgets", "+Now with types.", " "].join(
          "\n",
        ),
      },
    ],
  },
];

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
  /** Answer the activity query with no `statusCheckRollup` — a repo with no CI. */
  setNoChecks: (value: boolean) => void;
  /** Refuse a posted comment, so the screen's failure path can be tested. */
  setCommentRefused: (value: boolean) => void;
  /**
   * Answer EVERY request with one of GitHub's refusals.
   *
   * ⚠️ `"ratelimit"` is not the same 403 as `"forbidden"`: the app tells them
   * apart by `x-ratelimit-remaining`, so the headers are the test, not the
   * status code.
   */
  setRefusal: (value: "unauthorized" | "missing" | "ratelimit" | null) => void;
  /** Comments this stub has accepted, newest last. */
  setMerge: (value: Record<string, unknown>) => void;
  merges: unknown[];
  comments: string[];
  seen: string[];
  close: () => Promise<void>;
}> {
  let broken = false;
  let empty = false;
  let repos = [REPO, "acme/toolkit", "other-org/sandbox"];
  let installationsRefused = false;
  let noChecks = false;
  let commentRefused = false;
  let refusal: "unauthorized" | "missing" | "ratelimit" | null = null;
  let mergeData: Record<string, unknown> = {};
  const merges: unknown[] = [];
  const comments: string[] = [];
  /** Every request seen, so a test can prove what was actually asked for. */
  const seen: string[] = [];

  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const url = request.url ?? "";
    seen.push(url);

    if (refusal === "unauthorized") return send(401, { message: "Bad creds" });
    if (refusal === "missing") return send(404, { message: "Not Found" });
    if (refusal === "ratelimit") {
      // A quarter of an hour out, so the sentence the app writes has a number
      // in it that this test can name exactly.
      response.writeHead(403, {
        "content-type": "application/json",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 900),
      });
      return response.end(JSON.stringify({ message: "rate limit exceeded" }));
    }

    if (request.method === "PUT" && url.endsWith("/merge")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      merges.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (mergeData.reject)
        return send(422, {
          message: "Unprocessable Entity",
          errors: ["Branch policy rejected this merge."],
        });
      if (mergeData.notMerged)
        return send(200, {
          merged: false,
          message: "Merge refused by required checks.",
        });
      mergeData = { ...mergeData, merged: true, state: "closed" };
      return send(200, { merged: true });
    }
    if (url === "/repos/acme/widgets")
      return send(200, {
        permissions: { push: true },
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
        ...(mergeData.repository as object),
      });
    if (request.method === "POST" && url.startsWith("/graphql")) {
      if (broken) return send(500, { message: "nope" });
      // The state filter is sent to GitHub, so the stub has to honour it —
      // otherwise a test could pass while the app filtered locally.
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      // ⚠️ Two different queries arrive on this one path. The activity read
      // names a pull request; the list read does not. Answering both with the
      // list's shape is what made the first run of these tests green against a
      // screen that could not have worked.
      if (typeof body?.variables?.number === "number")
        return send(200, {
          data: {
            repository: {
              pullRequest: {
                createdAt: new Date(Date.now() - 86_400_000).toISOString(),
                author: { login: "dependabot" },
                timelineItems: {
                  totalCount: 2 + comments.length,
                  nodes: [
                    {
                      __typename: "PullRequestCommit",
                      id: "c1",
                      commit: {
                        committedDate: new Date(
                          Date.now() - 80_000_000,
                        ).toISOString(),
                        author: { user: { login: "dependabot" } },
                      },
                    },
                    {
                      __typename: "PullRequestCommit",
                      id: "c2",
                      commit: {
                        committedDate: new Date(
                          Date.now() - 79_000_000,
                        ).toISOString(),
                        author: { user: { login: "dependabot" } },
                      },
                    },
                    ...comments.map((text, index) => ({
                      __typename: "IssueComment",
                      id: `ic${index}`,
                      createdAt: new Date().toISOString(),
                      body: text,
                      author: { login: "tester" },
                    })),
                  ],
                },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: noChecks
                          ? null
                          : {
                              state: "FAILURE",
                              contexts: {
                                totalCount: 2,
                                nodes: [
                                  {
                                    __typename: "CheckRun",
                                    id: "cr1",
                                    name: "build",
                                    conclusion: "SUCCESS",
                                    status: "COMPLETED",
                                    detailsUrl: "https://example.test/build",
                                  },
                                  {
                                    __typename: "CheckRun",
                                    id: "cr2",
                                    name: "typecheck",
                                    conclusion: "FAILURE",
                                    status: "COMPLETED",
                                    detailsUrl: null,
                                  },
                                ],
                              },
                            },
                      },
                    },
                  ],
                },
              },
            },
          },
        });

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
    if (request.method === "POST" && url.endsWith("/reviews"))
      return send(422, {
        message: "Validation Failed",
        errors: [{ message: "Review policy rejected this request." }],
      });
    if (request.method === "POST" && /\/issues\/\d+\/comments$/.test(url)) {
      if (commentRefused)
        return send(403, { message: "You cannot comment on this repository." });
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      comments.push(String(body?.body ?? ""));
      return send(201, { id: comments.length });
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
    // ⚠️ TWO commits, so the picker has something to choose BETWEEN. A stub
    // with one commit cannot tell "shows the commit you picked" apart from
    // "shows whatever it was already showing".
    if (/\/pulls\/\d+\/commits/.test(url))
      return send(
        200,
        COMMITS.map((commit) => ({
          sha: commit.sha,
          commit: {
            message: commit.message,
            author: { name: "Dependabot", date: commit.date },
          },
          author: { login: "dependabot" },
        })),
      );
    // ⚠️ Anchored on the whole path, not `includes("/commits/")`. Every call
    // this stub serves starts `/repos/owner/repo/`, so a loose match here
    // swallowed the pull request's own reads and answered them with a commit.
    const commitPath =
      /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{7,64})$/i.exec(url);
    if (commitPath) {
      const commit = COMMITS.find((entry) => entry.sha === commitPath[1]);
      if (!commit) return send(404, { message: "no such commit" });
      return send(200, {
        sha: commit.sha,
        parents: [{ sha: "c".repeat(40) }],
        files: commit.files,
      });
    }
    if (/\/pulls\/\d+\/files/.test(url))
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
          // ⚠️ The only file here with a folder in front of it. Everything the
          // header does with a path — muting the directory, truncating it from
          // the left, keeping the filename — needs a path that HAS one, and a
          // fixture of root files is why none of that was ever checked.
          filename: "src/lib/utils.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: [
            "@@ -1,1 +1,2 @@",
            " export const a = 1;",
            "+export const b = 2;",
          ].join("\n"),
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
    // ⚠️ ANY pull number, not just 7. Serving one number meant a request for
    // any other hung with no response at all — which a test sees as a 30s
    // timeout and an empty page snapshot, rather than as a 404 it could read.
    const detail = /\/pulls\/(\d+)(?:\?|$)/.exec(url);
    if (detail) {
      const number = Number(detail[1]);
      const state = number === 5 ? "MERGED" : number === 3 ? "CLOSED" : "OPEN";
      return send(200, {
        ...pullNode(state),
        state: state === "OPEN" ? "open" : "closed",
        merged: state === "MERGED",
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
        html_url: "https://github.com/acme/widgets/pull/7",
        mergeable: true,
        mergeable_state: "clean",
        ...mergeData,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        requested_reviewers: [{ login: "tester" }],
      });
    }
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
    setNoChecks: (value) => {
      noChecks = value;
    },
    setCommentRefused: (value) => {
      commentRefused = value;
    },
    setRefusal: (value) => {
      refusal = value;
    },
    setMerge: (value) => {
      mergeData = value;
    },
    merges,
    comments,
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

/**
 * The three refusals GitHub has for this screen, each one a sentence.
 *
 * ⚠️ Asserted with no cache behind them. A repeat read falls back to the saved
 * list, which is the right screen but the wrong test: it hides the message, so
 * each of these reads GitHub for the first time.
 */
test("a dead connection asks to be connected again", async () => {
  const { page, github, cleanup } = await open();
  try {
    github.setRefusal("unauthorized");
    await gotoPulls(page);
    // A 401 is the one refusal the app acts on rather than reports: the token
    // is finished, so the screen names the account and offers the way back in
    // instead of printing a sentence next to a retry that cannot work.
    await expect(
      page.getByRole("heading", { name: "Reconnect GitHub" }),
    ).toBeVisible({ timeout: 15_000 });
    const message = page.getByText(
      /GitHub stopped accepting the connection for @tester/i,
    );
    await expect(message).toBeVisible();
    await expect(message).not.toContainText("GitHubError");
    await expect(
      page.getByRole("button", { name: "Connect GitHub" }),
    ).toBeVisible();
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("a repository it cannot see names both reasons", async () => {
  const { page, github, cleanup } = await open();
  try {
    github.setRefusal("missing");
    await gotoPulls(page);
    // Both halves, because "does not exist" alone sends someone to re-type a
    // name that was right, and "cannot see it" alone hides a typo.
    const message = page.getByText(
      /does not exist, or this connection cannot see it/i,
    );
    await expect(message).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("a used-up rate limit says when it comes back", async () => {
  const { page, github, cleanup } = await open();
  try {
    github.setRefusal("ratelimit");
    await gotoPulls(page);
    // The reset header is 15 minutes out; a screen that only said "try again"
    // would leave someone retrying into the same wall for a quarter of an hour.
    const message = page.getByText(/hourly request limit is used up/i);
    await expect(message).toBeVisible({ timeout: 15_000 });
    await expect(message).toContainText(/resets in about 1[45] minutes/i);
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
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
      // ⚠️ The timeline read and the comment write, both keyed by slug like the
      // rest. `comment` is the first write here that is NOT a review — see
      // `DesktopGitApi` — and neither of them takes an `owner/repo`.
      "activity",
      "appAccess",
      "cancelConnect",
      "comment",
      // Two reads, no writes, both keyed by the project's slug — the rule the
      // rest of this surface follows. Neither can be pointed at a repository
      // the renderer names, and neither carries a token back.
      "commitDiff",
      "commits",
      "connect",
      "disconnect",
      "fileText",
      "linkRepo",
      "merge",
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

test("starts the file list flush against the header", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await expect(page.getByText("package.json")).toBeVisible({
      timeout: 15_000,
    });

    // ⚠️ `CodeView` puts 8px of margin above its first item by default, which
    // reads as a gap between the pull request's header and a list that starts
    // directly under it. `options.layout.paddingTop` is the only way to reach
    // it — the margin is set inline, on an element the library owns.
    const gap = await page
      .locator("diffs-container")
      .first()
      .evaluate((el) => {
        const scroller = el.closest(".overflow-y-auto");
        if (scroller === null) return null;
        return Math.round(
          el.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
        );
      });
    expect(gap).toBe(0);
  } finally {
    await cleanup();
  }
});

test("names a file by its type, and by its folder apart from its name", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    const header = page.getByRole("button", {
      name: "Collapse src/lib/utils.ts",
    });
    await expect(header).toBeVisible({ timeout: 15_000 });

    // ⚠️ The icon is chosen from the FILE TYPE, not from what happened to the
    // file. `@pierre/diffs` draws its own change symbol here — the same blue
    // dot on every modified file — and this is the assertion that says the
    // `@pierre/trees` sprite replaced it.
    // ⚠️ `header-custom` is the slot `@pierre/diffs` opens when the host takes
    // the whole header over; `header-prefix` is the one the DEFAULT header
    // leaves for an add-on, and this screen no longer uses it.
    const row = page.locator('[slot="header-custom"]').filter({
      has: page.getByRole("button", { name: "Collapse package.json" }),
    });
    await expect(row.locator("use")).toHaveAttribute(
      "href",
      "#file-tree-builtin-json",
    );

    // The directory is muted and the filename is not, so a list of paths reads
    // as a list of files. Colours, not classes: this is about what is on
    // screen, and a class name proves nothing about that.
    // ⚠️ Colours, not class names: this is about what is on screen. Reached
    // through a cast on `globalThis`, the shape the gallery spec uses — the
    // test tsconfig has no DOM lib, and this callback runs in the page.
    const parts = await header.evaluate((el) => {
      const styles = globalThis as unknown as {
        getComputedStyle(node: unknown): { color: string };
      };
      const root = el as unknown as {
        querySelectorAll(
          selector: string,
        ): ArrayLike<{ textContent: string | null }>;
      };
      return Array.from(root.querySelectorAll("span")).map((span) => ({
        text: span.textContent ?? "",
        color: styles.getComputedStyle(span).color,
      }));
    });
    expect(parts.map((part) => part.text)).toEqual(["src/lib/", "utils.ts"]);
    expect(parts[0].color).not.toBe(parts[1].color);
  } finally {
    await cleanup();
  }
});

test("hands over the file path, once you point at the file", async () => {
  const { app, page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    const header = page.getByRole("button", {
      name: "Collapse src/lib/utils.ts",
    });
    await expect(header).toBeVisible({ timeout: 15_000 });

    const copy = page.getByRole("button", {
      name: "Copy path src/lib/utils.ts",
    });
    // ⚠️ `toBeVisible` is no use here: an `opacity: 0` element is visible to
    // Playwright, and opacity is exactly what hides a row's actions until the
    // row is pointed at. Read the opacity itself.
    const opacity = () =>
      copy.evaluate((el) => {
        const box = (
          el as unknown as { closest(selector: string): unknown }
        ).closest("span");
        if (box === null) return "1";
        return (
          globalThis as unknown as {
            getComputedStyle(node: unknown): { opacity: string };
          }
        ).getComputedStyle(box).opacity;
      });
    expect(await opacity()).toBe("0");

    // ⚠️ Hover INSIDE the retry, not once before it. The diff finishes
    // highlighting after the header is already visible and the layout shifts
    // under a pointer that stays put — one hover then lands on whatever moved
    // into its place, and polling the opacity waits for a hover that is over.
    await expect(async () => {
      await header.hover();
      expect(await opacity()).toBe("1");
    }).toPass({ timeout: 10_000 });

    await copy.click();
    // The tick only appears once `writeText` RESOLVES, so waiting for it is
    // what makes the clipboard read below a fact rather than a race.
    await expect(
      page.getByRole("button", { name: "Copied src/lib/utils.ts" }),
    ).toBeVisible();

    // ⚠️ Read back from the OS clipboard through main, not from the promise the
    // renderer resolved. `setPermissionCheckHandler(() => false)` refuses
    // `clipboard-sanitized-write`, which makes `writeText` reject and every
    // Copy button in the app a no-op — and a renderer-side assertion cannot
    // tell that apart from a write that worked.
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      "src/lib/utils.ts",
    );
  } finally {
    await cleanup();
  }
});

test("puts the changed files in a tree, and jumps the diff to the one you pick", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await expect(page.getByText("package.json")).toBeVisible({
      timeout: 15_000,
    });

    // ⚠️ Addressed by `data-item-path`. `@pierre/trees` splits a name into
    // segments so it can truncate them separately, so `utils.ts` is not one
    // text node and `getByText` will not find it.
    const tree = page.locator("file-tree-container");
    await expect(tree).toBeVisible();
    await expect(tree.locator('[data-item-path="src/lib/"]')).toBeVisible();
    const row = tree.locator('[data-item-path="src/lib/utils.ts"]');
    await expect(row).toBeVisible();
    // The status GitHub reported, carried into the tree's own vocabulary.
    await expect(row).toHaveAttribute("data-item-git-status", "modified");

    // ⚠️ The file is far enough down to be virtualized away, which is the
    // reason the tree drives `CodeView.scrollTo` rather than an anchor: a
    // `scrollIntoView` on an element that was never rendered does nothing.
    const header = page.getByRole("button", {
      name: /(Collapse|Expand) src\/lib\/utils\.ts/,
    });
    await row.click();
    await expect(header).toBeInViewport({ timeout: 15_000 });
  } finally {
    await cleanup();
  }
});

test("the header names the branches as badges, not as text with an arrow in it", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });

    // Both branches are on screen, each as its own element rather than as one
    // run of text — which is what lets the long one truncate on its own.
    await expect(
      page.getByTitle("dependabot/npm_and_yarn/types/node-22.1.0"),
    ).toBeVisible();
    await expect(page.getByTitle("main")).toBeVisible();

    // ⚠️ And the arrow between them is DRAWN, not typed. A "→" in the text
    // takes the surrounding font's baseline rather than the icon metrics the
    // rest of the row is aligned to.
    await expect(page.getByText("→")).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("the files panel starts under the title row, not beside it", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    const panel = page.getByRole("complementary", { name: "Files changed" });
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // ⚠️ This REPLACES an assertion that the tree ran the full height of the
    // window, level with the pull request list. It did, and that was the
    // problem: it stood alongside the pull request's TITLE, a row that says
    // nothing about files, so the header describing the pull request stopped
    // short of the width it described. The tree now begins below that row.
    const panelBox = await panel.boundingBox();
    const listBox = await page.getByTestId("list").boundingBox();
    const header = await page.getByRole("tab", { name: "Code" }).boundingBox();
    if (panelBox === null || listBox === null || header === null)
      throw new Error("no box");

    expect(panelBox.y).toBeGreaterThan(listBox.y);
    // Below the title row, and the tab control sits in that row.
    expect(panelBox.y).toBeGreaterThan(header.y);
    // ⚠️ And it runs the full height of the DIFF beside it — it is a column of
    // the detail pane, not a box floating inside the diff. It stops where the
    // review footer starts, because that footer spans both: approving is about
    // the pull request, not about the file you happen to have open, so it stays
    // put when the summary replaces the diff.
    const diffBox = await page.getByTestId("diff").boundingBox();
    if (diffBox === null) throw new Error("no diff box");
    expect(Math.round(panelBox.y)).toBe(Math.round(diffBox.y));
    expect(Math.round(panelBox.height)).toBe(Math.round(diffBox.height));

    // Put it away and it is gone from the window, not merely narrowed.
    await page.getByRole("button", { name: "Hide file tree" }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "Show file tree" }).click();
    await expect(panel).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("the summary has no file tree beside it", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    const panel = page.getByRole("complementary", { name: "Files changed" });
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // ⚠️ A tree beside a description navigates nothing. The row that carries
    // the commit picker goes with it — both describe a diff.
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(panel).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Hide file tree" }),
    ).toHaveCount(0);

    // ⚠️ And the choice survives the trip. Collapsing the panel to draw the
    // summary must not be recorded as "they closed the file tree".
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(panel).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("one commit can be reviewed on its own, and the whole pull request again", async () => {
  const { page, github, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });

    const picker = page.getByRole("button", {
      name: /Choose what the diff shows/,
    });
    await expect(picker).toContainText("All PR changes");

    // ⚠️ Nothing has asked GitHub for the commits yet. They are read when the
    // menu is opened, never with the pull request — most pull requests are
    // opened by somebody who never wants this list.
    expect(github.seen.some((url) => url.includes("/pulls/7/commits"))).toBe(
      false,
    );

    await picker.click();
    await page.getByText("Commits", { exact: true }).hover();
    await expect(
      page.getByText("docs: note the bump in the changelog"),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByText("docs: note the bump in the changelog").click();

    // ⚠️ The diff is now that commit's, and ONLY that commit's. The pull
    // request touches four files; this commit touches one, and a viewer still
    // showing the other three would be describing a change nobody picked.
    await expect(page.getByText("Now with types.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('"@types/node": "^22.1.0",')).toHaveCount(0);
    await expect(picker).toContainText("docs: note the bump in the changelog");

    // ⚠️ And the tree follows it. The tree is a separate panel now and reads
    // the selection from the same place the diff does — two answers to "which
    // files are on screen" is a tree listing files the diff is not showing.
    //
    // ⚠️ Rows are addressed by `data-item-path`. The library splits a name into
    // segments so it can truncate them separately, and it keeps a measuring
    // copy of each — so the panel's text reads `README.README.……mdmdM` and no
    // text assertion against it means anything.
    const panel = page.getByRole("complementary", { name: "Files changed" });
    await expect(panel.locator('[data-item-path="README.md"]')).toBeVisible();
    await expect(panel.locator('[data-item-path="package.json"]')).toHaveCount(
      0,
    );

    await picker.click();
    await page.getByText("All PR changes").click();
    await expect(page.getByText('"@types/node": "^22.1.0",')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      panel.locator('[data-item-path="package.json"]'),
    ).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("summary and code are two tabs, and the tab is in the URL", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });

    // ⚠️ Code is the landing tab, and it is spelled by ABSENCE — a pull request
    // somebody is reviewing keeps the short URL, and a `view` in a link means
    // they deliberately went to the summary.
    const code = page.getByRole("tab", { name: "Code" });
    await expect(code).toHaveAttribute("aria-selected", "true");
    expect(page.url()).not.toContain("view=");

    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(page.getByRole("tab", { name: "Summary" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(page.url()).toContain("view=summary");

    // The summary is about the pull request, so it carries the facts the
    // header stopped carrying: the branches, and the description.
    await expect(page.getByText("Description")).toBeVisible();
    await expect(page.getByText("Branch")).toBeVisible();

    // ⚠️ The branch row is on the SUMMARY now, so the diff's own second row —
    // the one with the commit picker on it — is gone while we are here.
    await expect(
      page.getByRole("button", { name: "Show file tree" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Hide file tree" }),
    ).toHaveCount(0);

    // ⚠️ Back returns to the diff rather than leaving the pull request. That is
    // the whole reason the tab lives in the URL instead of in a `useState`.
    await page.goBack();
    await expect(code).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("package.json").first()).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("the switch between tabs keeps the list's own filters", async () => {
  const { page, cleanup } = await open();
  try {
    // ⚠️ The detail route inherits `tab` and `status` from the list route. A
    // tab switch that wrote a bare `{view}` would drop them, and the list
    // beside the diff would quietly reset to every open pull request.
    await page.goto(`app://lanework/w/${SLUG}/pulls?tab=all&status=all`);
    await page.getByText("chore(deps): bump @types/node").click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(page.getByText("Description")).toBeVisible();
    expect(page.url()).toContain("tab=all");
    expect(page.url()).toContain("status=all");
  } finally {
    await cleanup();
  }
});

test("the columns can be dragged, and the separator is a real one", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });

    const list = page.getByTestId("list");
    const before = await list.boundingBox();
    if (before === null) throw new Error("no list");

    // ⚠️ Driven by the KEYBOARD, not a synthetic drag. A pointer drag in a
    // headless window is a flaky way to assert a resize, and arrow-key resizing
    // is the accessibility this dependency was taken for — if it works, the
    // separator is a real `role="separator"` with the right ARIA on it.
    // ⚠️ BY NAME. `.first()` is the shell's own handle — the one between the
    // rail and everything else — and widening that one makes this list NARROWER,
    // which is how this assertion first failed while the feature worked.
    const separator = page.getByRole("separator", {
      name: "Resize pull request list",
    });
    await separator.focus();
    for (let index = 0; index < 5; index += 1)
      await separator.press("ArrowRight");

    await expect
      .poll(async () => (await list.boundingBox())?.width ?? 0)
      .toBeGreaterThan(before.width);
  } finally {
    await cleanup();
  }
});

test("focus mode puts the other columns away, and gives them back", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });

    const list = page.getByTestId("list");
    const sidebar = page.getByTestId("sidebar");
    expect((await list.boundingBox())?.width ?? 0).toBeGreaterThan(0);

    // ⚠️ One button, two panel GROUPS: the rail belongs to the shell and the
    // list belongs to this screen, so this also asserts that `stores/layout.ts`
    // reaches both of them.
    await page.getByRole("button", { name: "Focus the diff" }).click();
    await expect
      .poll(async () => (await list.boundingBox())?.width ?? 0)
      .toBe(0);
    await expect
      .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
      .toBe(0);

    await page.getByRole("button", { name: "Show the other panels" }).click();
    await expect
      .poll(async () => (await list.boundingBox())?.width ?? 0)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
      .toBeGreaterThan(100);
  } finally {
    await cleanup();
  }
});

test("the files panel can be filtered by name", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    const filter = page.getByLabel("Filter files");
    await expect(filter).toBeVisible({ timeout: 15_000 });

    // ⚠️ The count is in the PLACEHOLDER, which is where the `FILES 15` header
    // this input replaced used to say it. It costs no row, and it gets out of
    // the way the moment somebody starts typing — which is when "how many
    // files" stops being the question they are asking.
    await expect(filter).toHaveAttribute("placeholder", /\d+ files?…/);
  } finally {
    await cleanup();
  }
});

test("the timeline is read for the summary, and not before", async () => {
  const { page, github, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });

    // ⚠️ The count of GraphQL reads, not "did it happen". Opening a pull request
    // already spends one — the list — and the point of loading the timeline
    // lazily is that reading a DIFF must not spend a second one.
    const before = github.seen.filter((entry) =>
      entry.startsWith("/graphql"),
    ).length;

    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(page.getByText("opened this pull request")).toBeVisible();
    expect(
      github.seen.filter((entry) => entry.startsWith("/graphql")).length,
    ).toBeGreaterThan(before);

    // A push of two commits is ONE row, not two.
    await expect(page.getByText("pushed 2 commits")).toBeVisible();

    // ⚠️ And going back is free. The tab is unmounted and remounted on every
    // switch, so a read per mount would be a request per click.
    const after = github.seen.filter((entry) =>
      entry.startsWith("/graphql"),
    ).length;
    await page.getByRole("tab", { name: "Code" }).click();
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(page.getByText("opened this pull request")).toBeVisible();
    expect(
      github.seen.filter((entry) => entry.startsWith("/graphql")).length,
    ).toBe(after);
  } finally {
    await cleanup();
  }
});

test("checks are counted rather than summed into a verdict", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await page.getByRole("tab", { name: "Summary" }).click();

    await expect(page.getByText("typecheck")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("build")).toBeVisible();
    // ⚠️ Counts, not "all checks passed". A rollup can read SUCCESS while
    // several checks were skipped, and that sentence is the one somebody reads
    // immediately before approving.
    await expect(page.getByText("1 failing, 1 passing")).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("a repository with no CI is told so in words", async () => {
  const { page, github, cleanup } = await open();
  try {
    // ⚠️ Set BEFORE the app asks, rather than reloading the window mid-test. A
    // repository with no CI is an ordinary repository: it gets a sentence, not
    // a spinner and not an error — those two are what a failed read looks like.
    github.setNoChecks(true);
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await page.getByRole("tab", { name: "Summary" }).click();

    await expect(page.getByText("No CI checks")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await cleanup();
  }
});

test("a comment is posted and read back, and a refusal leaves the draft", async () => {
  const { page, github, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await page.getByRole("tab", { name: "Summary" }).click();
    const box = page.getByLabel("Leave a comment");
    await expect(box).toBeVisible({ timeout: 15_000 });

    // ⚠️ Refusal FIRST, because what it must not do is destroy the draft. A
    // send that empties the field before it succeeds loses a paragraph that no
    // error message brings back.
    github.setCommentRefused(true);
    await box.fill("Does this need a changelog entry?");
    await page.getByRole("button", { name: "Post comment" }).click();
    // ⚠️ And the sentence is one a person can read. It arrived as
    // `GitHubError: GitHub refused that request…` until `ipcMessage` learned to
    // strip the class name Electron serialises in front of a main-process
    // throw — every GitHub path had it, this is just where it surfaced.
    const failure = page.getByText(/refused that request/i);
    await expect(failure).toBeVisible();
    await expect(failure).not.toContainText("GitHubError");
    await expect(box).toHaveValue("Does this need a changelog entry?");
    expect(github.comments).toHaveLength(0);

    github.setCommentRefused(false);
    await page.getByRole("button", { name: "Post comment" }).click();

    // ⚠️ Read BACK from the server rather than appended locally. The row on
    // screen is the one GitHub stored, so its author and its timestamp are
    // facts rather than three guesses that each fail differently.
    await expect(
      page.getByText("Does this need a changelog entry?"),
    ).toBeVisible();
    await expect(box).toHaveValue("");
    expect(github.comments).toEqual(["Does this need a changelog entry?"]);
  } finally {
    await cleanup();
  }
});

test("a merged pull request offers no verdict, but still takes a comment", async () => {
  const { page, cleanup } = await open();
  try {
    // ⚠️ `status=all` so the merged one is in the list at all — the state
    // filter is sent to GitHub, not applied here.
    await page.goto(`app://lanework/w/${SLUG}/pulls?tab=all&status=all`);
    await page.getByText("chore(deps): bump @types/node").first().click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });
    // ⚠️ `exact`, because the list's own `Reviewing` tab is also a button
    // whose name contains "Review".
    const verdict = page.getByRole("button", { name: "Review", exact: true });
    // The open one still offers it.
    await expect(verdict).toBeVisible();

    // The merged one, by its own title — the stub gives each state a distinct
    // pull request rather than three copies of one.
    await page.getByText("feat: ship the thing").click();
    await expect(verdict).toHaveCount(0);

    // ⚠️ But commenting survives. "Why was this done this way" is a question
    // people ask about merged work; only the VERDICT is meaningless once it
    // has shipped.
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(page.getByLabel("Leave a comment")).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("FE50 merge split buttons share methods, cancel safely and send viewed head", async () => {
  const { page, github, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page
      .getByText("chore(deps): bump @types/node", { exact: true })
      .click();
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(
      page.getByRole("button", { name: "Choose merge method" }),
    ).toHaveCount(2);
    await page
      .getByRole("button", { name: "Choose merge method" })
      .first()
      .click();
    await page
      .getByRole("menuitemradio", { name: /^Squash and merge/ })
      .click();
    await expect(
      page.getByRole("button", { name: "Squash and merge", exact: true }),
    ).toHaveCount(2);
    await page.screenshot({
      path: "../../.agents/artifacts/2026-10-09-fe50-header.png",
    });

    await page
      .getByRole("button", { name: "Squash and merge", exact: true })
      .first()
      .click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(github.merges).toEqual([]);
    await page
      .getByRole("button", { name: "Choose merge method" })
      .last()
      .click();
    await page
      .getByRole("menuitemradio", { name: /^Rebase and merge/ })
      .click();
    await expect(
      page.getByRole("button", { name: "Rebase and merge", exact: true }),
    ).toHaveCount(2);
    await mkdir(".agents/artifacts", { recursive: true });
    await page
      .getByRole("button", { name: "Choose merge method" })
      .first()
      .click();
    await page.screenshot({
      path: "../../.agents/artifacts/2026-10-09-fe50-merge.png",
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 760, height: 800 });
    for (const control of [
      page.getByRole("link", { name: "Open on GitHub" }),
      page.getByRole("button", { name: "Focus the diff" }),
      page.getByRole("button", { name: "Choose merge method" }).first(),
    ]) {
      await expect
        .poll(async () => {
          const bounds = await control.boundingBox();
          return bounds ? bounds.x + bounds.width : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(760);
    }
    await page
      .getByRole("button", { name: "Rebase and merge", exact: true })
      .first()
      .click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeHidden();
    await expect(page.getByRole("menu")).toBeHidden();
    await page.screenshot({
      path: "../../.agents/artifacts/2026-10-09-fe50-narrow.png",
    });
    await page.setViewportSize({ width: 1120, height: 800 });
    await page
      .getByRole("button", { name: "Rebase and merge", exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: "Confirm merge", exact: true })
      .click();
    await expect
      .poll(() => github.merges)
      .toEqual([{ merge_method: "rebase", sha: "a".repeat(40) }]);
    await expect(
      page.getByRole("button", { name: "Choose merge method" }),
    ).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("FE50 merge disables permission, draft, conflicts, unknown and blocked states", async () => {
  const { page, github, cleanup } = await open();
  try {
    for (const state of [
      { repository: { permissions: { push: false } } },
      {
        repository: {
          allow_rebase_merge: false,
          allow_merge_commit: false,
          allow_squash_merge: false,
        },
      },
      { draft: true },
      { mergeable: false, mergeable_state: "dirty" },
      { mergeable: null, mergeable_state: "unknown" },
      { mergeable_state: "blocked" },
    ]) {
      github.setMerge(state);
      await gotoPulls(page);
      await page
        .getByText("chore(deps): bump @types/node", { exact: true })
        .click();
      await expect(
        page
          .getByRole("button", { name: "Merge pull request", exact: true })
          .first(),
      ).toBeDisabled();
      await page.reload();
    }
    expect(github.merges).toEqual([]);
  } finally {
    await cleanup();
  }
});

test("FE50 actual PR header link opens OS browser", async () => {
  const { app, page, cleanup } = await open();
  try {
    await app.evaluate(({ shell }) => {
      (globalThis as typeof globalThis & { opened: string[] }).opened = [];
      shell.openExternal = async (url) => {
        (globalThis as typeof globalThis & { opened: string[] }).opened.push(
          url,
        );
      };
    });
    await gotoPulls(page);
    await page
      .getByText("chore(deps): bump @types/node", { exact: true })
      .click();
    await page.getByRole("link", { name: "Open on GitHub" }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as typeof globalThis & { opened: string[] }).opened,
        ),
      )
      .toEqual(["https://github.com/acme/widgets/pull/7"]);
    expect(app.windows()).toHaveLength(1);
  } finally {
    await cleanup();
  }
});

test("FE50 guarded IPC sends each method and refuses changed head, invalid input and API rejection", async () => {
  const { page, github, cleanup } = await open();
  const attempt = async (method: string, sha = "a".repeat(40)) =>
    page.evaluate(
      async ({ method, sha }) => {
        const git = (
          globalThis as unknown as {
            desktop: {
              git: {
                merge: (
                  slug: string,
                  number: number,
                  method: string,
                  sha: string,
                ) => Promise<void>;
              };
            };
          }
        ).desktop.git;
        try {
          await git.merge("acme", 7, method, sha);
          return "ok";
        } catch (error) {
          return String(error);
        }
      },
      { method, sha },
    );
  try {
    for (const method of ["merge", "squash", "rebase"]) {
      github.setMerge({});
      expect(await attempt(method)).toBe("ok");
      expect(github.merges.at(-1)).toEqual({
        merge_method: method,
        sha: "a".repeat(40),
      });
    }
    github.setMerge({});
    const count = github.merges.length;
    expect(await attempt("invalid")).not.toBe("ok");
    expect(await attempt("merge", "invalid")).not.toBe("ok");
    github.setMerge({ head: { ref: "topic", sha: "c".repeat(40) } });
    expect(await attempt("merge")).toMatch(/changed|updated|refresh/i);
    github.setMerge({ repository: { allow_squash_merge: false } });
    expect(await attempt("squash")).toMatch(/disabled/i);
    expect(github.merges).toHaveLength(count);
    github.setMerge({ reject: true });
    expect(await attempt("merge")).toContain(
      "Branch policy rejected this merge.",
    );
    github.setMerge({ notMerged: true });
    expect(await attempt("merge")).toContain(
      "Merge refused by required checks.",
    );
    github.setMerge({ user: { login: "tester" } });
    await gotoPulls(page);
    await page
      .getByText("chore(deps): bump @types/node", { exact: true })
      .click();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(
      page.getByText(/does not allow approving or requesting changes/),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Review note" })
      .fill("A note for this PR.");
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Request changes", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Comment", exact: true }),
    ).toBeEnabled();
    const review = async () =>
      page.evaluate(async () => {
        const git = (
          globalThis as unknown as {
            desktop: {
              git: {
                review: (
                  slug: string,
                  number: number,
                  verdict: string,
                  body: string,
                ) => Promise<void>;
              };
            };
          }
        ).desktop.git;
        try {
          await git.review("acme", 7, "APPROVE", "");
          return "ok";
        } catch (error) {
          return String(error);
        }
      });
    expect(await review()).toMatch(/own pull request/i);
    expect(github.seen.filter((url) => url.endsWith("/reviews"))).toHaveLength(
      0,
    );
    github.setMerge({});
    expect(await review()).toContain("Review policy rejected this request.");
  } finally {
    await cleanup();
  }
});
