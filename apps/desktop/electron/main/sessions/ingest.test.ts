// Run with `bun test ./electron/main/sessions/ingest.test.ts` from
// apps/desktop. Written against `node:test`/`node:assert`, as the store's
// specs are.
//
// FE-112: one conversation of each CLI read into a row, and read again from
// where the last read stopped, against a fake home folder.
import assert from "node:assert/strict";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { openDatabase } from "../../local-store/driver";
import type { IngestState } from "../../session-store/types";
import {
  parsedFromJSON,
  parsedToJSON,
  readTranscriptTasksFrom,
} from "../terminal/background-tasks";
import {
  claudeFolderDir,
  codexMetaOf,
  type IngestOutcome,
  type IngestRow,
  ingestClaude,
  ingestCodex,
  ingestOpencode,
  opencodeConversations,
} from "./ingest";

const home = mkdtempSync(join(tmpdir(), "lanework-fe112-ingest-"));
const folder = "/Users/someone/project";
after(() => rmSync(home, { recursive: true, force: true }));

/** A UUID-shaped conversation id, numbered for the reader. */
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let clock = Date.parse("2026-10-31T10:00:00.000Z");
/** The next line's timestamp, a second after the last one. */
const at = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};
const jsonl = (rows: object[]) =>
  rows.map((row) => `${JSON.stringify(row)}\n`).join("");

/** Back-date `file` by an hour: long past every staleness window. */
function quiet(file: string) {
  const then = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(file, then, then);
}

/** The row an outcome holds; fails the test for any other outcome. */
function rowOf(outcome: IngestOutcome): IngestRow {
  assert.equal(outcome.kind, "row");
  return (outcome as { row: IngestRow }).row;
}

/** What the store would answer for `row` once written: through JSON. */
function stored(row: IngestRow): IngestState {
  return {
    path: row.session.sourcePath ?? null,
    size: row.ingest.size,
    mtime: row.ingest.mtime,
    offset: row.ingest.offset,
    state: JSON.parse(JSON.stringify(row.ingest.state)),
  };
}

// ── Claude ──────────────────────────────────────────────────────────────────

const claudeDir = claudeFolderDir(home, folder);
mkdirSync(claudeDir, { recursive: true });

let uuidLine = 0;
const base = (id: string, cwd = folder) => ({
  uuid: `u-${++uuidLine}`,
  sessionId: id,
  cwd,
  isSidechain: false,
});
const user = (id: string, content: unknown, extra: object = {}) => ({
  ...base(id),
  type: "user",
  timestamp: at(),
  message: { role: "user", content },
  ...extra,
});
const assistant = (id: string, content: unknown[], stop = "end_turn") => ({
  ...base(id),
  type: "assistant",
  timestamp: at(),
  message: { role: "assistant", content, stop_reason: stop },
});
const closed = (id: string) => ({
  ...base(id),
  type: "system",
  subtype: "turn_duration",
  timestamp: at(),
});
const aiTitle = (id: string, title: string) => ({
  type: "ai-title",
  sessionId: id,
  aiTitle: title,
});

function claudeFile(n: number, rows: object[]): string {
  const file = join(claudeDir, `${uuid(n)}.jsonl`);
  writeFileSync(file, jsonl(rows));
  return file;
}

/** A shell left running in the background, as Claude writes its start. */
const backgroundShell = (id: string, task: string) => [
  assistant(
    id,
    [
      {
        type: "tool_use",
        id: `toolu_${task}`,
        name: "Bash",
        input: { command: "bun run dev", run_in_background: true },
      },
    ],
    "tool_use",
  ),
  user(
    id,
    [
      {
        type: "tool_result",
        tool_use_id: `toolu_${task}`,
        content: `Command running in background with ID: ${task}. Output is being written to: /tmp/claude-1/tasks/${task}.output`,
      },
    ],
    { toolUseResult: { backgroundTaskId: task } },
  ),
];

describe("Claude", () => {
  test("reads a transcript into a row, titled by its first prompt", async () => {
    const id = uuid(1);
    const first = at();
    const file = claudeFile(1, [
      { ...user(id, "Fix the login bug"), timestamp: first },
      assistant(id, [{ type: "text", text: "Done." }]),
      closed(id),
    ]);
    const row = rowOf(await ingestClaude(file, folder, null));
    assert.equal(row.key, `claude:${id}`);
    assert.equal(row.session.cliTitle, "Fix the login bug");
    assert.equal(row.session.createdAt, first);
    assert.equal(row.session.sourcePath, file);
    assert.equal(row.session.working, false);
    assert.deepEqual(row.session.background, { running: 0, total: 0 });
    assert.equal(row.ingest.offset, statSync(file).size);
    assert.deepEqual(row.subagents, []);
  });

  test("Claude's newest title wins over the prompt", async () => {
    const id = uuid(2);
    const file = claudeFile(2, [
      user(id, "Fix the login bug"),
      aiTitle(id, "Login bug"),
      assistant(id, [{ type: "text", text: "Done." }]),
      aiTitle(id, "Login redirect bug"),
      closed(id),
    ]);
    const row = rowOf(await ingestClaude(file, folder, null));
    assert.equal(row.session.cliTitle, "Login redirect bug");
  });

  test("a second read starts at the stored offset, not the first byte", async () => {
    const id = uuid(3);
    const file = claudeFile(3, [
      user(id, "Start the dev server"),
      ...backgroundShell(id, "b1abc"),
    ]);
    const first = rowOf(await ingestClaude(file, folder, null));
    assert.deepEqual(first.session.background, { running: 1, total: 1 });
    // Blank every byte read so far, newlines kept. A read from the first
    // byte would find no prompt and no task in them.
    const size = statSync(file).size;
    const blank = Buffer.alloc(size, 0x20);
    blank[size - 1] = 0x0a;
    const fd = openSync(file, "r+");
    writeSync(fd, blank, 0, size, 0);
    closeSync(fd);
    appendFileSync(
      file,
      jsonl([
        user(
          id,
          "<task-notification><task-id>b1abc</task-id><status>completed</status><summary>Exited with exit code 0</summary></task-notification>",
        ),
        assistant(id, [{ type: "text", text: "The server stopped." }]),
        closed(id),
      ]),
    );
    const second = rowOf(await ingestClaude(file, folder, stored(first)));
    assert.equal(second.session.cliTitle, "Start the dev server");
    assert.deepEqual(second.session.background, { running: 0, total: 1 });
    assert.equal(second.ingest.offset, statSync(file).size);
  });

  test("a stored read of a file that did not move reads nothing", async () => {
    const id = uuid(4);
    const file = claudeFile(4, [
      user(id, "Rename the package"),
      assistant(id, [{ type: "text", text: "Done." }]),
      closed(id),
    ]);
    quiet(file);
    const first = rowOf(await ingestClaude(file, folder, null));
    assert.equal((first.ingest.state as { live: boolean }).live, false);
    assert.deepEqual(await ingestClaude(file, folder, stored(first)), {
      kind: "unchanged",
    });
  });

  test("one still working is read again though it did not move", async () => {
    const id = uuid(5);
    const file = claudeFile(5, [
      user(id, "Run the migration"),
      assistant(
        id,
        [
          {
            type: "tool_use",
            id: "toolu_card",
            name: "mcp__lanework__get_review",
            input: { board_id: "board-1", card: "FE-112" },
          },
        ],
        "tool_use",
      ),
    ]);
    const first = rowOf(await ingestClaude(file, folder, null));
    assert.equal(first.session.working, true);
    assert.deepEqual(first.session.card, {
      boardId: "board-1",
      card: "FE-112",
    });
    const again = await ingestClaude(file, folder, stored(first));
    assert.equal(again.kind, "row");
  });

  test("a file that shrank is read from its first byte", async () => {
    const id = uuid(6);
    const file = claudeFile(6, [
      user(id, "A long first conversation"),
      assistant(id, [{ type: "text", text: "x".repeat(4096) }]),
      closed(id),
    ]);
    const first = rowOf(await ingestClaude(file, folder, null));
    writeFileSync(file, jsonl([user(id, "Rewritten"), closed(id)]));
    const second = rowOf(await ingestClaude(file, folder, stored(first)));
    assert.equal(second.session.cliTitle, "Rewritten");
    assert.equal(second.ingest.offset, statSync(file).size);
  });

  test("another folder's transcript is skipped", async () => {
    const id = uuid(7);
    const file = claudeFile(7, [
      { ...user(id, "Elsewhere"), cwd: "/Users/someone/other" },
    ]);
    assert.deepEqual(await ingestClaude(file, folder, null), { kind: "skip" });
  });

  test("a transcript nothing was typed in is skipped", async () => {
    const id = uuid(8);
    const file = claudeFile(8, [
      user(id, "<command-name>/model</command-name>"),
      user(id, "Caveat: local command", { isMeta: true }),
    ]);
    assert.deepEqual(await ingestClaude(file, folder, null), { kind: "skip" });
  });
});

describe("the background-task parse as JSON", () => {
  test("round-trips, and another version or a cut one reads as none", async () => {
    const id = uuid(9);
    const file = claudeFile(9, [
      user(id, "Watch the logs"),
      ...backgroundShell(id, "b2def"),
    ]);
    const { state, tasks } = await readTranscriptTasksFrom(file, null);
    assert.equal(tasks.length, 1);
    const back = parsedFromJSON(JSON.parse(JSON.stringify(state)));
    assert.ok(back);
    assert.deepEqual(parsedToJSON(back), state);
    assert.equal(parsedFromJSON({ ...state, v: 2 }), null);
    assert.equal(parsedFromJSON({ ...state, offset: state.size + 1 }), null);
    assert.equal(parsedFromJSON({ ...state, started: [["x", null]] }), null);
    // Read on from it: nothing new, the same task.
    const again = await readTranscriptTasksFrom(file, state);
    assert.equal(again.restarted, false);
    assert.equal(again.tasks.length, 1);
    assert.equal(again.state.offset, state.offset);
  });
});

// ── Codex ───────────────────────────────────────────────────────────────────

const codexDay = join(home, ".codex", "sessions", "2026", "10", "31");
mkdirSync(codexDay, { recursive: true });

const meta = (id: string, payload: object = {}) => ({
  timestamp: at(),
  type: "session_meta",
  payload: {
    id,
    timestamp: "2026-10-31T09:00:00.000Z",
    cwd: folder,
    originator: "codex_cli_rs",
    // The whole system prompt rides on this line: more than one read step.
    instructions: "x".repeat(40_000),
    ...payload,
  },
});
const event = (payload: object) => ({
  timestamp: at(),
  type: "event_msg",
  payload,
});
const agentsTurn = () => ({
  timestamp: at(),
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "# AGENTS.md instructions" }],
  },
});

function rollout(n: number, rows: object[]): string {
  const file = join(
    codexDay,
    `rollout-2026-10-31T10-00-${String(n).padStart(2, "0")}-${uuid(100 + n)}.jsonl`,
  );
  writeFileSync(file, jsonl(rows));
  return file;
}

describe("Codex", () => {
  test("reads a rollout into a row, titled by its first prompt", async () => {
    const id = uuid(101);
    const file = rollout(1, [
      meta(id),
      agentsTurn(),
      event({ type: "user_message", message: "Add dark mode" }),
      event({ type: "task_started" }),
      event({ type: "task_complete" }),
    ]);
    const row = rowOf(
      await ingestCodex(file, folder, null, { names: new Map() }),
    );
    assert.equal(row.key, `codex:${id}`);
    assert.equal(row.session.cliTitle, "Add dark mode");
    assert.equal(row.session.createdAt, "2026-10-31T09:00:00.000Z");
    assert.equal(row.session.working, false);
    assert.equal(row.ingest.offset, statSync(file).size);
    assert.equal(row.subagents, null);
  });

  test("a rename in session_index is news though the rollout did not move", async () => {
    const id = uuid(102);
    const file = rollout(2, [
      meta(id),
      event({ type: "user_message", message: "Add dark mode" }),
      event({ type: "task_complete" }),
    ]);
    quiet(file);
    const first = rowOf(
      await ingestCodex(file, folder, null, { names: new Map() }),
    );
    assert.deepEqual(
      await ingestCodex(file, folder, stored(first), { names: new Map() }),
      { kind: "unchanged" },
    );
    const renamed = rowOf(
      await ingestCodex(file, folder, stored(first), {
        names: new Map([[id, "Dark mode"]]),
      }),
    );
    assert.equal(renamed.session.cliTitle, "Dark mode");
  });

  test("reads on from the stored offset", async () => {
    const id = uuid(103);
    const file = rollout(3, [meta(id), event({ type: "task_complete" })]);
    // Nothing typed yet: no row.
    assert.deepEqual(
      await ingestCodex(file, folder, null, { names: new Map() }),
      { kind: "skip" },
    );
    appendFileSync(
      file,
      jsonl([event({ type: "user_message", message: "Ship it" })]),
    );
    const first = rowOf(
      await ingestCodex(file, folder, null, { names: new Map() }),
    );
    appendFileSync(
      file,
      jsonl([event({ type: "user_message", message: "And the docs" })]),
    );
    const second = rowOf(
      await ingestCodex(file, folder, stored(first), { names: new Map() }),
    );
    // The first prompt stays the title; only the new line was read.
    assert.equal(second.session.cliTitle, "Ship it");
    assert.ok(second.ingest.offset > first.ingest.offset);
  });

  test("tells whose a rollout is from its first line", async () => {
    const id = uuid(104);
    const mine = rollout(4, [meta(id)]);
    const theirs = rollout(5, [meta(uuid(105), { cwd: "/elsewhere" })]);
    const none = rollout(6, [event({ type: "task_started" })]);
    const found = await codexMetaOf(mine, folder);
    assert.ok(found);
    assert.equal((found as { id: unknown }).id, id);
    assert.equal(await codexMetaOf(theirs, folder), false);
    assert.equal(await codexMetaOf(none, folder), null);
  });

  test("a spawned thread is its conversation's sub-agent", async () => {
    const root = uuid(106);
    const id = uuid(107);
    const file = rollout(7, [
      meta(id, {
        session_id: root,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: root,
              agent_nickname: "Ada",
              agent_path: "/root/social_card",
              agent_role: "worker",
            },
          },
        },
      }),
      event({ type: "task_complete" }),
    ]);
    const outcome = await ingestCodex(file, folder, null, { names: new Map() });
    assert.equal(outcome.kind, "spawned");
    const spawned = outcome as Extract<IngestOutcome, { kind: "spawned" }>;
    assert.equal(spawned.root, root);
    assert.equal(spawned.subagent.id, id);
    assert.equal(spawned.subagent.title, "Ada: social card");
    assert.equal(spawned.subagent.type, "worker");
  });
});

// ── OpenCode ────────────────────────────────────────────────────────────────

const hasSqlite = await import("node:sqlite").then(
  () => true,
  () => false,
);

/** An OpenCode id, its 26 characters all `char`. */
const ses = (char: string) => `ses_${char.repeat(26)}`;

// NOTE: OpenCode's database is read through `node:sqlite`; a runtime without
// it reads none, and has nothing here to check.
if (hasSqlite)
  describe("OpenCode", () => {
    const dataDir = join(home, "opencode-data");
    mkdirSync(dataDir, { recursive: true });
    const updated = Date.now() - 2 * 60 * 60_000;
    const db = openDatabase(join(dataDir, "opencode.db"));
    db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
      agent TEXT, time_created INTEGER, time_updated INTEGER,
      time_archived INTEGER, time_compacting INTEGER
    );
    CREATE TABLE session_message (
      session_id TEXT, seq INTEGER, type TEXT, data TEXT
    );
  `);
    const insert = db.prepare(
      "INSERT INTO session_v2 (id, parent_id, directory, title, agent, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      ses("A"),
      null,
      folder,
      "Port the CLI",
      null,
      updated - 1000,
      updated,
      null,
    );
    insert.run(
      ses("B"),
      ses("A"),
      folder,
      "Explore the repo (@explore subagent)",
      "explore",
      updated,
      updated,
      null,
    );
    insert.run(
      ses("C"),
      null,
      folder,
      "Archived one",
      null,
      updated,
      updated,
      updated,
    );
    insert.run(
      ses("D"),
      null,
      folder,
      "New session - 2026-10-31T10:00:00.000Z",
      null,
      updated,
      updated,
      null,
    );
    insert.run(
      ses("E"),
      null,
      "/elsewhere",
      "Not ours",
      null,
      updated,
      updated,
      null,
    );
    db.prepare(
      "INSERT INTO session_message (session_id, seq, type, data) VALUES (?, ?, ?, ?)",
    ).run(ses("A"), 1, "user", JSON.stringify({ text: "Port the CLI to Bun" }));
    db.close();

    test("lists the folder's titled, unarchived conversations", async () => {
      const found = await opencodeConversations(dataDir, folder);
      assert.deepEqual(
        found.map((conversation) => conversation.id),
        [ses("A")],
      );
    });

    test("reads one into a row with its sub-agents, then not again", async () => {
      const row = rowOf(await ingestOpencode(dataDir, folder, ses("A"), null));
      assert.equal(row.session.cliTitle, "Port the CLI");
      assert.equal(row.session.sourcePath, null);
      assert.equal(row.session.updatedAt, new Date(updated).toISOString());
      assert.deepEqual(
        row.subagents?.map((sub) => [sub.id, sub.title, sub.type]),
        [[ses("B"), "Explore the repo", "explore"]],
      );
      assert.deepEqual(
        await ingestOpencode(dataDir, folder, ses("A"), stored(row)),
        { kind: "unchanged" },
      );
    });
  });
