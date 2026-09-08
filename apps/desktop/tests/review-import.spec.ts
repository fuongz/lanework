// The gate on the ported reader — the one that catches a drift from the board.
//
// ⚠️ Two halves, and both are needed. The first runs the reader over THIS
// repo's own `.agents/reviews/**`: real cards, written by the Lanework board
// itself, so a rule this port got wrong shows up as a real card read wrongly
// rather than as a fixture disagreeing with a fixture. The second states the
// rules that live data does not currently exercise — a fenced checkbox, a
// quoted one, a `> note`, `*(dropped)*`, a wrapped item — because those are the
// exact cases four disagreeing regexes got wrong in the board's own history.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  buildReviewFileCard,
  parseCardItems,
} from "../electron/main/workspaces/review-card";
import {
  contentSha,
  DEFAULT_CATEGORIES,
  DEFAULT_COLUMNS,
  parseTaskSeq,
  planMigration,
} from "../electron/main/workspaces/review-import";
import {
  canonicalStatus,
  resolveCardLocation,
} from "../electron/main/workspaces/review-location";
import { scanTaskBlocks } from "../electron/main/workspaces/review-scan";

/** The repo this test file lives in — `apps/desktop` is the cwd. */
const REPO = join(process.cwd(), "..", "..");

test("this repo's own cards read as import records", async () => {
  const plan = await planMigration(REPO);
  const columns = new Set<string>(DEFAULT_COLUMNS.map((column) => column.key));

  // Not an exact count: cards get added. What must hold is that they all read.
  expect(plan.inventory.cards).toBeGreaterThan(9);
  expect(plan.blocked).toBeNull();
  expect(plan.inventory.problems).toEqual([]);
  expect(plan.records).toHaveLength(plan.inventory.cards);

  for (const record of plan.records) {
    expect(record.title.trim()).not.toBe("");
    expect(columns.has(record.columnKey)).toBe(true);
    // ⚠️ The ref is what the cloud keys on, and it has to be the same string
    // the CLI sends: repo-relative, forward slashes, no leading "./".
    expect(record.source.ref).toMatch(/^\.agents\/reviews\/.+\.md$/);
    expect(record.source.checksum).toMatch(/^[0-9a-f]{12}$/);
    expect(record.source.kind).toBe("local-review");
    // The body travels verbatim — the file is the card's own text.
    expect(record.body.startsWith("---")).toBe(true);
    expect(record.metadata).toMatchObject({
      import: { tool: "lanework-desktop", reviewPath: record.source.ref },
    });

    for (const row of record.restore.checklist) {
      // A row the cloud cannot address is a row nobody can ever tick off.
      expect(row.key).not.toBe("");
      expect(["decisions", "verify"]).toContain(row.section);
      expect(row.text.trim()).not.toBe("");
      // ⚠️ A checked row always carries WHEN, because the cloud derives
      // `checked` from `checkedAt`. A `checked: true` with no moment would read
      // back as unticked.
      if (row.checked) expect(row.checkedAt).toBeTruthy();
    }

    // ⚠️ The "How to review" task list at the top of every card is NOT part of
    // its checklist. Importing it would put three instructions about the file
    // format into every card on the board.
    for (const row of record.restore.checklist)
      expect(row.text).not.toMatch(/flip `- \[ \]`|How to review/i);

    if (record.restore.taskId) {
      const category = DEFAULT_CATEGORIES.find(
        (entry) => entry.key === record.categoryKey,
      );
      if (category)
        expect(record.restore.taskSeq).toBe(
          Number(record.restore.taskId.split("-")[1]),
        );
    }
  }

  // Both sections are really being read, not just the first.
  const sections = new Set(
    plan.records.flatMap((record) =>
      record.restore.checklist.map((row) => row.section),
    ),
  );
  expect([...sections].sort()).toEqual(["decisions", "verify"]);

  // ⚠️ Order IS the rank: the API appends each card to the bottom of its lane,
  // so records must arrive grouped by lane, oldest first.
  const lanes = plan.records.map((record) => record.columnKey);
  expect([...lanes].sort()).toEqual(lanes);
});

test("the checklist rules the board learned the hard way", () => {
  const md = [
    "---",
    "schema: 1",
    "status: todo",
    "task_id: FE-09",
    "category: frontend",
    "---",
    "",
    "# Review: A card about checklists",
    "",
    "**How to review:** flip `- [ ]` for each item you agree with.",
    "",
    "- [ ] This preamble item is not part of the checklist",
    "",
    "## Decisions",
    "",
    "- [x] **D1.** A ticked decision",
    "  wrapped onto a second line",
    "> the reviewer disagreed",
    "> on two lines",
    "- [ ] **D2.** Not done yet *(dropped)*",
    "- [x] **D3.** Ticked AND dropped, which contradicts itself *(dropped)*",
    "- Pick ONE:",
    "  - [ ] **D4a.** First option *(recommended)*",
    "  - [x] **D4b.** Second option",
    "- [ ] **D5.** Back at the outer level, so not in the group",
    "",
    "```md",
    "- [ ] A checkbox inside a fence is code, not an item",
    "```",
    "",
    "> - [ ] A quoted checkbox belongs to the note, not the checklist",
    "",
    "## Verify",
    "",
    "- [ ] **V1.** One thing to check",
    "",
  ].join("\n");

  const items = parseCardItems(md);
  expect(items.map((item) => item.id)).toEqual([
    "D1",
    "D2",
    "D3",
    "D4a",
    "D4b",
    "D5",
    "V1",
  ]);

  const byId = new Map(items.map((item) => [item.id, item]));
  // A wrapped item keeps its continuation line, with the indent peeled off.
  expect(byId.get("D1")?.text).toBe(
    "A ticked decision\nwrapped onto a second line",
  );
  // ⚠️ `> note` lines belong to the item above them. Reading bare task lines
  // instead of blocks dropped every one of these silently.
  expect(byId.get("D1")?.note).toBe("the reviewer disagreed\non two lines");
  // The markers are peeled from the text, and reported as flags instead.
  expect(byId.get("D2")).toMatchObject({
    text: "Not done yet",
    dropped: true,
    checked: false,
  });
  // ⚠️ A file hand-edited to `- [x] … *(dropped)*` reads back UNCHECKED rather
  // than propagating the contradiction.
  expect(byId.get("D3")).toMatchObject({ dropped: true, checked: false });
  expect(byId.get("D4a")).toMatchObject({
    text: "First option",
    recommended: true,
    group: "g1",
  });
  expect(byId.get("D4b")?.group).toBe("g1");
  // A follow-up at the outer level is not one of the options.
  expect(byId.get("D5")?.group).toBeNull();
  expect(byId.get("V1")?.section).toBe("verify");

  // The fenced and quoted checkboxes are not items at all.
  expect(items.some((item) => item.text.includes("inside a fence"))).toBe(
    false,
  );
  expect(items.some((item) => item.text.includes("quoted checkbox"))).toBe(
    false,
  );
  // …and the scanner agrees when asked directly, which is what the board's
  // renderer relies on.
  expect(
    scanTaskBlocks(md).some((block) =>
      block.task.content.includes("inside a fence"),
    ),
  ).toBe(false);
});

test("a card's fields come from its front matter, and its title from the heading", () => {
  const card = buildReviewFileCard({
    path: ".agents/reviews/2026-09-08/07-a-card.md",
    fileName: "07-a-card.md",
    folderDate: "2026-09-08",
    column: "processing",
    markdown: [
      "---",
      "schema: 1",
      'status: "processing"',
      "task_id: BE-07",
      "category: backend",
      "priority: HIGH",
      'tags: ["cloud", "chiến dịch"]',
      'assignees: ["pp"]',
      'agent_assignee: ["codex"]',
      "created_at: 2026-09-05 00:00:00Z",
      "handoff_from: someone",
      "---",
      "",
      "# Review: Tên tiếng Việt của card",
      "",
      "## Decisions",
      "",
      "- [ ] **D1.** One decision",
      "",
    ].join("\n"),
    updatedAt: "2026-09-08T10:00:00.000Z",
    sha: "abc123abc123",
  });

  expect(card).toMatchObject({
    column: "processing",
    // ⚠️ The heading, not the filename: the filename is a slug and a Vietnamese
    // title cannot survive one.
    title: "Tên tiếng Việt của card",
    taskId: "BE-07",
    category: "backend",
    priority: "high",
    // Not slugified — a Vietnamese tag stays a tag.
    tags: ["cloud", "chiến dịch"],
    assignees: ["pp"],
    agentAssignee: ["codex"],
    // `created_at` wins over the folder, as the board's own reader has it.
    date: "2026-09-05",
    ordinal: 7,
    structured: true,
  });
  // Front-matter keys that are not card fields travel as metadata.
  expect(card.custom).toEqual({ handoff_from: "someone" });
});

test("a card written before the document schema keeps its notes", () => {
  const md = [
    "---",
    "status: done",
    "---",
    "",
    "# An old card",
    "",
    "- [x] First thing",
    "> a note that must not be lost",
    "- [ ] Second thing",
    "",
  ].join("\n");
  const card = buildReviewFileCard({
    path: ".agents/reviews/done/old.md",
    fileName: "old.md",
    folderDate: null,
    column: "done",
    markdown: md,
    updatedAt: null,
    sha: contentSha(md),
  });

  expect(card.structured).toBe(false);
  // ⚠️ Positional ids, because this card never had any — and the note survives,
  // which is the whole reason the legacy path reads blocks.
  expect(card.items).toEqual([
    expect.objectContaining({
      id: "D1",
      checked: true,
      note: "a note that must not be lost",
    }),
    expect.objectContaining({ id: "D2", checked: false, note: null }),
  ]);
});

test("a task id travels with the sequence its category encodes", () => {
  const backend = DEFAULT_CATEGORIES.find((entry) => entry.key === "backend");
  if (!backend) throw new Error("the default categories lost backend");
  expect(parseTaskSeq("BE-04", backend)).toBe(4);
  expect(parseTaskSeq("BE-0004", backend)).toBe(4);
  // ⚠️ Null rather than a guess when the id does not belong to the category:
  // an id restored under the wrong sequence makes the NEXT card minted on that
  // board a duplicate of one that already exists.
  expect(parseTaskSeq("FE-04", backend)).toBeNull();
  expect(parseTaskSeq("BE-", backend)).toBeNull();
  expect(parseTaskSeq("BE-abc", backend)).toBeNull();
});

test("a file this app cannot read is reported, not skipped", async () => {
  const plan = await planMigration(join(REPO, "does-not-exist"));
  expect(plan.inventory.cards).toBe(0);
  expect(plan.records).toEqual([]);
  expect(plan.blocked).toBeNull();
});

test("the file's own bytes decide the checksum", async () => {
  const file = join(
    REPO,
    ".agents",
    "reviews",
    "2026-09-08",
    "06-desktop-cloud-workspace-board-v-migration-entry.md",
  );
  const markdown = await readFile(file, "utf8");
  const plan = await planMigration(REPO);
  const record = plan.records.find(
    (entry) =>
      entry.source.ref ===
      ".agents/reviews/2026-09-08/06-desktop-cloud-workspace-board-v-migration-entry.md",
  );
  expect(record?.source.checksum).toBe(contentSha(markdown));
  // sha1, first 12 hex — the board's `contentSha`, so a later reconciliation
  // compares like with like.
  expect(contentSha("hello")).toBe("aaf4c61ddcc5");
});

test("what counts as a card is the board's rule, not this app's", () => {
  // ⚠️ WIDER than "has front matter", and that width is the point: a file in a
  // date folder is a card in the fallback lane even with no `status:` at all.
  // A reader that skipped one would leave it behind at the cutover — shown on
  // the board before, absent from the cloud after, nothing reporting a loss.
  expect(resolveCardLocation(["2026-09-08", "01-a.md"], null)).toEqual({
    column: "todo",
    fileName: "01-a.md",
    folderDate: "2026-09-08",
  });
  // A declared status wins over the folder it sits in.
  expect(resolveCardLocation(["2026-09-08", "01-a.md"], "done")?.column).toBe(
    "done",
  );
  // A lane FOLDER is a lane too, and a lane's display name resolves like its key.
  expect(resolveCardLocation(["done", "a.md"], null)?.column).toBe("done");
  expect(resolveCardLocation(["a.md"], "Archived")?.column).toBe("dropped");
  // Loose markdown at the review root is not surfaced.
  expect(resolveCardLocation(["README.md"], null)).toBeNull();
  expect(resolveCardLocation(["notes", "thoughts.md"], null)).toBeNull();
  // An unrecognised status is not a lane; the file has to qualify another way.
  expect(resolveCardLocation(["a.md"], "blocked")).toBeNull();
  expect(canonicalStatus("IN PROGRESS")).toBe("processing");
  expect(canonicalStatus("nonsense")).toBeNull();
});
