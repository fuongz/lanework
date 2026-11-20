// Run with `bun test ./electron/main/conversation/handoff.test.ts`.
//
// Threads: the in-place links (`switchAgent`) join sessions head -> newest;
// a handoff to a new conversation never does. The context block of a thread
// carries every session's turns, without the blocks they started with.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  type ConversationHandoff,
  HANDOFF_CONTEXT_CLOSE,
  HANDOFF_CONTEXT_OPEN,
  HANDOFF_MESSAGE_HEADING,
  type Turn,
} from "../../../shared/conversation";
import { buildHandoff, createHandoffStore } from "./handoff";

const dir = mkdtempSync(join(tmpdir(), "handoff-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function link(
  from: number,
  to: number,
  thread: boolean,
  agents: [
    ConversationHandoff["from"]["agent"],
    ConversationHandoff["to"]["agent"],
  ] = ["claude", "codex"],
): ConversationHandoff {
  return {
    project: "p",
    from: { conversation: id(from), agent: agents[0], model: "m-from" },
    to: { conversation: id(to), agent: agents[1], model: `m-${to}` },
    at: "2026-11-20T00:00:00.000Z",
    carried: { summary: false, turns: 1, omitted: 0, bytes: 10 },
    limit: null,
    ...(thread ? { thread: true } : {}),
  };
}

describe("thread chains", () => {
  test("chainOf, headOf and newestOf follow the in-place links only", async () => {
    const store = createHandoffStore(join(dir, "a.json"));
    await store.record(link(1, 2, true));
    await store.record(link(2, 3, true, ["codex", "claude"]));
    // A handoff to a new conversation is no thread's.
    await store.record(link(3, 9, false));

    const chain = await store.chainOf("p", id(2));
    assert.deepEqual(
      chain.map((entry) => [entry.conversation, entry.agent, entry.model]),
      [
        [id(1), "claude", "m-from"],
        [id(2), "codex", "m-2"],
        [id(3), "claude", "m-3"],
      ],
    );
    assert.equal(chain[0]?.link, null);
    assert.equal(await store.headOf(id(3)), id(1));
    assert.equal(await store.newestOf(id(1)), id(3));
    // Lone conversations are their own thread.
    assert.deepEqual(await store.chainOf("p", id(9)), []);
    assert.equal(await store.headOf(id(9)), id(9));
    assert.equal(await store.newestOf(id(9)), id(9));
    // Another project's id is in no thread there.
    assert.deepEqual(await store.chainOf("q", id(1)), []);
  });

  test("a record invalidates the cached chain", async () => {
    const store = createHandoffStore(join(dir, "b.json"));
    await store.record(link(1, 2, true));
    assert.equal(store.now.newestOf(id(1)), id(2));
    assert.equal((await store.chainOf("p", id(1))).length, 2);
    await store.record(link(2, 3, true));
    assert.equal(store.now.newestOf(id(1)), id(3));
    assert.equal(store.now.headOf(id(3)), id(1));
    assert.equal((await store.chainOf("p", id(2))).length, 3);
  });

  test("the thread flag survives a restart", async () => {
    const file = join(dir, "c.json");
    const store = createHandoffStore(file);
    await store.record(link(1, 2, true));
    await store.flushed();
    assert.equal(
      (
        JSON.parse(readFileSync(file, "utf8")) as {
          handoffs: { thread?: boolean }[];
        }
      ).handoffs[0]?.thread,
      true,
    );
    const again = createHandoffStore(file);
    // Before it is read, every id is its own thread.
    assert.equal(again.now.headOf(id(2)), id(2));
    await again.ready();
    assert.equal(again.now.headOf(id(2)), id(1));
    assert.equal((await again.chainOf("p", id(1)))[0]?.model, "m-from");
  });

  test("a cycle in the file never loops", async () => {
    const store = createHandoffStore(join(dir, "d.json"));
    await store.record(link(1, 2, true));
    await store.record(link(2, 1, true));
    // The second link points into a session already joined: not followed.
    assert.equal(await store.headOf(id(2)), id(1));
    assert.equal((await store.chainOf("p", id(1))).length, 2);
  });
});

describe("buildHandoff of a thread", () => {
  const user = (n: number, text: string, conversation: string): Turn => ({
    role: "user",
    id: `u${n}`,
    text,
    attachments: [],
    at: "2026-11-20T00:00:00.000Z",
    session: { conversation, agent: "claude", model: null },
  });

  test("carries every session's turns, not the blocks they started with", () => {
    const nested = `${HANDOFF_CONTEXT_OPEN} from="claude" conversation="${id(1)}">\nold context\n${HANDOFF_CONTEXT_CLOSE}\n\n${HANDOFF_MESSAGE_HEADING}\nsecond ask`;
    const turns: Turn[] = [
      user(1, "first ask", id(1)),
      {
        role: "handoff",
        id: `handoff:${id(2)}`,
        from: [{ conversation: id(1), agent: "claude", model: "m-from" }],
        to: { conversation: id(2), agent: "codex", model: "m-2" },
        at: "2026-11-20T00:00:00.000Z",
        carried: { summary: false, turns: 1, omitted: 0, bytes: 10 },
      },
      user(2, nested, id(2)),
    ];
    const built = buildHandoff(
      {
        agent: "codex",
        conversation: id(2),
        model: "m-2",
        turns,
        truncated: false,
        sessions: [
          { conversation: id(1), agent: "claude", model: "m-from" },
          { conversation: id(2), agent: "codex", model: "m-2" },
        ],
        thread: id(1),
      },
      "third ask",
      16_000,
    );
    assert.match(built.text, /first ask/);
    assert.match(built.text, /second ask/);
    assert.doesNotMatch(built.text, /old context/);
    assert.match(built.text, /Handed off to Codex \(m-2\)/);
    assert.match(built.text, new RegExp(`thread="${id(1)}"`));
    assert.match(built.text, /Claude \(conversation .*\), then Codex/);
    assert.equal(built.carried.turns, 3);
    // One block only: the nested one's closing tag is not carried.
    assert.equal(built.text.split(HANDOFF_CONTEXT_CLOSE).length, 2);
  });
});
