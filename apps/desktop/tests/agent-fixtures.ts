// Agent conversations on disk (FE-23): a fake home folder holding what Claude
// and Codex would have written for a project's folder.
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectDir } from "../electron/main/terminal/agent-sessions";

export const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
export const CODEX_ID = "01a0db07-52f1-7020-abe9-92d305f1ecd4";

const jsonl = (lines: unknown[]) =>
  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

/**
 * A home folder holding one Claude and one Codex conversation for `folder`,
 * plus decoys that must not be listed.
 */
export async function seedAgentHome(home: string, folder: string) {
  const claude = join(home, ".claude", "projects", claudeProjectDir(folder));
  await mkdir(claude, { recursive: true });
  await writeFile(
    join(claude, `${CLAUDE_ID}.jsonl`),
    jsonl([
      { type: "mode", mode: "normal", sessionId: CLAUDE_ID },
      {
        type: "user",
        isMeta: true,
        cwd: folder,
        message: { role: "user", content: "<local-command-caveat>x" },
      },
      {
        type: "user",
        cwd: folder,
        message: { role: "user", content: "Fix the flaky login test" },
      },
      // Answered, and the turn closed: not working (FE-25).
      {
        type: "assistant",
        message: { role: "assistant", stop_reason: "end_turn", content: [] },
      },
      { type: "system", subtype: "turn_duration" },
      { type: "ai-title", aiTitle: "Early title", sessionId: CLAUDE_ID },
      { type: "ai-title", aiTitle: "Flaky login test", sessionId: CLAUDE_ID },
    ]),
  );
  // Opened and closed without a word: nothing to resume.
  await writeFile(
    join(claude, "22222222-2222-4333-8444-555555555555.jsonl"),
    jsonl([{ type: "mode", mode: "normal" }]),
  );
  // Another folder that encodes to the same name (`_` and `-` both → `-`).
  await writeFile(
    join(claude, "33333333-2222-4333-8444-555555555555.jsonl"),
    jsonl([
      {
        type: "user",
        cwd: `${folder}-other`,
        message: { role: "user", content: "Not this project" },
      },
    ]),
  );
  // Not a conversation id: never offered, so never typed.
  await writeFile(
    join(claude, "notes; rm -rf ~.jsonl"),
    jsonl([
      { type: "user", cwd: folder, message: { role: "user", content: "x" } },
    ]),
  );

  const day = join(home, ".codex", "sessions", "2026", "09", "26");
  await mkdir(day, { recursive: true });
  await writeFile(
    join(day, `rollout-2026-09-26T07-04-45-${CODEX_ID}.jsonl`),
    jsonl([
      { type: "session_meta", payload: { id: CODEX_ID, cwd: folder } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Tidy the settings page" }],
        },
      },
    ]),
  );
  await writeFile(
    join(day, "rollout-2026-09-26T08-00-00-elsewhere.jsonl"),
    jsonl([
      {
        type: "session_meta",
        payload: { id: "01a0db07-52f1-7020-abe9-000000000000", cwd: "/tmp" },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "Another folder" },
      },
    ]),
  );
  await writeFile(
    join(home, ".codex", "session_index.jsonl"),
    jsonl([
      { id: CODEX_ID, thread_name: "Old name" },
      { id: CODEX_ID, thread_name: "Settings page cleanup" },
    ]),
  );
}

export const CODEX_SPAWNED_ID = "01a0db07-52f1-7020-abe9-222222222222";
export const CODEX_GUARDIAN_ID = "01a0db07-52f1-7020-abe9-333333333333";

/**
 * What `seedAgentHome`'s conversations spawned (FE-33): three Claude
 * sub-agents — one done, one still going with no meta, one that handed its
 * report back — a thread the Codex one spawned, and the approval `guardian`
 * Codex ran for itself, which must be listed nowhere.
 *
 * ⚠️ Each Claude sub-agent is stamped a minute apart, so newest-first is
 * fixed: `going`, then `handback`, then `done`.
 */
export async function seedSubagents(home: string, folder: string) {
  const subagents = join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    CLAUDE_ID,
    "subagents",
  );
  await mkdir(subagents, { recursive: true });
  const sub = (name: string) => join(subagents, `agent-${name}.jsonl`);
  const meta = (name: string) => join(subagents, `agent-${name}.meta.json`);
  const sidechain = { isSidechain: true, cwd: folder };
  await writeFile(
    sub("done"),
    jsonl([
      { ...sidechain, type: "user", message: { content: "Map the rail" } },
      {
        ...sidechain,
        type: "assistant",
        message: { stop_reason: "end_turn", content: [] },
      },
    ]),
  );
  await writeFile(
    meta("done"),
    JSON.stringify({ agentType: "Explore", description: "Map the rail code" }),
  );
  await writeFile(
    sub("handback"),
    jsonl([
      { ...sidechain, type: "user", message: { content: "Find the specs" } },
      {
        ...sidechain,
        type: "assistant",
        message: {
          stop_reason: null,
          content: [{ type: "tool_use", name: "SubagentHandback" }],
        },
      },
      {
        ...sidechain,
        type: "user",
        toolEndsTurn: true,
        message: { content: [{ type: "tool_result" }] },
      },
    ]),
  );
  await writeFile(
    meta("handback"),
    JSON.stringify({ agentType: "general-purpose", description: "Find specs" }),
  );
  // No meta: called by what it was asked; mid-tool, so still going.
  await writeFile(
    sub("going"),
    jsonl([
      { ...sidechain, type: "user", message: { content: "Count the tests" } },
      {
        ...sidechain,
        type: "assistant",
        message: {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", name: "Bash" }],
        },
      },
    ]),
  );
  // Neither a sub-agent nor a transcript.
  await writeFile(join(subagents, "agent-done.forked-skill.json"), "{}");
  const now = Date.now() / 1000;
  await utimes(sub("done"), now - 180, now - 180);
  await utimes(sub("handback"), now - 120, now - 120);
  await utimes(sub("going"), now - 60, now - 60);

  const day = join(home, ".codex", "sessions", "2026", "09", "26");
  await writeFile(
    join(day, `rollout-2026-09-26T07-10-00-${CODEX_SPAWNED_ID}.jsonl`),
    jsonl([
      {
        type: "session_meta",
        payload: {
          id: CODEX_SPAWNED_ID,
          session_id: CODEX_ID,
          parent_thread_id: CODEX_ID,
          cwd: folder,
          timestamp: new Date().toISOString(),
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: CODEX_ID,
                depth: 1,
                agent_path: "/root/social_card",
                agent_nickname: "Gibbs",
                agent_role: null,
              },
            },
          },
        },
      },
      { type: "event_msg", payload: { type: "task_started" } },
    ]),
  );
  await writeFile(
    join(day, `rollout-2026-09-26T07-20-00-${CODEX_GUARDIAN_ID}.jsonl`),
    jsonl([
      {
        type: "session_meta",
        payload: {
          id: CODEX_GUARDIAN_ID,
          session_id: CODEX_ID,
          parent_thread_id: CODEX_ID,
          cwd: folder,
          timestamp: new Date().toISOString(),
          source: { subagent: { other: "guardian" } },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "The following is the Codex agent history whose request action you are assessing.",
            },
          ],
        },
      },
      { type: "event_msg", payload: { type: "task_started" } },
    ]),
  );
}
