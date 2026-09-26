// Agent conversations on disk (FE-23): a fake home folder holding what Claude
// and Codex would have written for a project's folder.
import { mkdir, writeFile } from "node:fs/promises";
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
