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
import { agentBindings } from "../electron/main/terminal/agent-binding";
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
  laneworkCard,
  lastActivity,
  lastCardIn,
  listAgentSessions,
} from "../electron/main/terminal/agent-sessions";
import { createSessions } from "../electron/main/terminal/sessions";
import {
  isAgentSessionId,
  type TerminalHostMessage,
  type TerminalSession,
} from "../shared/terminal";
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

test("the card an agent is on is its latest Lanework call that names one — this board's, from either CLI (FE-27)", async () => {
  const claudeCall = (name: string, input: unknown) => ({
    type: "assistant",
    message: {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "x" },
        { type: "tool_use", name, input },
      ],
    },
  });
  expect(
    laneworkCard(
      claudeCall("mcp__lanework__set_status", { board_id: "b1", card: "FE-3" }),
    ),
  ).toEqual({ boardId: "b1", card: "FE-3" });
  // However the server was added, and a uuid for the card.
  expect(
    laneworkCard(
      claudeCall("mcp__claude_ai_Lanework__get_review", {
        board_id: "b1",
        card: "0a5b9807-036e-4feb-9d2f-03d1e6bad977",
      }),
    ),
  ).toEqual({ boardId: "b1", card: "0a5b9807-036e-4feb-9d2f-03d1e6bad977" });
  // A call that names no card, another server, no board: none.
  expect(
    laneworkCard(
      claudeCall("mcp__lanework__board_summary", { board_id: "b1" }),
    ),
  ).toBeNull();
  expect(
    laneworkCard(
      claudeCall("mcp__linear__get_issue", { board_id: "b1", card: "X" }),
    ),
  ).toBeNull();
  expect(
    laneworkCard(claudeCall("mcp__lanework__get_review", { card: "FE-3" })),
  ).toBeNull();
  // Codex: an McpToolCall item, and the older function_call.
  expect(
    laneworkCard({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "McpToolCall",
          server: "lanework",
          tool: "toggle_item",
          arguments: { board_id: "b1", card: "BE-2", key: "V1" },
        },
      },
    }),
  ).toEqual({ boardId: "b1", card: "BE-2" });
  expect(
    laneworkCard({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "mcp__lanework__get_review",
        arguments: JSON.stringify({ board_id: "b1", card: "BE-4" }),
      },
    }),
  ).toEqual({ boardId: "b1", card: "BE-4" });

  // In a file: the NEWEST wins, and a line still being written is not read.
  const dir = await tempDir("lanew-card-");
  const file = join(dir, "t.jsonl");
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  await writeFile(
    file,
    line(
      claudeCall("mcp__lanework__get_review", { board_id: "b1", card: "FE-1" }),
    ) +
      line({ type: "user", message: { content: "more" } }) +
      line(
        claudeCall("mcp__lanework__set_status", {
          board_id: "b1",
          card: "FE-2",
        }),
      ) +
      line({ type: "user", message: { content: "and more" } }),
  );
  const size = (await import("node:fs/promises").then((fs) => fs.stat(file)))
    .size;
  const first = await lastCardIn(file, 0, size, true);
  expect(first).toEqual({ card: { boardId: "b1", card: "FE-2" }, end: size });
  // A half-written call is left for the next read, which starts at `end`.
  const half = JSON.stringify(
    claudeCall("mcp__lanework__set_status", { board_id: "b1", card: "FE-9" }),
  );
  await appendFile(file, half.slice(0, 40));
  const cut = await lastCardIn(file, first.end, size + 40, true);
  expect(cut).toEqual({ card: null, end: size });
  await appendFile(file, `${half.slice(40)}\n`);
  const whole = await lastCardIn(file, cut.end, size + half.length + 1, true);
  expect(whole.card).toEqual({ boardId: "b1", card: "FE-9" });
  // Nothing of Lanework in it: none.
  const plain = join(dir, "p.jsonl");
  await writeFile(plain, line({ type: "user", message: { content: "hi" } }));
  expect((await lastCardIn(plain, 0, 64, true)).card).toBeNull();
});

test("a listing and the watcher both say which card a working agent is on — and none once it is idle (FE-27)", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  await seedAgentHome(home, folder);
  const claude = join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    `${CLAUDE_ID}.jsonl`,
  );
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const call = (card: string) =>
    line({
      type: "assistant",
      message: {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            name: "mcp__lanework__get_review",
            input: { board_id: "b1", card },
          },
        ],
      },
    });
  const seen: string[] = [];
  const stop = watchAgentActivity(home, folder, (agent, _id, working, card) =>
    seen.push(`${agent}:${working}:${card?.card ?? "-"}`),
  );
  try {
    await expect(async () => {
      await appendFile(
        claude,
        line({ type: "user", message: { content: "Go" } }) + call("FE-1"),
      );
      await expect
        .poll(() => seen.at(-1), { timeout: 1_500 })
        .toBe("claude:true:FE-1");
    }).toPass({ timeout: 15_000 });
    const listed = await listAgentSessions(home, folder);
    expect(listed.find((entry) => entry.agent === "claude")?.card).toEqual({
      boardId: "b1",
      card: "FE-1",
    });
    // Moving on to another card moves the mark (D5).
    await appendFile(claude, call("FE-2"));
    await expect.poll(() => seen.at(-1)).toBe("claude:true:FE-2");
    // Writes that name no card keep the one it is on.
    await appendFile(
      claude,
      line({ type: "user", message: { content: "ok" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(seen.at(-1)).toBe("claude:true:FE-2");
    await appendFile(
      claude,
      line({ type: "system", subtype: "turn_duration" }),
    );
    await expect.poll(() => seen.at(-1)).toBe("claude:false:-");
    expect(
      (await listAgentSessions(home, folder)).find(
        (entry) => entry.agent === "claude",
      )?.card,
    ).toBeNull();
  } finally {
    stop();
  }
});

/** A running agent tab as the host lists it, for `agentBindings` (FE-31). */
function tab(
  fields: Partial<TerminalSession> & Pick<TerminalSession, "id" | "kind">,
): TerminalSession {
  return {
    workspace: "ws",
    shell: "zsh",
    cwd: null,
    pid: 4242,
    createdAt: Date.parse("2026-09-27T10:00:00Z"),
    exit: null,
    resume: null,
    ...fields,
  };
}

test("a Claude tab follows its CLI to the conversation it moved to — and keeps its own when it cannot tell", async () => {
  const home = await tempDir("lanew-bind-home-");
  const dir = join(home, ".claude", "sessions");
  await mkdir(dir, { recursive: true });
  const moved = "99999999-2222-4333-8444-555555555555";
  const running = tab({ id: "t1", kind: "claude", resume: CLAUDE_ID });
  const pidFile = (value: unknown) =>
    writeFile(join(dir, "4242.json"), JSON.stringify(value));

  // No pid file: nothing to go on, so nothing moves.
  expect(await agentBindings(home, "/repo", [running])).toEqual([]);

  // `/clear` or `/resume` inside the CLI: its pid file names the new one.
  await pidFile({
    pid: 4242,
    sessionId: moved,
    startedAt: running.createdAt + 3_000,
  });
  expect(await agentBindings(home, "/repo", [running])).toEqual([
    { id: "t1", resume: moved },
  ]);
  // Already on it: no news.
  expect(
    await agentBindings(home, "/repo", [{ ...running, resume: moved }]),
  ).toEqual([]);

  // Not a UUID, another pid's, or left by the pid's EARLIER owner: kept.
  for (const stale of [
    { pid: 4242, sessionId: "x; rm -rf ~", startedAt: running.createdAt },
    { pid: 1, sessionId: moved, startedAt: running.createdAt },
    { pid: 4242, sessionId: moved, startedAt: running.createdAt - 60_000 },
  ]) {
    await pidFile(stale);
    expect(await agentBindings(home, "/repo", [running])).toEqual([]);
  }
  await writeFile(join(dir, "4242.json"), "{ not json");
  expect(await agentBindings(home, "/repo", [running])).toEqual([]);
  // An exited tab is a transcript, not an agent.
  await pidFile({ pid: 4242, sessionId: moved, startedAt: running.createdAt });
  expect(
    await agentBindings(home, "/repo", [
      { ...running, exit: { code: 1, signal: null } },
    ]),
  ).toEqual([]);
});

test("two new Codex tabs each take their own rollout, never one another's", async () => {
  const home = await tempDir("lanew-bind-home-");
  const folder = "/repo";
  const day = join(home, ".codex", "sessions", "2026", "09", "27");
  await mkdir(day, { recursive: true });
  const at = (iso: string) => Date.parse(iso);
  const rollout = (id: string, cwd: string, timestamp: string) =>
    writeFile(
      join(day, `rollout-2026-09-27T17-00-00-${id}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id, cwd, timestamp } })}\n`,
    );
  const first = "01a0e24c-c571-79b0-8805-000000000001";
  const second = "01a0e24c-c571-79b0-8805-000000000002";
  const older = "01a0e24c-c571-79b0-8805-000000000003";
  const elsewhere = "01a0e24c-c571-79b0-8805-000000000004";
  const resumed = "01a0e24c-c571-79b0-8805-000000000005";
  // Each CLI starts a few seconds after its tab; the rollout is written later.
  await rollout(first, folder, "2026-09-27T10:00:03Z");
  await rollout(second, folder, "2026-09-27T10:05:04Z");
  // Before either tab: some earlier Codex, not theirs.
  await rollout(older, folder, "2026-09-27T09:00:00Z");
  // Another folder's, however close in time.
  await rollout(elsewhere, "/other", "2026-09-27T10:00:01Z");
  // Already another tab's.
  await rollout(resumed, folder, "2026-09-27T10:05:01Z");

  const tabs = [
    tab({ id: "a", kind: "codex", createdAt: at("2026-09-27T10:00:00Z") }),
    tab({ id: "b", kind: "codex", createdAt: at("2026-09-27T10:05:00Z") }),
    tab({ id: "c", kind: "codex", resume: resumed, pid: 7 }),
  ];
  expect(
    (await agentBindings(home, folder, tabs)).sort((x, y) =>
      x.id.localeCompare(y.id),
    ),
  ).toEqual([
    { id: "a", resume: first },
    { id: "b", resume: second },
  ]);
  // Nobody has typed into a third yet: it waits, rather than taking a
  // rollout another tab is on.
  const bound = [
    { ...tabs[0], resume: first },
    { ...tabs[1], resume: second },
    tabs[2],
    tab({ id: "d", kind: "codex", createdAt: at("2026-09-27T10:06:00Z") }),
  ] as TerminalSession[];
  expect(await agentBindings(home, folder, bound)).toEqual([]);
});

test("the host moves a live agent tab onto its conversation, and tells its watchers once", async () => {
  const sessions = createSessions({
    shell: { file: "/bin/sh", args: [] },
    agentCommand: () => "true",
  });
  const changes: string[] = [];
  const off = sessions.onChanged((workspace) => changes.push(workspace));
  try {
    const cwd = await tempDir("lanew-term-");
    const agent = sessions.spawn({
      workspace: "ws",
      cwd,
      cols: 80,
      rows: 24,
      kind: "codex",
    });
    const shell = sessions.spawn({ workspace: "ws", cwd, cols: 80, rows: 24 });
    changes.length = 0;
    expect(
      sessions.bind("ws", [
        { id: agent.id, resume: CODEX_ID },
        // A shell resumes nothing; a bad id is never taken.
        { id: shell.id, resume: CODEX_ID },
        { id: agent.id, resume: "not; an id" },
      ]),
    ).toBe(true);
    expect(sessions.list("ws").map((entry) => entry.resume)).toEqual([
      CODEX_ID,
      null,
    ]);
    // Another workspace's tab is not this one's to move.
    expect(sessions.bind("other", [{ id: agent.id, resume: CLAUDE_ID }])).toBe(
      false,
    );
    // The same answer again is no change.
    expect(sessions.bind("ws", [{ id: agent.id, resume: CODEX_ID }])).toBe(
      false,
    );
    expect(changes).toEqual(["ws"]);
  } finally {
    off();
    sessions.killAll();
  }
});
