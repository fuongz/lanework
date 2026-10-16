// Run with `bun test apps/desktop/electron/main/conversation`. The chat's
// transcript parser (FE-62) against a fake home folder: user turns, text and
// folded tool groups across lines, attachments, usage per turn, an open turn.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { AssistantTurn, UserTurn } from "../../../shared/conversation";
import { claudeProjectDir } from "../terminal/agent-sessions";
import { readConversation } from "./transcript";

const home = mkdtempSync(join(tmpdir(), "lanework-fe62-"));
const folder = "/Users/someone/project";
const ID = "11111111-2222-4333-8444-555555555555";
after(() => rmSync(home, { recursive: true, force: true }));

let clock = Date.parse("2026-10-16T10:00:00.000Z");
const at = (seconds = 1) => {
  clock += seconds * 1000;
  return new Date(clock).toISOString();
};
let n = 0;
const base = () => ({
  uuid: `u-${++n}`,
  sessionId: ID,
  cwd: folder,
  gitBranch: "main",
  isSidechain: false,
});
const user = (content: unknown, extra: object = {}) => ({
  ...base(),
  type: "user",
  timestamp: at(),
  message: { role: "user", content },
  ...extra,
});
const usage = (input: number, output: number, read: number, create = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: create,
});
const assistant = (
  id: string,
  content: unknown[],
  use: object,
  stop: string | null = null,
  seconds = 1,
) => ({
  ...base(),
  type: "assistant",
  timestamp: at(seconds),
  message: {
    id,
    model: "claude-haiku-5-5",
    role: "assistant",
    content,
    stop_reason: stop,
    usage: use,
  },
});

function write(rows: object[]): void {
  const dir = join(home, ".claude", "projects", claudeProjectDir(folder));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${ID}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

describe("readConversation", () => {
  test("turns, folded tools, attachments, usage, open turn", async () => {
    const rows = [
      { type: "queue-operation", operation: "enqueue", timestamp: at() },
      user("Fix the bug in app.ts"),
      { ...base(), type: "attachment", timestamp: at(), attachment: {} },
      assistant(
        "msg_A",
        [{ type: "thinking", thinking: "" }],
        usage(10, 5, 1000, 90),
      ),
      assistant(
        "msg_A",
        [{ type: "text", text: "Let me look." }],
        usage(10, 5, 1000, 90),
      ),
      assistant(
        "msg_A",
        [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: `${folder}/src/app.ts` },
          },
        ],
        usage(10, 40, 1000, 90),
        "tool_use",
      ),
      user([
        { type: "tool_result", tool_use_id: "toolu_1", content: "line 1" },
      ]),
      // A second call from the next message joins the same group.
      assistant(
        "msg_B",
        [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Bash",
            input: { command: "bun test\necho done" },
          },
        ],
        usage(5, 20, 1100),
        "tool_use",
      ),
      user([
        {
          type: "tool_result",
          tool_use_id: "toolu_2",
          content: [{ type: "text", text: "1 failed" }],
          is_error: true,
        },
      ]),
      assistant(
        "msg_C",
        [{ type: "text", text: "Found it." }],
        usage(5, 10, 1200),
      ),
      assistant(
        "msg_C",
        [
          {
            type: "tool_use",
            id: "toolu_3",
            name: "Edit",
            input: {
              file_path: `${folder}/src/app.ts`,
              old_string: "a",
              new_string: "b",
            },
          },
          {
            type: "tool_use",
            id: "toolu_4",
            name: "mcp__lanework__get_review",
            input: { board_id: "b", card: "FE-62" },
          },
        ],
        usage(5, 30, 1200),
        "tool_use",
      ),
      user([
        { type: "tool_result", tool_use_id: "toolu_3", content: "ok" },
        { type: "tool_result", tool_use_id: "toolu_4", content: "{}" },
      ]),
      assistant(
        "msg_D",
        [{ type: "text", text: "Fixed." }],
        usage(5, 8, 1300),
        "end_turn",
      ),
      { ...base(), type: "system", subtype: "turn_duration", timestamp: at() },
      // A pasted image and a dropped file.
      user([
        { type: "text", text: "What is this?" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAAA" },
        },
        { type: "text", text: "[Image: source: /tmp/shot.png]" },
      ]),
      assistant(
        "msg_E",
        [{ type: "text", text: "A screenshot." }],
        usage(5, 4, 0, 50),
        "end_turn",
      ),
      { ...base(), type: "system", subtype: "turn_duration", timestamp: at() },
      // A local command: never a turn.
      user("<local-command-caveat>Caveat</local-command-caveat>", {
        isMeta: true,
      }),
      user(
        "<command-name>/model</command-name><command-args>haiku</command-args>",
      ),
      user("<local-command-stdout>Set model to haiku</local-command-stdout>"),
      // A slash command that reaches the model is a turn.
      user(
        "<command-name>/review</command-name><command-args>12</command-args>",
      ),
      assistant(
        "msg_F",
        [{ type: "text", text: "Reviewing." }],
        usage(1, 1, 0),
        "end_turn",
      ),
      { ...base(), type: "system", subtype: "turn_duration", timestamp: at() },
      user("[Request interrupted by user]"),
      user("Spawn a helper"),
      assistant(
        "msg_G",
        [
          {
            type: "tool_use",
            id: "toolu_5",
            name: "Agent",
            input: { description: "Look around", prompt: "…" },
          },
        ],
        usage(1, 2, 0),
        "tool_use",
      ),
      {
        ...base(),
        type: "progress",
        timestamp: at(),
        parentToolUseID: "toolu_5",
        data: { type: "agent_progress", agentId: "a1b2c3" },
      },
    ];
    // Fresh: the transcript was written just now.
    clock = Date.now() - 60_000;
    write(rows);
    const read = await readConversation(home, folder, ID);
    assert.equal(read.id, ID);
    assert.equal(read.cwd, folder);
    assert.equal(read.branch, "main");
    assert.equal(read.truncated, false);
    assert.equal(read.working, true);
    assert.deepEqual(
      read.turns.map((turn) => turn.role),
      [
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
      ],
    );

    const [prompt, first, image, , review, , spawn, open] = read.turns as [
      UserTurn,
      AssistantTurn,
      UserTurn,
      AssistantTurn,
      UserTurn,
      AssistantTurn,
      UserTurn,
      AssistantTurn,
    ];
    assert.equal(prompt.text, "Fix the bug in app.ts");
    assert.equal(review.text, "/review 12");
    assert.equal(spawn.text, "Spawn a helper");

    // text · tools(Read, Bash) · text · tools(Edit, mcp) · text
    assert.deepEqual(
      first.blocks.map((block) =>
        block.type === "tools"
          ? block.calls.map((call) => call.tool)
          : block.type,
      ),
      [
        "text",
        ["Read", "Bash"],
        "text",
        ["Edit", "mcp__lanework__get_review"],
        "text",
      ],
    );
    const tools = first.blocks.filter((block) => block.type === "tools");
    const [read1, bash] = tools[0]?.type === "tools" ? tools[0].calls : [];
    assert.equal(read1?.kind, "read");
    assert.equal(read1?.summary, "src/app.ts");
    assert.equal(read1?.filePath, `${folder}/src/app.ts`);
    assert.equal(read1?.output, "line 1");
    assert.equal(bash?.kind, "command");
    assert.equal(bash?.summary, "bun test");
    assert.equal(bash?.error, true);
    assert.equal(bash?.output, "1 failed");
    const [edit, mcp] = tools[1]?.type === "tools" ? tools[1].calls : [];
    assert.equal(edit?.kind, "edit");
    assert.equal(mcp?.kind, "mcp");
    assert.equal(first.model, "claude-haiku-5-5");
    assert.equal(first.open, false);
    assert.ok(first.endedAt);

    // Usage: msg_A counted once (its last line), then B, C (once), D.
    assert.deepEqual(
      {
        input: first.usage?.input,
        output: first.usage?.output,
        cached: first.usage?.cached,
      },
      {
        input: 100 + 5 + 5 + 5,
        output: 40 + 20 + 30 + 8,
        cached: 1000 + 1100 + 1200 + 1300,
      },
    );
    const hit = first.usage?.cacheHitPct ?? 0;
    assert.ok(Math.abs(hit - (4600 / (4600 + 115)) * 100) < 1e-9);
    assert.ok((first.usage?.tokPerSec ?? 0) > 0);

    assert.equal(image.text, "What is this?");
    assert.deepEqual(image.attachments, [
      { name: "shot.png", mediaType: "image/png", path: "/tmp/shot.png" },
    ]);

    // The open turn: still being written, its sub-agent named by progress.
    assert.equal(open.open, true);
    assert.equal(open.endedAt, null);
    const call =
      open.blocks[0]?.type === "tools" ? open.blocks[0].calls[0] : null;
    assert.equal(call?.kind, "agent");
    assert.equal(call?.subagent, "a1b2c3");
    assert.equal(call?.output, null);
  });

  test("a long transcript keeps its end", async () => {
    clock = Date.parse("2026-01-01T00:00:00.000Z");
    const rows: object[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(user(`prompt ${i} ${"x".repeat(200)}`));
      rows.push(
        assistant(
          `m${i}`,
          [{ type: "text", text: `answer ${i}` }],
          usage(1, 1, 0),
          "end_turn",
        ),
      );
      rows.push({
        ...base(),
        type: "system",
        subtype: "turn_duration",
        timestamp: at(),
      });
    }
    write(rows);
    const read = await readConversation(home, folder, ID, 4 * 1024);
    assert.equal(read.truncated, true);
    assert.equal(read.working, false);
    const last = read.turns.at(-1) as AssistantTurn;
    assert.equal(last.role, "assistant");
    assert.equal(last.open, false);
    assert.deepEqual(last.blocks, [{ type: "text", text: "answer 39" }]);
    assert.ok(read.turns.length < 80);
  });

  test("refuses an id that is not a UUID", async () => {
    await assert.rejects(readConversation(home, folder, "../etc/passwd"));
  });
});
