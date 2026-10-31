// Run with `bun test ./electron/main/sessions/pull.test.ts` from apps/desktop.
// Written against `node:test`/`node:assert`, as the store's specs are.
//
// FE-112: a Pull of a fake home's folder into a store, on this thread and in
// the worker thread, cancelled, and one conversation read on a settled write.
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type {
  AgentPullProgress,
  TerminalAgent,
} from "../../../shared/terminal";
import { openSessionStore, type SessionStore } from "../../session-store";
import { claudeFolderDir } from "./ingest";
import { ingestOne, type PullIntoStoreOptions, pullIntoStore } from "./pull";
import { type PullBatch, type PullStep, runPullJob } from "./pull-job";

const home = mkdtempSync(join(tmpdir(), "lanework-fe112-pull-"));
const folder = "/Users/someone/project";
const opencodeDir = join(home, "opencode-empty");
const agents: TerminalAgent[] = ["claude", "codex", "opencode"];
const opened: SessionStore[] = [];
after(() => {
  for (const store of opened) store.close();
  rmSync(home, { recursive: true, force: true });
});

/** A UUID-shaped conversation id, numbered for the reader. */
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let clock = Date.parse("2026-10-31T10:00:00.000Z");
const at = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};
const jsonl = (rows: object[]) =>
  rows.map((row) => `${JSON.stringify(row)}\n`).join("");

/** Back-date `file` by two hours: long past every staleness window. */
function quiet(file: string) {
  const then = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(file, then, then);
}

/** A throwaway store, closed after the suite. */
function store(): SessionStore {
  const sessions = openSessionStore({ path: ":memory:" });
  opened.push(sessions);
  return sessions;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const claudeDir = claudeFolderDir(home, folder);
mkdirSync(claudeDir, { recursive: true });
mkdirSync(opencodeDir, { recursive: true });

const claudeLine = (id: string, type: string, extra: object) => ({
  sessionId: id,
  cwd: folder,
  isSidechain: false,
  type,
  timestamp: at(),
  ...extra,
});

/** A finished Claude conversation of `folder`'s, asked `prompt`. */
function claudeConversation(n: number, prompt: string, cwd = folder): string {
  const id = uuid(n);
  const file = join(claudeDir, `${id}.jsonl`);
  writeFileSync(
    file,
    jsonl([
      { ...claudeLine(id, "user", { message: { content: prompt } }), cwd },
      claudeLine(id, "assistant", {
        message: {
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
        },
      }),
      claudeLine(id, "system", { subtype: "turn_duration" }),
    ]),
  );
  quiet(file);
  return file;
}

const codexDay = join(home, ".codex", "sessions", "2026", "10", "31");
mkdirSync(codexDay, { recursive: true });

const codexMeta = (id: string, payload: object = {}) => ({
  timestamp: at(),
  type: "session_meta",
  payload: {
    id,
    timestamp: "2026-10-31T09:00:00.000Z",
    cwd: folder,
    instructions: "x".repeat(20_000),
    ...payload,
  },
});
const codexEvent = (payload: object) => ({
  timestamp: at(),
  type: "event_msg",
  payload,
});

function codexRollout(n: number, rows: object[]): string {
  const file = join(
    codexDay,
    `rollout-2026-10-31T10-00-${String(n).padStart(2, "0")}-${uuid(n)}.jsonl`,
  );
  writeFileSync(file, jsonl(rows));
  quiet(file);
  return file;
}

/** A thread conversation `root` spawned, as Codex writes its rollout. */
const spawnedMeta = (id: string, root: string, nickname: string) =>
  codexMeta(id, {
    session_id: root,
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: root,
          agent_nickname: nickname,
          agent_path: "/root/review_docs",
        },
      },
    },
  });

const claudeMine = claudeConversation(1, "Fix the login bug");
claudeConversation(2, "Elsewhere", "/Users/someone/other");
claudeConversation(3, "<command-name>/model</command-name>");
codexRollout(11, [
  codexMeta(uuid(11)),
  codexEvent({ type: "user_message", message: "Add dark mode" }),
  codexEvent({ type: "task_complete" }),
]);
codexRollout(12, [
  spawnedMeta(uuid(12), uuid(11), "Ada"),
  codexEvent({ type: "task_complete" }),
]);
codexRollout(13, [
  codexMeta(uuid(13), { cwd: "/elsewhere" }),
  codexEvent({ type: "user_message", message: "Not ours" }),
]);

const options = (
  extra: Partial<PullIntoStoreOptions> = {},
): PullIntoStoreOptions => ({
  project: "proj",
  folder,
  agents,
  home,
  opencodeDir,
  inline: true,
  ...extra,
});

// ── Specs ───────────────────────────────────────────────────────────────────

describe("a Pull", () => {
  test("reads only the folder's conversations, one agent at a time", async () => {
    const batches: PullBatch[] = [];
    const steps: PullStep[] = [];
    await runPullJob(
      { folder, agents, home, opencodeDir },
      {
        states: async (keys) =>
          Object.fromEntries(keys.map((key) => [key, null])),
        write: (batch) => batches.push(batch),
        progress: (step) => steps.push(step),
      },
    );
    assert.deepEqual(
      batches.flatMap((batch) => batch.rows.map((row) => row.key)).sort(),
      [`claude:${uuid(1)}`, `codex:${uuid(11)}`],
    );
    assert.deepEqual(
      batches
        .flatMap((batch) => batch.subagents)
        .map(({ key, list }) => [key, list.map((sub) => sub.title)]),
      [[`codex:${uuid(11)}`, ["Ada: review docs"]]],
    );
    for (const agent of agents) {
      const mine = steps.filter((step) => step.agent === agent);
      assert.equal(mine[0]?.phase, "scan");
      assert.equal(mine.at(-1)?.phase, "done");
    }
    const claude = steps.filter((step) => step.agent === "claude").at(-1);
    assert.deepEqual([claude?.done, claude?.total], [3, 3]);
    // Every rollout on the machine is looked at, the folder's or not.
    const codex = steps.filter((step) => step.agent === "codex").at(-1);
    assert.deepEqual([codex?.done, codex?.total], [3, 3]);
  });

  test("fills the store, keeps Lanework's marks, and skips what did not move", async () => {
    const sessions = store();
    const progress: AgentPullProgress[] = [];
    const written: string[] = [];
    const first = await pullIntoStore(
      sessions,
      options({
        onProgress: (step) => progress.push(step),
        onWritten: (keys) => written.push(...keys),
      }),
    );
    assert.deepEqual(first, { pulled: 2, cancelled: false });
    assert.ok(progress.every((step) => step.project === "proj"));
    assert.ok(written.includes(`claude:${uuid(1)}`));
    const rail = sessions.listRail("proj");
    assert.deepEqual(rail.map((row) => row.title).sort(), [
      "Add dark mode",
      "Fix the login bug",
    ]);
    assert.deepEqual(
      rail.find((row) => row.agent === "codex")?.subagents.map((sub) => sub.id),
      [uuid(12)],
    );
    const stored = sessions.getSession(`claude:${uuid(1)}`);
    assert.equal(stored?.origin, "pulled");
    assert.equal(stored?.sourcePath, claudeMine);

    sessions.setName(`claude:${uuid(1)}`, "Login");
    sessions.setPinned(`claude:${uuid(1)}`, true, 1);
    const second = await pullIntoStore(sessions, options());
    assert.deepEqual(second, { pulled: 0, cancelled: false });
    const kept = sessions.getSession(`claude:${uuid(1)}`);
    assert.equal(kept?.name, "Login");
    assert.equal(kept?.pinnedAt, 1);
  });

  test("reads in its worker thread", async () => {
    const sessions = store();
    // NOTE: Bun runs the worker's TypeScript as is; the app runs its bundle,
    // `session-pull.cjs`.
    const outcome = await pullIntoStore(
      sessions,
      options({
        inline: false,
        workerFile: join(import.meta.dirname, "pull-worker.ts"),
      }),
    );
    assert.deepEqual(outcome, { pulled: 2, cancelled: false });
    assert.equal(sessions.listRail("proj").length, 2);
  });

  test("a cancelled Pull ends every agent's part as cancelled", async () => {
    const sessions = store();
    const progress: AgentPullProgress[] = [];
    const stop = new AbortController();
    stop.abort();
    const outcome = await pullIntoStore(
      sessions,
      options({
        signal: stop.signal,
        onProgress: (step) => progress.push(step),
      }),
    );
    assert.deepEqual(outcome, { pulled: 0, cancelled: true });
    assert.deepEqual(
      progress.map((step) => [step.agent, step.phase]),
      agents.map((agent) => [agent, "cancelled"]),
    );
    assert.equal(sessions.listRail("proj").length, 0);
  });
});

describe("a settled write", () => {
  test("reads the new lines of one conversation into the store", async () => {
    const sessions = store();
    await pullIntoStore(sessions, options());
    const id = uuid(1);
    appendFileSync(
      claudeMine,
      jsonl([{ type: "ai-title", sessionId: id, aiTitle: "Login bug" }]),
    );
    assert.deepEqual(
      await ingestOne(
        sessions,
        { agent: "claude", file: claudeMine },
        { project: "proj", folder, home, opencodeDir },
      ),
      { key: `claude:${id}`, written: true },
    );
    assert.equal(sessions.getSession(`claude:${id}`)?.cliTitle, "Login bug");
  });

  test("a thread Codex spawned joins its conversation's sub-agents", async () => {
    const sessions = store();
    await pullIntoStore(sessions, options());
    const file = codexRollout(14, [
      spawnedMeta(uuid(14), uuid(11), "Grace"),
      codexEvent({ type: "task_complete" }),
    ]);
    assert.deepEqual(
      await ingestOne(
        sessions,
        { agent: "codex", file },
        { project: "proj", folder, home, opencodeDir },
      ),
      { key: `codex:${uuid(11)}`, written: true },
    );
    assert.deepEqual(
      sessions
        .getSession(`codex:${uuid(11)}`)
        ?.subagents.map((sub) => sub.id)
        .sort(),
      [uuid(12), uuid(14)],
    );
  });
});
