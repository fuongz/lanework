import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { MachineRecord } from "../electron/main/auth/store";
import { writeFolders } from "../electron/main/projects/store";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

/**
 * The pull-request screen, against a GitHub CLI this test answers itself.
 *
 * NOTE: hermetic. `LANEWORK_GH_PATH` points the main process at
 * `fixtures/fake-gh.mjs` through a wrapper. A suite that ran the real `gh`
 * would need somebody's login to pass, would spend their rate limit, and
 * would fail on a plane.
 */

const SLUG = "acme";
const REPO = "acme/widgets";
const UPSTREAM = "upstream/widgets";
const AVATAR = "https://avatars.githubusercontent.com/u/1";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const FAKE_GH = join(import.meta.dirname, "fixtures", "fake-gh.mjs");

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

/** `package.json` at a commit: the base (`b…`) still has the old version. */
function fileAt(ref: string): string {
  const tail = ref.startsWith("b")
    ? TAIL.map((line) =>
        line.includes("@types/node") ? '   "@types/node": "^20.14.11",' : line,
      )
    : TAIL;
  return [...HEAD_LINES, ...tail].join("\n");
}

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
}

/**
 * The files the pull request changes.
 *
 * - Four, not one. A one-file fixture is why a renderer that refused
 *   multi-file patches passed every test and broke on the first real pull
 *   request.
 * - `src/lib/utils.ts` is the only path with a folder in it. Muting the
 *   directory and keeping the filename need a path that has one.
 * - `CHANGELOG.md` is long, so the diff pane has to scroll. A short diff fits
 *   the pane and passes with the scroller missing.
 */
const FILES: DiffFile[] = [
  { path: "package.json", additions: 1, deletions: 1, patch: PATCH },
  {
    path: "src/lib/utils.ts",
    additions: 1,
    deletions: 0,
    patch: [
      "@@ -1,1 +1,2 @@",
      " export const a = 1;",
      "+export const b = 2;",
    ].join("\n"),
  },
  {
    path: "CHANGELOG.md",
    additions: 200,
    deletions: 0,
    patch: [
      "@@ -1,1 +1,201 @@",
      " # Changelog",
      ...Array.from({ length: 200 }, (_, i) => `+entry ${i + 1}`),
    ].join("\n"),
  },
  {
    path: "README.md",
    additions: 1,
    deletions: 0,
    patch: ["@@ -1,2 +1,3 @@", " # Widgets", "+Now with types.", " "].join(
      "\n",
    ),
  },
];

/** What `gh pr diff` prints for these files. */
function unifiedDiff(files: DiffFile[]): string {
  return files
    .map((file) =>
      [
        `diff --git a/${file.path} b/${file.path}`,
        "index 1111111..2222222 100644",
        `--- a/${file.path}`,
        `+++ b/${file.path}`,
        file.patch,
      ].join("\n"),
    )
    .join("\n")
    .concat("\n");
}

/**
 * The commits this pull request is made of, oldest first.
 *
 * Each one changes a different file, so picking a commit is visible: the
 * diff and the tree both have to change. Commits that all touched the same
 * file would let a broken picker pass.
 */
const COMMITS = [
  {
    sha: HEAD,
    message: "chore(deps): bump @types/node from 20.14.11 to 22.1.0\n\nBody.",
    date: new Date(Date.now() - 172_800_000).toISOString(),
    files: [FILES[0]],
  },
  {
    sha: "d".repeat(40),
    message: "docs: note the bump in the changelog",
    date: new Date(Date.now() - 86_400_000).toISOString(),
    files: [FILES[3]],
  },
];

/** What `fixtures/fake-gh.mjs` answers from. See its header for the files. */
interface Scenario {
  /** `gh auth status`: `ok` exits 0, anything else exits 1. */
  account: "ok" | "logged-out";
  /** `gh api user`. */
  user: { login: string; avatar_url: string | null };
  /** `gh repo view <name> --json …`, by `owner/repo`. */
  repos: Record<string, Record<string, unknown>>;
  /** `gh pr list` / `gh pr view`, by `owner/repo`, in `gh`'s JSON shape. */
  pulls: Record<string, Record<string, unknown>[]>;
  /** `gh pr diff`, by `owner/repo#number`. */
  diffs: Record<string, string>;
  /** `gh api repos/o/r/commits/<sha>`, in REST's shape. */
  commits: Record<string, unknown>;
  /** `gh api repos/o/r/contents/<path>?ref=<sha>`, by `path@sha`. */
  contents: Record<string, string>;
  /** `gh api graphql` rate-limit query. Omitted: a full budget. */
  rateLimit?: { remaining: number; resetAt: string };
  /** The first rule whose `args` start the argv fails it with `stderr`. */
  fail: { args: string[]; stderr: string; code?: number }[];
}

function repoNode(
  name: string,
  parent: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    nameWithOwner: name,
    url: `https://github.com/${name}`,
    parent,
    viewerPermission: "WRITE",
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
  };
}

/** One pull request per state, each with its own number and title. */
function pullNode(
  state: "OPEN" | "MERGED" | "CLOSED",
): Record<string, unknown> {
  const shape = {
    OPEN: { number: 7, title: "chore(deps): bump @types/node" },
    MERGED: { number: 5, title: "feat: ship the thing" },
    CLOSED: { number: 3, title: "spike: abandoned idea" },
  }[state];
  return {
    number: shape.number,
    title: shape.title,
    state,
    url: `https://github.com/${REPO}/pull/${shape.number}`,
    isDraft: false,
    author: { login: "dependabot" },
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    headRefName: "dependabot/npm_and_yarn/types/node-22.1.0",
    baseRefName: "main",
    additions: 36,
    deletions: 24,
    changedFiles: FILES.length,
    reviewDecision: "REVIEW_REQUIRED",
    reviewRequests: [{ __typename: "User", login: "tester" }],
    body: "Bumps @types/node.",
    files: FILES.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      changeType: "MODIFIED",
    })),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefOid: HEAD,
    baseRefOid: BASE,
    commits: COMMITS.map((commit) => ({
      oid: commit.sha,
      messageHeadline: commit.message.split("\n")[0],
      committedDate: commit.date,
      authors: [{ login: "dependabot", name: "Dependabot" }],
    })),
    comments: [],
    reviews: [],
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "build",
        conclusion: "SUCCESS",
        status: "COMPLETED",
        detailsUrl: "https://example.test/build",
      },
      {
        __typename: "CheckRun",
        name: "typecheck",
        conclusion: "FAILURE",
        status: "COMPLETED",
        detailsUrl: null,
      },
    ],
  };
}

function baseScenario(): Scenario {
  const diff = unifiedDiff(FILES);
  return {
    account: "ok",
    user: { login: "tester", avatar_url: AVATAR },
    repos: { [REPO]: repoNode(REPO, null) },
    pulls: {
      [REPO]: [pullNode("OPEN"), pullNode("MERGED"), pullNode("CLOSED")],
    },
    diffs: { [`${REPO}#7`]: diff, [`${REPO}#5`]: diff, [`${REPO}#3`]: diff },
    commits: Object.fromEntries(
      COMMITS.map((commit) => [
        commit.sha,
        {
          sha: commit.sha,
          parents: [{ sha: "c".repeat(40) }],
          files: commit.files.map((file) => ({
            filename: file.path,
            status: "modified",
            additions: file.additions,
            deletions: file.deletions,
            patch: file.patch,
          })),
        },
      ]),
    ),
    contents: {
      [`package.json@${HEAD}`]: fileAt(HEAD),
      [`package.json@${BASE}`]: fileAt(BASE),
    },
    fail: [],
  };
}

/** The open pull request, #7, in a scenario. */
function pull7(scenario: Scenario): Record<string, unknown> {
  const pull = scenario.pulls[REPO].find((row) => row.number === 7);
  if (!pull) throw new Error("no pull request 7");
  return pull;
}

/** One run of the fake `gh`, as it logged it. */
interface GhCall {
  argv: string[];
  stdin: string | null;
  code: number;
}

/** The value after `flag` in an argv, or null. */
function flag(call: GhCall, name: string): string | null {
  const at = call.argv.indexOf(name);
  return at >= 0 ? (call.argv[at + 1] ?? null) : null;
}

/**
 * A fake `gh` in `profile/gh/`.
 *
 * The app runs `bin`, a shell wrapper that sets `FAKE_GH_STATE` itself and
 * runs the fixture under this test's own Node. So the fixture needs no
 * executable bit in git, and no `node` on the app's PATH.
 */
async function startFakeGh(
  profile: string,
  setup?: (scenario: Scenario) => void,
) {
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

  let scenario = baseScenario();
  const save = () =>
    writeFile(join(dir, "scenario.json"), JSON.stringify(scenario));
  setup?.(scenario);
  await save();

  return {
    bin,
    /** Change the scenario in place. Writes made so far stay. */
    update: async (change: (scenario: Scenario) => void) => {
      change(scenario);
      await save();
    },
    /** Start again from the base scenario, and forget every write. */
    reset: async (change?: (scenario: Scenario) => void) => {
      scenario = baseScenario();
      change?.(scenario);
      await save();
      await rm(join(dir, "state.json"), { force: true });
    },
    /** Every run so far, oldest first. */
    calls: async (): Promise<GhCall[]> => {
      const text = await readFile(join(dir, "calls.jsonl"), "utf8").catch(
        () => "",
      );
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as GhCall);
    },
  };
}

type FakeGh = Awaited<ReturnType<typeof startFakeGh>>;

/** Runs of `gh pr <command>`, optionally only the ones that succeeded. */
async function prCalls(
  gh: FakeGh,
  command: string,
  succeeded = false,
): Promise<GhCall[]> {
  return (await gh.calls()).filter(
    (call) =>
      call.argv[0] === "pr" &&
      call.argv[1] === command &&
      (!succeeded || call.code === 0),
  );
}

/** A git checkout with this `origin`, or none when `origin` is null. */
async function gitFolder(profile: string, origin: string | null) {
  const folder = join(profile, "widgets");
  await mkdir(folder, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: folder });
  if (origin)
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: folder });
  return folder;
}

/**
 * Link `folder` to the project, through the app's own writer.
 *
 * NOTE: `writeFolders` resolves the app home from `LANEWORK_HOME`, so it is
 * pointed at the test's home for the call and put back after. Left set, it
 * would leak into every later test in this worker.
 */
async function linkFolder(home: string, apiUrl: string, folder: string) {
  const previous = process.env.LANEWORK_HOME;
  process.env.LANEWORK_HOME = home;
  try {
    const record = {
      machineId: "test-machine",
      userId: "test-user",
      apiUrl,
      name: "test-machine",
      secret: "lw_mch_test-secret",
      owner: null,
    } satisfies MachineRecord;
    await writeFolders(record, SLUG, [folder]);
  } finally {
    if (previous === undefined) delete process.env.LANEWORK_HOME;
    else process.env.LANEWORK_HOME = previous;
  }
}

/**
 * Launch the app on one project whose folder is a checkout of `REPO`.
 *
 * NOTE: set a scenario that changes the open list BEFORE launch, through
 * `scenario`. The new-PR watcher reads every project's open list as the app
 * starts and leaves it in the 60s cache, so a change made after launch is not
 * seen by the screen's first read.
 */
async function open(
  options: {
    scenario?: (scenario: Scenario) => void;
    /** `missing` points `LANEWORK_GH_PATH` at a file that does not exist. */
    gh?: "fake" | "missing";
    /** The folder's `origin`; null for no remote; `false` for no folder. */
    origin?: string | null | false;
    /** Put a file in the pre-`gh` store, `~/.lanew/git/`. */
    legacy?: boolean;
  } = {},
) {
  const plane = await startStubPlane({
    projects: [
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
  const gh = await startFakeGh(profile, options.scenario);

  const origin =
    options.origin === undefined
      ? `https://github.com/${REPO}.git`
      : options.origin;
  if (origin !== false)
    await linkFolder(home, plane.origin, await gitFolder(profile, origin));

  if (options.legacy) {
    await mkdir(join(home, "git"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, "git", "token-legacy.json"), "{}");
  }

  const app = await electron.launch({
    args: [process.cwd()],
    env: {
      ...launchEnv({ profile, home, apiUrl: plane.origin }),
      LANEWORK_GH_PATH:
        options.gh === "missing" ? join(profile, "no-such-gh") : gh.bin,
    },
  });
  const page: Page = await app.firstWindow();
  await page
    .getByRole("button", { name: /^Switch project/ })
    .waitFor({ state: "visible", timeout: 15_000 });

  return {
    app,
    page,
    gh,
    home,
    cleanup: async () => {
      await app.close();
      await plane.close();
      await removeProfile(profile);
    },
  };
}

async function gotoPulls(page: Page): Promise<void> {
  await page.goto(`app://lanework/w/${SLUG}/issues/pulls`);
}

test("lists pull requests, grouped by what they need from you", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await expect(page.getByText("Needs my review")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible();
    await expect(page.getByText("+36").first()).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("says a repo is empty rather than drawing nothing", async () => {
  const { page, cleanup } = await open({
    scenario: (scenario) => {
      scenario.pulls[REPO] = [];
    },
  });
  try {
    await gotoPulls(page);
    // A shadcn `Empty`, the same component the issues list uses, so the two
    // screens say "nothing here" the same way.
    await expect(page.getByText("No open pull requests")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(`${REPO} has none to show.`)).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("asks for the GitHub CLI when it is not installed", async () => {
  const { page, cleanup } = await open({ gh: "missing" });
  try {
    await gotoPulls(page);
    await expect(
      page.getByRole("heading", { name: "Install the GitHub CLI" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("brew install gh")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /cli\.github\.com/ }),
    ).toHaveAttribute("href", "https://cli.github.com");
    await expect(page.getByText("chore(deps): bump @types/node")).toHaveCount(
      0,
    );
  } finally {
    await cleanup();
  }
});

test("asks for `gh auth login`, and Check again picks the login up", async () => {
  const { page, gh, cleanup } = await open({
    scenario: (scenario) => {
      scenario.account = "logged-out";
    },
  });
  try {
    await gotoPulls(page);
    await expect(
      page.getByRole("heading", { name: "Sign in to the GitHub CLI" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("gh auth login", { exact: true }),
    ).toBeVisible();
    // Nothing reads pull requests without a login: not the screen, not the
    // new-PR watcher.
    expect(await prCalls(gh, "list")).toEqual([]);

    // The person runs `gh auth login` in a terminal; the app only looks again.
    await gh.update((scenario) => {
      scenario.account = "ok";
    });
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await cleanup();
  }
});

test("a login refused on a read turns into the sign-in step", async () => {
  const { page, cleanup } = await open({
    scenario: (scenario) => {
      scenario.fail = [
        {
          args: ["pr", "list"],
          stderr:
            "HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login",
        },
      ];
    },
  });
  try {
    await gotoPulls(page);
    // `gh auth status` still passes, but a read that comes back 401 means the
    // login is finished. A retry next to an error cannot fix that.
    await expect(
      page.getByRole("heading", { name: "Sign in to the GitHub CLI" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("GitHubError")).toHaveCount(0);
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("a folder whose origin is not on GitHub says so", async () => {
  const { page, gh, cleanup } = await open({
    origin: "https://gitlab.com/acme/widgets.git",
  });
  try {
    await gotoPulls(page);
    await expect(
      page.getByRole("heading", { name: "Not a GitHub repo" }),
    ).toBeVisible({ timeout: 15_000 });
    expect(await prCalls(gh, "list")).toEqual([]);
  } finally {
    await cleanup();
  }
});

test("a project with no folder on this machine says so", async () => {
  const { page, cleanup } = await open({ origin: false });
  try {
    await gotoPulls(page);
    await expect(
      page.getByRole("heading", { name: "No folder for this project" }),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanup();
  }
});

test("a fork reads its own pull requests, or its parent's", async () => {
  const { page, gh, cleanup } = await open({
    scenario: (scenario) => {
      // `gh repo view --json parent` names the parent by owner and name, with
      // no `nameWithOwner`.
      scenario.repos[REPO] = repoNode(REPO, {
        id: "R_parent",
        name: "widgets",
        owner: { id: "U_upstream", login: "upstream" },
      });
      scenario.repos[UPSTREAM] = repoNode(UPSTREAM, null);
      scenario.pulls[UPSTREAM] = [
        {
          ...pullNode("OPEN"),
          number: 42,
          title: "feat: upstream change",
          url: `https://github.com/${UPSTREAM}/pull/42`,
        },
      ];
    },
  });
  try {
    await gotoPulls(page);
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible({
      timeout: 15_000,
    });

    // NOTE: the repo is named to `gh` from `origin`. A bare `gh repo view` in
    // a fork with an `upstream` remote answers the upstream repo.
    const views = (await gh.calls()).filter(
      (call) => call.argv[0] === "repo" && call.argv[1] === "view",
    );
    expect(views.some((call) => call.argv[2] === REPO)).toBe(true);
    expect(views.some((call) => call.argv[2]?.startsWith("-"))).toBe(false);

    const sides = page.getByRole("group", { name: "Read pull requests from" });
    await expect(sides.getByRole("button", { name: REPO })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await sides.getByRole("button", { name: UPSTREAM }).click();
    await expect(page.getByText("feat: upstream change")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("chore(deps): bump @types/node")).toHaveCount(
      0,
    );
    expect(
      (await prCalls(gh, "list")).some(
        (call) => flag(call, "--repo") === UPSTREAM,
      ),
    ).toBe(true);

    await sides.getByRole("button", { name: REPO }).click();
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await cleanup();
  }
});

test("deletes the GitHub store the app kept before `gh`", async () => {
  const { home, cleanup } = await open({ legacy: true });
  try {
    // The OAuth token lived there. Nothing reads it now, and a token left on
    // disk is a token that can leak.
    await expect
      .poll(() => existsSync(join(home, "git")), { timeout: 15_000 })
      .toBe(false);
  } finally {
    await cleanup();
  }
});

test("labels a saved list when GitHub cannot be reached", async () => {
  const { page, gh, cleanup } = await open();
  try {
    // One good read fills the cache…
    await gotoPulls(page);
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible({
      timeout: 15_000,
    });

    // …then GitHub stops answering, and the screen has to say which copy it
    // is showing rather than draw a saved list as if it were current.
    await gh.update((scenario) => {
      scenario.fail = [
        {
          args: ["pr", "list"],
          stderr: "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
        },
      ];
    });
    await page.getByRole("button", { name: "Refresh pull requests" }).click();
    await expect(page.getByText("Showing a saved list")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible();
  } finally {
    await cleanup();
  }
});

// The refusals below are each asserted with no cache behind them. A repeat
// read falls back to the saved list, which hides the message, so the
// scenario is set before launch and the first read already fails.

test("a repository it cannot see names both reasons", async () => {
  const { page, cleanup } = await open({
    scenario: (scenario) => {
      scenario.fail = [
        {
          args: ["pr", "list"],
          stderr:
            "GraphQL: Could not resolve to a Repository with the name 'acme/widgets'. (repository)",
        },
      ];
    },
  });
  try {
    await gotoPulls(page);
    // Both halves: "does not exist" alone sends someone to re-type a name that
    // was right, and "cannot see it" alone hides a typo.
    const message = page.getByText(
      /does not exist, or your GitHub login cannot see it/i,
    );
    await expect(message).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("a used-up rate limit says when it comes back", async () => {
  const { page, cleanup } = await open({
    scenario: (scenario) => {
      scenario.fail = [
        {
          args: ["pr", "list"],
          stderr: "GraphQL: API rate limit exceeded for user ID 1. (rateLimit)",
        },
      ];
      // A quarter of an hour out, so the sentence has a number in it this
      // test can name.
      scenario.rateLimit = {
        remaining: 0,
        resetAt: new Date(Date.now() + 900_000).toISOString(),
      };
    },
  });
  try {
    await gotoPulls(page);
    // A screen that only said "try again" would leave someone retrying into
    // the same wall for a quarter of an hour.
    const message = page.getByText(/request limit is used up/i).first();
    await expect(message).toBeVisible({ timeout: 15_000 });
    await expect(message).toContainText(/about 1[45] minutes/i);
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("the renderer learns who is signed in, and nothing more", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await expect(page.getByText("Needs my review")).toBeVisible({
      timeout: 15_000,
    });

    // The whole surface, not a hand-picked field: a leak would arrive as a
    // new key. `globalThis`, not `window`: the test tsconfig has no DOM lib.
    const surface = await page.evaluate(() =>
      Object.keys(
        (globalThis as unknown as { desktop: { git: Record<string, unknown> } })
          .desktop.git,
      ).sort(),
    );
    // Every read and write is keyed by the project's slug. None takes an
    // `owner/repo`, so none can be pointed at a repo the renderer names.
    expect(surface).toEqual([
      "account",
      "activity",
      "check",
      "comment",
      "commitDiff",
      "commits",
      "fileText",
      // The repo's GitHub issues, beside its pull requests (FE-75).
      "issue",
      "issues",
      "merge",
      "onAccountChange",
      "pull",
      "pulls",
      "repo",
      "review",
      "selectRepo",
    ]);

    const account = await page.evaluate(() =>
      (
        globalThis as unknown as {
          desktop: { git: { account: () => Promise<unknown> } };
        }
      ).desktop.git.account(),
    );
    expect(account).toEqual({ kind: "ok", login: "tester", avatarUrl: AVATAR });
  } finally {
    await cleanup();
  }
});

test("filters by state, and asks GitHub for it rather than trimming locally", async () => {
  const { page, gh, cleanup } = await open();
  try {
    await gotoPulls(page);
    await expect(page.getByText("chore(deps): bump @types/node")).toBeVisible({
      timeout: 15_000,
    });
    // Open is the default, so nothing merged is on screen yet.
    await expect(page.getByText("feat: ship the thing")).toHaveCount(0);

    // State is a field of the list's Filter menu, as the issue list's are
    // (FE-75): the button, the field on hover, then its value.
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("menuitem", { name: "State" }).hover();
    await page.getByRole("option", { name: "Merged" }).click();

    await expect(page.getByText("feat: ship the thing")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("chore(deps): bump @types/node")).toHaveCount(
      0,
    );

    // The proof that this is a server-side filter: `gh` was asked for merged
    // ones. A list narrowed in the renderer would have asked for open ones
    // and shown nothing, which looks the same until a repo has merged work.
    expect(
      (await prCalls(gh, "list")).some(
        (call) => flag(call, "--state") === "merged",
      ),
    ).toBe(true);

    // The filter survives a reload, because it lives in the URL.
    await page.reload();
    await expect(page.getByText("feat: ship the thing")).toBeVisible({
      timeout: 15_000,
    });
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

    // The repository has pull requests; this tab does not. "None to show"
    // here would send somebody looking for work that is right there.
    // Show is a field of the Filter menu now, not a row of tabs (FE-75).
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("menuitem", { name: "Show" }).hover();
    await page.getByRole("option", { name: "Authored" }).click();
    await expect(page.getByText("None of these are yours")).toBeVisible();
    await expect(page.getByText("Try the All tab.")).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("opens a diff, folds unchanged lines, and scrolls", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(page.getByText("package.json")).toBeVisible({
      timeout: 15_000,
    });
    // Rendered by `@pierre/diffs` inside an open shadow root. Playwright
    // pierces those, so these are ordinary text assertions.
    await expect(page.getByText('"@types/node": "^22.1.0",')).toBeVisible();

    // Lines 1–31 are not in the patch, and the fold says exactly that. The
    // library marks the fold with `data-unmodified-lines` and renders one per
    // side, so this names the attribute rather than the text.
    await expect(page.locator("[data-unmodified-lines]").first()).toHaveText(
      "31 unmodified lines",
    );
    await expect(page.getByText("// line 31")).toHaveCount(0);

    // Opening the fold reads the whole file through `git.fileText`
    // (`gh api …/contents`), which is why main serves whole files.
    //
    // NOTE: `[data-expand-button]` is a `div` with `role="button"`, not a
    // `<button>`, so a `button` selector finds nothing here.
    await page.locator("[data-expand-button]").first().click();
    await expect(page.getByText("// line 31")).toBeVisible({ timeout: 15_000 });

    // NOTE: the pane has to scroll on its own. `CodeView` virtualizes
    // against its own root and sets no `overflow` there. Without
    // `overflow-y-auto` the content spills out, an `overflow-hidden` ancestor
    // clips it, and the diff cannot be scrolled. That shipped once, so this
    // asserts the behaviour, not the class.
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

    // The last file is only reachable by scrolling. That proves the list
    // virtualizes rather than rendering every line of every file.
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
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(page.getByText('"@types/node": "^22.1.0",')).toBeVisible({
      timeout: 15_000,
    });

    // `collapsed` is a field on the item and `CodeView` is controlled, so
    // the library ships no fold control. This one is ours, in the file header.
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

test("starts the file list flush against the header", async () => {
  const { page, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(page.getByText("package.json")).toBeVisible({
      timeout: 15_000,
    });

    // `CodeView` puts 8px of margin above its first item by default, a gap
    // under the header. `options.layout.paddingTop` is the only way to reach
    // it: the margin is set inline, on an element the library owns.
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
    await page.getByRole("tab", { name: "Code" }).click();
    const header = page.getByRole("button", {
      name: "Collapse src/lib/utils.ts",
    });
    await expect(header).toBeVisible({ timeout: 15_000 });

    // The icon is chosen from the file type, not from what happened to the
    // file. `@pierre/diffs` draws the same blue dot on every modified file;
    // this checks the `@pierre/trees` sprite replaced it. `header-custom` is
    // the slot it opens when the host takes the whole header over.
    const row = page.locator('[slot="header-custom"]').filter({
      has: page.getByRole("button", { name: "Collapse package.json" }),
    });
    await expect(row.locator("use")).toHaveAttribute(
      "href",
      "#file-tree-builtin-json",
    );

    // The directory is muted and the filename is not, so a list of paths
    // reads as a list of files. Colours, not class names: this is about what
    // is on screen. The cast on `globalThis` is because the test tsconfig has
    // no DOM lib, and this callback runs in the page.
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
    await page.getByRole("tab", { name: "Code" }).click();
    const header = page.getByRole("button", {
      name: "Collapse src/lib/utils.ts",
    });
    await expect(header).toBeVisible({ timeout: 15_000 });

    const copy = page.getByRole("button", {
      name: "Copy path src/lib/utils.ts",
    });
    // NOTE: `toBeVisible` is no use here. An `opacity: 0` element is
    // visible to Playwright, and opacity is what hides a row's actions until
    // the row is pointed at. Read the opacity itself.
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

    // Hover inside the retry, not once before it. The diff finishes
    // highlighting after the header is visible and the layout shifts under a
    // pointer that stays put, so one hover lands on whatever moved there.
    await expect(async () => {
      await header.hover();
      expect(await opacity()).toBe("1");
    }).toPass({ timeout: 10_000 });

    await copy.click();
    // The tick appears only once `writeText` resolves, so waiting for it
    // makes the clipboard read below a fact rather than a race.
    await expect(
      page.getByRole("button", { name: "Copied src/lib/utils.ts" }),
    ).toBeVisible();

    // NOTE: read back from the OS clipboard through main, not from the
    // renderer's promise. A permission handler that refuses
    // `clipboard-sanitized-write` makes every Copy button a no-op, and a
    // renderer-side assertion cannot tell that from a write that worked.
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
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(page.getByText("package.json")).toBeVisible({
      timeout: 15_000,
    });

    // Addressed by `data-item-path`. `@pierre/trees` splits a name into
    // segments to truncate them separately, so `utils.ts` is not one text
    // node and `getByText` will not find it.
    const tree = page.locator("file-tree-container");
    await expect(tree).toBeVisible();
    await expect(tree.locator('[data-item-path="src/lib/"]')).toBeVisible();
    const row = tree.locator('[data-item-path="src/lib/utils.ts"]');
    await expect(row).toBeVisible();
    // The status GitHub reported, in the tree's own vocabulary.
    await expect(row).toHaveAttribute("data-item-git-status", "modified");

    // The file is far enough down to be virtualized away. That is why the
    // tree drives `CodeView.scrollTo`: `scrollIntoView` on an element that
    // was never rendered does nothing.
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
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });

    // Both branches are on screen, each as its own element, so the long
    // one can truncate on its own.
    await expect(
      page.getByTitle("dependabot/npm_and_yarn/types/node-22.1.0"),
    ).toBeVisible();
    await expect(page.getByTitle("main")).toBeVisible();

    // The arrow between them is an icon, not a typed "→". A text arrow
    // takes the font's baseline, not the icon metrics the row aligns to.
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
    await page.getByRole("tab", { name: "Code" }).click();
    const panel = page.getByRole("complementary", { name: "Files changed" });
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // The tree starts below the title row. Beside the title it would cut
    // short the header that describes the whole pull request.
    const panelBox = await panel.boundingBox();
    const listBox = await page.getByTestId("list").boundingBox();
    const header = await page.getByRole("tab", { name: "Code" }).boundingBox();
    if (panelBox === null || listBox === null || header === null)
      throw new Error("no box");

    // The title row is the window's title bar, above the whole card, so
    // the tree starts at the card's top: level with the list, and below the
    // row the tab control sits in.
    expect(Math.abs(panelBox.y - listBox.y)).toBeLessThanOrEqual(1);
    expect(panelBox.y).toBeGreaterThan(header.y + header.height);
    // It runs the full height of the diff beside it: a column of the
    // detail pane, not a box inside the diff. It stops at the review footer,
    // which spans both, because approving is about the pull request, not the
    // file on screen.
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
    await page.getByRole("tab", { name: "Code" }).click();
    const panel = page.getByRole("complementary", { name: "Files changed" });
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // A tree beside a description navigates nothing. The row with the
    // commit picker goes with it: both describe a diff.
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(panel).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Hide file tree" }),
    ).toHaveCount(0);

    // The choice survives the trip. Hiding the panel to draw the summary
    // must not be recorded as "they closed the file tree".
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(panel).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("one commit can be reviewed on its own, and the whole pull request again", async () => {
  const { page, gh, cleanup } = await open();
  const commitListReads = async () =>
    (await prCalls(gh, "view")).filter(
      (call) => flag(call, "--json") === "commits",
    ).length;
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });

    const picker = page.getByRole("button", {
      name: /Choose what the diff shows/,
    });
    await expect(picker).toContainText("All PR changes");

    // Nothing has asked for the commits yet. They are read when the menu
    // opens, never with the pull request: most people who open one never
    // want this list.
    expect(await commitListReads()).toBe(0);

    await picker.click();
    await page.getByText("Commits", { exact: true }).hover();
    await expect(
      page.getByText("docs: note the bump in the changelog"),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByText("docs: note the bump in the changelog").click();

    // The diff is now that commit's, and only that commit's. The pull
    // request touches four files; this commit touches one.
    await expect(page.getByText("Now with types.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('"@types/node": "^22.1.0",')).toHaveCount(0);
    await expect(picker).toContainText("docs: note the bump in the changelog");
    expect(await commitListReads()).toBeGreaterThan(0);
    // One commit is read through `gh api`: no `gh pr` subcommand has it.
    expect(
      (await gh.calls()).some(
        (call) =>
          call.argv[0] === "api" &&
          call.argv[1] === `repos/${REPO}/commits/${"d".repeat(40)}`,
      ),
    ).toBe(true);

    // The tree follows it. It is a separate panel and reads the selection
    // from the same place the diff does.
    //
    // Rows are addressed by `data-item-path`: the library splits names into
    // segments and keeps a measuring copy of each, so no text assertion on
    // the panel means anything.
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
    await expect(page.getByText("Description")).toBeVisible({
      timeout: 15_000,
    });

    // Summary is the landing tab, spelled by absence: a `view` in a link
    // means somebody went to the code.
    const summary = page.getByRole("tab", { name: "Summary" });
    await expect(summary).toHaveAttribute("aria-selected", "true");
    expect(page.url()).not.toContain("view=");

    const code = page.getByRole("tab", { name: "Code" });
    await code.click();
    await expect(code).toHaveAttribute("aria-selected", "true");
    expect(page.url()).toContain("view=code");
    await expect(page.getByText("package.json").first()).toBeVisible();

    await summary.click();
    await expect(summary).toHaveAttribute("aria-selected", "true");
    expect(page.url()).not.toContain("view=");

    // The summary is about the pull request, so it carries the facts the
    // header stopped carrying: the branches, and the description.
    await expect(page.getByText("Description")).toBeVisible();
    // `exact`: the merge box's "No conflicts with base branch" also says it.
    await expect(page.getByText("Branch", { exact: true })).toBeVisible();

    // The branch row is on the summary, so the diff's second row, the one
    // with the commit picker, is gone here.
    await expect(
      page.getByRole("button", { name: "Show file tree" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Hide file tree" }),
    ).toHaveCount(0);

    // Back returns to the diff rather than leaving the pull request. That
    // is why the tab lives in the URL and not in a `useState`.
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
    // The detail route inherits `tab` and `status` from the list route. A
    // tab switch that wrote a bare `{view}` would drop them, and the list
    // beside the diff would reset to every open pull request.
    await page.goto(`app://lanework/w/${SLUG}/issues/pulls?tab=all&status=all`);
    await page.getByText("chore(deps): bump @types/node").click();
    await page.getByRole("tab", { name: "Code" }).click();
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
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });

    const list = page.getByTestId("list");
    const before = await list.boundingBox();
    if (before === null) throw new Error("no list");

    // Driven by the keyboard, not a synthetic drag. A pointer drag in a
    // headless window is a flaky way to assert a resize, and arrow keys only
    // work on a real `role="separator"`.
    //
    // NOTE: by name. `.first()` is the shell's own handle, between the rail
    // and everything else, and widening it makes this list narrower.
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
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });

    const list = page.getByTestId("list");
    const sidebar = page.getByTestId("sidebar");
    expect((await list.boundingBox())?.width ?? 0).toBeGreaterThan(0);

    // One button, two panel groups: the rail belongs to the shell and the
    // list to this screen, so this also checks `stores/layout.ts` reaches
    // both.
    await page.getByRole("button", { name: "Focus the diff" }).click();
    await expect
      .poll(async () => (await list.boundingBox())?.width ?? 0)
      .toBe(0);
    // The rail folds to its icons, not to nothing (FE-57): the way back
    // stays on screen.
    await expect
      .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
      .toBeLessThan(57);

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
    await page.getByRole("tab", { name: "Code" }).click();
    const filter = page.getByLabel("Filter files");
    await expect(filter).toBeVisible({ timeout: 15_000 });

    // The count is in the placeholder. It costs no row, and it goes away
    // once somebody types, which is when "how many files" stops mattering.
    await expect(filter).toHaveAttribute("placeholder", /\d+ files?…/);
  } finally {
    await cleanup();
  }
});

test("the timeline is read for the summary, and not before", async () => {
  const { page, gh, cleanup } = await open();
  // The one read that carries the timeline: `gh pr view --json author,…`.
  const activityReads = async () =>
    (await prCalls(gh, "view")).filter((call) =>
      flag(call, "--json")?.startsWith("author,createdAt,comments"),
    ).length;
  try {
    // Straight to the code, as a link carrying `view=code` does: reading a
    // diff must not also read the timeline.
    await page.goto(`app://lanework/w/${SLUG}/issues/pulls/7?view=code`);
    await expect(page.getByText("package.json").first()).toBeVisible({
      timeout: 15_000,
    });
    expect(await activityReads()).toBe(0);

    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(page.getByText("opened this pull request")).toBeVisible();
    const after = await activityReads();
    expect(after).toBeGreaterThan(0);

    // A push of two commits is one row, not two.
    await expect(page.getByText("pushed 2 commits")).toBeVisible();

    // Going back is free. The tab unmounts and remounts on every switch, so
    // a read per mount would be a request per click.
    await page.getByRole("tab", { name: "Code" }).click();
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(page.getByText("opened this pull request")).toBeVisible();
    expect(await activityReads()).toBe(after);
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
    // Counts, not "all checks passed". A rollup can read SUCCESS while
    // checks were skipped, and this sentence is read right before approving.
    await expect(page.getByText("1 failing, 1 passing")).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("a repository with no CI is told so in words", async () => {
  // `gh` answers an empty `statusCheckRollup` for a head commit with no CI.
  // That is an ordinary repository: it gets a sentence, not a spinner and
  // not an error, which are what a failed read looks like.
  const { page, cleanup } = await open({
    scenario: (scenario) => {
      pull7(scenario).statusCheckRollup = [];
    },
  });
  try {
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
  const { page, gh, cleanup } = await open();
  try {
    await gotoPulls(page);
    await page.getByText("chore(deps): bump @types/node").click();
    await page.getByRole("tab", { name: "Summary" }).click();
    const box = page.getByLabel("Leave a comment");
    await expect(box).toBeVisible({ timeout: 15_000 });

    // Refusal first, because what it must not do is destroy the draft. A
    // send that empties the field before it succeeds loses a paragraph.
    await gh.update((scenario) => {
      scenario.fail = [
        {
          args: ["pr", "comment"],
          stderr:
            "GraphQL: tester does not have the correct permissions to execute `AddComment` (addComment)",
        },
      ];
    });
    await box.fill("Does this need a changelog entry?");
    await page.getByRole("button", { name: "Post comment" }).click();
    // A sentence a person can read, without the class name Electron puts in
    // front of an error thrown in main.
    const failure = page.getByText(/refused that request/i);
    await expect(failure).toBeVisible();
    await expect(failure).not.toContainText("GitHubError");
    await expect(box).toHaveValue("Does this need a changelog entry?");
    expect(await prCalls(gh, "comment", true)).toHaveLength(0);

    await gh.update((scenario) => {
      scenario.fail = [];
    });
    await page.getByRole("button", { name: "Post comment" }).click();

    // Read back through `gh pr view`, not appended locally, so the row's
    // author and time are the ones GitHub stored.
    await expect(
      page.getByText("Does this need a changelog entry?"),
    ).toBeVisible();
    await expect(box).toHaveValue("");
    // The body goes through stdin, never argv.
    expect(await prCalls(gh, "comment", true)).toMatchObject([
      {
        argv: ["pr", "comment", "7", "--repo", REPO, "--body-file", "-"],
        stdin: "Does this need a changelog entry?",
      },
    ]);
  } finally {
    await cleanup();
  }
});

test("a merged pull request offers no verdict, but still takes a comment", async () => {
  const { page, cleanup } = await open();
  try {
    // `status=all` so the merged one is in the list at all: the state
    // filter is sent to GitHub, not applied here.
    await page.goto(`app://lanework/w/${SLUG}/issues/pulls?tab=all&status=all`);
    await page.getByText("chore(deps): bump @types/node").first().click();
    // `exact`, because "Needs my review" is also a button whose name
    // contains "Review".
    const verdict = page.getByRole("button", { name: "Review", exact: true });
    // The open one still offers it. It lands on the summary, which is where
    // the verdict sits beside the comment box.
    await expect(verdict).toBeVisible({ timeout: 15_000 });

    // The merged one, by its own title: each state is a distinct pull
    // request.
    await page.getByText("feat: ship the thing").click();
    await expect(verdict).toHaveCount(0);

    // Commenting survives. "Why was this done this way" is asked about
    // merged work; only the verdict is meaningless once it has shipped.
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(page.getByLabel("Leave a comment")).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("FE50 merge split buttons share methods, cancel safely and send viewed head", async () => {
  const { page, gh, cleanup } = await open();
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
    expect(await prCalls(gh, "merge")).toEqual([]);
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
    // NOTE: `--match-head-commit` with the head on screen is what makes
    // "merge what I reviewed" true. Without it, a push that landed after the
    // screen loaded would be merged unseen.
    await expect
      .poll(async () => (await prCalls(gh, "merge")).map((call) => call.argv))
      .toEqual([
        [
          "pr",
          "merge",
          "7",
          "--repo",
          REPO,
          "--rebase",
          "--match-head-commit",
          HEAD,
        ],
      ]);
    await expect(
      page.getByRole("button", { name: "Choose merge method" }),
    ).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("FE50 merge disables permission, draft, conflicts, unknown and blocked states", async () => {
  const { page, gh, cleanup } = await open();
  try {
    const states: ((scenario: Scenario) => void)[] = [
      (scenario) => {
        scenario.repos[REPO].viewerPermission = "READ";
      },
      (scenario) => {
        Object.assign(scenario.repos[REPO], {
          mergeCommitAllowed: false,
          squashMergeAllowed: false,
          rebaseMergeAllowed: false,
        });
      },
      (scenario) => {
        pull7(scenario).isDraft = true;
      },
      (scenario) => {
        Object.assign(pull7(scenario), {
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
        });
      },
      (scenario) => {
        Object.assign(pull7(scenario), {
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
        });
      },
      (scenario) => {
        pull7(scenario).mergeStateStatus = "BLOCKED";
      },
    ];
    for (const state of states) {
      await gh.reset(state);
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
    expect(await prCalls(gh, "merge")).toEqual([]);
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
      .toEqual([`https://github.com/${REPO}/pull/7`]);
    expect(app.windows()).toHaveLength(1);
  } finally {
    await cleanup();
  }
});

test("FE50 guarded IPC sends each method and refuses changed head, invalid input and gh rejection", async () => {
  const { page, gh, cleanup } = await open();
  const attempt = async (method: string, sha = HEAD) =>
    page.evaluate(
      async ({ slug, method, sha }) => {
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
          await git.merge(slug, 7, method, sha);
          return "ok";
        } catch (error) {
          return String(error);
        }
      },
      { slug: SLUG, method, sha },
    );
  const review = async (verdict: string, body: string) =>
    page.evaluate(
      async ({ slug, verdict, body }) => {
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
          await git.review(slug, 7, verdict, body);
          return "ok";
        } catch (error) {
          return String(error);
        }
      },
      { slug: SLUG, verdict, body },
    );
  try {
    for (const method of ["merge", "squash", "rebase"]) {
      // A fresh scenario each time: the merge before left #7 merged.
      await gh.reset();
      expect(await attempt(method)).toBe("ok");
      expect((await prCalls(gh, "merge")).at(-1)?.argv).toEqual([
        "pr",
        "merge",
        "7",
        "--repo",
        REPO,
        `--${method}`,
        "--match-head-commit",
        HEAD,
      ]);
    }
    await gh.reset();
    const count = (await prCalls(gh, "merge")).length;
    expect(await attempt("invalid")).not.toBe("ok");
    expect(await attempt("merge", "invalid")).not.toBe("ok");
    await gh.reset((scenario) => {
      pull7(scenario).headRefOid = "c".repeat(40);
    });
    expect(await attempt("merge")).toMatch(/changed|updated|refresh/i);
    await gh.reset((scenario) => {
      scenario.repos[REPO].squashMergeAllowed = false;
    });
    expect(await attempt("squash")).toMatch(/disabled/i);
    // Each refusal above is decided before `gh pr merge` runs.
    expect(await prCalls(gh, "merge")).toHaveLength(count);

    await gh.reset((scenario) => {
      scenario.fail = [
        {
          args: ["pr", "merge"],
          stderr:
            "GraphQL: Branch policy rejected this merge. (mergePullRequest)",
        },
      ];
    });
    expect(await attempt("merge")).toContain(
      "Branch policy rejected this merge.",
    );
    await gh.reset((scenario) => {
      scenario.fail = [
        {
          args: ["pr", "merge"],
          stderr: `X Pull request ${REPO}#7 is not mergeable: the base branch policy prohibits the merge.`,
        },
      ];
    });
    expect(await attempt("merge")).toContain(
      "the base branch policy prohibits the merge",
    );

    await gh.reset((scenario) => {
      pull7(scenario).author = { login: "tester" };
      scenario.fail = [
        {
          args: ["pr", "review"],
          stderr:
            "failed to create review: GraphQL: Review Can not approve your own pull request (addPullRequestReview)",
        },
      ];
    });
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
    // Main has no guard of its own here, so GitHub's refusal is what comes
    // back, as a sentence. An approval carries no body, so no stdin.
    expect(await review("APPROVE", "")).toMatch(/own pull request/i);
    expect((await prCalls(gh, "review")).at(-1)).toMatchObject({
      argv: ["pr", "review", "7", "--repo", REPO, "--approve"],
      stdin: null,
    });

    await gh.reset((scenario) => {
      scenario.fail = [
        {
          args: ["pr", "review"],
          stderr:
            "failed to create review: GraphQL: Review policy rejected this request. (addPullRequestReview)",
        },
      ];
    });
    expect(await review("APPROVE", "")).toContain(
      "Review policy rejected this request.",
    );

    // NOTE: free text goes through stdin, never argv. An argv a review body
    // could reach is an argv it could add flags to.
    await gh.reset();
    expect(await review("COMMENT", "Looks fine to me.")).toBe("ok");
    expect((await prCalls(gh, "review", true)).at(-1)).toMatchObject({
      argv: [
        "pr",
        "review",
        "7",
        "--repo",
        REPO,
        "--comment",
        "--body-file",
        "-",
      ],
      stdin: "Looks fine to me.",
    });
  } finally {
    await cleanup();
  }
});
