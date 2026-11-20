// Run with `bun test ./electron/main/terminal/thread-rail.test.ts`.
//
// One rail row per thread: a successor is hidden, and the head takes the
// newest session's activity.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentSession } from "../../../shared/terminal";
import { foldThreads, type RailThreadSession } from "./thread-rail";

function row(
  id: string,
  updatedAt: string,
  extra: Partial<AgentSession> = {},
): AgentSession {
  return {
    id,
    agent: "claude",
    title: `title ${id}`,
    cliTitle: `title ${id}`,
    updatedAt,
    pinnedAt: null,
    conductor: null,
    working: false,
    card: null,
    subagents: [],
    background: { running: 0, total: 0 },
    ...extra,
  };
}

const chain: RailThreadSession[] = [
  { conversation: "head", agent: "claude" },
  { conversation: "mid", agent: "codex" },
  { conversation: "new", agent: "claude" },
];
const threads = {
  chainOf: (id: string) =>
    chain.some((entry) => entry.conversation === id) ? chain : [],
};

describe("foldThreads", () => {
  test("hides successors and gives the head the newest's activity", () => {
    const listed = [
      row("new", "2026-11-20T03:00:00.000Z", {
        agent: "claude",
        working: true,
        background: { running: 1, total: 2 },
      }),
      row("lone", "2026-11-20T02:30:00.000Z"),
      row("mid", "2026-11-20T02:00:00.000Z", { agent: "codex" }),
      row("head", "2026-11-20T01:00:00.000Z", { pinnedAt: 5 }),
    ];
    const out = foldThreads(listed, threads, () => null);
    assert.deepEqual(
      out.map((entry) => entry.id),
      ["head", "lone"],
    );
    const head = out[0] as AgentSession;
    assert.equal(head.title, "title head");
    assert.equal(head.pinnedAt, 5);
    // Every agent it ran on, each once, oldest first; a lone row has none.
    assert.deepEqual(head.agents, ["claude", "codex"]);
    assert.equal((out[1] as AgentSession).agents, undefined);
    assert.equal(head.updatedAt, "2026-11-20T03:00:00.000Z");
    assert.equal(head.working, true);
    assert.deepEqual(head.background, { running: 1, total: 2 });
  });

  test("a head older than the listing is read from the store", () => {
    const listed = [row("new", "2026-11-20T03:00:00.000Z", { working: true })];
    const out = foldThreads(listed, threads, (_agent, id) =>
      id === "head" ? row("head", "2026-01-01T00:00:00.000Z") : null,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.id, "head");
    assert.equal(out[0]?.working, true);
  });

  test("without threads, the listing is as it was", () => {
    const listed = [row("a", "2026-11-20T03:00:00.000Z")];
    assert.deepEqual(
      foldThreads(listed, null, () => null),
      listed,
    );
  });
});
