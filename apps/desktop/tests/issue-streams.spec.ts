// The issue page's Work breakdown (BE-19): a card split into streams shows them
// wave by wave, with what each owns, waits for and has proved; its verify rows
// carry the stream they belong to; a card without streams shows nothing.
//
// ⚠️ Against the REAL app and the stub control plane. The streams ride on the
// card exactly as the API serializes them — the stub's single-card read spreads
// the card it holds, so the extra fields below reach the app unchanged — and
// the bug this guards against is the plumbing dropping them on the way.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { Project } from "../shared/projects";
import {
  launchEnv,
  removeProfile,
  type StubCard,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

const projects: Project[] = [
  {
    id: "ws-cloud-project",
    slug: "cloud-project",
    name: "Cloud project",
    path: null,
    baseBranch: null,
  },
];

/** A stream as the API serializes one. */
function stream(
  key: string,
  position: number,
  over: Partial<Record<string, unknown>> = {},
) {
  return {
    key,
    title: `Stream ${key}`,
    goal: `Goal of ${key}`,
    role: "implement",
    owns: [],
    reads: [],
    dependsOn: [],
    isolation: "worktree",
    position,
    ...over,
  };
}

function item(
  key: string,
  section: "decisions" | "verify",
  checked: boolean,
  streamKey: string | null,
) {
  return {
    key,
    section,
    text: `Item ${key}`,
    checked,
    checkedAt: checked ? "2026-09-02T00:00:00.000Z" : null,
    note: null,
    group: null,
    stream: streamKey,
  };
}

// ⚠️ Cast, not typed: `StubCard` states the fields the stub reads, and the
// stream fields are ones it only passes through.
function card(over: Record<string, unknown> & { id: string }): StubCard {
  return {
    revision: 1,
    title: "Example issue",
    body: "Body.",
    columnKey: "todo",
    categoryKey: "backend",
    taskId: null,
    priority: null,
    tags: [],
    rank: "0100",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-08T07:00:00.000Z",
    ...over,
  } as StubCard;
}

const board = {
  columns: [
    { key: "todo", name: "Todo", role: "start" },
    { key: "done", name: "Done", role: "done" },
  ],
  categories: [{ key: "backend", name: "Backend", prefix: "BE", tone: "sky" }],
  labels: [],
  members: [{ userId: "u-viewer", name: "Viewer", image: null, role: "owner" }],
  cards: [
    // No `dispatch`: the waves are computed from `dependsOn`.
    card({
      id: "c-split",
      taskId: "BE-19",
      title: "Split card",
      streams: [
        stream("W0", 0, {
          title: "Data contract",
          owns: ["packages/db/src/board/streams.ts"],
        }),
        stream("W1", 1, {
          title: "API",
          owns: ["apps/api/src/"],
          dependsOn: ["W0"],
        }),
        stream("W2", 2, {
          title: "Desktop",
          owns: ["apps/desktop/shared/projects.ts"],
          dependsOn: ["W0"],
        }),
        stream("W3", 3, {
          title: "Real-app check",
          role: "test",
          dependsOn: ["W1", "W2"],
        }),
      ],
      checklist: [
        item("D1", "decisions", true, null),
        item("V1", "verify", true, "W0"),
        item("V2", "verify", false, "W1"),
        item("V3", "verify", true, "W1"),
        item("V4", "verify", false, "W2"),
        item("V5", "verify", false, null),
      ],
    }),
    // A `dispatch` the server worked out wins over the client's own waves.
    card({
      id: "c-dispatched",
      taskId: "BE-20",
      title: "Dispatched card",
      rank: "0200",
      streams: [
        stream("W0", 0, { title: "First" }),
        stream("W1", 1, { title: "Second" }),
      ],
      dispatch: { waves: [["W1"], ["W0"]], briefs: { W0: "b0", W1: "b1" } },
      checklist: [item("V1", "verify", false, "W0")],
    }),
    card({
      id: "c-plain",
      taskId: "BE-21",
      title: "Plain card",
      rank: "0300",
      streams: [],
      checklist: [item("V1", "verify", false, null)],
    }),
  ],
};

async function openIssue(page: Page, taskId: string, title: string) {
  await page.goto(`app://lanework/w/cloud-project/issues/${taskId}`);
  await expect(page.getByLabel("Card title")).toHaveValue(title);
}

test("a card's streams render as a work breakdown, wave by wave", async () => {
  const plane = await startStubPlane({ projects });
  plane.setBoard("ws-cloud-project", board);
  const profile = await mkdtemp(join(tmpdir(), "lanew-issue-streams-"));
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
    await page.getByRole("link", { name: /Cloud project/ }).click();
    await expect(
      page.getByRole("button", {
        name: "Switch project — currently Cloud project",
      }),
    ).toBeVisible();

    await openIssue(page, "BE-19", "Split card");
    const section = page.getByRole("region", { name: "Work breakdown" });
    await expect(section).toBeVisible();
    await expect(section).toContainText("4 streams, 3 waves");

    // Waves follow `dependsOn`: W0, then W1 and W2 together, then W3.
    const wave = (n: number) =>
      section.getByRole("listitem", { name: `Wave ${n}` });
    const keysIn = (n: number) =>
      wave(n)
        .locator("[data-stream]")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-stream")),
        );
    expect(await keysIn(1)).toEqual(["W0"]);
    expect(await keysIn(2)).toEqual(["W1", "W2"]);
    expect(await keysIn(3)).toEqual(["W3"]);

    const row = (key: string) => section.locator(`[data-stream="${key}"]`);
    await expect(row("W0")).toContainText("Data contract");
    await expect(row("W0")).toContainText("Implement");
    await expect(row("W0").locator("code")).toHaveText([
      "packages/db/src/board/streams.ts",
    ]);
    await expect(row("W1").locator("code")).toHaveText(["apps/api/src/"]);
    await expect(row("W1")).toContainText("Depends on");
    await expect(row("W3")).toContainText("Test");
    await expect(row("W3")).toContainText("Nothing");
    // Progress counts ONLY verify rows tagged with the stream.
    await expect(row("W0")).toContainText("Verify 1/1");
    await expect(row("W1")).toContainText("Verify 1/2");
    await expect(row("W2")).toContainText("Verify 0/1");
    await expect(row("W3")).toContainText("Verify 0/0");

    // Sits between the checklist and what follows it.
    const verifyHeading = page.getByRole("heading", { name: "Verify" });
    const above = await verifyHeading.boundingBox();
    const box = await section.boundingBox();
    expect(above && box && above.y < box.y).toBe(true);

    // Tagged verify rows carry their stream's key; the lead's rows do not.
    const label = (key: string) =>
      page.locator("label").filter({ hasText: `Item ${key}` });
    await expect(label("V2")).toContainText("W1");
    await expect(label("V4")).toContainText("W2");
    await expect(label("V5")).not.toContainText(/W\d/);
    await expect(label("D1")).not.toContainText(/W\d/);

    // `dispatch.waves` wins: W1 first although it comes second.
    await openIssue(page, "BE-20", "Dispatched card");
    const dispatched = page.getByRole("region", { name: "Work breakdown" });
    await expect(dispatched).toContainText("2 streams, 2 waves");
    await expect(
      dispatched
        .getByRole("listitem", { name: "Wave 1" })
        .locator("[data-stream]"),
    ).toHaveAttribute("data-stream", "W1");

    // No streams, no section.
    await openIssue(page, "BE-21", "Plain card");
    await expect(page.getByRole("heading", { name: "Verify" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Work breakdown" }),
    ).toHaveCount(0);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});
