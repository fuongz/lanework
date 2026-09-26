// The agent conversations the rail's Agents group lists, and the resume line a
// tab types for one (FE-23) — driven directly under Node against a fake home.
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { watchAgentActivity } from "../electron/main/terminal/agent-activity";
import {
  applyAgentMarks,
  cleanAgentName,
  keptKeys,
  readAgentMarks,
  updateAgentMark,
} from "../electron/main/terminal/agent-marks";
import {
  claudeProjectDir,
  claudeWorking,
  codexWorking,
  lastActivity,
  listAgentSessions,
} from "../electron/main/terminal/agent-sessions";
import { createSessions } from "../electron/main/terminal/sessions";
import { isAgentSessionId, type TerminalHostMessage } from "../shared/terminal";
import { CLAUDE_ID, CODEX_ID, seedAgentHome } from "./agent-fixtures";

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

test("lists this folder's Claude and Codex conversations by their titles, and nothing else", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  await seedAgentHome(home, folder);

  const listed = await listAgentSessions(home, folder);
  expect(
    listed
      .map(({ id, agent, title }) => ({ id, agent, title }))
      .sort((a, b) => a.agent.localeCompare(b.agent)),
  ).toEqual([
    { id: CLAUDE_ID, agent: "claude", title: "Flaky login test" },
    { id: CODEX_ID, agent: "codex", title: "Settings page cleanup" },
  ]);
  // No history at all is an empty list, not an error.
  expect(
    await listAgentSessions(await tempDir("lanew-empty-"), folder),
  ).toEqual([]);
});

test("an agent tab resumes a conversation by its id — and never types anything else as one", async () => {
  const typed: string[] = [];
  const sessions = createSessions({
    shell: { file: "/bin/sh", args: [] },
    agentCommand: (agent) => `printf 'ran-%s-%s-%s\\n' ${agent}`,
  });
  const run = async (kind: "claude" | "codex", resume: unknown) => {
    const session = sessions.spawn({
      workspace: "ws",
      cwd: await tempDir("lanew-term-"),
      cols: 80,
      rows: 24,
      kind,
      resume,
    });
    const messages: TerminalHostMessage[] = [];
    sessions.attach(
      { send: (message) => messages.push(message) },
      session.id,
      80,
      24,
    );
    const text = () =>
      messages
        .map((m) => (m.t === "snapshot" || m.t === "data" ? m.data : ""))
        .join("");
    await expect.poll(text).toMatch(/ran-\w+-/);
    typed.push(text());
    return session;
  };
  try {
    const claude = await run("claude", CLAUDE_ID);
    expect(claude.resume).toBe(CLAUDE_ID);
    expect(typed[0]).toContain(`ran-claude---resume-${CLAUDE_ID}`);

    const codex = await run("codex", CODEX_ID);
    expect(codex.resume).toBe(CODEX_ID);
    expect(typed[1]).toContain(`ran-codex-resume-${CODEX_ID}`);

    // Not a UUID: a NEW conversation, under an id chosen here — never the
    // one sent — so the rail can tie the tab to its transcript.
    const hostile = await run("claude", "x; echo pwned");
    expect(isAgentSessionId(hostile.resume)).toBe(true);
    expect(typed[2]).toContain(`ran-claude---session-id-${hostile.resume}`);
    expect(typed[2]).not.toContain("pwned");

    // Codex takes no id for a new conversation: nothing appended.
    const fresh = await run("codex", undefined);
    expect(fresh.resume).toBeNull();
    expect(typed[3]).toMatch(/ran-codex--\s/);
  } finally {
    sessions.killAll();
  }
});

test("a name and a pin are Lanework's own, and a pinned conversation outlives the listing's limit", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "repo");
  // 25 conversations: more than the 20 the rail is given.
  const dir = join(home, ".claude", "projects", claudeProjectDir(folder));
  await mkdir(dir, { recursive: true });
  const ids = Array.from(
    { length: 25 },
    (_, index) =>
      `${String(index).padStart(8, "0")}-2222-4333-8444-555555555555`,
  );
  for (const [index, id] of ids.entries()) {
    const file = join(dir, `${id}.jsonl`);
    await writeFile(
      file,
      `${JSON.stringify({ type: "user", cwd: folder, message: { role: "user", content: `Task ${index}` } })}\n`,
    );
    // Oldest first: ids[0] is the oldest conversation.
    const at = new Date(Date.UTC(2026, 0, 1, 0, index));
    await utimes(file, at, at);
  }
  const marks = join(await tempDir("lanew-marks-"), "agent-sessions.json");
  const oldest = `claude:${ids[0]}`;

  expect(await listAgentSessions(home, folder)).toHaveLength(20);
  expect(
    (await listAgentSessions(home, folder)).some(
      (entry) => entry.id === ids[0],
    ),
  ).toBe(false);

  await updateAgentMark(marks, oldest, (mark) => ({
    ...mark,
    name: "Login rewrite",
    pinnedAt: 1_000,
  }));
  const saved = await readAgentMarks(marks);
  const listed = applyAgentMarks(
    await listAgentSessions(home, folder, keptKeys(saved)),
    saved,
  );
  // Pinned, so kept past the limit — and shown by its Lanework name.
  expect(listed).toHaveLength(21);
  expect(listed.find((entry) => entry.id === ids[0])).toMatchObject({
    title: "Login rewrite",
    cliTitle: "Task 0",
    pinnedAt: 1_000,
  });

  // Emptied, a mark goes away entirely; nothing blank is kept.
  await updateAgentMark(marks, oldest, () => ({}));
  expect(await readAgentMarks(marks)).toEqual({});

  // A name is one line, and short.
  expect(cleanAgentName("  Login rewrite  ")).toBe("Login rewrite");
  expect(() => cleanAgentName("two\nlines")).toThrow("one line");
  expect(() => cleanAgentName("x".repeat(121))).toThrow("at most 120");
  // A missing or foreign file reads as no marks.
  expect(await readAgentMarks(join(home, "nope.json"))).toEqual({});
});

test("working is a turn left open — not a transcript being written", async () => {
  const user = { type: "user", message: { content: "Do it" } };
  const toolResult = {
    type: "user",
    message: { content: [{ type: "tool_result" }] },
  };
  const thinking = { type: "assistant", message: { stop_reason: null } };
  const toolCall = { type: "assistant", message: { stop_reason: "tool_use" } };
  const answered = { type: "assistant", message: { stop_reason: "end_turn" } };
  const closed = { type: "system", subtype: "turn_duration" };
  const bookkeeping = [
    { type: "mode" },
    { type: "permission-mode" },
    { type: "cost-state" },
    { type: "last-prompt" },
    { type: "ai-title", aiTitle: "x" },
  ];
  expect(claudeWorking([])).toBe(false);
  expect(claudeWorking([user])).toBe(true);
  expect(claudeWorking([user, thinking])).toBe(true);
  expect(claudeWorking([user, toolCall, toolResult])).toBe(true);
  // Answered but not yet closed is still the turn.
  expect(claudeWorking([user, answered])).toBe(true);
  expect(claudeWorking([user, answered, closed])).toBe(false);
  // ⚠️ Opening a conversation writes these — none of them is work.
  expect(claudeWorking([user, answered, closed, ...bookkeeping])).toBe(false);
  expect(
    claudeWorking([
      user,
      { type: "user", message: { content: "[Request interrupted by user]" } },
    ]),
  ).toBe(false);
  // A local slash command after a closed turn is not a new one.
  expect(
    claudeWorking([
      user,
      answered,
      closed,
      {
        type: "user",
        message: { content: "<command-name>/model</command-name>" },
      },
      {
        type: "user",
        message: {
          content: "<local-command-stdout>Set model</local-command-stdout>",
        },
      },
      { type: "system", subtype: "informational" },
    ]),
  ).toBe(false);

  const event = (type: string) => ({ type: "event_msg", payload: { type } });
  expect(codexWorking([])).toBe(false);
  expect(codexWorking([event("task_started"), event("token_count")])).toBe(
    true,
  );
  expect(codexWorking([event("task_started"), event("task_complete")])).toBe(
    false,
  );
  expect(codexWorking([event("task_started"), event("turn_aborted")])).toBe(
    false,
  );
});

test("a conversation's time is when it last moved — not when it was last opened", () => {
  const at = (iso: string) => `2026-09-26T${iso}.000Z`;
  const claude = [
    { type: "user", timestamp: at("01:00:00"), message: { content: "Fix it" } },
    {
      type: "assistant",
      timestamp: at("01:00:05"),
      message: { stop_reason: "end_turn" },
    },
    { type: "system", subtype: "turn_duration", timestamp: at("01:00:06") },
    // A resume, hours later: bookkeeping, a local command, an attachment.
    { type: "mode" },
    { type: "last-prompt" },
    { type: "attachment", timestamp: at("05:00:00") },
    {
      type: "user",
      timestamp: at("05:00:01"),
      message: { content: "<command-name>/model</command-name>" },
    },
  ];
  expect(lastActivity(claude, "claude")).toBe(at("01:00:06"));
  expect(lastActivity([{ type: "mode" }], "claude")).toBeNull();

  const codex = [
    {
      type: "event_msg",
      timestamp: at("02:00:00"),
      payload: { type: "task_complete" },
    },
    { type: "turn_context", timestamp: at("06:00:00"), payload: {} },
    { type: "token_usage_record", timestamp: at("06:00:01") },
  ];
  expect(lastActivity(codex, "codex")).toBe(at("02:00:00"));
});

test("the watcher reports a turn opening and closing — this folder's only", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  await seedAgentHome(home, folder);
  const seen: string[] = [];
  const stop = watchAgentActivity(home, folder, (agent, id, working) =>
    seen.push(`${agent}:${id}:${working}`),
  );
  const claude = join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    `${CLAUDE_ID}.jsonl`,
  );
  const day = join(home, ".codex", "sessions", "2026", "09", "26");
  const codex = join(day, `rollout-2026-09-26T07-04-45-${CODEX_ID}.jsonl`);
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  try {
    // Another folder's rollout, named like one and working: never reported.
    await writeFile(
      join(
        day,
        "rollout-2026-09-26T09-00-00-01a0db07-52f1-7020-abe9-111111111111.jsonl",
      ),
      line({
        type: "session_meta",
        payload: { id: "01a0db07-52f1-7020-abe9-111111111111", cwd: "/tmp" },
      }) + line({ type: "event_msg", payload: { type: "task_started" } }),
    );
    // ⚠️ Written AGAIN until it is seen: the OS watcher takes a moment to
    // start reporting, and a turn keeps writing anyway.
    await expect(async () => {
      await appendFile(
        claude,
        line({ type: "user", message: { content: "Go" } }),
      );
      await appendFile(
        codex,
        line({ type: "event_msg", payload: { type: "task_started" } }),
      );
      await expect
        .poll(() => [...new Set(seen)].sort(), { timeout: 1_500 })
        .toEqual([`claude:${CLAUDE_ID}:true`, `codex:${CODEX_ID}:true`]);
    }).toPass({ timeout: 15_000 });

    await appendFile(
      claude,
      line({ type: "system", subtype: "turn_duration" }),
    );
    await appendFile(
      codex,
      line({ type: "event_msg", payload: { type: "task_complete" } }),
    );
    await expect
      .poll(() => seen.slice(-2).sort())
      .toEqual([`claude:${CLAUDE_ID}:false`, `codex:${CODEX_ID}:false`]);
    // Bookkeeping after the turn closed says nothing new.
    const before = seen.length;
    await appendFile(claude, line({ type: "cost-state" }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(seen.length).toBe(before);
    expect(seen.some((key) => key.includes("111111111111"))).toBe(false);
  } finally {
    stop();
  }
});
