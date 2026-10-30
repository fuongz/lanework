// Whether a card may be handed to an agent as it is, and what approving its
// recommendations would tick (FE-34) — the pure part, under plain Node.
import { expect, test } from "@playwright/test";
import type { BoardChecklistItem } from "../shared/projects";
import { checklistGate } from "../src/lib/checklist-gate";

function box(
  key: string,
  text: string,
  fields: Partial<BoardChecklistItem> = {},
): BoardChecklistItem {
  return {
    key,
    section: "decisions",
    text,
    checked: false,
    checkedAt: null,
    note: null,
    group: null,
    ...fields,
  };
}

test("FE-34: open decisions are approved as recommended — the marked option of each group, every lone decision", () => {
  const gate = checklistGate([
    // Marked at the start, the way the MCP's review flow writes it.
    box("D1a", "(Recommended) A button in the header", { group: "entry" }),
    box("D1b", "A row in the Assignee field", { group: "entry" }),
    box("D2", "Write the agent on the card"),
    // Marked at the end, the old markdown cards' way, and in any case.
    box("D3a", "The app ticks", { group: "approver" }),
    box("D3b", "The agent ticks *(RECOMMENDED)*", { group: "approver" }),
    // Settled already: nothing to approve.
    box("D4", "Open the session", { checked: true }),
    box("D5a", "(Recommended) Keep the user's flags", {
      group: "perms",
    }),
    box("D5b", "Add our own", { group: "perms", checked: true }),
    // Verify boxes never gate.
    box("V1", "typecheck", { section: "verify" }),
  ]);
  expect(gate.ready).toBe(false);
  expect(gate.blocked).toEqual([]);
  expect(gate.picks.map((pick) => pick.key)).toEqual(["D1a", "D2", "D3b"]);
  expect(gate.picks[0]).toEqual({
    key: "D1a",
    text: "(Recommended) A button in the header",
    group: "entry",
  });
});

test("FE-34: a group with no single recommendation is the person's to pick", () => {
  const none = checklistGate([
    box("D1a", "One way", { group: "entry" }),
    box("D1b", "Another", { group: "entry" }),
    box("D2", "(Recommended) Lone"),
  ]);
  expect(none.ready).toBe(false);
  expect(none.blocked).toEqual(["entry"]);
  // A lone decision is still listed — the dialog says what else is open.
  expect(none.picks.map((pick) => pick.key)).toEqual(["D2"]);

  // Two options both marked is a card contradicting itself, not a choice.
  const both = checklistGate([
    box("D1a", "(Recommended) One way", { group: "entry" }),
    box("D1b", "(Recommended) Another", { group: "entry" }),
  ]);
  expect(both.blocked).toEqual(["entry"]);
  expect(both.picks).toEqual([]);
});

test("FE-34: a group is one choice wherever its options sit", () => {
  const gate = checklistGate([
    box("D1a", "One way", { group: "entry" }),
    box("D2", "Between them", { checked: true }),
    box("D1b", "(Recommended) Another", { group: "entry" }),
  ]);
  expect(gate.picks.map((pick) => pick.key)).toEqual(["D1b"]);
  expect(gate.blocked).toEqual([]);
});

test("FE-34: a card whose decisions are settled — or that has none — is ready as it is", () => {
  const settled = checklistGate([
    box("D1a", "(Recommended) One", { group: "entry" }),
    box("D1b", "Two", { group: "entry", checked: true }),
    box("D2", "Lone", { checked: true }),
    box("V1", "typecheck", { section: "verify" }),
  ]);
  expect(settled).toEqual({ ready: true, picks: [], blocked: [] });

  expect(
    checklistGate([box("V1", "typecheck", { section: "verify" })]),
  ).toEqual({ ready: true, picks: [], blocked: [] });
  expect(checklistGate([])).toEqual({ ready: true, picks: [], blocked: [] });
});
