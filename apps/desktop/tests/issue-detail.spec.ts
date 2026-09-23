// The issue page as a person meets it: the thread, the history, who it is on,
// what it is labelled, and the two per-reader switches (follow, star).
//
// ⚠️ Against the REAL app and the stub control plane, not a mocked store. Every
// one of these surfaces is a round trip through preload → main → HTTP, and the
// bugs they had were in that plumbing — an argument count, a field read as
// `false` when it was absent — none of which a component test can see.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { Workspace } from "../shared/workspaces";
import {
  launchEnv,
  removeProfile,
  type StubCard,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

const workspaces: Workspace[] = [
  {
    id: "ws-cloud-project",
    slug: "cloud-project",
    name: "Cloud project",
    path: null,
    baseBranch: null,
  },
];

const COLUMNS = [
  { key: "todo", name: "Todo", role: "start" },
  { key: "processing", name: "In Progress", role: "active" },
  { key: "done", name: "Done", role: "done" },
];

const MEMBERS = [
  { userId: "u-viewer", name: "Viewer", image: null, role: "owner" },
  { userId: "u-decio", name: "Decio", image: null, role: "member" },
];

const LABELS = [
  { key: "bug", name: "Bug", tone: "rose" },
  { key: "feature", name: "Feature", tone: "violet" },
  { key: "improvement", name: "Improvement", tone: "blue" },
];

function card(over: Partial<StubCard> & { id: string }): StubCard {
  return {
    revision: 1,
    title: "Example issue",
    body: "This is an example of an issue's description.",
    columnKey: "todo",
    categoryKey: "frontend",
    taskId: null,
    priority: null,
    tags: [],
    rank: "0100",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-08T07:00:00.000Z",
    ...over,
  };
}

const board = {
  columns: COLUMNS,
  categories: [
    { key: "frontend", name: "Frontend", prefix: "FE", tone: "sky" },
  ],
  labels: LABELS,
  members: MEMBERS,
  cards: [
    card({
      id: "c-parent",
      taskId: "FE-11",
      tags: ["bug"],
      attachments: [
        {
          id: "a-1",
          name: "Example.pdf",
          reference: "docs/Example.pdf",
          mimeType: "application/pdf",
          sizeBytes: 5_360_517,
        },
      ],
      comments: [
        {
          id: "c-1",
          authorUserId: "u-viewer",
          body: "Starting on this.",
          at: "2026-09-02T00:00:00.000Z",
        },
      ],
      subscribers: ["u-viewer"],
    }),
    card({
      id: "c-kid-1",
      taskId: "FE-12",
      title: "Example sub-issue",
      parentId: "c-parent",
      columnKey: "done",
      tags: ["bug"],
      priority: "high",
      rank: "0200",
    }),
    card({
      id: "c-kid-2",
      taskId: "FE-13",
      title: "Second sub-issue",
      parentId: "c-parent",
      columnKey: "todo",
      tags: ["feature", "improvement"],
      rank: "0300",
    }),
  ],
};

/** Open the card the tests are about, cold, by the id a person would say. */
async function openIssue(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // ⚠️ Choose the project FIRST. With nothing remembered the app asks rather
  // than guessing, and a `goto` into a workspace route before that is aborted
  // by the redirect back to the picker.
  await page.getByRole("link", { name: /Cloud project/ }).click();
  await expect(
    page.getByRole("button", {
      name: "Switch project — currently Cloud project",
    }),
  ).toBeVisible();
  await page.goto("app://lanework/w/cloud-project/issues/FE-11");
  await expect(page.getByLabel("Card title")).toHaveValue("Example issue");
  return errors;
}

test("the issue page carries the card's labels, people, files and sub-issues", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", board);
  const profile = await mkdtemp(join(tmpdir(), "lanew-issue-detail-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const errors = await openIssue(page);

    // The breadcrumb names the project and the card, in that order.
    await expect(
      page.getByRole("link", { name: "Cloud project" }),
    ).toBeVisible();
    await expect(page.getByText("FE-11").first()).toBeVisible();

    // ⚠️ The label's NAME, not its tag. The vocabulary is what gives `bug` a
    // display name and a colour, and a chip showing the raw key would mean the
    // board config never reached the page.
    await expect(page.getByText("Bug").first()).toBeVisible();

    // A file is metadata and a reference — its size is the part a person reads.
    await expect(page.getByText("Example.pdf")).toBeVisible();
    await expect(page.getByText(/5\.11 MB/)).toBeVisible();

    // Sub-issues, with the fraction counted off the lane ROLES rather than a
    // lane called "Done".
    await expect(
      page.getByRole("button", { name: "Sub-issues" }),
    ).toBeVisible();
    await expect(page.getByText("1/2")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Example sub-issue/ }),
    ).toBeVisible();

    // The history and the thread arrive as ONE sequence.
    await expect(page.getByText(/created the issue/)).toBeVisible();
    await expect(page.getByText("Starting on this.")).toBeVisible();

    expect(errors).toEqual([]);
    await page.screenshot({
      path: "../../.agents/artifacts/2026-09-14-issue-detail.png",
      fullPage: true,
      // Native macOS vibrancy is outside the renderer capture; flatten only the
      // screenshot so the theme is reviewable against its backdrop.
      style: "html { background: var(--background) !important; }",
    });
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("a comment can be written, reworded and retracted, and the thread keeps the gap", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", board);
  const profile = await mkdtemp(join(tmpdir(), "lanew-issue-comment-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const errors = await openIssue(page);

    // ⚠️ Scoped to the rendered thread. A bare `getByText` also matches the
    // editor's own `.cm-line`, so the composer holding the same words would
    // satisfy an assertion meant to prove the comment came back from the board.
    const posted = (text: string) =>
      page.getByRole("paragraph").filter({ hasText: text });

    const composer = page.getByRole("textbox", { name: "Leave a comment" });
    await composer.click();
    await page.keyboard.type("Looks right to me.");
    // ⚠️ `exact`, because "Comment actions" — the per-comment `…` menu — is a
    // prefix match for this name and there is one of those per comment already.
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    // ⚠️ Read back from the SERVICE, not spliced in locally. The composer is
    // deliberately not optimistic — the server stamps the moment and orders the
    // comment against the audit log — so this appearing proves the round trip.
    await expect(posted("Looks right to me.").first()).toBeVisible();
    // And the box empties, so the next reply does not start with the last one.
    // ⚠️ Asserted on the BUTTON going back to disabled rather than on the box
    // being textless: an empty CodeMirror renders its placeholder as real text,
    // so `toHaveText("")` fails on a composer that did clear.
    await expect(
      page.getByRole("button", { name: "Comment", exact: true }),
    ).toBeDisabled();
    await expect
      .poll(() =>
        plane
          .readCard("ws-cloud-project", "c-parent")
          ?.comments?.map((entry) => entry.body),
      )
      .toContain("Looks right to me.");

    // Reword it: the thread says it was edited.
    await page.getByRole("button", { name: "Comment actions" }).last().click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const editor = page.getByRole("textbox", { name: "Edit comment" });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Looks right to me, shipping it.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      posted("Looks right to me, shipping it.").first(),
    ).toBeVisible();
    await expect(page.getByText("(edited)")).toBeVisible();

    // Retract it: a tombstone, not a hole. The thread still reads as one.
    await page.getByRole("button", { name: "Comment actions" }).last().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(page.getByText(/deleted a comment/)).toBeVisible();
    await expect(posted("Looks right to me, shipping it.")).toHaveCount(0);
    // The one that was there first is untouched — this is what a tombstone buys.
    await expect(posted("Starting on this.").first()).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("following, starring, assigning and labelling all reach the board", async () => {
  const plane = await startStubPlane({ workspaces });
  plane.setBoard("ws-cloud-project", board);
  const profile = await mkdtemp(join(tmpdir(), "lanew-issue-props-"));
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const errors = await openIssue(page);
    const read = () => plane.readCard("ws-cloud-project", "c-parent");

    // ⚠️ "Unsubscribe" because the card already has a follower, which is what
    // the service's auto-subscribe produces. A page that read an absent field
    // as `false` would say "Subscribe" here and unfollow on the first click.
    const follow = page.getByRole("button", { name: "Unsubscribe" });
    await expect(follow).toBeVisible();
    await follow.click();
    await expect(page.getByRole("button", { name: "Subscribe" })).toBeVisible();
    await expect.poll(() => read()?.subscribers).toEqual([]);

    // The star is this reader's alone, and it is a `PUT`, not a toggle.
    const star = page.getByRole("button", { name: "Add to favorites" });
    await star.click();
    await expect(
      page.getByRole("button", { name: "Remove from favorites" }),
    ).toBeVisible();
    await expect.poll(() => read()?.favorite).toBe(true);

    // Assign somebody: the rail names them, and the board records BOTH lists.
    await page.getByRole("button", { name: /Unassigned/ }).click();
    await page.getByRole("menuitem", { name: "Decio" }).click();
    await page.keyboard.press("Escape");
    await expect
      .poll(() => read()?.assignees)
      .toEqual({
        users: ["u-decio"],
        agents: [],
      });
    await expect(page.getByRole("button", { name: /Decio/ })).toBeVisible();

    // Add a label from the board's own vocabulary.
    await page.getByRole("button", { name: "Add label" }).click();
    await page.getByRole("menuitem", { name: "Feature" }).click();
    await page.keyboard.press("Escape");
    await expect.poll(() => read()?.tags).toEqual(["bug", "feature"]);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});
