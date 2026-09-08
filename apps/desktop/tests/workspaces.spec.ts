import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { MachineRecord } from "../electron/main/auth/store";
import {
  parseBoardConfig,
  parseCard,
  parseWorkspaces,
} from "../electron/main/workspaces/client";
import { readLocalFolder } from "../electron/main/workspaces/local-folder";
import { slugify } from "../electron/main/workspaces/slug";
import {
  readActive,
  writeActive,
  writeFolder,
} from "../electron/main/workspaces/store";
import type { DesktopApi } from "../shared/desktop";
import type { Workspace } from "../shared/workspaces";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

const workspaces: Workspace[] = [
  {
    id: "ws-lanework",
    slug: "lanework",
    name: "Lanework",
    path: "/projects/lanework",
    baseBranch: "main",
  },
  {
    id: "ws-cloud-project",
    slug: "cloud-project",
    name: "Cloud project",
    path: null,
    baseBranch: null,
  },
];

test("workspace responses reject malformed lists and only return display fields", () => {
  expect(parseWorkspaces({ workspaces: [] })).toEqual([]);
  expect(
    parseWorkspaces({
      profile: { name: "Private" },
      workspaces: [{ ...workspaces[0], secret: "ignored" }],
    }),
  ).toEqual([workspaces[0]]);
  for (const value of [
    null,
    {},
    { workspaces: null },
    { workspaces: [null] },
    { workspaces: [{ ...workspaces[0], path: 42 }] },
    { workspaces: [{ ...workspaces[0], slug: "" }] },
    { workspaces: [workspaces[0], workspaces[0]] },
  ])
    expect(() => parseWorkspaces(value)).toThrow(/invalid workspace/);
});

test("a control plane with no workspace ids is usable, and says which half is missing", () => {
  // ⚠️ The regression this pins down shipped and was caught in the app: the
  // parser required `id`, the deployed service did not send it yet, and every
  // real workspace came back as "invalid workspace" — a strict reader turning a
  // deploy-order problem into a broken screen. A missing id means "no board
  // yet", never "no workspace".
  const older = parseWorkspaces({
    workspaces: [
      { slug: "lanework", name: "Lanework", path: null, baseBranch: null },
    ],
  });
  expect(older).toEqual([
    {
      id: null,
      slug: "lanework",
      name: "Lanework",
      path: null,
      baseBranch: null,
    },
  ]);
  // Everything else is still refused — tolerance is for the ONE field a service
  // may predate, not for a malformed row.
  for (const value of [
    { workspaces: [{ slug: "", name: "x", path: null, baseBranch: null }] },
    { workspaces: [{ slug: "x", name: "", path: null, baseBranch: null }] },
  ])
    expect(() => parseWorkspaces(value)).toThrow(/invalid workspace/);
});

test("active workspace persists separately for each account, machine and API origin", async () => {
  const home = await mkdtemp(join(tmpdir(), "lanew-workspace-store-"));
  const previous = process.env.LANEWORK_HOME;
  process.env.LANEWORK_HOME = home;
  const record: MachineRecord = {
    machineId: "machine-a",
    userId: "account-a",
    apiUrl: "https://example.test",
    name: "Test",
    secret: "never-persist-this",
    owner: null,
  };
  try {
    expect(await readActive(record)).toBeNull();
    await writeActive(record, { id: "ws-lanework", slug: "lanework" });
    // ⚠️ By cloud workspace ID, not slug: a slug is a display key a rename can
    // move, and every board call is `/v1/boards/:workspaceId/…`.
    expect(await readActive(record)).toEqual({
      by: "id",
      value: "ws-lanework",
    });
    for (const other of [
      { ...record, userId: "account-b" },
      { ...record, machineId: "machine-b" },
      { ...record, apiUrl: "https://other.test" },
    ]) {
      expect(await readActive(other)).toBeNull();
      await writeActive(other, {
        id: "ws-cloud-project",
        slug: "cloud-project",
      });
      expect(await readActive(record)).toEqual({
        by: "id",
        value: "ws-lanework",
      });
    }
    for (const file of await readdir(join(home, "workspaces")))
      expect(
        await readFile(join(home, "workspaces", file), "utf8"),
      ).not.toContain(record.secret);
    await writeActive(record, { id: null, slug: null });
    expect(await readActive(record)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.LANEWORK_HOME;
    else process.env.LANEWORK_HOME = previous;
    await removeProfile(home);
  }
});

test("home loads the picker, saves a selection across relaunch and clears a removed workspace", async () => {
  const plane = await startStubPlane({ workspaces });
  // Keep the loading state observable without slowing every request.
  plane.setWorkspaceResponse(200, undefined, 400);
  const profile = await mkdtemp(join(tmpdir(), "lanew-workspaces-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  let app = await electron.launch({ args: [process.cwd()], env });
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByRole("status")).toHaveText(
      "Loading your workspaces…",
    );
    await expect(page.getByRole("list", { name: "Workspaces" })).toBeVisible();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeHidden();
    // ⚠️ Was "No local folder linked on this machine". A workspace with no
    // folder is a COMPLETE workspace — its cards are in the cloud — so the row
    // names it by slug instead of reporting a missing folder (FE-06 D1).
    await expect(
      page.getByText("cloud-project", { exact: true }),
    ).toBeVisible();
    expect(plane.calls).toContain("GET /v1/sync/state");
    expect(plane.workspaceAuth).toEqual(["Bearer lw_mch_test-secret"]);
    await page.screenshot({
      path: "../../.agents/artifacts/2026-09-08-workspace-picker.png",
      // Native macOS vibrancy is outside the renderer capture. Flatten only
      // the screenshot so the light theme is reviewable against its backdrop.
      style: "html { background: var(--background) !important; }",
    });

    await page.getByRole("button", { name: "Open Cloud project" }).click();
    await expect(
      page.getByRole("button", { name: "Open Lanework" }),
    ).toBeDisabled();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Cloud project", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("list", { name: "Workspaces" })).toBeHidden();
    expect(errors).toEqual([]);
    await page.screenshot({
      path: "../../.agents/artifacts/2026-09-08-workspace-active.png",
      style: "html { background: var(--background) !important; }",
    });
    await app.close();

    plane.setWorkspaces(workspaces);
    app = await electron.launch({ args: [process.cwd()], env });
    page = await app.firstWindow();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Cloud project", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Change workspace" }).click();
    await page.getByRole("button", { name: "Open Lanework" }).click();
    await expect(
      page.getByRole("heading", { name: "Lanework", exact: true }),
    ).toBeVisible();
    // ⚠️ Was `Branch: main`. The active view is the BOARD now, and a base branch
    // is a fact about a checkout — it belongs where code runs, not in the header
    // of a card list (FE-06 D1/D4). What must be there instead is the board's
    // own state, even when this stub serves no board for the workspace.
    await expect(
      page
        .getByRole("button", { name: "Try again" })
        .or(page.getByRole("status")),
    ).toBeVisible();

    // A removed selection does not silently fall back to the first project.
    plane.setWorkspaces([workspaces[1]]);
    await page.reload();
    await expect(page.getByRole("list", { name: "Workspaces" })).toBeVisible();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeHidden();
    // Restoring that project does not resurrect a stale active pointer.
    plane.setWorkspaces(workspaces);
    await page.reload();
    await expect(page.getByRole("list", { name: "Workspaces" })).toBeVisible();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeHidden();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("home distinguishes service errors from empty and selection failures never replace active", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setWorkspaceResponse(503);
  const profile = await mkdtemp(join(tmpdir(), "lanew-workspace-errors-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("alert")).toContainText("HTTP 503");
    await expect(
      page.getByText("No workspaces yet", { exact: true }),
    ).toBeHidden();
    plane.setWorkspaces([]);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByText("No workspaces yet", { exact: true }),
    ).toBeVisible();
    plane.setWorkspaceResponse(200, { workspaces: "invalid" });
    await page.getByRole("button", { name: "Refresh list" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "invalid workspace list",
    );
    await expect(
      page.getByText("No workspaces yet", { exact: true }),
    ).toBeHidden();
    plane.setWorkspaces(workspaces);
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByRole("button", { name: "Open Lanework" }).click();
    await page.getByRole("button", { name: "Change workspace" }).click();
    await expect(
      page.getByRole("button", { name: "Open Cloud project" }),
    ).toBeVisible();
    plane.setWorkspaces([workspaces[0]]);
    await page.getByRole("button", { name: "Open Cloud project" }).click();
    await expect(page.getByRole("alert")).toContainText("no longer available");
    await page.reload();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Lanework", exact: true }),
    ).toBeVisible();
    // An offline launch reports an error and preserves the saved selection.
    plane.setWorkspaceResponse(503);
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("HTTP 503");
    plane.setWorkspaces(workspaces);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("workspace IPC rejects invalid selections and signed-out callers", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lanew-workspace-ipc-"));
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home: join(profile, "home") }),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeVisible();
    const failures = await page.evaluate(async () => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
        .workspaces;
      const result: string[] = [];
      for (const call of [
        () => api.load(),
        () => api.select("ws-lanework"),
        () => api.select(""),
        () => api.select(42 as unknown as string),
      ]) {
        try {
          await call();
          result.push("unexpected success");
        } catch (error) {
          result.push((error as Error).message);
        }
      }
      return result;
    });
    expect(failures[0]).toContain("Sign in");
    expect(failures[1]).toContain("Sign in");
    expect(failures[2]).toContain("valid workspace");
    expect(failures[3]).toContain("valid workspace");
  } finally {
    await app.close();
    await removeProfile(profile);
  }
});

test("a v1 selection file (a slug) is honoured once and rewritten as an id", async () => {
  // ⚠️ Upgrade behaviour, and the reason `readActive` has two shapes. Dropping
  // the old file would silently move every existing user back to "no workspace
  // selected"; resolving it once and rewriting keeps their choice without
  // leaving a slug in a field the board is addressed by.
  const home = await mkdtemp(join(tmpdir(), "lanew-workspace-v1-"));
  const previous = process.env.LANEWORK_HOME;
  process.env.LANEWORK_HOME = home;
  const record: MachineRecord = {
    machineId: "machine-a",
    userId: "account-a",
    apiUrl: "https://example.test",
    name: "Test",
    secret: "never-persist-this",
    owner: null,
  };
  try {
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256")
      .update(JSON.stringify([record.apiUrl, record.userId, record.machineId]))
      .digest("hex");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(home, "workspaces"), { recursive: true });
    await writeFile(
      join(home, "workspaces", `${key}.json`),
      JSON.stringify({ v: 1, active: "lanework" }),
      "utf8",
    );

    expect(await readActive(record)).toEqual({ by: "slug", value: "lanework" });
    // Once resolved, the caller writes the id and the slug never comes back.
    await writeActive(record, { id: "ws-lanework", slug: "lanework" });
    expect(await readActive(record)).toEqual({
      by: "id",
      value: "ws-lanework",
    });
  } finally {
    if (previous === undefined) delete process.env.LANEWORK_HOME;
    else process.env.LANEWORK_HOME = previous;
    await removeProfile(home);
  }
});

test("a card is dropped rather than guessed when its identity is missing", () => {
  // ⚠️ `id`, `revision` and `columnKey` are what an edit is addressed by: a
  // guessed revision sends `If-Match: NaN` and a guessed lane renders the card
  // in the wrong column. Absent beats plausible.
  const card = {
    id: "item-1",
    revision: 3,
    columnKey: "todo",
    title: "A card",
    body: "",
    taskId: "BE-01",
    categoryKey: "backend",
    priority: "high",
    tags: ["cloud"],
    rank: "V",
    createdAt: null,
    updatedAt: null,
    checklist: [
      {
        key: "D1",
        section: "decisions",
        text: "One",
        checked: true,
        checkedAt: "2026-09-01T00:00:00.000Z",
        note: null,
      },
    ],
  };
  expect(parseCard(card)).toMatchObject({
    id: "item-1",
    revision: 3,
    priority: "high",
    checklist: [{ key: "D1", checked: true }],
  });
  for (const broken of [
    null,
    {},
    { ...card, id: "" },
    { ...card, revision: "3" },
    { ...card, revision: 1.5 },
    { ...card, columnKey: "" },
  ])
    expect(parseCard(broken)).toBeNull();

  // An unknown priority is null rather than passed through — the board renders
  // it as a pill and there is no pill for "urgent".
  expect(parseCard({ ...card, priority: "urgent" })?.priority).toBeNull();
});

test("a board with no columns is an error, not an empty screen", () => {
  // The same call the API's own validator makes: a board with no lanes cannot
  // be drawn at all, so answering with zero columns would render a blank page
  // that looks like an empty project.
  expect(() =>
    parseBoardConfig({ board: { workspaceId: "ws-1", columns: [] } }),
  ).toThrow(/no columns/);
  expect(() => parseBoardConfig({})).toThrow(/invalid board/);

  const parsed = parseBoardConfig({
    board: {
      workspaceId: "ws-1",
      migratedAt: "2026-09-08T05:00:00.000Z",
      columns: [
        { key: "done", name: "Done", role: "done", position: 3 },
        { key: "todo", name: "To-Do", role: "start", position: 1 },
      ],
      categories: [{ key: "backend", name: "Backend", prefix: "BE" }],
    },
  });
  // Sorted by the board's own display order, not by the order they arrived.
  expect(parsed.columns.map((column) => column.key)).toEqual(["todo", "done"]);
  expect(parsed.migratedAt).toBe("2026-09-08T05:00:00.000Z");
  expect(parsed.categories[0]?.prefix).toBe("BE");
});

test("opening a workspace shows its cloud board, and a tick carries the revision", async () => {
  // ⚠️ The point of FE-06 D1: the workspace being opened here has NO local
  // folder, and its board renders anyway. Every earlier version of this screen
  // showed a path and called a folderless workspace unlinked.
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", {
    migratedAt: "2026-09-08T05:00:00.000Z",
    columns: [
      { key: "todo", name: "To-Do", role: "start" },
      { key: "processing", name: "In Progress", role: "active" },
    ],
    cards: [
      {
        id: "card-1",
        revision: 4,
        title: "Cache the composer input",
        body: "",
        columnKey: "todo",
        categoryKey: "frontend",
        taskId: "FE-01",
        priority: "high",
        tags: ["ui"],
        rank: "V",
        createdAt: null,
        updatedAt: null,
        checklist: [
          {
            key: "D1",
            section: "decisions",
            text: "Keep the draft in the store",
            checked: false,
            checkedAt: null,
            note: null,
          },
        ],
      },
    ],
  });
  const profile = await mkdtemp(join(tmpdir(), "lanew-board-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  const app = await electron.launch({ args: [process.cwd()], env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.getByRole("button", { name: "Open Cloud project" }).click();
    await expect(
      page
        .getByRole("region", { name: "To-Do column" })
        .or(page.getByLabel("To-Do column")),
    ).toBeVisible();
    await expect(
      page.getByText("FE-01 · Cache the composer input"),
    ).toBeVisible();
    await expect(page.getByText("Live ·")).toBeVisible();

    // ⚠️ `click`, not `check`: the box is a CONTROLLED input, so it does not
    // flip until the server has confirmed — which is FE-06 D2's "only confirm
    // the save when the server succeeded", and exactly what `check()` refuses to
    // wait for. A tick sends the revision the screen is showing, as `If-Match`.
    await page.getByRole("checkbox").first().click();
    await expect
      .poll(() => plane.boardPreconditions)
      .toEqual(expect.arrayContaining(["4"]));

    // A lost race shows both sides instead of "try again".
    plane.setChecklistConflict(true);
    await page.getByRole("checkbox").first().click();
    await expect(
      page.getByText("Someone else changed this card"),
    ).toBeVisible();
    plane.setChecklistConflict(false);

    // A move is one request and the card lands in the other lane.
    await page
      .getByRole("button", { name: /^Move .* to In Progress$/ })
      .first()
      .click();
    await expect(
      page.getByLabel("In Progress column").getByText(/Cache the composer/),
    ).toBeVisible();

    // ⚠️ And when the board cannot be reached, the app shows its saved copy WITH
    // a label rather than an empty board — the failure that invites somebody to
    // re-create a card that already exists.
    plane.setBoardOffline(true);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(
      page.getByText("You are looking at a saved copy"),
    ).toBeVisible();
    await expect(page.getByText(/Cache the composer/)).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await removeProfile(profile);
    await plane.close();
  }
});

test("a selection is honoured whether the service sends ids or not", async () => {
  // ⚠️ The regression this pins down was visible on the first click: the
  // renderer sends `id ?? slug`, and against a service that predates the id
  // field every id is null — so matching on the id alone made every Open button
  // answer "this workspace is no longer available", about a row it had just
  // listed.
  const plane = await startStubPlane({
    workspaces: workspaces.map(({ slug, name, path, baseBranch }) => ({
      // The older shape, exactly: no `id` anywhere.
      slug,
      name,
      path,
      baseBranch,
    })) as unknown as Workspace[],
  });
  const profile = await mkdtemp(join(tmpdir(), "lanew-older-plane-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  let app = await electron.launch({ args: [process.cwd()], env });
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Open Cloud project" }).click();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeVisible();
    // The board says which half is missing rather than failing the screen.
    await expect(
      page.getByText("This board is not available yet"),
    ).toBeVisible();

    // And the choice survives a relaunch, which is what remembering a slug buys.
    await app.close();
    app = await electron.launch({ args: [process.cwd()], env });
    page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Cloud project", exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

/** A review card as the board writes one: front matter, a heading, a checklist. */
function cardFile(fields: Record<string, string>, title: string): string {
  const front = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return [
    "---",
    "schema: 1",
    front,
    "---",
    "",
    `# Review: ${title}`,
    "",
    "## Decisions",
    "",
    "- [x] D1. A ticked box, which this app must not count",
    "- [ ] D2. An unticked one",
    "",
    "> note under it",
    "",
  ].join("\n");
}

async function seedRepo(root: string): Promise<void> {
  const day = join(root, ".agents", "reviews", "2026-09-08");
  await mkdir(day, { recursive: true });
  await writeFile(
    join(day, "01-cloud-board.md"),
    cardFile(
      {
        status: "done",
        task_id: "FE-06",
        category: "frontend",
        created_at: "2026-09-08 00:00:00Z",
        priority: "high",
      },
      "[desktop] Cloud workspace board",
    ),
  );
  await writeFile(
    join(day, "02-import.md"),
    cardFile(
      {
        status: "done",
        task_id: "BE-03",
        category: "backend",
        created_at: "2026-09-07 00:00:00Z",
      },
      "Import issues and old task cards",
    ),
  );
  await writeFile(
    join(day, "03-mcp.md"),
    cardFile(
      {
        status: "done",
        task_id: "BE-04",
        category: "backend",
        created_at: "2026-09-06 00:00:00Z",
      },
      "Board and MCP on cloud cards",
    ),
  );
  await writeFile(
    join(day, "04-next.md"),
    cardFile(
      {
        status: "todo",
        category: "backend",
        created_at: "2026-09-05 00:00:00Z",
      },
      "Something not started",
    ),
  );
  // ⚠️ Two files that are NOT cards — and they sit at the review ROOT, not in
  // the date folder, because the board's rule is that anything in a date folder
  // IS a card (in the fallback lane). A README one level up is loose markdown;
  // the same README inside `2026-09-08/` would be a card, and this app has to
  // agree with the board about which.
  const reviews = join(day, "..");
  await writeFile(
    join(reviews, "README.md"),
    "# Just notes\n\nnothing here.\n",
  );
  await writeFile(
    join(reviews, "draft.md"),
    "---\ntitle: a yaml file that is not a card\n---\n\n# Draft\n",
  );
}

test("a folder is read from its front matter, and never from a card's body", async () => {
  // ⚠️ The line this test defends: this app reads `status`, `category`,
  // `task_id` and `created_at` — a fixed set of `key: value` lines — and stops.
  // What a checklist item IS lives in the board's own parsers in another repo;
  // a second reader of a card's body here would disagree with the board the
  // first time somebody hand-edited a card, and both sides would look right.
  const root = await mkdtemp(join(tmpdir(), "lanew-folder-"));
  try {
    await seedRepo(root);
    const summary = await readLocalFolder(root);

    expect(summary.cards).toBe(4);
    expect(summary.reviewRoot).toBe(".agents/reviews");
    expect(summary.byStatus).toEqual({ done: 3, todo: 1 });
    expect(summary.byCategory).toEqual({ backend: 3, frontend: 1 });
    expect(summary.newest).toBe("2026-09-08");
    expect(summary.looksUnrelated).toBe(false);
    // A README and a non-card front matter are neither cards nor errors.
    expect(summary.unreadable).toBe(0);
    expect(summary.capped).toBe(false);

    // Newest first, titles stripped of the `Review:` prefix, paths as written.
    expect(summary.sample[0]).toEqual({
      ref: join(".agents", "reviews", "2026-09-08", "01-cloud-board.md"),
      taskId: "FE-06",
      title: "[desktop] Cloud workspace board",
      status: "done",
      category: "frontend",
      createdAt: "2026-09-08",
    });
    // ⚠️ Nothing on a card carries checklist state. If this ever grows a
    // `checked` count, the reader has started parsing bodies.
    expect(JSON.stringify(summary.sample)).not.toContain("D1");
  } finally {
    await removeProfile(root);
  }
});

test("a folder that is not a project says so, rather than failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "lanew-not-a-project-"));
  try {
    const plain = await readLocalFolder(root);
    expect(plain).toMatchObject({
      cards: 0,
      reviewRoot: null,
      looksUnrelated: true,
    });

    // An `.agents` with no `reviews` is a project, just not one with cards —
    // and the two need different sentences on screen.
    await mkdir(join(root, ".agents", "artifacts"), { recursive: true });
    expect(await readLocalFolder(root)).toMatchObject({
      cards: 0,
      reviewRoot: null,
      looksUnrelated: false,
    });

    // A folder that was linked and has since gone is the caller's case, not
    // this reader's: it answers about what is there.
    expect(await readLocalFolder(join(root, "gone"))).toMatchObject({
      cards: 0,
      looksUnrelated: true,
    });
  } finally {
    await removeProfile(root);
  }
});

test("a workspace with no cloud board can still be read from its folder", async () => {
  // The screenshot this exists for: a service that predates the workspace id
  // sends none, so the board cannot be addressed — while the cards are sitting
  // in a folder on this machine the whole time. The board still says which half
  // is missing; the folder panel says what the project holds.
  const plane = await startStubPlane({
    workspaces: workspaces.map(({ slug, name, path, baseBranch }) => ({
      slug,
      name,
      path,
      baseBranch,
    })) as unknown as Workspace[],
  });
  const profile = await mkdtemp(join(tmpdir(), "lanew-folder-panel-"));
  const home = join(profile, "home");
  const repo = join(profile, "repo");
  await seedRepo(repo);
  await seedCredential(home, plane.origin);

  // Link the folder the way `pick` would, so the test never opens a native
  // chooser. `LANEWORK_HOME` has to be set for the write to land where the app
  // will read it.
  const previous = process.env.LANEWORK_HOME;
  process.env.LANEWORK_HOME = home;
  await writeFolder(
    {
      machineId: "test-machine",
      userId: "test-user",
      apiUrl: plane.origin,
      name: "test-machine",
      secret: "lw_mch_test-secret",
      owner: null,
    } satisfies MachineRecord,
    "cloud-project",
    repo,
  );
  if (previous === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previous;

  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  const app = await electron.launch({ args: [process.cwd()], env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.getByRole("button", { name: "Open Cloud project" }).click();
    await expect(
      page.getByText("This board is not available yet"),
    ).toBeVisible();

    // What the folder holds, from front matter only.
    await expect(page.getByText("4 review cards")).toBeVisible();
    await expect(page.getByText("3 done · 1 todo")).toBeVisible();
    await expect(page.getByText(/newest 2026-09-08/)).toBeVisible();
    // ⚠️ And the sentence that stops somebody waiting for this to become a
    // board: it names where the migration actually happens.
    await expect(page.getByText(/These cards are still files/)).toBeVisible();

    // Unlinking leaves the offer, not an error.
    await page.getByRole("button", { name: "Unlink" }).click();
    await expect(
      page.getByRole("button", { name: "Sync from local folder" }),
    ).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a project name becomes a slug the service will accept", () => {
  const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  // ⚠️ Vietnamese first, because it is this app's own users' language and the
  // naive version of this function produced `d-n-c-a-t-i` for the first name
  // anybody would type. `đ` needs naming separately: NFD does not decompose it.
  expect(slugify("Dự án của tôi")).toBe("du-an-cua-toi");
  expect(slugify("Đà Nẵng App")).toBe("da-nang-app");
  expect(slugify("fuongz/lanework")).toBe("fuongz-lanework");
  expect(slugify("  Hello   World  ")).toBe("hello-world");
  expect(slugify("--weird--")).toBe("weird");
  // A cap that lands on a separator must not leave a trailing hyphen: the
  // service's own regex refuses one.
  expect(slugify(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
  for (const name of [
    "Dự án của tôi",
    "日本語",
    "🙂",
    "...",
    `${"a".repeat(63)} b`,
    "A",
  ])
    expect(slugify(name)).toMatch(SLUG);
  // A name with nothing latin in it still yields a usable key, and says by its
  // shape that it was not derived from the name.
  expect(slugify("日本語")).toMatch(/^project-[a-z0-9]{6}$/);
});

test("a project can be created from the app, and opens straight away", async () => {
  const plane = await startStubPlane({ workspaces });
  const profile = await mkdtemp(join(tmpdir(), "lanew-create-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  let app = await electron.launch({ args: [process.cwd()], env });
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.getByLabel("New project name").fill("Dự án của tôi");
    await page.getByRole("button", { name: "Create project" }).click();

    // ⚠️ Created AND opened: the new project is the active one, without a
    // second click. The heading is the name the user typed, not the slug.
    await expect(
      page.getByRole("heading", { name: "Dự án của tôi", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Active workspace", { exact: true }),
    ).toBeVisible();
    // The slug this app minted is what the service was asked for.
    expect(plane.calls).toContain("POST /v1/sync/state/workspace");

    // And it is remembered, which is what makes "created" different from
    // "showing on screen".
    await app.close();
    app = await electron.launch({ args: [process.cwd()], env });
    page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Dự án của tôi", exact: true }),
    ).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a taken key and an old service are told apart, and the name is kept", async () => {
  const plane = await startStubPlane({ workspaces });
  const profile = await mkdtemp(join(tmpdir(), "lanew-create-fail-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  const app = await electron.launch({ args: [process.cwd()], env });
  try {
    const page = await app.firstWindow();

    // A name that slugifies onto a project the account already has.
    await page.getByLabel("New project name").fill("Cloud Project");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByText(/already uses the key/)).toBeVisible();
    // ⚠️ The typed name survives the refusal: "that key is taken" is an
    // invitation to edit what you typed, and a field that clears itself makes
    // the user retype it to find out what was wrong.
    await expect(page.getByLabel("New project name")).toHaveValue(
      "Cloud Project",
    );

    // ⚠️ And a service that predates the route is reported as out of date, not
    // as a bad name — the deploy-order mistake this app has already made twice.
    plane.setCreateMissing(true);
    await page.getByLabel("New project name").fill("Something New");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByText(/cannot create projects yet/)).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

/** A plane, a profile and a linked folder — the state a migration starts from. */
async function migrationFixture(name: string) {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", {
    migratedAt: null,
    columns: [{ key: "todo", name: "To-Do", role: "start" }],
    cards: [],
  });
  const profile = await mkdtemp(join(tmpdir(), name));
  const home = join(profile, "home");
  const repo = join(profile, "repo");
  await seedRepo(repo);
  await seedCredential(home, plane.origin);

  const previous = process.env.LANEWORK_HOME;
  process.env.LANEWORK_HOME = home;
  await writeFolder(
    {
      machineId: "test-machine",
      userId: "test-user",
      apiUrl: plane.origin,
      name: "test-machine",
      secret: "lw_mch_test-secret",
      owner: null,
    } satisfies MachineRecord,
    "cloud-project",
    repo,
  );
  if (previous === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previous;

  return { plane, profile, home, repo };
}

test("a linked folder is migrated to the cloud from here, then handed over", async () => {
  const { plane, profile, home } = await migrationFixture("lanew-migrate-");
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.getByRole("button", { name: "Open Cloud project" }).click();
    // The board is empty and not migrated, so the folder panel is the answer.
    await expect(page.getByText("This project on this machine")).toBeVisible();
    // ⚠️ The lossy number is on screen BEFORE the button: markdown says `- [x]`
    // and never when, so every ticked box arrives with a derived date.
    await expect(page.getByText(/ticked box.*approximate date/)).toBeVisible();
    await expect(page.getByText(/4 cards and 8 checklist items/)).toBeVisible();

    await page.getByRole("button", { name: "Sync to cloud" }).click();
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/Sent — 4 imported/)).toBeVisible();

    // The lanes went first, with the tag cap, and every card arrived with its
    // checklist and the repo-relative ref the CLI would have sent.
    expect(plane.pushedConfig).toEqual({
      columns: 5,
      categories: 5,
      tagMax: 3,
    });
    expect(plane.imported).toHaveLength(4);
    for (const record of plane.imported) {
      expect(record.ref).toMatch(/^\.agents\/reviews\/2026-09-08\/.+\.md$/);
      expect(record.checklist).toBe(2);
    }
    // ⚠️ Grouped by lane, oldest first — that order IS the rank, because the
    // API appends each card to the bottom of its lane.
    expect(plane.imported.map((record) => record.columnKey)).toEqual([
      "done",
      "done",
      "done",
      "todo",
    ]);

    // ⚠️ A SECOND click hands the board over, with the receipts on screen.
    await page.getByRole("button", { name: "Complete cutover" }).click();
    await page.getByRole("button", { name: "Complete cutover" }).last().click();
    // The count the seal claims is everything the run accounted for.
    await expect.poll(() => plane.sealed.length).toBe(1);
    expect(plane.sealed[0].items).toBe(4);
    expect(plane.sealed[0].manifest).toMatch(/^[0-9a-f]{64}$/);

    // And the board re-reads itself: it is migrated now, so the folder panel
    // is gone rather than still offering to send the same files.
    await expect(page.getByText("Cards not migrated yet")).not.toBeVisible();
    await expect(
      page.getByText("This project on this machine"),
    ).not.toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a stopped run keeps what landed, and a refused seal names both numbers", async () => {
  const { plane, profile, home } = await migrationFixture(
    "lanew-migrate-fail-",
  );
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open Cloud project" }).click();
    await expect(page.getByText("This project on this machine")).toBeVisible();

    // ⚠️ A batch that fails stops the run and SAYS so. Nothing is lost by
    // stopping: records already accepted are keyed on their source ref, so the
    // next run skips them rather than duplicating them.
    plane.setImportBroken(true);
    await page.getByRole("button", { name: "Sync to cloud" }).click();
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/refused|stopped/)).toBeVisible();
    expect(plane.imported).toHaveLength(0);

    plane.setImportBroken(false);
    await page.getByRole("button", { name: "Send again" }).click();
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/Sent — 4 imported/)).toBeVisible();

    // ⚠️ The service counts its own table before it agrees. A mismatch has to
    // reach the screen with BOTH numbers — "it was refused" alone tells the
    // reader nothing they can act on.
    plane.setSealMismatch(3);
    await page.getByRole("button", { name: "Complete cutover" }).click();
    await page.getByRole("button", { name: "Complete cutover" }).last().click();
    await expect(
      page.getByText(/the run accounted for 4, the board holds 3/),
    ).toBeVisible();
    // Still not migrated, so the panel is still offering the cutover.
    await expect(page.getByText("This project on this machine")).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});
