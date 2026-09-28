import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
  parseBoardConfig,
  parseCard,
  parseWorkspaces,
} from "../electron/main/workspaces/client";
import { readLocalFolder } from "../electron/main/workspaces/local-folder";
import { slugify } from "../electron/main/workspaces/slug";
import {
  readActive,
  writeActive,
  writeFolders,
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

/** Open a project the way a person does: through the rail's switcher. */
async function switchTo(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /^Switch project/ }).click();
  // Not `exact`: "Lanework" would otherwise have to match the whole row.
  await page.getByRole("option", { name }).first().click();
  await expect(
    page.getByRole("button", { name: `Switch project — currently ${name}` }),
  ).toBeVisible();
  // ⚠️ The rail's label changes BEFORE main has written the selection down —
  // the store sets the active project, then awaits `select`. Waiting only for
  // the label and then relaunching races that write, and the app reopens the
  // PREVIOUS project. The board's own state is the first thing that can only
  // appear after `select` resolved.
  await expect(
    page
      .getByRole("button", { name: /^Refresh board — (Live|Saved copy)/ })
      .or(page.getByText("Board not available yet"))
      .or(page.getByText("Could not load this board", { exact: true }))
      .first(),
  ).toBeVisible();
}

/**
 * Open one project's import panel from Settings → Projects.
 *
 * ⚠️ Not the rail any more: linking a folder and sending it to the cloud is a
 * per-project act, so it lives next to the project it acts on (see
 * `ImportLocalDialog`). Every test that used to click "Local folder" in the
 * rail comes through here.
 */
async function openImport(page: Page, project: string): Promise<void> {
  await page.goto("app://lanework/settings/workspaces");
  await page
    .getByRole("button", { name: `Import from local into ${project}` })
    .click();
}

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

test("the rail remembers a project across relaunch, and never falls back silently", async () => {
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

    // ⚠️ With nothing remembered the app ASKS. Opening whichever project happens
    // to be first would put somebody on a board they did not choose, and the
    // only clue would be a name in the corner.
    await expect(
      page.getByRole("heading", { name: "Choose a project" }),
    ).toBeVisible();
    await expect(page.getByRole("list", { name: "Projects" })).toBeVisible();
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

    await page.getByRole("link", { name: /Cloud project/ }).click();
    await expect(
      page.getByRole("button", {
        name: "Switch project — currently Cloud project",
      }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({
      path: "../../.agents/artifacts/2026-09-08-workspace-active.png",
      style: "html { background: var(--background) !important; }",
    });
    await app.close();

    // The choice survives a relaunch — that is what remembering it buys.
    plane.setWorkspaces(workspaces);
    app = await electron.launch({ args: [process.cwd()], env });
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", {
        name: "Switch project — currently Cloud project",
      }),
    ).toBeVisible();

    await switchTo(page, "Lanework");

    // ⚠️ A selection whose project has been removed becomes a QUESTION, not a
    // different project. Main clears the pointer; the app asks again.
    plane.setWorkspaces([workspaces[1]]);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Choose a project" }),
    ).toBeVisible();
    // Restoring it does not resurrect a stale pointer either.
    plane.setWorkspaces(workspaces);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Choose a project" }),
    ).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a service error is told apart from an empty account, and a bad selection keeps the old one", async () => {
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
    // ⚠️ "I could not ask" must never render as "you have none". Somebody who
    // believes the second creates a project they already have.
    // ⚠️ The failure is the whole screen now, not a banner on one — so it is
    // addressed by what it SAYS rather than by `role="alert"`, which belongs to
    // a message interrupting something that still works.
    await expect(page.getByText("Could not load your projects")).toBeVisible();
    await expect(page.getByText(/HTTP 503/)).toBeVisible();
    await expect(
      page.getByText("No projects yet", { exact: true }),
    ).toBeHidden();

    plane.setWorkspaces([]);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByText("No projects yet", { exact: true }),
    ).toBeVisible();

    plane.setWorkspaceResponse(200, { workspaces: "invalid" });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText(/invalid workspace list/)).toBeVisible();
    await expect(
      page.getByText("No projects yet", { exact: true }),
    ).toBeHidden();

    plane.setWorkspaces(workspaces);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("list", { name: "Projects" })).toBeVisible();
    await page.getByRole("link", { name: /Lanework/ }).click();
    await expect(
      page.getByRole("button", { name: "Switch project — currently Lanework" }),
    ).toBeVisible();

    // An offline relaunch reports the failure and keeps the saved selection.
    plane.setWorkspaceResponse(503);
    await page.reload();
    // ⚠️ The failure is the whole screen now, not a banner on one — so it is
    // addressed by what it SAYS rather than by `role="alert"`, which belongs to
    // a message interrupting something that still works.
    //
    // ⚠️ The PROJECT's failure, and the project's URL, rather than the picker's.
    // A reload with a project open used to be answered by sending somebody to
    // the list of projects — which is built from the list that just failed, so
    // it could not draw either, and it navigated back the moment it could.
    await expect(page.getByText("Could not open this project")).toBeVisible();
    await expect(page.getByText(/HTTP 503/)).toBeVisible();
    expect(page.url()).toContain("/w/lanework/issues");
    plane.setWorkspaceResponse(200);
    plane.setWorkspaces(workspaces);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Switch project — currently Lanework" }),
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
    // A machine with no credential opens on the first-run flow; what matters
    // here is only that it is not inside the app.
    await expect(
      page.getByRole("heading", { name: "Welcome to Lanework" }),
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
        // ⚠️ The write surface too. Every channel here reaches the board under
        // this machine's credential, so "there is no signed-in machine" has to
        // be the first thing each one says — a new channel that skipped
        // `authorizedRecord` would be reachable from any window.
        () => api.board.card("ws-lanework", "card-1"),
        () => api.board.lookup("ws-lanework", "FE-01"),
        () => api.board.update("ws-lanework", "card-1", { title: "x" }, 1),
        () => api.board.move("ws-lanework", "card-1", "todo"),
        () => api.board.changes("ws-lanework", 0),
        () =>
          api.board.setChecklist("ws-lanework", "card-1", [{ text: "One" }], 1),
        // Shapes the handler must refuse before it ever asks who is calling.
        () => api.board.update("ws-lanework", "card-1", {}, 1),
        () =>
          api.board.update("ws-lanework", "card-1", { rank: "V" } as never, 1),
        () =>
          api.board.move("ws-lanework", "card-1", null, {
            after: "",
          } as never),
        () => api.board.changes("ws-lanework", -1 as number),
        () =>
          api.board.setChecklist("ws-lanework", "card-1", [{ text: "" }], 1),
        () =>
          api.board.setChecklist(
            "ws-lanework",
            "card-1",
            [
              { key: "D1", text: "One" },
              { key: "D1", text: "Two" },
            ],
            1,
          ),
        () =>
          api.board.setChecklist(
            "ws-lanework",
            "card-1",
            [{ text: "One", section: "notes" as never }],
            1,
          ),
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
    for (const message of failures.slice(4, 10))
      expect(message).toContain("Sign in");
    expect(failures[10]).toContain("must change something");
    expect(failures[11]).toContain("Cannot change");
    expect(failures[12]).toContain("neighbouring card");
    expect(failures[13]).toContain("cursor");
    expect(failures[14]).toContain("needs text");
    expect(failures[15]).toContain('keyed "D1"');
    expect(failures[16]).toContain("decisions or verify");
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

test("a card read from a list has no checklist, and a card read alone does", () => {
  // ⚠️ The distinction this pins is the one that shipped broken. `GET /items`
  // serializes WITHOUT parts, so a card from a board read carries no checklist
  // key at all — and the old parser turned that into `[]`, which is the same
  // value a card with genuinely no decisions has. The board rendered "no
  // decisions" for every card on it and nothing said otherwise.
  const listed = {
    id: "item-1",
    revision: 3,
    columnKey: "todo",
    title: "A card",
    rank: "V",
  };
  expect(parseCard(listed)?.checklist).toBeNull();
  expect(parseCard(listed)?.assignees).toBeNull();

  // Asked for and genuinely empty — a different answer, and it has to look
  // different.
  expect(parseCard({ ...listed, checklist: [] })?.checklist).toEqual([]);
  expect(
    parseCard({ ...listed, assignees: { users: [], agents: [] } })?.assignees,
  ).toEqual({ users: [], agents: [] });

  // The hierarchy fields, which the board has always sent and this app used to
  // drop on the floor.
  expect(
    parseCard({
      ...listed,
      type: "epic",
      parentId: "item-0",
      estimate: 3,
      dueAt: "2026-09-30T00:00:00.000Z",
    }),
  ).toMatchObject({
    type: "epic",
    parentId: "item-0",
    estimate: 3,
    dueAt: "2026-09-30T00:00:00.000Z",
  });

  // `issue` when the board says nothing — the type every card has by default.
  expect(parseCard(listed)?.type).toBe("issue");
  expect(parseCard({ ...listed, estimate: "3" })?.estimate).toBeNull();
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

    await switchTo(page, "Cloud project");
    // The list is the default view: the card's key and title on one row.
    await expect(page.getByText("FE-01", { exact: true })).toBeVisible();
    await expect(page.getByText("Cache the composer input")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Refresh board — Live/ }),
    ).toBeVisible();

    // ⚠️ No checkbox on the LIST, and there never could have been: a board is
    // read through `GET /items`, which serializes without parts, so no card
    // here carries a checklist. The stub used to send one anyway, which is how
    // this assertion's ancestor stayed green against a UI that could not work
    // in production. The checklist lives on the card's own screen, below.
    await expect(page.getByRole("checkbox")).toHaveCount(0);

    // ⚠️ But the row DOES say how far through that checklist the card is. The
    // count rides on the list read as its own `{ done, total }` key, which is
    // the whole point: a lane draws `0/1` without the board shipping a single
    // checklist row. This assertion is the one that would have caught the
    // `3/7` beside a row being dead code for as long as it was.
    await expect(page.getByTitle("0 of 1 checked")).toBeVisible();

    // The card's own screen reads it again, WITH its parts — and a tick there
    // sends the revision the screen is showing, as `If-Match`.
    await page.getByRole("link", { name: /Cache the composer input/ }).click();
    await expect(
      page.getByRole("heading", { name: "Decisions" }),
    ).toBeVisible();
    // ⚠️ A tick is a DRAFT until Save (FE-13/D7): the box shows it, the row is
    // marked, and the header offers to save — but nothing has been sent.
    const sent = plane.boardPreconditions.length;
    await page.getByRole("checkbox").first().click();
    await expect(page.getByRole("checkbox").first()).toBeChecked();
    await expect(page.getByText("Not saved yet:")).toHaveCount(1);
    const save = page.getByRole("button", { name: "Save change" });
    await expect(save).toBeVisible();
    expect(plane.boardPreconditions.length).toBe(sent);
    // ⚠️ The unsaved marker's screen-reader text must not make the WINDOW
    // scrollable — it once sat outside every positioned box, and the whole app
    // slid up under a grey band.
    expect(
      await page.evaluate(() => {
        const root = (
          globalThis as unknown as {
            document: {
              scrollingElement: { scrollHeight: number; clientHeight: number };
            };
          }
        ).document.scrollingElement;
        return root.scrollHeight - root.clientHeight;
      }),
    ).toBeLessThanOrEqual(0);
    await save.click();
    await expect
      .poll(() => plane.boardPreconditions)
      .toEqual(expect.arrayContaining(["4"]));
    // ⚠️ ONE write for the whole draft — the card's activity once got a line
    // per box.
    expect(plane.boardPreconditions.length).toBe(sent + 1);
    await expect(page.getByRole("checkbox").first()).toBeChecked();
    await expect(save).toHaveCount(0);

    // A lost race shows both sides instead of "try again" — sent with ⌘S.
    plane.setChecklistConflict(true);
    await page.getByRole("checkbox").first().click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect(
      page.getByText("Someone else changed this card"),
    ).toBeVisible();
    plane.setChecklistConflict(false);

    // The refused untick is still a draft, so leaving asks before dropping it.
    await page
      .getByRole("link", { name: "Cloud project", exact: true })
      .click();
    const leave = page.getByRole("alertdialog", { name: "Discard changes?" });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Discard" }).click();

    // Back on the board, a move is one request and the card changes lane.
    // ⚠️ The card's breadcrumb names the PROJECT, not "Issues" — it reads
    // "Cloud project › FE-01", the way the design draws it. The sidebar's own
    // Issues link carries a count in its accessible name, so it is not an exact
    // match for "Issues" either.
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page
      .getByRole("combobox", { name: /^Move Cache the composer input/ })
      .click();
    await page.getByRole("option", { name: "In Progress" }).click();
    await expect(
      page.getByLabel("In Progress column").getByText(/Cache the composer/),
    ).toBeVisible();

    // ⚠️ And when the board cannot be reached, the app shows its saved copy WITH
    // a label rather than an empty board — the failure that invites somebody to
    // re-create a card that already exists.
    plane.setBoardOffline(true);
    await page.getByRole("button", { name: "Refresh board" }).click();
    // ⚠️ One bar across the pane, not a boxed alert: the condition belongs to
    // the window, so it reads as chrome rather than as a message about a card.
    await expect(
      page.getByText(/^Offline — showing a saved board/),
    ).toBeVisible();
    await expect(page.getByText(/Cache the composer/)).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await removeProfile(profile);
    await plane.close();
  }
});

test("the board write surface edits, reorders, looks up and follows changes", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", {
    migratedAt: "2026-09-08T05:00:00.000Z",
    columns: [
      { key: "todo", name: "To-Do", role: "start" },
      { key: "processing", name: "In Progress", role: "active" },
    ],
    cards: [
      {
        id: "card-a",
        revision: 1,
        title: "First",
        body: "",
        columnKey: "todo",
        categoryKey: "frontend",
        taskId: "FE-01",
        priority: null,
        tags: [],
        rank: "0001",
        createdAt: null,
        updatedAt: null,
        checklist: [
          {
            key: "D1",
            section: "decisions",
            text: "One",
            checked: false,
            checkedAt: null,
            note: null,
          },
        ],
      },
      {
        id: "card-b",
        revision: 1,
        title: "Second",
        body: "",
        columnKey: "todo",
        categoryKey: null,
        taskId: "FE-02",
        priority: null,
        tags: [],
        rank: "0002",
        createdAt: null,
        updatedAt: null,
        checklist: [],
      },
    ],
  });
  const profile = await mkdtemp(join(tmpdir(), "lanew-write-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Cloud project");
    await expect(
      page.getByRole("button", { name: /^Refresh board — Live/ }),
    ).toBeVisible();

    const result = await page.evaluate(async () => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
        .workspaces.board;
      const ws = "ws-cloud-project";
      const fail = async (run: () => Promise<unknown>) => {
        try {
          await run();
          return "unexpected success";
        } catch (error) {
          return (error as Error).message;
        }
      };

      // A card read on its own carries what the list cannot.
      const alone = await api.card(ws, "card-a");
      const listed = (await api.load(ws)).cards.find((c) => c.id === "card-a");

      // Addressed the way a human says it, and null — not a failure — when
      // nothing carries that id.
      const found = await api.lookup(ws, "FE-02");
      const missing = await api.lookup(ws, "ZZ-99");

      // An edit against the revision on screen. Five tags, a board that keeps
      // three: the write succeeds and says which two did not land.
      const edited = await api.update(
        ws,
        "card-a",
        { title: "Renamed", tags: ["UI", "Electron", "cloud", "api", "auth"] },
        alone.revision,
      );

      // The same edit again, against the revision that is now stale.
      const raced = await api.update(
        ws,
        "card-a",
        { title: "Later" },
        alone.revision,
      );

      // Fields the server owns cannot be named from here at all.
      const refusedField = await fail(() =>
        api.update(ws, "card-a", { taskId: "XX-9" } as never, 1),
      );
      const refusedRevision = await fail(() =>
        api.update(ws, "card-a", { title: "x" }, 1.5),
      );
      const refusedMove = await fail(() => api.move(ws, "card-a", null));

      // A pure reorder: no lane named, card-b placed before card-a.
      await api.move(ws, "card-b", null, { before: "card-a" });
      const order = (await api.load(ws)).cards
        .filter((c) => c.columnKey === "todo")
        .map((c) => c.id);

      const first = await api.changes(ws, 0);
      const caughtUp = await api.changes(ws, first.nextSince);

      return {
        aloneChecklist: alone.checklist?.length ?? null,
        // ⚠️ `?? "absent"` would swallow the very thing under test: the value
        // this asserts on IS null, so the fallback has to distinguish "no such
        // card" from "that card's checklist is null".
        listedChecklist: listed ? listed.checklist : "no card",
        foundTitle: found?.title ?? null,
        missing,
        edited,
        raced,
        refusedField,
        refusedRevision,
        refusedMove,
        order,
        firstCards: first.cards.length,
        caughtUpCards: caughtUp.cards.length,
        cursorMoved: first.nextSince > 0,
      };
    });

    // The read that has parts, beside the read that does not.
    expect(result.aloneChecklist).toBe(1);
    expect(result.listedChecklist).toBeNull();

    expect(result.foundTitle).toBe("Second");
    // ⚠️ Null, not a thrown error: a deep link naming a task id nobody minted
    // is a thing that happens, and it must not look like a board that failed.
    expect(result.missing).toBeNull();

    expect(result.edited).toMatchObject({ kind: "ok" });
    if (result.edited.kind === "ok") {
      expect(result.edited.card.title).toBe("Renamed");
      expect(result.edited.card.tags).toEqual(["ui", "electron", "cloud"]);
      // ⚠️ Reported in the words the user typed. "api and auth were dropped"
      // is about what they wrote; the normalized form would send them looking
      // for a tag they never entered.
      expect(result.edited.droppedTags).toEqual(["api", "auth"]);
    }

    // The lost race carries the server's copy, so both sides can be shown.
    expect(result.raced).toMatchObject({ kind: "conflict" });
    if (result.raced.kind === "conflict")
      expect(result.raced.current.title).toBe("Renamed");

    expect(result.refusedField).toContain("Cannot change");
    expect(result.refusedRevision).toContain("revision");
    // A move that names neither a lane nor a neighbour is not a move.
    expect(result.refusedMove).toContain("column or a placement");

    // ⚠️ The order the SERVER decided, read back from a fresh board read — not
    // the order this app hoped for. `placement` is the whole reason drag to
    // reorder can persist at all.
    expect(result.order).toEqual(["card-b", "card-a"]);

    // Every write above is in the first delta; asking again from the cursor the
    // server returned is caught up.
    expect(result.firstCards).toBeGreaterThan(0);
    expect(result.caughtUpCards).toBe(0);
    expect(result.cursorMoved).toBe(true);

    // ⚠️ Both edits sent `If-Match: 1`, and that is the point rather than a
    // duplicate: each carried the revision ITS CALLER had read, and the second
    // caller had read revision 1 too. That is exactly how it loses the race —
    // a client that quietly re-sent the current revision would have won it and
    // overwritten the first edit.
    expect(plane.boardPreconditions).toEqual(["1", "1"]);
  } finally {
    await app.close();
    await removeProfile(profile);
    await plane.close();
  }
});

test("a checklist is rewritten whole, and ticked boxes survive the rewrite", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", {
    migratedAt: "2026-09-08T05:00:00.000Z",
    columns: [{ key: "todo", name: "To-Do", role: "start" }],
    cards: [
      {
        id: "card-a",
        revision: 1,
        title: "First",
        body: "",
        columnKey: "todo",
        categoryKey: null,
        taskId: "FE-01",
        priority: null,
        tags: [],
        rank: "0001",
        createdAt: null,
        updatedAt: null,
        checklist: [
          {
            key: "D1",
            section: "decisions",
            text: "Keep the draft in the store",
            checked: true,
            checkedAt: "2026-09-01T00:00:00.000Z",
            note: null,
          },
          {
            key: "D2",
            section: "decisions",
            text: "Drop this one",
            checked: false,
            checkedAt: null,
            note: null,
          },
        ],
      },
    ],
  });
  const profile = await mkdtemp(join(tmpdir(), "lanew-checklist-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Cloud project");
    await expect(
      page.getByRole("button", { name: /^Refresh board — Live/ }),
    ).toBeVisible();

    const result = await page.evaluate(async () => {
      const api = (globalThis as unknown as { desktop: DesktopApi }).desktop
        .workspaces.board;
      const ws = "ws-cloud-project";
      const before = await api.card(ws, "card-a");

      // A rewrite that: rewords D1 (ticked), DELETES D2, ADDS a new row with no
      // key, and files a pair under one "pick ONE" group.
      const written = await api.setChecklist(
        ws,
        "card-a",
        [
          { key: "D1", section: "decisions", text: "Keep the draft, reworded" },
          { section: "decisions", text: "A brand new decision" },
          { section: "verify", text: "Option A", group: "g1" },
          { section: "verify", text: "Option B", group: "g1" },
        ],
        before.revision,
      );

      const after = await api.card(ws, "card-a");
      // The same write again, against the revision that is now stale.
      const raced = await api.setChecklist(
        ws,
        "card-a",
        [{ key: "D1", text: "Later" }],
        before.revision,
      );
      return {
        beforeTexts: (before.checklist ?? []).map((i) => i.text),
        writtenKind: written.kind,
        afterTexts: (after.checklist ?? []).map((i) => i.text),
        // ⚠️ The assertion this test exists for.
        d1StillTicked:
          (after.checklist ?? []).find((i) => i.key === "D1")?.checked ?? null,
        d2Gone: !(after.checklist ?? []).some((i) => i.key === "D2"),
        groups: (after.checklist ?? []).map((i) => i.group),
        sections: (after.checklist ?? []).map((i) => i.section),
        racedKind: raced.kind,
      };
    });

    expect(result.beforeTexts).toEqual([
      "Keep the draft in the store",
      "Drop this one",
    ]);
    expect(result.writtenKind).toBe("ok");
    expect(result.afterTexts).toEqual([
      "Keep the draft, reworded",
      "A brand new decision",
      "Option A",
      "Option B",
    ]);
    // ⚠️ Reworded and still ticked. The keys travel back with the rewrite and
    // the board matches on them — send none and every approval on the card is
    // silently cleared, which is the failure this pins down.
    expect(result.d1StillTicked).toBe(true);
    expect(result.d2Gone).toBe(true);
    // A "pick ONE" pair survives as a pair; the rest carry no group.
    expect(result.groups).toEqual([null, null, "g1", "g1"]);
    expect(result.sections).toEqual([
      "decisions",
      "decisions",
      "verify",
      "verify",
    ]);
    // A rewrite that lost the race is a conflict, not a silent overwrite.
    expect(result.racedKind).toBe("conflict");
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
    await switchTo(page, "Cloud project");
    // The app says which half is missing rather than failing the screen.
    await expect(page.getByText("Board not available yet")).toBeVisible();
    // ⚠️ And it still says WHICH project — in the sentence rather than in a
    // heading of its own, because the rail already carries the name. What must
    // not happen is a screen that reports a problem without naming its subject.
    await expect(page.getByText(/no id for Cloud project/)).toBeVisible();

    // And the choice survives a relaunch, which is what remembering a slug buys.
    await app.close();
    app = await electron.launch({ args: [process.cwd()], env });
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", {
        name: "Switch project — currently Cloud project",
      }),
    ).toBeVisible();
    await expect(page.getByText("Board not available yet")).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("switching projects and back returns to where the project was left", async () => {
  const plane = await startStubPlane({ workspaces });
  for (const id of ["ws-lanework", "ws-cloud-project"])
    plane.setBoard(id, {
      columns: [{ key: "todo", name: "To-Do", role: "start" }],
      cards: [
        {
          id: `${id}-card`,
          revision: 1,
          title: `Card of ${id}`,
          body: "",
          columnKey: "todo",
          categoryKey: null,
          taskId: "FE-01",
          priority: null,
          tags: [],
          rank: "V",
          createdAt: null,
          updatedAt: null,
          checklist: [],
        },
      ],
    });
  const profile = await mkdtemp(join(tmpdir(), "lanew-last-route-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  const app = await electron.launch({ args: [process.cwd()], env });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Lanework");
    await page.getByText("Card of ws-lanework").click();
    await expect.poll(() => page.url()).toContain("/w/lanework/issues/FE-01");

    // A project never opened yet starts at its issues…
    await switchTo(page, "Cloud project");
    await expect.poll(() => page.url()).toMatch(/\/w\/cloud-project\/issues$/);

    // …and one already open comes back on the screen it was left on. (Not
    // `switchTo`: it waits for the list's refresh button, and this lands on
    // the issue instead.)
    await page.getByRole("button", { name: /^Switch project/ }).click();
    await page.getByRole("option", { name: "Lanework" }).first().click();
    await expect.poll(() => page.url()).toContain("/w/lanework/issues/FE-01");
    await expect(page.getByRole("textbox", { name: "Card title" })).toHaveValue(
      "Card of ws-lanework",
    );

    // The menu's gear, beside New project, opens Settings → Projects.
    await page.getByRole("button", { name: /^Switch project/ }).click();
    await page.getByRole("button", { name: "Project settings" }).click();
    await expect.poll(() => page.url()).toContain("/settings/workspaces");
    await expect(page.getByRole("option")).toHaveCount(0);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("the project menu shows the agents running in each project", async () => {
  test.skip(process.platform === "win32", "The stand-in CLI is a POSIX shell.");
  const plane = await startStubPlane({ workspaces });
  for (const id of ["ws-lanework", "ws-cloud-project"])
    plane.setBoard(id, {
      columns: [{ key: "todo", name: "To-Do", role: "start" }],
      cards: [],
    });
  const profile = await mkdtemp(join(tmpdir(), "lanew-menu-agents-"));
  const home = join(profile, "home");
  const repo = join(profile, "repo");
  await seedRepo(repo);
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
    "lanework",
    [repo],
  );
  if (previous === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previous;
  // A stand-in Claude that stays running until `/exit`, as the real one does.
  const claude = join(profile, "claude-stand-in.sh");
  await writeFile(
    claude,
    `#!/bin/sh\nprintf 'claude-started\\n'\nwhile IFS= read -r line; do [ "$line" = "/exit" ] && exit 0; done\n`,
    { mode: 0o755 },
  );
  const app = await electron.launch({
    args: [process.cwd()],
    env: {
      ...launchEnv({ profile, home, apiUrl: plane.origin }),
      LANEWORK_TERMINAL_SHELL: "/bin/sh",
      LANEWORK_TERMINAL_AGENTS: "claude",
      LANEWORK_CLAUDE_BIN: claude,
    },
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Lanework");
    const group = page.getByRole("navigation", { name: "Agents" });
    await group.getByRole("button", { name: "New agent" }).click();
    await page.getByRole("menuitem", { name: "New Claude" }).click();
    await expect(
      page
        .getByRole("region", { name: "Claude — New Claude session" })
        .locator(".xterm-rows"),
    ).toContainText("claude-started");

    // From ANOTHER project, the menu still says what Lanework has running —
    // and says nothing about a project with no agent.
    await switchTo(page, "Cloud project");
    await page.getByRole("button", { name: /^Switch project/ }).click();
    await expect(
      page.getByRole("option", { name: /^Lanework/ }),
    ).toHaveAccessibleName(/1 agent running: Claude$/);
    await expect(
      page.getByRole("option", { name: /^Cloud project/ }),
    ).not.toHaveAccessibleName(/running/);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("projects are put in order from Settings, and the switcher and ⌘1 follow it (FE-32)", async () => {
  const plane = await startStubPlane({ workspaces });
  for (const id of ["ws-lanework", "ws-cloud-project"])
    plane.setBoard(id, {
      columns: [{ key: "todo", name: "To-Do", role: "start" }],
      cards: [],
    });
  const profile = await mkdtemp(join(tmpdir(), "lanew-order-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  let app = await electron.launch({ args: [process.cwd()], env });
  const rows = (page: Page) =>
    page
      .locator("[data-project-row]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-project-row")),
      );
  const menuOrder = async (page: Page) => {
    await page.getByRole("button", { name: /^Switch project/ }).click();
    const names = await page.getByRole("option").allInnerTexts();
    await page.keyboard.press("Escape");
    // The tile's initial is a line of its own; the name is the last one.
    return names.map((name) => name.trim().split("\n").at(-1)?.trim());
  };
  try {
    let page = await app.firstWindow();
    await switchTo(page, "Lanework");
    await page.goto("app://lanework/settings/workspaces");
    await expect.poll(() => rows(page)).toEqual(["lanework", "cloud-project"]);

    // Dragged by its grip onto the first row: it takes that place.
    const grip = page.getByRole("button", { name: /^Move Cloud project/ });
    const target = page.locator('[data-project-row="lanework"]');
    // "On this account" sits below the fold, under the selected project.
    await target.scrollIntoViewIfNeeded();
    const from = await grip.boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) throw new Error("no rows to drag");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Past the 4px that tell a drag from a click, then the rest of the way.
    await page.mouse.move(from.x + from.width / 2, from.y - 8, { steps: 3 });
    await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => rows(page)).toEqual(["cloud-project", "lanework"]);
    expect(plane.calls).toContain("PUT /v1/sync/state/workspace-order");

    // Alt+↓ on the focused grip moves it back down one place.
    await page.getByRole("button", { name: /^Move Cloud project/ }).focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(() => rows(page)).toEqual(["lanework", "cloud-project"]);
    await page.getByRole("button", { name: /^Move Cloud project/ }).focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => rows(page)).toEqual(["cloud-project", "lanework"]);

    // The switcher lists them in that order, and ⌘1 is the new first one.
    await page.goto("app://lanework/w/lanework/issues");
    await expect(
      page.getByRole("button", { name: "Switch project — currently Lanework" }),
    ).toBeVisible();
    expect(await menuOrder(page)).toEqual(["Cloud project", "Lanework"]);
    await page.keyboard.press("Meta+1");
    await expect(
      page.getByRole("button", {
        name: "Switch project — currently Cloud project",
      }),
    ).toBeVisible();

    // And it is the ACCOUNT's order: a relaunch reads it back from the service.
    await app.close();
    app = await electron.launch({ args: [process.cwd()], env });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /^Switch project/ }).waitFor();
    expect(await menuOrder(page)).toEqual(["Cloud project", "Lanework"]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("an issue is written on its own page, and the board mints its key", async () => {
  // ⚠️ The KEY is what this page exists for. The quick-add can only send a
  // title, and the board mints `taskId` from a card's CATEGORY — so every card
  // made in this app was unkeyed: blank in the column each list reserves for it,
  // unreachable by ⌘K, and impossible to deep-link.
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", bigBoard(2));
  const profile = await mkdtemp(join(tmpdir(), "lanew-new-issue-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await switchTo(page, "Cloud project");

    // ⌘N, the shortcut the rail's button prints. A hint that does nothing is
    // worse than no hint — it teaches the reader that the hints are decoration.
    await page.keyboard.press("ControlOrMeta+n");
    const title = page.getByRole("textbox", { name: "Issue title" });
    await expect(title).toBeFocused();
    // Nothing to save until there is something to save.
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

    // Said in the rail, not discovered after the fact: no category, no key.
    await expect(
      page.getByText(/No category means no issue key/),
    ).toBeVisible();

    await title.fill("Composer lands with a key");
    await page
      .getByRole("textbox", { name: "Description" })
      .fill("## Context\n\nWritten on the page, not in a one-line field.");
    await page.getByRole("combobox", { name: "Category" }).click();
    await page.getByRole("option", { name: "Frontend" }).click();
    await page.getByRole("combobox", { name: "Priority" }).click();
    await page.getByRole("option", { name: "High" }).click();
    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "In Progress" }).click();
    // ⚠️ One entry of "ui, electron" becomes TWO chips, not one tag with a
    // comma in it. `normalizeTag` turns spaces into hyphens and leaves commas
    // alone, so a field that took the whole string would have made `ui,-electron`.
    await page.getByRole("button", { name: "Add label" }).click();
    await page.getByRole("textbox", { name: "New label" }).fill("ui, electron");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Remove ui" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove electron" }),
    ).toBeVisible();
    await expect(page.getByText(/No category means no issue key/)).toBeHidden();

    await page.getByRole("button", { name: "Save" }).click();

    // ⚠️ It lands ON the card it just made, addressed by the key the BOARD
    // minted — `FE-02`, the second frontend card. Following a card with no key
    // there would land on "No card called …", which is why the page checks.
    // ⚠️ `.first()`: the key is in the breadcrumb AND at the top of the
    // properties rail, which is deliberate — the rail's header is where the
    // copy-id and copy-branch buttons hang off it.
    await expect(
      page.getByText("FE-02", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Card title" })).toHaveValue(
      "Composer lands with a key",
    );
    // Every field travelled: the rail reads them back off the board, not off
    // the form that has since been unmounted.
    // ⚠️ By text, not by heading role: `markdown-body` renders `##` as a bold
    // paragraph on purpose, so the page keeps one heading hierarchy of its own.
    await expect(
      page.getByText("Written on the page, not in a one-line field."),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Priority" }),
    ).toContainText("High");
    await expect(page.getByRole("combobox", { name: "Status" })).toContainText(
      "In Progress",
    );
    // ⚠️ Chips on the detail rail, read back off the BOARD rather than off the
    // form that has since been unmounted. The control is the same one the
    // composer carries — labels are one field with one control on both rails —
    // so this is the board's own answer, not the draft's.
    await expect(page.getByRole("button", { name: "Remove ui" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove electron" }),
    ).toBeVisible();

    // And Cancel leaves a draft behind rather than writing it.
    await page.keyboard.press("ControlOrMeta+n");
    await page.getByRole("textbox", { name: "Issue title" }).fill("Abandoned");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: /Abandoned/ })).toHaveCount(
      0,
    );

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("the description is a markdown editor: lists continue, ⌘↵ saves, Escape leaves", async () => {
  // ⚠️ The three things a textarea could not do, and the reason the composer
  // carries an editor at all. ⌘↵ and Escape matter twice over: CodeMirror's
  // default keymap binds BOTH — Mod-Enter inserts a blank line, Escape
  // simplifies the selection — so without the bindings this pins, the field a
  // person types in would be the one field those two keys stopped working in.
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", bigBoard(2));
  const profile = await mkdtemp(join(tmpdir(), "lanew-md-editor-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await switchTo(page, "Cloud project");

    await page.keyboard.press("ControlOrMeta+n");
    const body = page.getByRole("textbox", { name: "Description" });
    await body.click();
    await page.keyboard.type("- first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    // The bullet came back on its own — `markdownKeymap`, not a plain newline.
    await expect(body).toContainText("- second");

    // Escape leaves from INSIDE the editor, draft and all.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);

    // And ⌘↵ saves from inside it, without touching the mouse.
    await page.keyboard.press("ControlOrMeta+n");
    await page
      .getByRole("textbox", { name: "Issue title" })
      .fill("Saved by ⌘↵");
    await page.getByRole("textbox", { name: "Description" }).click();
    await page.keyboard.type("Written and filed without leaving the keyboard.");
    await page.keyboard.press("ControlOrMeta+Enter");

    // No category, so the card has no key to be opened by — the list is where
    // it is reachable, and that is where the composer sends it.
    await expect(
      page.getByRole("heading", { name: "All issues" }),
    ).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Saved by ⌘↵" }),
    ).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("labels are picked from the board's vocabulary, and free text still lands", async () => {
  // ⚠️ Driven on the NEW ISSUE page, where the same control sits. Labels are one
  // field with one control on both rails — `properties.tsx` states why — so this
  // covers the composer and `issue-detail.spec.ts` covers the card that exists.
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", {
    ...bigBoard(2),
    labels: [{ key: "ui-polish", name: "UI Polish", tone: "violet" }],
  });
  const profile = await mkdtemp(join(tmpdir(), "lanew-tags-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await switchTo(page, "Cloud project");
    await page.getByRole("button", { name: /^New issue/ }).click();

    // A label the board has named is picked, and the chip says its NAME.
    await page.getByRole("button", { name: "Add label" }).click();
    await page.getByRole("menuitem", { name: "UI Polish" }).click();
    await expect(
      page.getByRole("button", { name: "Remove UI Polish" }),
    ).toBeVisible();

    // ⚠️ And free text still lands, because the vocabulary is a PALETTE rather
    // than a whitelist — the service accepts any tag, and a picker that only
    // offered the named ones would make every other tag unreachable.
    //
    // ⚠️ The chip carries what the BOARD will store, not what was typed: a
    // comma ends a tag, which is how people type a list, and `normalizeTag` is
    // the same mirror the main process compares against.
    const field = page.getByRole("textbox", { name: "New label" });
    await field.click();
    await page.keyboard.type("Electron App,");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Remove electron-app" }),
    ).toBeVisible();

    // The × takes one back off and leaves the other alone.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Remove UI Polish" }).click();
    await expect(
      page.getByRole("button", { name: "Remove UI Polish" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove electron-app" }),
    ).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a card is deleted from its context menu, in the list and on the board", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", bigBoard(4));
  const profile = await mkdtemp(join(tmpdir(), "lanew-delete-card-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await switchTo(page, "Cloud project");

    const row = page.getByRole("listitem").filter({ hasText: "Card number 1" });
    await expect(row).toBeVisible();
    await row.click({ button: "right" });

    // ⚠️ The menu NAMES the card. On a dense list the row under the cursor and
    // the row somebody meant are one pixel apart, and this is the last place
    // that gap can be caught.
    await expect(page.getByText("FE-01", { exact: true }).last()).toBeVisible();
    await page.getByRole("menuitem", { name: /^Delete/ }).click();

    // The confirmation says what actually happens, and only then does it.
    await expect(
      page.getByText(/comes off the board for everyone/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Delete card" }).click();

    await expect(row).toHaveCount(0);
    expect(plane.calls).toContain(
      "DELETE /v1/boards/ws-cloud-project/items/card-0",
    );

    // ⚠️ And again on the lanes, where the same menu has to survive a card that
    // is also a drag handle and a drop target. A wrapper element around it would
    // break dnd-kit's measuring; the menu renders the card's own `li` instead.
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const card = page
      .getByRole("listitem")
      .filter({ hasText: "Card number 2" });
    await expect(card).toBeVisible();
    await card.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Delete/ }).click();
    await page.getByRole("button", { name: "Delete card" }).click();

    await expect(card).toHaveCount(0);
    expect(plane.calls).toContain(
      "DELETE /v1/boards/ws-cloud-project/items/card-1",
    );

    // Cancel leaves the card where it is — the gesture is one right click away
    // from the wrong row, so the way out has to work.
    const kept = page
      .getByRole("listitem")
      .filter({ hasText: "Card number 4" });
    await kept.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Delete/ }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(kept).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

/** A board big enough that a card wall stops being readable. */
function bigBoard(count: number) {
  return {
    migratedAt: "2026-09-08T05:00:00.000Z",
    columns: [
      { key: "todo", name: "To-Do", role: "start" },
      { key: "processing", name: "In Progress", role: "active" },
      { key: "done", name: "Done", role: "done" },
    ],
    categories: [
      { key: "frontend", name: "Frontend", prefix: "FE", tone: "sky" },
      { key: "backend", name: "Backend", prefix: "BE", tone: "emerald" },
    ],
    cards: Array.from({ length: count }, (_, i) => ({
      id: `card-${i}`,
      revision: 1,
      title: `Card number ${i + 1}`,
      body: "",
      columnKey: ["todo", "processing", "done"][i % 3],
      categoryKey: i % 2 ? "backend" : "frontend",
      taskId: `${i % 2 ? "BE" : "FE"}-${String(i + 1).padStart(2, "0")}`,
      priority: (["high", "medium", "low", null] as const)[i % 4],
      tags: i % 2 ? ["ui"] : ["cloud"],
      rank: String(i).padStart(4, "0"),
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-08T07:00:00.000Z",
      checklist: [],
    })),
  };
}

test("a long board is readable: groups fold, filters cut, and ⌘K jumps by key", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", bigBoard(33));
  const profile = await mkdtemp(join(tmpdir(), "lanew-long-board-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await switchTo(page, "Cloud project");

    // ⚠️ 33 cards is the case the old card wall could not render usefully. Two
    // lanes are open and the finished one starts folded — the largest lane on
    // any board that has been running a while, and the least often read.
    const rows = page.getByRole("listitem");
    await expect.poll(async () => await rows.count()).toBe(22);
    await expect(
      page.getByRole("button", { name: /^Done/, expanded: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Done/ }).click();
    await expect.poll(async () => await rows.count()).toBe(33);
    await page.getByRole("button", { name: /^Done/ }).click();

    // ⚠️ ONE filter button, then a field, then a searchable list of its values.
    // Everything a board can be cut by goes through the same door.
    await page.getByRole("button", { name: "Filter" }).click();
    // ⚠️ HOVER, not click. The submenu opens on hover — a click that also had
    // to open it would be a second interaction for the same intent, and this is
    // the gesture the menu is actually built around.
    await page.getByRole("menuitem", { name: "Category" }).hover();
    await page.getByRole("option", { name: "Backend" }).click();
    await expect.poll(async () => await rows.count()).toBe(11);
    await expect(page.getByText("FE-01", { exact: true })).toBeHidden();
    await expect(page.getByText("BE-02", { exact: true })).toBeVisible();

    // The filter in play reads as a sentence, and its VALUE is a control: the
    // commonest edit is swapping one value for another, not rebuilding it.
    // ⚠️ Asserted on WHICH cards, not how many: both categories happen to leave
    // eleven rows on screen once the finished lane is folded, so a count would
    // pass without the filter having changed at all.
    await page.getByRole("button", { name: "Change Category filter" }).click();
    await page.getByRole("option", { name: "Frontend" }).click();
    await expect(page.getByText("FE-01", { exact: true })).toBeVisible();
    await expect(page.getByText("BE-02", { exact: true })).toBeHidden();

    await page.getByRole("button", { name: "Remove Category filter" }).click();
    await expect.poll(async () => await rows.count()).toBe(22);

    // Grouping is the second axis, and it drops empty groups rather than
    // drawing a board that looks like it has states it does not.
    await page.getByRole("combobox", { name: "Group by" }).click();
    await page.getByRole("option", { name: "Priority" }).click();
    await expect(page.getByRole("button", { name: /^High/ })).toBeVisible();
    await page.getByRole("combobox", { name: "Group by" }).click();
    await page.getByRole("option", { name: "Status" }).click();

    // ⌘K finds a card by the key a person says out loud, and lands on it.
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("option", { name: /BE-02/ }).first().waitFor();
    await page.keyboard.type("BE-02");
    await page.keyboard.press("Enter");
    await expect(
      page
        .getByRole("heading", { name: "Card properties" })
        .or(page.getByLabel("Card title")),
    ).toBeVisible();
    await expect(page.getByLabel("Card title")).toHaveValue("Card number 2");

    // ⚠️ And the card's own URL is the address, so a deep link works cold —
    // this is `lookup` earning its keep, on a card the list was never read for.
    await page.goto("app://lanework/w/cloud-project/issues/FE-05");
    await expect(page.getByLabel("Card title")).toHaveValue("Card number 5");

    // A key nobody minted is a plain answer, not a broken screen.
    await page.goto("app://lanework/w/cloud-project/issues/ZZ-99");
    await expect(page.getByText(/^No card called/)).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("dragging a card reorders its lane, and the order outlives a reload", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", bigBoard(6));
  const profile = await mkdtemp(join(tmpdir(), "lanew-dnd-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await switchTo(page, "Cloud project");
    await page.getByRole("button", { name: "Board", exact: true }).click();

    const lane = page.getByLabel("To-Do column").getByRole("listitem");
    const titles = () => lane.allInnerTexts();
    // ⚠️ Wait for the lane to be FULLY drawn before measuring it. Grabbing a
    // bounding box while the board is still loading gives coordinates for a
    // card that is about to move, and the drop then lands nowhere — the failure
    // looks like broken drag-and-drop rather than a race in the test.
    await expect(lane).toHaveCount(2);
    expect((await titles()).join("|")).toMatch(
      /Card number 1[\s\S]*Card number 4/,
    );

    // ⚠️ The drop lands ABOVE the first card, so this is a reorder inside one
    // lane — the case `rank` exists for and the one a `columnKey`-only move
    // could never express.
    // ⚠️ A REAL pointer gesture, which is the whole reason the board is on
    // dnd-kit rather than HTML5 drag-and-drop. Chromium only turns a mouse
    // gesture into `dragstart` through its own drag interception, which
    // Playwright cannot drive inside an Electron window — so this used to be
    // three dispatched events with a hand-made `DataTransfer`, testing the
    // handlers while the gesture that reaches them went untested. A pointer
    // sensor listens to the events Playwright can actually send.
    const from = await lane.nth(1).boundingBox();
    const to = await lane.nth(0).boundingBox();
    if (!from || !to) throw new Error("the lane's cards are not on screen");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // ⚠️ Two moves, and the first one only has to clear the 6px the sensor
    // waits for. A single jump to the destination is one event that both starts
    // the drag and ends it, and dnd-kit resolves the target from the move AFTER
    // activation — so the drop would land on nothing.
    await page.mouse.move(
      from.x + from.width / 2,
      from.y + from.height / 2 + 12,
    );
    // Above the first card's midpoint, so the drop lands BEFORE it.
    await page.mouse.move(to.x + to.width / 2, to.y + 3, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => (await titles())[0])
      .toContain("Card number 4");

    // ⚠️ Read back from the SERVER, not from the screen it was dropped on. The
    // position is optimistic while the request is in flight; what this proves
    // is that the board agreed.
    await page.reload();
    // ⚠️ No click: the lanes are a VIEW of the issues now (FE-13/D4), and the
    // URL carries it, so a reload comes back to the board by itself.
    await expect(lane).toHaveCount(2);
    await expect
      .poll(async () => (await titles())[0])
      .toContain("Card number 4");

    // ⚠️ The rail's "Issues" reopens the view last used for THIS project
    // (FE-13/D5): someone who works from the lanes is not sent to the list
    // every time they come back.
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByLabel("To-Do column")).toHaveCount(0);
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page.getByRole("link", { name: /^Issues/ }).click();
    await expect(lane).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Board", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    // The old /board path still lands on the lanes, filters kept, rather than
    // on a "not found" — links and ⌘K history from older builds name it.
    await page.goto("app://lanework/w/cloud-project/board?priority=high");
    await expect(page).toHaveURL(/\/w\/cloud-project\/issues\?/);
    expect(new URL(page.url()).searchParams.get("view")).toBe("board");
    expect(new URL(page.url()).searchParams.get("priority")).toBe("high");
    expect(errors).toEqual([]);
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
  await writeFolders(
    {
      machineId: "test-machine",
      userId: "test-user",
      apiUrl: plane.origin,
      name: "test-machine",
      secret: "lw_mch_test-secret",
      owner: null,
    } satisfies MachineRecord,
    "cloud-project",
    [repo],
  );
  if (previous === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previous;

  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  const app = await electron.launch({ args: [process.cwd()], env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await switchTo(page, "Cloud project");
    await expect(page.getByText("Board not available yet")).toBeVisible();

    // ⚠️ Reachable whatever the board is doing — not only from a board that
    // failed to load (FE-08 D14). The door moved to Settings → Projects, where
    // it sits against the project it acts on.
    await openImport(page, "Cloud project");

    // What the folder holds, from front matter only.
    await expect(page.getByText("4 review cards")).toBeVisible();
    await expect(page.getByText("3 done, 1 todo")).toBeVisible();
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

    await page.getByRole("button", { name: /^Switch project/ }).click();
    // ⚠️ The field is behind a row now: a menu people open to SWITCH should
    // not lead with a text input.
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("New project name").fill("Dự án của tôi");
    await page.getByRole("button", { name: "Create project" }).click();

    // ⚠️ Created AND opened: the new project is the active one, without a
    // second click. The rail names it by what the user typed, not by the slug.
    await expect(
      page.getByRole("button", {
        name: "Switch project — currently Dự án của tôi",
      }),
    ).toBeVisible();
    // The slug this app minted is what the service was asked for.
    expect(plane.calls).toContain("POST /v1/sync/state/workspace");

    // And it is remembered, which is what makes "created" different from
    // "showing on screen".
    await app.close();
    app = await electron.launch({ args: [process.cwd()], env });
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", {
        name: "Switch project — currently Dự án của tôi",
      }),
    ).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a project is created from the folders a person picked, primary first", async () => {
  const plane = await startStubPlane({ workspaces });
  const profile = await mkdtemp(join(tmpdir(), "lanew-create-folders-"));
  const home = join(profile, "home");
  const repo = join(profile, "repo");
  const extra = join(profile, "extra");
  await seedRepo(repo);
  await mkdir(extra, { recursive: true });
  await seedCredential(home, plane.origin);
  // ⚠️ The native chooser is the one control Playwright cannot drive, so the
  // app is told what a person would have picked. Everything after the chooser —
  // the ids, the order, what is written down — is the real code path.
  const env = {
    ...launchEnv({ profile, home, apiUrl: plane.origin }),
    LANEWORK_TEST_FOLDERS: `${repo}:${extra}`,
  };
  let app = await electron.launch({ args: [process.cwd()], env });
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.getByRole("button", { name: /^Switch project/ }).click();
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("New project name").fill("Repo Project");
    await page.getByRole("button", { name: /^Add folders/ }).click();

    // Both folders are listed, by name and by path — two checkouts of one repo
    // have the same basename, so the path is what tells them apart.
    const rows = page
      .getByRole("list", { name: "Source folders" })
      .getByRole("listitem");
    await expect(rows.filter({ hasText: repo })).toBeVisible();
    await expect(rows.filter({ hasText: extra })).toBeVisible();
    // The first one picked is primary until somebody says otherwise.
    await expect(page.getByText("Primary", { exact: true })).toBeVisible();

    // ⚠️ Making a folder primary MOVES it: the order carries the fact, so the
    // primary is always the row the eye lands on first.
    await page
      .getByRole("button", { name: "Make extra the primary folder" })
      .click();
    await expect(rows.first()).toContainText(extra);

    await page.getByRole("button", { name: "Create project" }).click();
    await expect(
      page.getByRole("button", {
        name: "Switch project — currently Repo Project",
      }),
    ).toBeVisible();

    // ⚠️ The projects page names the PRIMARY, and the panel names the rest. A
    // folder chosen at creation that never appears again is one the app forgot.
    await openImport(page, "Repo Project");
    await expect(page.getByText("Also in this project")).toBeVisible();
    await expect(page.getByText(repo, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    // The row names the primary and counts the rest: "<extra> + 1 more" —
    // and so does the selected-project section above it (FE-14).
    await expect(page.getByText(`${extra} + 1 more`)).toHaveCount(2);

    // And the link survives a relaunch, which is what makes it a link rather
    // than something the dialog remembered.
    await app.close();
    app = await electron.launch({ args: [process.cwd()], env });
    page = await app.firstWindow();
    // The window has to finish its first load before a navigation will stick.
    await page
      .getByRole("button", { name: /^Switch project/ })
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.goto("app://lanework/settings/workspaces");
    await expect(page.getByText(`${extra} + 1 more`)).toHaveCount(2);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("projects are managed from settings: folders changed, deleted, created", async () => {
  const plane = await startStubPlane({ workspaces });
  const profile = await mkdtemp(join(tmpdir(), "lanew-settings-projects-"));
  const home = join(profile, "home");
  const repo = join(profile, "repo");
  await seedRepo(repo);
  await seedCredential(home, plane.origin);
  const env = {
    ...launchEnv({ profile, home, apiUrl: plane.origin }),
    LANEWORK_TEST_FOLDERS: repo,
  };
  const app = await electron.launch({ args: [process.cwd()], env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("button", { name: /^Switch project/ })
      .waitFor({ state: "visible", timeout: 15_000 });

    await page.goto("app://lanework/settings/workspaces");
    await expect(
      page.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible();
    // Every project on the ACCOUNT, not just the one that is open — each a row
    // that selects it for the section above (FE-14).
    await expect(
      page.getByRole("button", { name: "Select Cloud project" }),
    ).toBeVisible();
    // Neither project has a folder on this machine yet, and the page says so
    // per row rather than once for the page — plus once in the section.
    await expect(page.getByText("No folder on this machine")).toHaveCount(3);

    // Folders and the name are two buttons, not one "edit": the folders are
    // this machine's, the name is the account's.
    await page.getByRole("button", { name: "Select Cloud project" }).click();
    await page
      .getByRole("button", { name: "Source folders for Cloud project" })
      .click();
    await page.getByRole("button", { name: /^Add folders/ }).click();
    await page.getByRole("button", { name: "Save folders" }).click();
    // The row and the section both say where it lives now.
    await expect(page.getByText(repo, { exact: true })).toHaveCount(2);

    // Deleting says what it does, and only then does it — and it reaches a
    // project that is NOT open, by selecting it rather than switching to it.
    await page.getByRole("button", { name: "Select Lanework" }).click();
    await page.getByRole("button", { name: "Delete Lanework" }).click();
    await expect(
      page.getByText(/removes the project and its cloud board/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Delete project" }).click();
    await expect(
      page.getByRole("button", { name: "Delete Lanework" }),
    ).toBeHidden();
    // ⚠️ By ID, not by the slug on screen. The stub refuses a slug with a 400,
    // as the service does — the mix-up used to be a 200 that deleted nothing.
    expect(plane.calls).toContain(
      "DELETE /v1/sync/state/workspace/ws-lanework",
    );

    // And a project can be created from here too, with the same dialog.
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("New project name").fill("From Settings");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(
      page.getByRole("button", { name: "Select From Settings" }),
    ).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a project with no cloud id says why it cannot be renamed or deleted", async () => {
  // ⚠️ Both buttons are DISABLED WITH A REASON, not hidden. Delete used to reach
  // a project like this one — the machine surface took its slug — and it moved to
  // the cloud id because a uuid matches the service's slug shape, so the two keys
  // could not be told apart and an id sent to the old route removed nothing while
  // answering 200. Losing this row's delete is the price of that being loud, and
  // a button that quietly vanished would leave nothing to explain why.
  const plane = await startStubPlane({
    workspaces: [
      ...workspaces,
      {
        id: null,
        slug: "legacy",
        name: "Legacy project",
        path: null,
        baseBranch: null,
      },
    ],
  });
  const profile = await mkdtemp(join(tmpdir(), "lanew-no-id-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  const app = await electron.launch({ args: [process.cwd()], env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("button", { name: /^Switch project/ })
      .waitFor({ state: "visible", timeout: 15_000 });

    await page.goto("app://lanework/settings/workspaces");
    await page.getByRole("button", { name: "Select Legacy project" }).click();
    const remove = page.getByRole("button", { name: "Delete Legacy project" });
    await expect(remove).toBeDisabled();
    await expect(remove).toHaveAttribute("title", /no cloud id/);
    await expect(
      page.getByRole("button", { name: "Rename Legacy project" }),
    ).toBeDisabled();
    // The purge is addressed by cloud id too, so it is gated the same way.
    await expect(
      page.getByRole("button", { name: "Remove all issues in Legacy project" }),
    ).toBeDisabled();

    // ⚠️ And nothing reached the service. The gate exists so a slug is never
    // sent to a route that would answer 200 having deleted nothing.
    expect(plane.calls.some((call) => call.startsWith("DELETE "))).toBe(false);

    // The project the account DID give an id is untouched by the gate.
    await page.getByRole("button", { name: "Select Lanework" }).click();
    await expect(
      page.getByRole("button", { name: "Delete Lanework" }),
    ).toBeEnabled();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("every issue is removed from settings, once the key is typed", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", bigBoard(3));
  const profile = await mkdtemp(join(tmpdir(), "lanew-purge-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await switchTo(page, "Cloud project");
    await expect(page.getByText("Card number 1")).toBeVisible();

    // The OPEN project is the one the section manages, without picking it.
    // ⚠️ Reached by clicking through, not `goto`: a full reload would drop the
    // board read, and the dialog would rightly say "every issue" instead of a
    // count it never saw.
    await page.getByRole("link", { name: /^Settings/ }).click();
    await page.getByRole("link", { name: "Projects" }).click();
    await page
      .getByRole("button", { name: "Remove all issues in Cloud project" })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Remove all 3 issues in Cloud project?");
    const confirm = dialog.getByRole("button", {
      name: "Remove 3 issues permanently",
    });
    // ⚠️ The button stays off until the KEY is typed exactly — not the name,
    // and not something close. Nothing has been sent while it is off.
    await expect(confirm).toBeDisabled();
    await dialog
      .getByLabel(/Type cloud-project to confirm/)
      .fill("Cloud project");
    await expect(confirm).toBeDisabled();
    await dialog
      .getByLabel(/Type cloud-project to confirm/)
      .fill("cloud-project");
    await expect(confirm).toBeEnabled();
    expect(plane.calls.some((call) => call.includes("/purge"))).toBe(false);
    await confirm.click();

    await expect(page.getByText(/^Removed 3 issues\./)).toBeVisible();
    expect(plane.calls.filter((call) => call.includes("/purge"))).toEqual([
      "POST /v1/boards/ws-cloud-project/purge",
    ]);

    // The open board was re-read, not patched: its issues are gone.
    await page.goto("app://lanework/w/cloud-project/issues");
    await expect(page.getByText("No cards yet")).toBeVisible();
    await expect(page.getByText("Card number 1")).toHaveCount(0);

    // ⚠️ A service older than the route answers 404, and the page says what
    // that means rather than "not found" about a board that is right there.
    plane.setPurgeMissing(true);
    await page.goto("app://lanework/settings/workspaces");
    await page
      .getByRole("button", { name: "Remove all issues in Cloud project" })
      .click();
    await page
      .getByRole("alertdialog")
      .getByLabel(/Type cloud-project to confirm/)
      .fill("cloud-project");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^Remove/ })
      .click();
    await expect(
      page.getByText(/This Lanework service cannot remove issues yet/),
    ).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a project is renamed from settings, and its key does not move", async () => {
  const plane = await startStubPlane({ workspaces });
  const profile = await mkdtemp(join(tmpdir(), "lanew-rename-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const env = launchEnv({ profile, home, apiUrl: plane.origin });
  const app = await electron.launch({ args: [process.cwd()], env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("button", { name: /^Switch project/ })
      .waitFor({ state: "visible", timeout: 15_000 });

    // A project is OPEN before the rename, so the test can prove a rename does
    // not move the selection — the whole reason main answers with `load()`.
    await switchTo(page, "Lanework");

    await page.goto("app://lanework/settings/workspaces");
    await page.getByRole("button", { name: "Select Cloud project" }).click();
    await page.getByRole("button", { name: "Rename Cloud project" }).click();

    // The field arrives holding the current name — a rename is an edit, not an
    // entry — and the dialog names the key that is NOT going to change.
    const field = page.getByLabel("New name for Cloud project");
    await expect(field).toHaveValue("Cloud project");
    await expect(
      page.getByText(/The key cloud-project stays as it is/),
    ).toBeVisible();
    // Nothing to save until something is different.
    await expect(
      page.getByRole("button", { name: "Save name" }),
    ).toBeDisabled();

    await field.fill("Cloud project renamed");
    await page.getByRole("button", { name: "Save name" }).click();

    // ⚠️ The new name is awaited BEFORE `plane.calls` is read. `calls` is a
    // plain array on the stub, so asserting it straight after a click reads it
    // before the request has necessarily arrived — which passes on a fast run
    // and fails in a full suite.
    await expect(
      page.getByRole("button", { name: "Rename Cloud project renamed" }),
    ).toBeVisible();
    // ⚠️ By ID, as the sibling DELETE now is too. They were split for one
    // release — rename by id, delete by slug — and a uuid matches the slug
    // shape, so the mix-up could not be seen from either side.
    expect(plane.calls).toContain(
      "PATCH /v1/sync/state/workspace/ws-cloud-project",
    );
    // ⚠️ The KEY is untouched, which is what the folder link and the saved
    // selection are both keyed by. (Twice: the selected-project section and
    // the project's own row.)
    await expect(page.getByText("cloud-project", { exact: true })).toHaveCount(
      2,
    );

    // A name that is only whitespace never reaches the service: there is
    // nothing to save, so there is nothing to refuse.
    await page.getByRole("button", { name: "Select Lanework" }).click();
    await page.getByRole("button", { name: "Rename Lanework" }).click();
    await page.getByLabel("New name for Lanework").fill("   ");
    await expect(
      page.getByRole("button", { name: "Save name" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Cancel" }).click();

    // ⚠️ And the project that was OPEN is still the one that is open. Renaming
    // reads the account back with `load()`, not `load(id)` — passing the id
    // would quietly select whichever project was renamed, from a Settings page
    // that shows no board at all.
    await page.getByRole("link", { name: "Back to app" }).click();
    await expect(
      page.getByRole("button", {
        name: "Switch project — currently Lanework",
      }),
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
    await page.getByRole("button", { name: /^Switch project/ }).click();
    await page.getByRole("button", { name: "New project" }).click();
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
  await writeFolders(
    {
      machineId: "test-machine",
      userId: "test-user",
      apiUrl: plane.origin,
      name: "test-machine",
      secret: "lw_mch_test-secret",
      owner: null,
    } satisfies MachineRecord,
    "cloud-project",
    [repo],
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

    await switchTo(page, "Cloud project");
    // ⚠️ A migration starts from the same place every time — Settings →
    // Projects — not only from an empty board (FE-08 D14).
    await openImport(page, "Cloud project");
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

    // ⚠️ The panel STAYS — it is reachable whatever the board's state (FE-08
    // D14) — but the offer to send does not. After a cutover the files on disk are a frozen
    // copy, and a button that would send them again points somebody at the
    // version that stopped being true.
    await expect(page.getByText("This project on this machine")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^(Sync to cloud|Send again)$/ }),
    ).toHaveCount(0);
    await expect(page.getByText(/cloud has owned this project/)).toBeVisible();

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
    await switchTo(page, "Cloud project");
    await openImport(page, "Cloud project");
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

test("a project URL whose list will not load asks once and stays put", async () => {
  const plane = await startStubPlane({ workspaces });
  const profile = await mkdtemp(join(tmpdir(), "lanew-workspace-loop-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("list", { name: "Projects" })).toBeVisible();

    const reads = () =>
      plane.calls.filter((call) => call === "GET /v1/sync/state").length;

    plane.setWorkspaceResponse(500);
    const before = reads();
    await page.goto("app://lanework/w/lanework/issues");

    // ⚠️ ONE read for one navigation. It used to be three: the layout hydrated,
    // `open` hydrated again because the failed list had no such slug, then the
    // picker it bounced to hydrated a third time — and main logs every one of
    // them as an unhandled handler error.
    await expect(page.getByText("Could not open this project")).toBeVisible();
    await expect(page.getByText(/HTTP 500/)).toBeVisible();
    expect(reads() - before).toBe(1);

    // ⚠️ And it STAYS on the project's URL. A list that failed to load is not
    // evidence the project is gone, so sending somebody to the picker is wrong
    // twice over: the picker is built from the same list, and it navigates
    // straight back — a loop that sat on "Opening your project…" and asked
    // again every lap.
    expect(page.url()).toContain("/w/lanework/issues");
    await page.waitForTimeout(1500);
    expect(reads() - before).toBe(1);
    expect(page.url()).toContain("/w/lanework/issues");

    // Try again is the way out, and it is the only thing that asks again.
    plane.setWorkspaceResponse(200);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByRole("button", { name: "Switch project — currently Lanework" }),
    ).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

/**
 * Watch for the thing that reads as "loading again": a skeleton, or a lane
 * card mounting at `opacity: 0` because it is about to fade in (FE-15).
 */
async function watchForReload(page: Page): Promise<void> {
  // ⚠️ A string, not a function: this project's test tsconfig has no DOM lib,
  // and the observer has to run in the page.
  await page.evaluate(`(() => {
    const seen = { skeleton: false, fade: false };
    globalThis.__reload = seen;
    new MutationObserver(() => {
      if (document.querySelector('[data-slot="skeleton"]')) seen.skeleton = true;
      if (document.querySelector('li.shadow-card[style*="opacity: 0"]'))
        seen.fade = true;
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
  })()`);
}

const sawReload = (page: Page) =>
  page.evaluate<{ skeleton: boolean; fade: boolean }>("globalThis.__reload");

test("coming back to a project draws its board at once and reads only what changed", async () => {
  const plane = await startStubPlane({ workspaces });
  // Every Cloud card is To-Do, so the list shows them all unfolded, and named
  // so nothing on Lanework's board can match them.
  const cloud = bigBoard(2);
  cloud.cards = cloud.cards.map((card, i) => ({
    ...card,
    title: `Cloud card ${i + 1}`,
    columnKey: "todo",
  }));
  plane.setBoard("ws-cloud-project", cloud);
  plane.setBoard("ws-lanework", bigBoard(2));
  const profile = await mkdtemp(join(tmpdir(), "lanew-board-cache-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Cloud project");
    await expect(page.getByText("Cloud card 2")).toBeVisible();
    await switchTo(page, "Lanework");
    await expect(page.getByText("Cloud card 2")).toHaveCount(0);

    // Written on another machine while this window was on Lanework.
    plane.addCard("ws-cloud-project", {
      ...cloud.cards[0],
      id: "card-elsewhere",
      title: "Made elsewhere",
      taskId: "FE-09",
      rank: "0009",
    });

    const mark = plane.calls.length;
    await watchForReload(page);
    await switchTo(page, "Cloud project");
    await expect(page.getByText("Cloud card 2")).toBeVisible();
    // ⚠️ The delta, not a re-read: the card made elsewhere arrives through
    // the change feed from the cached cursor.
    await expect(page.getByText("Made elsewhere")).toBeVisible();

    const since = plane.calls.slice(mark);
    expect(await sawReload(page)).toEqual({ skeleton: false, fade: false });
    expect(since.filter((call) => call.includes("/v1/sync/state"))).toEqual([]);
    expect(
      since.filter((call) =>
        /\/v1\/boards\/ws-cloud-project\/(items\?|config)/.test(call),
      ),
    ).toEqual([]);
    expect(
      since.some((call) =>
        /\/v1\/boards\/ws-cloud-project\/changes\?since=[1-9]/.test(call),
      ),
    ).toBe(true);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a card opens with one activity read, and the lanes do not fade in again on the way back", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", bigBoard(3));
  const profile = await mkdtemp(join(tmpdir(), "lanew-board-back-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Cloud project");
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await expect(page.locator("li.shadow-card")).toHaveCount(3);

    const mark = plane.calls.length;
    await page.getByText("Card number 1").click();
    await expect(page).toHaveURL(/\/issues\/FE-01/);
    await expect(page.getByRole("textbox", { name: "Card title" })).toHaveValue(
      "Card number 1",
    );
    const activity = () =>
      plane.calls
        .slice(mark)
        .filter((call) => call.includes("/items/card-0/activity")).length;
    await expect.poll(activity).toBe(1);
    // Settled at one, not on its way to two.
    await page.waitForTimeout(500);
    expect(activity()).toBe(1);

    await watchForReload(page);
    await page.goBack();
    await expect(page.locator("li.shadow-card")).toHaveCount(3);
    expect(await sawReload(page)).toEqual({ skeleton: false, fade: false });
    // Nothing was read to draw it: the board was already in memory.
    expect(
      plane.calls.slice(mark).filter((call) => /\/(items\?|config)/.test(call)),
    ).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a big board opens one group at a time, counted by the service", async () => {
  const plane = await startStubPlane({ workspaces });
  // 300 cards, 100 a lane: To-Do is the start lane, so it reads 50; the
  // others 20.
  plane.setBoard("ws-cloud-project", bigBoard(300));
  const profile = await mkdtemp(join(tmpdir(), "lanew-big-board-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const mark = plane.calls.length;
    await switchTo(page, "Cloud project");
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const lane = (name: string) =>
      page.getByRole("region", { name: `${name} column` });
    await expect(lane("To-Do").locator("li.shadow-card")).toHaveCount(50);
    await expect(lane("In Progress").locator("li.shadow-card")).toHaveCount(20);
    await expect(lane("Done").locator("li.shadow-card")).toHaveCount(20);
    // The counts are the service's, not the page on screen.
    await expect(lane("Done").locator("header")).toContainText("100");
    await expect(page.getByRole("link", { name: /^Issues/ })).toContainText(
      "300",
    );

    const reads = plane.calls
      .slice(mark)
      .filter((call) => call.includes("/v1/boards/ws-cloud-project/items"));
    // ⚠️ One query per lane, never the whole board.
    expect(reads.every((call) => /[?&]column=/.test(call))).toBe(true);
    expect(reads.some((call) => /column=todo.*limit=50/.test(call))).toBe(true);
    expect(reads.some((call) => /column=done.*limit=20/.test(call))).toBe(true);
    expect(
      plane.calls.slice(mark).some((call) => call.includes("/stats")),
    ).toBe(true);

    await page
      .getByRole("button", { name: "Load more in In Progress" })
      .click();
    await expect(lane("In Progress").locator("li.shadow-card")).toHaveCount(40);
    await expect(
      page.getByRole("button", { name: "Load more in In Progress" }),
    ).toContainText("60 left");
    expect(
      plane.calls.some((call) =>
        /items\?.*column=processing.*cursor=/.test(call),
      ),
    ).toBe(true);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a filter is the service's, and ⌘K opens a card that is not loaded", async () => {
  const plane = await startStubPlane({ workspaces });
  const big = bigBoard(300);
  // Deep in a lane, far past its first page.
  big.cards[298] = { ...big.cards[298], tags: ["needle"] };
  plane.setBoard("ws-cloud-project", big);
  const profile = await mkdtemp(join(tmpdir(), "lanew-big-filter-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Cloud project");
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await expect(
      page.getByText("Card number 1", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Card number 299")).toHaveCount(0);

    const mark = plane.calls.length;
    await page.goto(
      "app://lanework/w/cloud-project/issues?view=board&tag=needle",
    );
    await expect(page.getByText("Card number 299")).toBeVisible();
    expect(
      plane.calls.slice(mark).some((call) => /items\?.*tag=needle/.test(call)),
    ).toBe(true);

    // ⌘K on a key no loaded card has: the card page asks the service.
    await page.goto("app://lanework/w/cloud-project/issues?view=board");
    await expect(
      page.getByText("Card number 1", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Meta+k");
    await page
      .getByPlaceholder("Jump to a card, a project, or a command…")
      .fill("FE-297");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/issues\/FE-297/);
    await expect(page.getByRole("textbox", { name: "Card title" })).toHaveValue(
      "Card number 297",
    );
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a service without stats still gets the whole board", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setStatsMissing(true);
  plane.setBoard("ws-cloud-project", bigBoard(150));
  const profile = await mkdtemp(join(tmpdir(), "lanew-old-stats-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Cloud project");
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const lane = (name: string) =>
      page.getByRole("region", { name: `${name} column` });
    // Every card, as before FE-17, and no "Load more" to press.
    await expect(lane("Done").locator("li.shadow-card")).toHaveCount(50);
    await expect(page.getByRole("button", { name: /^Load more/ })).toHaveCount(
      0,
    );
    await expect(page.getByRole("link", { name: /^Issues/ })).toContainText(
      "150",
    );
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("⌘K finds a card that is not loaded, asking the service once per pause", async () => {
  const plane = await startStubPlane({ workspaces });
  const big = bigBoard(300);
  // Far past its lane's first page, so only the service can find it.
  big.cards[289] = { ...big.cards[289], title: "Zebra migration plan" };
  plane.setBoard("ws-cloud-project", big);
  const profile = await mkdtemp(join(tmpdir(), "lanew-search-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Cloud project");
    await expect(page.getByText("Zebra migration plan")).toHaveCount(0);

    const mark = plane.calls.length;
    await page.keyboard.press("Meta+k");
    const field = page.getByPlaceholder(
      "Jump to a card, a project, or a command…",
    );
    // Typed faster than the debounce: one pause, one request.
    await field.pressSequentially("zebra mig", { delay: 30 });
    const option = page.getByRole("option", { name: /Zebra migration plan/ });
    await expect(option).toBeVisible();
    const searches = () =>
      plane.calls.slice(mark).filter((call) => /items\?q=/.test(call));
    expect(searches()).toHaveLength(1);
    expect(searches()[0]).toContain("q=zebra+mig");

    await option.click();
    await expect(page).toHaveURL(/\/issues\/BE-290/);
    await expect(page.getByRole("textbox", { name: "Card title" })).toHaveValue(
      "Zebra migration plan",
    );
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a search the service cannot answer keeps the loaded matches, and says so", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", bigBoard(3));
  plane.setSearchFailing(true);
  const profile = await mkdtemp(join(tmpdir(), "lanew-search-down-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Cloud project");
    await expect(page.getByText("Card number 2")).toBeVisible();
    await page.keyboard.press("Meta+k");
    await page
      .getByPlaceholder("Jump to a card, a project, or a command…")
      .fill("card number 2");
    await expect(page.getByText("Showing loaded cards only")).toBeVisible();
    await expect(
      page.getByRole("option", { name: /Card number 2/ }),
    ).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});
