// The agent conversations the rail's Agents group lists, and the resume line a
// tab types for one (FE-23) — driven directly under Node against a fake home.
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { listAgentSessions } from "../electron/main/terminal/agent-sessions";
import { createSessions } from "../electron/main/terminal/sessions";
import type { TerminalHostMessage } from "../shared/terminal";
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

    // Not a UUID: a plain agent tab, with nothing appended.
    const hostile = await run("claude", "x; echo pwned");
    expect(hostile.resume).toBeNull();
    expect(typed[2]).toContain("ran-claude--");
    expect(typed[2]).not.toContain("pwned");
  } finally {
    sessions.killAll();
  }
});
