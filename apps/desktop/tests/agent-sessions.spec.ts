// The agent conversations the rail's Agents group lists, and the resume line a
// tab types for one (FE-23) — driven directly under Node against a fake home.
import { execFileSync } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { MachineRecord } from "../electron/main/auth/store";
import { watchAgentActivity } from "../electron/main/terminal/agent-activity";
import { agentBindings } from "../electron/main/terminal/agent-binding";
import {
  factsRequest,
  readAgentFacts,
  readAgentUsage,
} from "../electron/main/terminal/agent-facts";
import {
  AGENT_FILES_READ_MAX,
  agentFileMarks,
  agentFilesRequest,
  patchedFiles,
  readAgentFiles,
  scanTranscript,
} from "../electron/main/terminal/agent-files";
import {
  applyAgentMarks,
  cleanAgentName,
  keptKeys,
  readAgentMarks,
  updateAgentMark,
} from "../electron/main/terminal/agent-marks";
import {
  claudeProjectDir,
  claudeSubagentWorking,
  claudeWorking,
  codexStarts,
  codexWorking,
  laneworkCard,
  lastActivity,
  lastCardIn,
  listAgentSessions,
} from "../electron/main/terminal/agent-sessions";
import {
  backgroundRequest,
  readBackgroundTasks,
  readTaskOutput,
  taskOutputRequest,
} from "../electron/main/terminal/background-tasks";
import {
  readCodexGoals,
  readCodexQuota,
  readCodexUsage,
} from "../electron/main/terminal/codex-usage";
import { cardPrompt, createSessions } from "../electron/main/terminal/sessions";
import {
  readSubagentTranscript,
  subagentRequest,
} from "../electron/main/terminal/subagent-transcript";
import { writeFolders } from "../electron/main/workspaces/store";
import {
  AGENT_FACTS_READ_MAX,
  BACKGROUND_OUTPUT_MAX,
  isAgentSessionId,
  isCardRef,
  type TerminalHostMessage,
  type TerminalSession,
} from "../shared/terminal";
import {
  CLAUDE_BG_ID,
  CLAUDE_BG_OLD_ID,
  CLAUDE_EDITS_ID,
  CLAUDE_ID,
  CLAUDE_TOOLS_ID,
  CODEX_EDITS_ID,
  CODEX_EDITS_SPAWNED_ID,
  CODEX_GUARDIAN_ID,
  CODEX_ID,
  CODEX_SPAWNED_ID,
  codexRateLimits,
  codexTokenCount,
  seedAgentFacts,
  seedAgentHome,
  seedBackgroundTasks,
  seedClaudeEdits,
  seedCodexEdits,
  seedCodexGoals,
  seedForkSubagent,
  seedSubagents,
  tick,
} from "./agent-fixtures";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

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

test("FE-34: an agent handed a card is briefed by the host's own prompt, as one word — and only for a card shaped right", async () => {
  // Every argument the CLI receives on its own line, so a prompt the shell
  // split into words — or ran a piece of — shows up as more than one.
  const sessions = createSessions({
    shell: { file: "/bin/sh", args: [] },
    agentCommand: (agent) => `printf 'arg[%s]\\n' ${agent}`,
    // An exited tab still holds its place, and this test opens eleven.
    limit: 20,
  });
  const board = "604f96ba-e76f-4503-b183-9aeff29f1004";
  const run = async (
    kind: "claude" | "codex",
    card: unknown,
    resume?: unknown,
  ) => {
    const session = sessions.spawn({
      workspace: "ws",
      cwd: await tempDir("lanew-term-"),
      // Wide, so a long prompt is never wrapped into the screen's next row.
      cols: 1000,
      rows: 24,
      kind,
      resume,
      card,
    });
    const messages: TerminalHostMessage[] = [];
    sessions.attach(
      { send: (message) => messages.push(message) },
      session.id,
      1000,
      24,
    );
    const text = () =>
      messages
        .map((m) => (m.t === "snapshot" || m.t === "data" ? m.data : ""))
        .join("");
    await expect.poll(text).toMatch(/\[Process exited/);
    const args = [...text().matchAll(/arg\[([^\]]*)\]/g)].map((m) => m[1]);
    return { session, args };
  };
  try {
    const claude = await run("claude", {
      boardId: board,
      card: "FE-34",
      mode: "work",
    });
    expect(claude.session.card).toBe("FE-34");
    expect(claude.args).toEqual([
      "claude",
      "--session-id",
      claude.session.resume,
      cardPrompt("work", board, "FE-34"),
    ]);
    expect(claude.args[3]).toContain(`card FE-34 on board ${board}`);
    // A card with streams makes the agent the lead (BE-19): it runs the
    // card's dispatch, one sub-agent per stream, and checkpoints per wave.
    expect(claude.args[3]).toMatch(
      /If the card has streams, you are the lead: run its dispatch wave by wave, one sub-agent per stream in its own worktree/,
    );
    expect(claude.args[3]).toContain("checkpoint once per wave");

    // Codex takes the prompt alone; a uuid names a card with no task id.
    const uuidCard = "0bbfb085-821a-4233-8faf-fef325e501bb";
    const codex = await run("codex", {
      boardId: board,
      card: uuidCard,
      mode: "review",
    });
    expect(codex.session.card).toBe(uuidCard);
    expect(codex.args).toEqual([
      "codex",
      cardPrompt("review", board, uuidCard),
    ]);
    expect(codex.args[1]).toMatch(/^Review lanework card .* with me first/);
    expect(codex.args[1]).toContain(
      "If the card has streams, you are the lead",
    );

    // Anything else is no card at all: a plain new conversation, nothing
    // typed after the CLI's own arguments.
    for (const hostile of [
      { boardId: board, card: "FE-1; rm -rf ~", mode: "work" },
      { boardId: board, card: "$(id)", mode: "work" },
      { boardId: board, card: "FE-1\nid", mode: "work" },
      { boardId: board, card: "fe-34", mode: "work" },
      { boardId: "x'; id; '", card: "FE-34", mode: "work" },
      { boardId: board, card: "FE-34", mode: "anything" },
      { card: "FE-34", mode: "work" },
      "FE-34",
    ]) {
      const refused = await run("claude", hostile);
      expect(refused.session.card).toBeNull();
      expect(refused.args).toEqual([
        "claude",
        "--session-id",
        refused.session.resume,
      ]);
    }

    // A resumed conversation has its own history: the card is ignored.
    const resumed = await run(
      "claude",
      { boardId: board, card: "FE-34", mode: "work" },
      CLAUDE_ID,
    );
    expect(resumed.session.card).toBeNull();
    expect(resumed.args).toEqual(["claude", "--resume", CLAUDE_ID]);
  } finally {
    sessions.killAll();
  }
});

test("FE-34: a card ref is a task id or a uuid, and nothing a shell reads as syntax", () => {
  for (const good of ["FE-34", "INF-1", "PD-02", "ABCDEF-12345"])
    expect(isCardRef(good), good).toBe(true);
  expect(isCardRef("0bbfb085-821a-4233-8faf-fef325e501bb")).toBe(true);
  for (const bad of [
    "fe-34",
    "FE-34 ",
    "FE-34\n",
    "FE-1; id",
    "$(id)",
    "`id`",
    "FE-34'",
    "ABCDEFG-1",
    "FE-123456",
    "",
    42,
    null,
  ])
    expect(isCardRef(bad), String(bad)).toBe(false);
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

test("a conversation lists the agents it spawned under it — and Codex's own helpers nowhere (FE-33)", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  await seedAgentHome(home, folder);
  await seedSubagents(home, folder);

  const listed = await listAgentSessions(home, folder);
  // The guardian is no conversation, and no spawned one is a row of its own.
  expect(listed.map(({ agent, id }) => `${agent}:${id}`).sort()).toEqual([
    `claude:${CLAUDE_ID}`,
    `codex:${CODEX_ID}`,
  ]);
  const claude = listed.find((entry) => entry.agent === "claude");
  expect(
    claude?.subagents.map(({ id, title, type, working }) => ({
      id,
      title,
      type,
      working,
    })),
  ).toEqual([
    { id: "going", title: "Count the tests", type: null, working: true },
    {
      id: "handback",
      title: "Find specs",
      type: "general-purpose",
      working: false,
    },
    { id: "done", title: "Map the rail code", type: "Explore", working: false },
  ]);
  const codex = listed.find((entry) => entry.agent === "codex");
  expect(
    codex?.subagents.map(({ id, title, type, working }) => ({
      id,
      title,
      type,
      working,
    })),
  ).toEqual([
    {
      id: CODEX_SPAWNED_ID,
      title: "Gibbs: social card",
      type: null,
      working: true,
    },
  ]);
  // A thread Codex started is no new tab's conversation either.
  expect(
    (await codexStarts(home, folder)).map((start) => start.id),
  ).not.toContain(CODEX_SPAWNED_ID);
  expect(
    (await codexStarts(home, folder)).map((start) => start.id),
  ).not.toContain(CODEX_GUARDIAN_ID);

  expect(
    claudeSubagentWorking([
      { type: "user", isSidechain: true, message: { content: "Go" } },
      { type: "attachment" },
    ]),
  ).toBe(true);
  expect(
    claudeSubagentWorking([
      { type: "user", isSidechain: true, message: { content: "Go" } },
      { type: "user", message: { content: "[Request interrupted by user]" } },
    ]),
  ).toBe(false);
});

test("the watcher reports a sub-agent's writes as its conversation's sub-agent — never a guardian's (FE-33)", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  await seedAgentHome(home, folder);
  await seedSubagents(home, folder);
  const seen: string[] = [];
  const stop = watchAgentActivity(
    home,
    folder,
    (agent, id, working, _card, subagent) =>
      seen.push(`${agent}:${id}:${subagent}:${working}`),
  );
  const claude = join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    CLAUDE_ID,
    "subagents",
    "agent-done.jsonl",
  );
  const day = join(home, ".codex", "sessions", "2026", "09", "26");
  const spawned = join(
    day,
    `rollout-2026-09-26T07-10-00-${CODEX_SPAWNED_ID}.jsonl`,
  );
  const guardian = join(
    day,
    `rollout-2026-09-26T07-20-00-${CODEX_GUARDIAN_ID}.jsonl`,
  );
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  /**
   * The two written here, each by its latest word.
   *
   * ⚠️ Only theirs: the seeding just before the watch started may be
   * reported late (macOS replays recent writes), which is true of the other
   * sub-agents and no failure. And the LATEST: a sub-agent's every settled
   * write is news (FE-35/D11), so the last two said need not be one of each.
   */
  const written = [
    `claude:${CLAUDE_ID}:done`,
    `codex:${CODEX_ID}:${CODEX_SPAWNED_ID}`,
  ];
  const latest = () =>
    [
      ...new Map(
        seen
          .map((key) => [key.slice(0, key.lastIndexOf(":")), key] as const)
          .filter(([who]) => written.includes(who)),
      ).values(),
    ].sort();
  try {
    // ⚠️ Written AGAIN until it is seen, as the watcher spec above does.
    await expect(async () => {
      await appendFile(
        claude,
        line({ type: "user", isSidechain: true, message: { content: "More" } }),
      );
      await appendFile(
        spawned,
        line({ type: "event_msg", payload: { type: "task_started" } }),
      );
      await appendFile(
        guardian,
        line({ type: "event_msg", payload: { type: "task_started" } }),
      );
      await expect
        .poll(latest, { timeout: 1_500 })
        .toEqual([
          `claude:${CLAUDE_ID}:done:true`,
          `codex:${CODEX_ID}:${CODEX_SPAWNED_ID}:true`,
        ]);
    }).toPass({ timeout: 15_000 });

    await appendFile(
      claude,
      line({
        type: "assistant",
        isSidechain: true,
        message: { stop_reason: "end_turn", content: [] },
      }),
    );
    await appendFile(
      spawned,
      line({ type: "event_msg", payload: { type: "task_complete" } }),
    );
    await expect
      .poll(latest)
      .toEqual([
        `claude:${CLAUDE_ID}:done:false`,
        `codex:${CODEX_ID}:${CODEX_SPAWNED_ID}:false`,
      ]);
    expect(seen.some((key) => key.includes(CODEX_GUARDIAN_ID))).toBe(false);
    // The conversations themselves were not written: no news of them.
    expect(seen.some((key) => key.includes(":null:"))).toBe(false);
  } finally {
    stop();
  }
});

test("FE-35: a sub-agent reads as its prompt, its tool calls and its report — a fork's own directive, a handback's report, a Codex thread's calls", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  await seedAgentHome(home, folder);
  await seedSubagents(home, folder);
  await seedForkSubagent(home, folder);
  const claude = (sub: string) =>
    readSubagentTranscript(home, folder, {
      agent: "claude",
      conversation: CLAUDE_ID,
      sub,
    });
  const brief = (steps: { tool: string; summary: string; error: boolean }[]) =>
    steps.map(({ tool, summary, error }) => ({ tool, summary, error }));

  // Answered with `end_turn`: its last words are the report; a failed call
  // is flagged, and its result is never carried over (FE-35/D3).
  const done = await claude("done");
  expect(done).toMatchObject({
    title: "Map the rail code",
    type: "Explore",
    model: "claude-haiku-4-5-20251001",
    startedAt: "2026-09-26T07:00:00.000Z",
    endedAt: "2026-09-26T07:01:08.000Z",
    working: false,
    prompt: "Map the rail",
    report: "The rail is **mapped**.",
    truncated: false,
  });
  expect(brief(done.steps)).toEqual([
    { tool: "Grep", summary: '"subagents" src', error: false },
    { tool: "Read", summary: "src/nav.tsx:410-470", error: true },
  ]);
  expect(JSON.parse(done.steps[1]?.input ?? "")).toMatchObject({
    offset: 410,
    limit: 61,
  });
  expect(JSON.stringify(done)).not.toContain("File does not exist");

  // Handed back: the handback is the report, never a step; what the CLI
  // reminded it of is no prompt.
  const handback = await claude("handback");
  expect(handback).toMatchObject({
    title: "Find specs",
    type: "general-purpose",
    working: false,
    prompt: "Find the specs",
    report: "Two specs: `terminal` and `agents`.",
  });
  expect(brief(handback.steps)).toEqual([
    { tool: "Glob", summary: '"tests/*.spec.ts"', error: false },
  ]);

  // Still going: no report yet, and no meta to name it by but its prompt.
  const going = await claude("going");
  expect(going).toMatchObject({
    title: "Count the tests",
    type: null,
    working: true,
    report: null,
  });
  expect(going.steps.map((step) => step.tool)).toEqual(["Bash"]);

  // A fork: its prompt is its OWN directive — not the parent's history it
  // was handed, nor the rules wrapped around it — and the parent's call
  // that spawned it is none of its steps.
  const fork = await claude("fork");
  expect(fork).toMatchObject({
    title: "Fork: which model",
    type: "fork",
    model: "claude-opus-5-5",
    startedAt: "2026-09-26T07:30:01.000Z",
    working: false,
    prompt: "Say which model you are",
    steps: [],
    report: "Opus 5.5.",
  });

  // A Codex thread: its function and `exec` calls, the one whose script
  // failed flagged; its task as its spawner sent it.
  const codex = () =>
    readSubagentTranscript(home, folder, {
      agent: "codex",
      conversation: CODEX_ID,
      sub: CODEX_SPAWNED_ID,
    });
  const thread = await codex();
  expect(thread).toMatchObject({
    title: "Gibbs: social card",
    model: "gpt-5.6-sol",
    working: true,
    prompt: "Draw the social card",
    report: null,
  });
  expect(brief(thread.steps)).toEqual([
    { tool: "exec_command", summary: "ls public", error: false },
    { tool: "exec", summary: "sips -g pixelWidth card.png", error: true },
  ]);
  await appendFile(
    join(
      home,
      ".codex",
      "sessions",
      "2026",
      "09",
      "26",
      `rollout-2026-09-26T07-10-00-${CODEX_SPAWNED_ID}.jsonl`,
    ),
    `${JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "Card drawn." },
    })}\n`,
  );
  expect(await codex()).toMatchObject({
    working: false,
    report: "Card drawn.",
  });
});

test("FE-35: a sub-agent is read by ids alone — a path, `..` or any other shape is refused, and nothing outside the CLI's folder is read", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  await seedAgentHome(home, folder);
  await seedSubagents(home, folder);
  // A transcript-shaped file OUTSIDE the agent home, worth stealing.
  const outside = await tempDir("lanew-outside-");
  const secret = join(outside, "agent-secret.jsonl");
  await writeFile(
    secret,
    `${JSON.stringify({ type: "user", message: { content: "TOP SECRET" } })}\n`,
  );

  expect(subagentRequest(["ws-alpha", "claude", CLAUDE_ID, "done"])).toEqual({
    workspace: "ws-alpha",
    agent: "claude",
    conversation: CLAUDE_ID,
    sub: "done",
  });
  expect(
    subagentRequest(["ws-alpha", "codex", CODEX_ID, CODEX_SPAWNED_ID]).sub,
  ).toBe(CODEX_SPAWNED_ID);
  const refused: unknown[][] = [
    ["ws-alpha", "claude", CLAUDE_ID, "../../../../outside/agent-secret"],
    ["ws-alpha", "claude", CLAUDE_ID, secret],
    ["ws-alpha", "claude", CLAUDE_ID, "done.jsonl"],
    ["ws-alpha", "claude", CLAUDE_ID, ".."],
    ["ws-alpha", "claude", CLAUDE_ID, "a/b"],
    ["ws-alpha", "claude", CLAUDE_ID, "a\\b"],
    ["ws-alpha", "claude", CLAUDE_ID, ""],
    ["ws-alpha", "claude", CLAUDE_ID, 7],
    ["ws-alpha", "claude", `${CLAUDE_ID}/..`, "done"],
    ["ws-alpha", "claude", "../projects", "done"],
    ["ws-alpha", "claude", outside, "done"],
    // A Codex thread is a UUID, never a Claude-shaped name.
    ["ws-alpha", "codex", CODEX_ID, "done"],
    ["ws-alpha", "shell", CLAUDE_ID, "done"],
    ["", "claude", CLAUDE_ID, "done"],
    ["ws-alpha", "claude", CLAUDE_ID],
    ["ws-alpha", "claude", CLAUDE_ID, "done", "extra"],
  ];
  for (const args of refused)
    expect(() => subagentRequest(args), JSON.stringify(args)).toThrow(
      /required/,
    );
  // The reader checks them again, whoever calls it.
  for (const sub of ["../../../../outside/agent-secret", secret, "a/b"])
    await expect(
      readSubagentTranscript(home, folder, {
        agent: "claude",
        conversation: CLAUDE_ID,
        sub,
      }),
    ).rejects.toThrow(/valid sub-agent/);

  // Well shaped, but not this conversation's in this folder: refused too —
  // no such Claude file; Codex's other folder's rollout, its guardian, and
  // a thread named under the wrong conversation.
  const notOurs = /not one of this conversation's/;
  await expect(
    readSubagentTranscript(home, folder, {
      agent: "claude",
      conversation: CLAUDE_ID,
      sub: "secret",
    }),
  ).rejects.toThrow(notOurs);
  for (const [conversation, sub] of [
    [CODEX_ID, "01a0db07-52f1-7020-abe9-000000000000"],
    [CODEX_ID, CODEX_GUARDIAN_ID],
    [CLAUDE_ID, CODEX_SPAWNED_ID],
  ] as const)
    await expect(
      readSubagentTranscript(home, folder, {
        agent: "codex",
        conversation,
        sub,
      }),
    ).rejects.toThrow(notOurs);
});

const factsLine = (value: unknown) => `${JSON.stringify(value)}\n`;

/** A Claude answer with its usage, as the CLI writes one line of it. */
function answer(id: string, cacheRead: number, output = 100) {
  return {
    type: "assistant",
    message: {
      id,
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
        output_tokens: output,
      },
      content: [],
    },
  };
}

test("FE-38: a Claude conversation's numbers are its newest cost-state's — and the answers since are added, once each", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  await seedAgentHome(home, folder);
  await seedAgentFacts(home, folder);
  const file = join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    `${CLAUDE_ID}.jsonl`,
  );

  // The newer of two `cost-state`s and two recaps; the cut `cost-state`
  // after them, and the sub-agent's answer, count for nothing.
  expect(await readAgentFacts(home, folder, "claude", CLAUDE_ID)).toEqual({
    agent: "claude",
    model: "claude-opus-5-5",
    effort: null,
    costUSD: 0.7312,
    stale: false,
    tokens: { input: 141_000, output: 4020, cached: 130_000 },
    context: { tokens: 142_320, window: null },
    lines: { added: 120, removed: 8 },
    duration: { wall: 252_000, api: 90_000, tools: 30_000 },
    recap: {
      text: "Fixed the flaky login test; the retry is next.",
      at: "2026-09-26T08:00:00.000Z",
    },
    partial: false,
  });

  // A turn after Claude last saved: its answer — two lines, one id — joins
  // the tokens once, is the context now, and the saved totals are stale.
  await appendFile(
    file,
    factsLine({ type: "user", message: { content: "And the retry?" } }) +
      factsLine(answer("msg_third", 150_000, 300)) +
      factsLine(answer("msg_third", 150_000, 300)),
  );
  const after = await readAgentFacts(home, folder, "claude", CLAUDE_ID);
  expect(after.stale).toBe(true);
  expect(after.costUSD).toBe(0.7312);
  expect(after.tokens).toEqual({
    input: 141_000 + 150_001,
    output: 4020 + 300,
    cached: 130_000 + 150_000,
  });
  expect(after.context).toEqual({ tokens: 150_001, window: null });

  // Saved again: the new totals, nothing added on top.
  await appendFile(
    file,
    factsLine({
      type: "cost-state",
      totalCostUSD: 0.91,
      modelUsage: { "claude-opus-5-5": { inputTokens: 300_000 } },
    }),
  );
  const saved = await readAgentFacts(home, folder, "claude", CLAUDE_ID);
  expect(saved.stale).toBe(false);
  expect(saved.costUSD).toBe(0.91);
  expect(saved.tokens).toEqual({ input: 300_000, output: 0, cached: 0 });
  // Nothing saved for these: not known, never a 0.
  expect(saved.lines).toBeNull();
  expect(saved.duration).toBeNull();

  // Recap off, never saved — a conversation running now: what its answers
  // say, read to its start; no cost, no recap.
  const fresh = "44444444-2222-4333-8444-555555555555";
  await writeFile(
    join(
      home,
      ".claude",
      "projects",
      claudeProjectDir(folder),
      `${fresh}.jsonl`,
    ),
    factsLine({ type: "user", cwd: folder, message: { content: "Go" } }) +
      factsLine(answer("msg_a", 1000, 10)) +
      factsLine(answer("msg_b", 2000, 20)),
  );
  expect(await readAgentFacts(home, folder, "claude", fresh)).toMatchObject({
    costUSD: null,
    stale: false,
    tokens: { input: 3002, output: 30, cached: 3000 },
    context: { tokens: 2001, window: null },
    recap: null,
    partial: false,
  });
});

test("FE-38: a cost-state is found behind the last 64 KB — and past 4 MB the read stops, with what it found", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  const dir = join(home, ".claude", "projects", claudeProjectDir(folder));
  await mkdir(dir, { recursive: true });
  const head =
    factsLine({ type: "user", cwd: folder, message: { content: "Go" } }) +
    factsLine({ type: "cost-state", totalCostUSD: 1.5 });
  // Bookkeeping Claude writes between turns, ~1 KB a line.
  const filler = (bytes: number) =>
    factsLine({
      type: "attachment",
      attachment: { text: "x".repeat(1000) },
    }).repeat(Math.ceil(bytes / 1040));

  const near = "55555555-2222-4333-8444-555555555555";
  await writeFile(
    join(dir, `${near}.jsonl`),
    head + filler(300 * 1024) + factsLine(answer("msg_end", 9000)),
  );
  const found = await readAgentFacts(home, folder, "claude", near);
  expect(found.costUSD).toBe(1.5);
  expect(found.context?.tokens).toBe(9001);
  expect(found.partial).toBe(false);

  // Past the cap the `cost-state` at its start is never reached: partial,
  // with the newest answer's context — and no cost or tokens it cannot
  // vouch for, rather than the whole file read.
  const far = "66666666-2222-4333-8444-555555555555";
  await writeFile(
    join(dir, `${far}.jsonl`),
    head +
      filler(AGENT_FACTS_READ_MAX + 512 * 1024) +
      factsLine(answer("msg_end", 9000)),
  );
  const capped = await readAgentFacts(home, folder, "claude", far);
  expect(capped).toMatchObject({
    model: "claude-opus-5-5",
    costUSD: null,
    tokens: null,
    context: { tokens: 9001, window: null },
    partial: true,
  });
});

test("FE-38: a Codex conversation's numbers are its newest token_count's — its context a share of the window only when Codex records one", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  await seedAgentHome(home, folder);
  await seedAgentFacts(home, folder);

  // The newest `token_count` says nothing (`info: null`): the one before.
  expect(await readAgentFacts(home, folder, "codex", CODEX_ID)).toEqual({
    agent: "codex",
    model: "gpt-6.1-sol",
    effort: "low",
    costUSD: null,
    stale: false,
    tokens: { input: 1_753_176, output: 17_326, cached: 1_665_152 },
    context: { tokens: 88_039, window: 258_400 },
    lines: null,
    duration: null,
    recap: null,
    partial: false,
  });

  // No window recorded: a count, no share (FE-38/D2).
  await appendFile(
    join(
      home,
      ".codex",
      "sessions",
      "2026",
      "09",
      "26",
      `rollout-2026-09-26T07-04-45-${CODEX_ID}.jsonl`,
    ),
    factsLine({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 1_900_000, output_tokens: 20_000 },
          last_token_usage: { input_tokens: 95_000 },
        },
      },
    }),
  );
  expect(
    (await readAgentFacts(home, folder, "codex", CODEX_ID)).context,
  ).toEqual({ tokens: 95_000, window: null });
});

test("FE-38: a conversation's numbers are read by ids alone — another shape, another folder's conversation or a sub-agent are refused", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  await seedAgentHome(home, folder);
  await seedSubagents(home, folder);
  const outside = await tempDir("lanew-outside-");

  expect(factsRequest(["ws-alpha", "claude", CLAUDE_ID])).toEqual({
    workspace: "ws-alpha",
    agent: "claude",
    id: CLAUDE_ID,
  });
  const refused: unknown[][] = [
    ["ws-alpha", "claude", "../../../../outside/secret"],
    ["ws-alpha", "claude", join(outside, "secret")],
    ["ws-alpha", "claude", `${CLAUDE_ID}.jsonl`],
    ["ws-alpha", "claude", `${CLAUDE_ID}/..`],
    ["ws-alpha", "claude", ""],
    ["ws-alpha", "claude", 7],
    ["ws-alpha", "shell", CLAUDE_ID],
    ["", "claude", CLAUDE_ID],
    ["ws-alpha", "claude"],
    ["ws-alpha", "claude", CLAUDE_ID, "extra"],
  ];
  for (const args of refused)
    expect(() => factsRequest(args), JSON.stringify(args)).toThrow(/required/);
  // The reader checks the id again, whoever calls it.
  await expect(
    readAgentFacts(home, folder, "claude", "../../../../outside/secret"),
  ).rejects.toThrow(/valid conversation/);

  // Well shaped, but not this folder's conversation: Claude's under a name
  // two folders share, Codex's other folder's rollout, its guardian, and a
  // thread a conversation spawned.
  const notOurs = /not one of this project's/;
  await expect(
    readAgentFacts(
      home,
      folder,
      "claude",
      "33333333-2222-4333-8444-555555555555",
    ),
  ).rejects.toThrow(notOurs);
  await expect(
    readAgentFacts(
      home,
      folder,
      "claude",
      "77777777-2222-4333-8444-555555555555",
    ),
  ).rejects.toThrow(notOurs);
  for (const id of [
    "01a0db07-52f1-7020-abe9-000000000000",
    CODEX_GUARDIAN_ID,
    CODEX_SPAWNED_ID,
  ])
    await expect(readAgentFacts(home, folder, "codex", id)).rejects.toThrow(
      notOurs,
    );
});

test("FE-38/D6: a project's usage totals each conversation written in the last 7 and 30 days — a Codex thread's spawns for their tokens only", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  await seedAgentHome(home, folder);
  await seedAgentFacts(home, folder);
  await seedSubagents(home, folder);
  const dir = join(home, ".claude", "projects", claudeProjectDir(folder));
  const day = 24 * 60 * 60;
  const now = Date.now() / 1000;
  // Written ten days ago: the 30 days' only. Forty: neither.
  for (const [id, age, cost] of [
    ["88888888-2222-4333-8444-555555555555", 10, 1.5],
    ["99999999-2222-4333-8444-555555555555", 40, 7],
  ] as const) {
    const file = join(dir, `${id}.jsonl`);
    await writeFile(
      file,
      factsLine({ type: "user", cwd: folder, message: { content: "Go" } }) +
        factsLine({
          type: "cost-state",
          totalCostUSD: cost,
          modelUsage: { m: { inputTokens: 1000, outputTokens: 10 } },
        }),
    );
    await utimes(file, now - age * day, now - age * day);
  }
  // The thread the Codex conversation spawned spent tokens of its own.
  await appendFile(
    join(
      home,
      ".codex",
      "sessions",
      "2026",
      "09",
      "26",
      `rollout-2026-09-26T07-10-00-${CODEX_SPAWNED_ID}.jsonl`,
    ),
    factsLine({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 5000, output_tokens: 50 },
        },
      },
    }),
  );

  const usage = await readAgentUsage(home, folder);
  expect(usage.skipped).toBe(0);
  expect(usage.windows.map((window) => window.days)).toEqual([7, 30]);
  const [week, month] = usage.windows;
  // The seeded conversation; the empty one, the other folder's and the
  // badly named one count for nothing.
  expect(week?.claude).toEqual({
    conversations: 1,
    costUSD: 0.7312,
    input: 141_000,
    output: 4020,
  });
  expect(month?.claude.conversations).toBe(2);
  expect(month?.claude.costUSD).toBeCloseTo(2.2312, 6);
  expect(month?.claude.input).toBe(142_000);
  // Codex: one conversation; its spawned thread's tokens, never its
  // guardian's or another folder's.
  expect(week?.codex).toEqual({
    conversations: 1,
    costUSD: null,
    input: 1_753_176 + 5000,
    output: 17_326 + 50,
  });
  expect(month?.codex).toEqual(week?.codex);
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
    card: null,
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

const HOUR = 3_600_000;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("FE-41: Codex's usage is the last `token_count` that reported it, in the rollout written last", async () => {
  const codex = join(await tempDir("lanew-codex-"), ".codex");
  const day = join(codex, "sessions", "2026", "10", "03");
  await mkdir(day, { recursive: true });
  const soon = Date.now() + 2 * HOUR;
  const later = Date.now() + 100 * HOUR;
  const rollout = (time: string, id: string) =>
    join(day, `rollout-2026-10-03T${time}-01a0db07-52f1-7020-abe9-${id}.jsonl`);
  // Written last of those that reported: several reports, and after the one
  // to take, a `premium` one with no window, a null one — and a tool output
  // longer than the first read of its end.
  const reported = rollout("08-00-00", "000000000001");
  await writeFile(
    reported,
    line({ type: "session_meta", payload: { id: "x", cwd: "/tmp" } }) +
      line(
        codexTokenCount(
          "2026-10-03T08:01:00.000Z",
          codexRateLimits(
            { used: 3, resetsAt: soon },
            { used: 1, resetsAt: later },
          ),
        ),
      ) +
      line(
        codexTokenCount(
          "2026-10-03T08:02:00.000Z",
          codexRateLimits(
            { used: 6, resetsAt: soon },
            { used: 2, resetsAt: later },
          ),
        ),
      ) +
      line(
        codexTokenCount("2026-10-03T08:03:00.000Z", {
          limit_id: "premium",
          primary: null,
          secondary: null,
        }),
      ) +
      line(codexTokenCount("2026-10-03T08:04:00.000Z", null)) +
      line({ type: "event_msg", payload: { type: "task_complete" } }) +
      line({
        type: "response_item",
        payload: { type: "function_call_output", output: "x".repeat(100_000) },
      }),
  );
  // Started later, but last written before it: older numbers.
  const older = rollout("09-00-00", "000000000002");
  await writeFile(
    older,
    line(
      codexTokenCount(
        "2026-10-03T07:00:00.000Z",
        codexRateLimits(
          { used: 50, resetsAt: soon },
          { used: 40, resetsAt: later },
        ),
      ),
    ),
  );
  // Written just now, with no report yet: passed over.
  const fresh = rollout("10-00-00", "000000000003");
  await writeFile(
    fresh,
    line({ type: "session_meta", payload: { id: "y", cwd: "/tmp" } }),
  );
  const now = Date.now() / 1000;
  await utimes(older, now - 3600, now - 3600);
  await utimes(reported, now - 60, now - 60);

  const expected = {
    primary: {
      usedPercent: 6,
      windowMinutes: 300,
      resetsAt: Math.floor(soon / 1000) * 1000,
    },
    secondary: {
      usedPercent: 2,
      windowMinutes: 10_080,
      resetsAt: Math.floor(later / 1000) * 1000,
    },
    plan: "plus",
    at: "2026-10-03T08:02:00.000Z",
  };
  expect(await readCodexQuota(codex)).toEqual(expected);
  // With the goals, side by side; no history at all is none, not an error.
  expect(
    await readCodexUsage({ home: codex, sqlite: codex }, [CODEX_ID]),
  ).toEqual({ quota: expected, goals: {} });
  expect(await readCodexQuota(await tempDir("lanew-codex-empty-"))).toBeNull();
});

test("FE-41: a goal is read for its own thread from Codex's newest goals database — one that cannot be read is no goals, and none is ever written", async () => {
  const sqlite = await tempDir("lanew-codex-sqlite-");
  // None yet.
  expect(await readCodexGoals(sqlite, [CODEX_ID])).toEqual({});

  const other = "01a0db07-52f1-7020-abe9-444444444444";
  const goal = {
    threadId: CODEX_ID,
    objective: "Ship the quota bar\n  on the rail",
    status: "usage_limited",
    tokenBudget: 500_000,
    tokensUsed: 363_078,
    timeUsedSeconds: 2_015,
  };
  // An older schema's file: `goals_2` sorts after `goals_10` as text, never
  // as a number.
  await seedCodexGoals(
    sqlite,
    [{ ...goal, status: "active" }],
    "goals_2.sqlite",
  );
  const file = await seedCodexGoals(
    sqlite,
    [goal, { ...goal, threadId: other, objective: "Not asked for" }],
    "goals_10.sqlite",
  );
  // ⚠️ Read-only for real: a file nobody may write still reads.
  await chmod(file, 0o444);
  const before = {
    bytes: await readFile(file),
    mtime: (await stat(file)).mtimeMs,
    names: (await readdir(sqlite)).sort(),
  };
  const read = await readCodexGoals(sqlite, [
    CODEX_ID,
    "x') OR 1=1 --",
    CODEX_ID,
  ]);
  expect(read).toEqual({
    [CODEX_ID]: {
      objective: "Ship the quota bar\n  on the rail",
      status: "usage_limited",
      tokenBudget: 500_000,
      tokensUsed: 363_078,
      timeUsedSeconds: 2_015,
      updatedAt: 1_790_649_031_534,
    },
  });
  // No thread asked for: the file is not even opened.
  expect(await readCodexGoals(sqlite, [])).toEqual({});
  // Never written: not a byte, not its time, no journal beside it.
  expect(await readFile(file)).toEqual(before.bytes);
  expect((await stat(file)).mtimeMs).toBe(before.mtime);
  expect((await readdir(sqlite)).sort()).toEqual(before.names);

  // Locked by a writer: no goals, no error — and back once it lets go.
  await chmod(file, 0o644);
  const { DatabaseSync } = await import("node:sqlite");
  const writer = new DatabaseSync(file);
  writer.exec("BEGIN EXCLUSIVE");
  try {
    expect(await readCodexGoals(sqlite, [CODEX_ID])).toEqual({});
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  expect(Object.keys(await readCodexGoals(sqlite, [CODEX_ID]))).toEqual([
    CODEX_ID,
  ]);

  // A newer schema this does not know: no goals.
  const changed = new DatabaseSync(join(sqlite, "goals_11.sqlite"));
  changed.exec(
    "CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, goal TEXT)",
  );
  changed.prepare("INSERT INTO thread_goals VALUES (?, ?)").run(CODEX_ID, "x");
  changed.close();
  expect(await readCodexGoals(sqlite, [CODEX_ID])).toEqual({});
  // Not a database at all: no goals.
  await writeFile(join(sqlite, "goals_12.sqlite"), "not a database");
  expect(await readCodexGoals(sqlite, [CODEX_ID])).toEqual({});
});

const FE41_WORKSPACES = [
  {
    id: "ws-alpha",
    slug: "alpha",
    name: "Alpha",
    path: null,
    baseBranch: null,
  },
  { id: "ws-beta", slug: "beta", name: "Beta", path: null, baseBranch: null },
];

/**
 * An app booted on a profile whose Alpha project is linked to a folder, its
 * agents' conversations read from a fake home `seed` fills (FE-41).
 */
async function bootOnAgentHome(
  origin: string,
  seed: (agentHome: string, repo: string) => Promise<void>,
) {
  const profile = await mkdtemp(join(tmpdir(), "lanew-codex-usage-"));
  const home = join(profile, "home");
  const repo = await realpath(await mkdtemp(join(tmpdir(), "lanew-repo-")));
  await mkdir(home, { recursive: true });
  await seedCredential(home, origin);
  const previous = process.env.LANEWORK_HOME;
  process.env.LANEWORK_HOME = home;
  await writeFolders(
    {
      machineId: "test-machine",
      userId: "test-user",
      apiUrl: origin,
      name: "test-machine",
      secret: "lw_mch_test-secret",
      owner: null,
    } satisfies MachineRecord,
    "alpha",
    [repo],
  );
  if (previous === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previous;
  const agentHome = join(profile, "agent-home");
  await seed(agentHome, repo);
  // A stand-in Codex: says it ran, then waits like a real CLI.
  const codexBin = join(profile, "codex-stand-in.sh");
  await writeFile(
    codexBin,
    `#!/bin/sh\nprintf 'ran-codex-%s\\n' "$@"\nwhile IFS= read -r line; do [ "$line" = "/exit" ] && exit 0; done\n`,
    { mode: 0o755 },
  );
  const app = await electron.launch({
    args: [process.cwd()],
    env: {
      ...launchEnv({ profile, home, apiUrl: origin }),
      LANEWORK_TERMINAL_SHELL: "/bin/sh",
      LANEWORK_TEST_AGENT_HOME: agentHome,
      LANEWORK_TERMINAL_AGENTS: "claude,codex",
      LANEWORK_CODEX_BIN: codexBin,
    },
  });
  return { app, profile };
}

async function openProject(page: Page, name: string) {
  await page.getByRole("button", { name: /^Switch project/ }).click();
  await page.getByRole("option", { name }).first().click();
  await expect(
    page.getByRole("button", { name: `Switch project — currently ${name}` }),
  ).toBeVisible();
}

test("FE-41: the rail shows Codex's usage until each window resets, and a goal's status on its conversation", async () => {
  test.skip(process.platform === "win32", "This drives a POSIX shell.");
  const plane = await startStubPlane({ workspaces: FE41_WORKSPACES });
  const board = {
    columns: [{ key: "todo", name: "To-Do", role: "start" }],
    cards: [],
  };
  plane.setBoard("ws-alpha", board);
  plane.setBoard("ws-beta", board);
  let rollout = "";
  const { app, profile } = await bootOnAgentHome(
    plane.origin,
    async (agentHome, repo) => {
      await seedAgentHome(agentHome, repo);
      const codex = join(agentHome, ".codex");
      rollout = join(
        codex,
        "sessions",
        "2026",
        "09",
        "26",
        `rollout-2026-09-26T07-04-45-${CODEX_ID}.jsonl`,
      );
      await appendFile(
        rollout,
        line(
          codexTokenCount(
            new Date().toISOString(),
            codexRateLimits(
              { used: 6, resetsAt: Date.now() + 2 * HOUR },
              { used: 1, resetsAt: Date.now() + 100 * HOUR },
            ),
          ),
        ),
      );
      await seedCodexGoals(codex, [
        {
          threadId: CODEX_ID,
          objective: "Ship the quota bar",
          status: "usage_limited",
          tokenBudget: 500_000,
          tokensUsed: 363_078,
          timeUsedSeconds: 2_015,
        },
      ]);
    },
  );
  try {
    const page = await app.firstWindow();
    await openProject(page, "Alpha");
    const group = page.getByRole("navigation", { name: "Agents" });
    const quota = group.getByTestId("codex-quota");
    // Read from the fake home with the listing; the details are in it for
    // anybody who cannot hover.
    await expect(quota).toContainText("Codex 5h 6%, week 1%");
    await expect(quota).toContainText("week resets");
    await expect(quota).toContainText("As of");
    // The goal that ran out of usage says so on its own row, and only there.
    const codexRow = page.getByRole("button", {
      name: "Resume “Settings page cleanup” in Codex",
    });
    await expect(codexRow.getByTestId("codex-goal-badge")).toHaveAttribute(
      "aria-label",
      "Goal usage limit",
    );
    await expect(
      page
        .getByRole("button", { name: "Resume “Flaky login test” in Claude" })
        .getByTestId("codex-goal-badge"),
    ).toHaveCount(0);

    // A turn reports again — its 5-hour window already past: that number
    // goes, the week's stays (FE-41/D3). Read as the watcher settles it.
    // ⚠️ Written AGAIN until it is seen: the OS watcher takes a moment.
    await expect(async () => {
      await appendFile(
        rollout,
        line({ type: "event_msg", payload: { type: "task_started" } }) +
          line(
            codexTokenCount(
              new Date().toISOString(),
              codexRateLimits(
                { used: 99, resetsAt: Date.now() - 60_000 },
                { used: 2, resetsAt: Date.now() + 100 * HOUR },
              ),
            ),
          ),
      );
      await expect(quota).toContainText("Codex week 2%", { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(quota).not.toContainText("5h");

    // Both past: the bar goes.
    await appendFile(
      rollout,
      line(
        codexTokenCount(
          new Date().toISOString(),
          codexRateLimits(
            { used: 99, resetsAt: Date.now() - 60_000 },
            { used: 2, resetsAt: Date.now() - 60_000 },
          ),
        ),
      ) + line({ type: "event_msg", payload: { type: "task_complete" } }),
    );
    await expect(quota).toHaveCount(0, { timeout: 10_000 });

    // Its agent view says what the goal is, where it stands, and its tokens
    // against its budget (FE-41/D4).
    await codexRow.click();
    const view = page.getByRole("region", {
      name: "Codex — Settings page cleanup",
    });
    const goal = view.getByTestId("agent-facts");
    await expect(goal).toContainText("Ship the quota bar");
    await expect(goal).toContainText("usage limit");
    await expect(goal).toContainText("363.1K / 500K tokens");
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

/** A real repository at `folder`, its one commit stamped `committedAt`. */
function gitRepo(folder: string, committedAt: string) {
  // Whole seconds: git's own resolution.
  const date = committedAt.replace(/\.\d+Z$/, "Z");
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: folder,
      env,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "tester@example.com");
  git("config", "user.name", "Tester");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return git;
}

test("FE-39: a Claude conversation's files — file history or its tools alone, sub-agents folded in, nothing outside the repo", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = await tempDir("lanew-files-");
  const git = gitRepo(folder, tick(0));
  // A sub-agent's isolated checkout lives inside the folder: its edits are
  // that worktree's, never this one's.
  git(
    "worktree",
    "add",
    "-q",
    join(".claude", "worktrees", "iso"),
    "-b",
    "iso",
  );
  await seedClaudeEdits(home, folder);
  const subagents = join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    CLAUDE_EDITS_ID,
    "subagents",
  );
  await writeFile(
    join(subagents, "agent-iso.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      isSidechain: true,
      timestamp: tick(8),
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_iso",
            name: "Edit",
            input: {
              file_path: join(folder, ".claude", "worktrees", "iso", "a.ts"),
            },
          },
        ],
      },
    })}\n`,
  );

  // File history on: two edits, one delta — counted as two, not three. The
  // failed `Write` and the edit outside the folder are not files.
  expect(
    await readAgentFiles(home, folder, {
      agent: "claude",
      id: CLAUDE_EDITS_ID,
    }),
  ).toEqual({
    partial: false,
    files: [
      {
        path: "src/helper.ts",
        op: "added",
        edits: 1,
        lastAt: tick(7),
        via: { id: "helper", type: "general-purpose" },
      },
      // Its sub-agent edited it too: folded in, and not "via" — the
      // conversation edited it itself.
      {
        path: "src/router.tsx",
        op: "modified",
        edits: 3,
        lastAt: tick(6),
        via: null,
      },
      { path: "src/new.ts", op: "added", edits: 1, lastAt: tick(3), via: null },
    ],
  });
  // File history off: the tools alone, `Write`'s result saying "created".
  expect(
    await readAgentFiles(home, folder, {
      agent: "claude",
      id: CLAUDE_TOOLS_ID,
    }),
  ).toEqual({
    partial: false,
    files: [
      {
        path: "nb/analysis.ipynb",
        op: "modified",
        edits: 1,
        lastAt: tick(3),
        via: null,
      },
      {
        path: "src/router.tsx",
        op: "modified",
        edits: 1,
        lastAt: tick(2),
        via: null,
      },
      {
        path: "src/made.ts",
        op: "added",
        edits: 1,
        lastAt: tick(1),
        via: null,
      },
    ],
  });
});

test("FE-39: a Codex conversation's patches — add, update, delete and move — counted once, its thread folded in", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = await tempDir("lanew-files-");
  await seedCodexEdits(home, folder);
  expect(
    await readAgentFiles(home, folder, { agent: "codex", id: CODEX_EDITS_ID }),
  ).toEqual({
    partial: false,
    files: [
      {
        path: "src/spawned.ts",
        op: "added",
        edits: 1,
        lastAt: tick(4),
        via: { id: CODEX_EDITS_SPAWNED_ID, type: "worker" },
      },
      // The patch and its `FileChange` are one edit; the older CLI's call a
      // second.
      {
        path: "src/router.tsx",
        op: "modified",
        edits: 2,
        lastAt: tick(3),
        via: null,
      },
      {
        path: "src/script.ts",
        op: "modified",
        edits: 1,
        lastAt: tick(2),
        via: null,
      },
      {
        path: "docs/added.md",
        op: "added",
        edits: 1,
        lastAt: tick(1),
        via: null,
      },
      { path: "old.txt", op: "deleted", edits: 1, lastAt: tick(1), via: null },
      {
        path: "src/renamed.ts",
        op: "renamed",
        edits: 1,
        lastAt: tick(1),
        via: null,
      },
    ],
  });
  expect(
    patchedFiles(
      "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** Delete File: c.ts\n*** Add File: d.ts\n+x\n*** End Patch",
    ),
  ).toEqual([
    { path: "b.ts", op: "renamed" },
    { path: "c.ts", op: "deleted" },
    { path: "d.ts", op: "added" },
  ]);
});

test("FE-39: a re-read parses only what was appended, and a transcript past 32 MB is read from its end", async () => {
  const folder = await tempDir("lanew-files-");
  const file = join(await tempDir("lanew-scan-"), "t.jsonl");
  const edit = (name: string, at: string) =>
    `${JSON.stringify({
      type: "assistant",
      timestamp: at,
      message: {
        content: [
          {
            type: "tool_use",
            id: `toolu_${name}`,
            name: "Edit",
            input: { file_path: join(folder, `${name}.ts`) },
          },
        ],
      },
    })}\n`;
  await writeFile(file, edit("one", tick(1)));
  const paths = async () =>
    [...(await scanTranscript(file, "claude", folder)).files.keys()].map(
      (path) => path.slice(folder.length + 1),
    );
  expect(await paths()).toEqual(["one.ts"]);

  // The first line rewritten in place, the same length, and a line appended:
  // only the appended line is read — `uno` is never seen.
  const first = edit("one", tick(1));
  await writeFile(
    file,
    first.replace("one.ts", "uno.ts") + edit("two", tick(2)),
  );
  expect((await paths()).sort()).toEqual(["one.ts", "two.ts"]);
  // A line still being written is left for the next read.
  await appendFile(file, edit("six", tick(6)).slice(0, 40));
  expect((await paths()).sort()).toEqual(["one.ts", "two.ts"]);

  // Past 32 MB: its newest 32 MB, and it says so.
  const big = join(await tempDir("lanew-scan-"), "big.jsonl");
  const filler = `${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "x".repeat(1024 * 1024) }] },
  })}\n`;
  await writeFile(big, edit("early", tick(1)));
  for (let mb = 0; mb <= AGENT_FILES_READ_MAX / (1024 * 1024); mb++)
    await appendFile(big, filler);
  await appendFile(big, edit("late", tick(2)));
  const scanned = await scanTranscript(big, "claude", folder);
  expect(scanned.partial).toBe(true);
  expect([...scanned.files.keys()]).toEqual([join(folder, "late.ts")]);
});

test("FE-39: Changes marks only what a conversation edited since HEAD's commit — and files are asked for by ids alone", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = await tempDir("lanew-files-");
  // Committed after `src/new.ts` (tick 3), before the sub-agent's edits.
  gitRepo(folder, tick(4));
  await seedClaudeEdits(home, folder);
  expect(
    await agentFileMarks(home, folder, await listAgentSessions(home, folder)),
  ).toEqual({
    partial: false,
    files: {
      "src/helper.ts": [
        {
          agent: "claude",
          id: CLAUDE_EDITS_ID,
          title: "Wire the router",
          lastAt: tick(7),
          via: { id: "helper", type: "general-purpose" },
        },
      ],
      "src/router.tsx": [
        {
          agent: "claude",
          id: CLAUDE_EDITS_ID,
          title: "Wire the router",
          lastAt: tick(6),
          via: null,
        },
      ],
    },
  });

  for (const args of [
    ["ws", "claude"],
    ["ws", "claude", "../../etc/passwd"],
    ["ws", "bash", CLAUDE_EDITS_ID],
    ["", "claude", CLAUDE_EDITS_ID],
  ])
    expect(() => agentFilesRequest(args)).toThrow();
  expect(agentFilesRequest(["ws", "codex", CODEX_EDITS_ID])).toEqual({
    workspace: "ws",
    agent: "codex",
    id: CODEX_EDITS_ID,
  });
  // Another folder's conversation is not this one's to read.
  await expect(
    readAgentFiles(home, await tempDir("lanew-other-"), {
      agent: "claude",
      id: CLAUDE_EDITS_ID,
    }),
  ).rejects.toThrow(/not one of this project's/);
});

test("FE-42: a conversation's background tasks are read from its transcript — status from the notification, lost when it went quiet", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  const tmp = await tempDir("lanew-tmp-");
  await seedBackgroundTasks(home, folder, tmp);

  // Running first, then newest first. The foreground `Bash` and the
  // sidechain's call are no tasks; the duplicated notice is read once; the
  // Monitor's status-less event ends nothing.
  const tasks = await readBackgroundTasks(home, folder, CLAUDE_BG_ID);
  expect(
    tasks.map(({ id, kind, status, exitCode, subagentId }) => ({
      id,
      kind,
      status,
      exitCode,
      subagentId,
    })),
  ).toEqual([
    {
      id: "bgmon01",
      kind: "monitor",
      status: "running",
      exitCode: null,
      subagentId: null,
    },
    {
      id: "bgrun01",
      kind: "shell",
      status: "running",
      exitCode: null,
      subagentId: null,
    },
    {
      id: "agbg01",
      kind: "agent",
      status: "completed",
      exitCode: null,
      subagentId: "agbg01",
    },
    {
      id: "bgfail1",
      kind: "shell",
      status: "failed",
      exitCode: 1,
      subagentId: null,
    },
  ]);
  const failed = tasks.find((task) => task.id === "bgfail1");
  expect(failed).toMatchObject({
    toolUseId: "toolu_fail",
    description: "Run the tests",
    command: "bun test\nbun run lint",
    summary: 'Background command "Run the tests" failed with exit code 1',
    startedAt: "2026-10-03T04:00:02.000Z",
    endedAt: "2026-10-03T04:00:07.000Z",
  });
  expect(tasks.find((task) => task.id === "bgmon01")).toMatchObject({
    command: null,
    description: "Watch the log",
    summary: 'Monitor event: "Watch the log"',
    endedAt: null,
  });
  expect(tasks.find((task) => task.id === "agbg01")).toMatchObject({
    description: "Explore the views",
    command: null,
    endedAt: "2026-10-03T04:00:08.000Z",
  });

  // An hour quiet: the one that never reported is lost, and so is the one
  // Claude marked `stopped`.
  const old = await readBackgroundTasks(home, folder, CLAUDE_BG_OLD_ID);
  expect(
    old.map(({ id, status, endedAt }) => ({ id, status, endedAt })),
  ).toEqual([
    { id: "bgstop1", status: "lost", endedAt: null },
    { id: "bglost1", status: "lost", endedAt: null },
  ]);

  // The rail's counts ride on the listing.
  const listed = await listAgentSessions(home, folder);
  expect(
    Object.fromEntries(
      listed.map((session) => [session.id, session.background]),
    ),
  ).toEqual({
    [CLAUDE_BG_ID]: { running: 2, total: 4 },
    [CLAUDE_BG_OLD_ID]: { running: 0, total: 2 },
  });

  // Read on from where it stopped: the notice appended now ends the shell.
  const file = join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    `${CLAUDE_BG_ID}.jsonl`,
  );
  await appendFile(
    file,
    `${JSON.stringify({
      type: "user",
      timestamp: "2026-10-03T04:01:00.000Z",
      message: {
        role: "user",
        content:
          "<task-notification>\n<task-id>bgrun01</task-id>\n<status>completed</status>\n<summary>Background command &quot;Run the gate&quot; completed (exit code 0)</summary>\n</task-notification>",
      },
    })}\n`,
  );
  expect(
    (await readBackgroundTasks(home, folder, CLAUDE_BG_ID)).find(
      (task) => task.id === "bgrun01",
    ),
  ).toMatchObject({
    status: "completed",
    exitCode: 0,
    summary: 'Background command "Run the gate" completed (exit code 0)',
    endedAt: "2026-10-03T04:01:00.000Z",
  });

  // `TaskStop` sends no notification: its own answer ends the task.
  const stop = {
    message: "Successfully stopped task: bgmon01 (tail -f log)",
    task_id: "bgmon01",
    task_type: "local_bash",
    command: "tail -f log",
  };
  await appendFile(
    file,
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-03T04:02:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_stopmon",
            name: "TaskStop",
            input: { task_id: "bgmon01" },
          },
        ],
      },
    })}\n${JSON.stringify({
      type: "user",
      timestamp: "2026-10-03T04:02:01.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_stopmon",
            content: JSON.stringify(stop),
          },
        ],
      },
      toolUseResult: stop,
    })}\n`,
  );
  expect(
    (await readBackgroundTasks(home, folder, CLAUDE_BG_ID)).find(
      (task) => task.id === "bgmon01",
    ),
  ).toMatchObject({
    status: "killed",
    exitCode: null,
    endedAt: "2026-10-03T04:02:01.000Z",
  });

  for (const args of [["ws"], ["ws", "../../etc/passwd"], ["", CLAUDE_BG_ID]])
    expect(() => backgroundRequest(args)).toThrow();
  expect(backgroundRequest(["ws", CLAUDE_BG_ID])).toEqual({
    workspace: "ws",
    conversation: CLAUDE_BG_ID,
  });
});

test("FE-42: a task's output is read only from its CLI task folder — its last 64 KB, escapes stripped", async () => {
  const home = await tempDir("lanew-agent-home-");
  const folder = join(await tempDir("lanew-agent-"), "my_repo");
  const tmp = await tempDir("lanew-tmp-");
  const { tasks, decoy } = await seedBackgroundTasks(home, folder, tmp);
  const read = (task: string, roots = [tmp]) =>
    readTaskOutput(home, folder, CLAUDE_BG_ID, task, roots);

  expect(await read("bgrun01")).toEqual({
    text: "✓ typecheck\nrunning e2e…\n",
    size: (await stat(join(tasks, "bgrun01.output"))).size,
    truncated: false,
    missing: false,
  });

  // A task this conversation never started, one with no output of its own,
  // and an id that is no id.
  await expect(read("nosuch1")).rejects.toThrow(/no such task/);
  await expect(read("agbg01")).rejects.toThrow(/no output/);
  await expect(read("../secret")).rejects.toThrow(/valid task/);
  for (const args of [
    ["ws", CLAUDE_BG_ID],
    ["ws", CLAUDE_BG_ID, "../x"],
    ["ws", "nope", "bgrun01"],
  ])
    expect(() => taskOutputRequest(args)).toThrow();

  // The same file, but not under a temp dir it may read.
  await expect(
    read("bgrun01", [await tempDir("lanew-other-")]),
  ).rejects.toThrow(/outside/);
  // Its file swapped for a symlink out of the folder.
  await rm(join(tasks, "bgfail1.output"));
  await symlink(decoy, join(tasks, "bgfail1.output"));
  await expect(read("bgfail1")).rejects.toThrow(/outside/);

  // A path the transcript recorded outside any CLI task folder.
  const elsewhere = join(tmp, "bgout9.output");
  await writeFile(elsewhere, "not a task's\n");
  await appendFile(
    join(
      home,
      ".claude",
      "projects",
      claudeProjectDir(folder),
      `${CLAUDE_BG_ID}.jsonl`,
    ),
    [
      {
        type: "assistant",
        timestamp: "2026-10-03T04:02:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_out",
              name: "Bash",
              input: { command: "true", run_in_background: true },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-10-03T04:02:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_out",
              content: `Command running in background with ID: bgout9. Output is being written to: ${elsewhere}.`,
            },
          ],
        },
        toolUseResult: { backgroundTaskId: "bgout9" },
      },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(""),
  );
  await expect(read("bgout9")).rejects.toThrow(/outside/);

  // Never written, or gone: missing, not an error.
  expect(
    await readTaskOutput(home, folder, CLAUDE_BG_OLD_ID, "bglost1", [tmp]),
  ).toEqual({ text: "", size: 0, truncated: false, missing: true });

  // Longer than the cap: only its end.
  const long = `${"é".repeat(BACKGROUND_OUTPUT_MAX)}\u001b[1mEND\u001b[0m\n`;
  await writeFile(join(tasks, "bgrun01.output"), long);
  const tail = await read("bgrun01");
  expect(tail.truncated).toBe(true);
  expect(tail.size).toBe(Buffer.byteLength(long));
  expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(
    BACKGROUND_OUTPUT_MAX,
  );
  expect(tail.text.endsWith("éEND\n")).toBe(true);
  expect(tail.text).not.toContain("\u001b");
  expect(tail.text.startsWith("é")).toBe(true);
});
