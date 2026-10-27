// Agent conversations on disk (FE-23): a fake home folder holding what Claude
// and Codex would have written for a project's folder.
import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { claudeProjectDir } from "../electron/main/terminal/agent-sessions";

export const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
export const CODEX_ID = "01a0db07-52f1-7020-abe9-92d305f1ecd4";

/** A Claude conversation's rail row: it opens the chat (FE-62/D3). */
export const claudeRowName = (title: string) => `Open “${title}”`;

/**
 * Resume a Claude conversation in a terminal the way a person now does
 * (FE-62/D3): its rail row opens the chat, whose title-bar Terminal button hands the
 * conversation to a pty — the running one, if a tab already has it. Resolves
 * once the xterm is on screen. `within` narrows where the row is found.
 *
 * ⚠️ The chat's section and the terminal's region share the name
 * `Claude — <title>`: only the xterm inside tells them apart.
 */
export async function resumeClaudeInTerminal(
  page: Page,
  title: string,
  within: Page | Locator = page,
): Promise<Locator> {
  await within
    .getByRole("button", { name: claudeRowName(title), exact: true })
    .click();
  const region = page.getByRole("region", { name: `Claude — ${title}` });
  // The chat's header sits in the window title bar (FE-58), outside its region.
  const terminal = page
    .locator('[data-slot="window-titlebar"]')
    .getByRole("button", { name: "Terminal", exact: true });
  await expect(terminal).toBeVisible();
  // Off (aria-disabled) while a turn runs: a click then does nothing.
  await expect(terminal).not.toHaveAttribute("aria-disabled", "true");
  await terminal.click();
  const xterm = region.locator(".xterm");
  await expect(xterm).toBeVisible();
  return region;
}

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
 * Each one calls tools the viewer lists (FE-35): `done` a Grep and a Read
 * that failed, then answers; `handback` a Glob, then hands its report back;
 * the Codex thread a function call and an `exec` script that failed.
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
      {
        ...sidechain,
        type: "user",
        timestamp: "2026-09-26T07:00:00.000Z",
        message: { content: "Map the rail" },
      },
      {
        ...sidechain,
        type: "assistant",
        timestamp: "2026-09-26T07:00:05.000Z",
        message: {
          model: "claude-haiku-4-5-20251001",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "Looking." },
            {
              type: "tool_use",
              id: "toolu_grep",
              name: "Grep",
              input: { pattern: "subagents", path: join(folder, "src") },
            },
            {
              type: "tool_use",
              id: "toolu_read",
              name: "Read",
              input: {
                file_path: join(folder, "src", "nav.tsx"),
                offset: 410,
                limit: 61,
              },
            },
          ],
        },
      },
      {
        ...sidechain,
        type: "user",
        timestamp: "2026-09-26T07:00:06.000Z",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_grep", content: "x" },
            {
              type: "tool_result",
              tool_use_id: "toolu_read",
              is_error: true,
              content: "File does not exist.",
            },
          ],
        },
      },
      {
        ...sidechain,
        type: "assistant",
        timestamp: "2026-09-26T07:01:08.000Z",
        message: {
          model: "claude-haiku-4-5-20251001",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "The rail is **mapped**." }],
        },
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
      // What the CLI reminds it of is no prompt and no step.
      {
        ...sidechain,
        type: "user",
        isMeta: true,
        message: { content: "<system-reminder>Hand back.</system-reminder>" },
      },
      {
        ...sidechain,
        type: "assistant",
        message: {
          stop_reason: null,
          content: [
            {
              type: "tool_use",
              id: "toolu_glob",
              name: "Glob",
              input: { pattern: "tests/*.spec.ts" },
            },
          ],
        },
      },
      {
        ...sidechain,
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_glob" }],
        },
      },
      {
        ...sidechain,
        type: "assistant",
        message: {
          stop_reason: null,
          content: [{ type: "text", text: "Found them, handing back." }],
        },
      },
      {
        ...sidechain,
        type: "assistant",
        message: {
          stop_reason: null,
          content: [
            {
              type: "tool_use",
              id: "toolu_back",
              name: "SubagentHandback",
              input: { message: "Two specs: `terminal` and `agents`." },
            },
          ],
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
      {
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", cwd: folder },
      },
      {
        type: "response_item",
        payload: {
          type: "agent_message",
          author: "/root",
          recipient: "/root/social_card",
          content: [
            {
              type: "input_text",
              text: "Message Type: NEW_TASK\nTask name: /root/social_card\nSender: /root\nPayload:\nDraw the social card",
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "ls public\nls src" }),
          call_id: "call_ls",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_ls",
          output: "card.png",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          input:
            'const r = await tools.exec_command({"cmd":"sips -g pixelWidth card.png"});',
          call_id: "call_sips",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_sips",
          output: [
            {
              type: "input_text",
              text: "Script failed\nWall time 0.0 seconds",
            },
          ],
        },
      },
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

export const CLAUDE_EDITS_ID = "44444444-2222-4333-8444-555555555555";
export const CLAUDE_TOOLS_ID = "55555555-2222-4333-8444-555555555555";
export const CODEX_EDITS_ID = "01a0db07-52f1-7020-abe9-444444444444";
export const CODEX_EDITS_SPAWNED_ID = "01a0db07-52f1-7020-abe9-555555555555";

/** `2026-09-27T01:00:0<n>.000Z`: the FE-39 fixtures' clock, a second a tick. */
export const tick = (n: number) => `2026-09-27T01:00:0${n}.000Z`;

/** A Claude file-tool call, as the assistant line that makes it. */
function claudeCall(
  name: string,
  id: string,
  input: Record<string, unknown>,
  at: string,
  extra: Record<string, unknown> = {},
) {
  return {
    ...extra,
    type: "assistant",
    timestamp: at,
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

/** Its result: an error, or what Claude records of a `Write` that created. */
function claudeResult(
  id: string,
  at: string,
  { error = false, created }: { error?: boolean; created?: string } = {},
) {
  return {
    type: "user",
    timestamp: at,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          ...(error ? { is_error: true } : {}),
          content: error ? "File has not been read yet." : "ok",
        },
      ],
    },
    ...(created
      ? { toolUseResult: { type: "create", filePath: created, content: "" } }
      : {}),
  };
}

/** Claude's file history's record of a file's first edit in a session. */
function claudeDelta(folder: string, path: string, at: string, fresh: boolean) {
  return {
    type: "file-history-delta",
    messageId: "ac95fa64-9cce-4bf9-9a66-2d661047fa86",
    trackingPath: path,
    backup: {
      backupFileName: fresh ? null : "ebdb35af1818c9c1@v1",
      version: 1,
      backupTime: at,
      realParentDir: join(folder, path, ".."),
    },
    timestamp: at,
  };
}

/**
 * Two Claude conversations that edited files in `folder` (FE-39), as the CLI
 * writes them:
 *
 * - `CLAUDE_EDITS_ID` ("Wire the router") with file history on: two `Edit`s
 *   of `src/router.tsx` (one file-history delta), a `Write` that created
 *   `src/new.ts`, a `Write` that FAILED, and an edit outside the folder. Its
 *   sub-agent `helper` (general-purpose) edited `src/router.tsx` too, and
 *   created `src/helper.ts`.
 * - `CLAUDE_TOOLS_ID` ("Tidy the notebook") with file history off: a `Write`
 *   that created `src/made.ts`, a `MultiEdit` of `src/router.tsx`, a
 *   `NotebookEdit` of `nb/analysis.ipynb`.
 *
 * Stamped `tick(1)` … `tick(7)`.
 */
export async function seedClaudeEdits(home: string, folder: string) {
  const dir = join(home, ".claude", "projects", claudeProjectDir(folder));
  await mkdir(join(dir, CLAUDE_EDITS_ID, "subagents"), { recursive: true });
  const at = (path: string) => join(folder, path);
  await writeFile(
    join(dir, `${CLAUDE_EDITS_ID}.jsonl`),
    jsonl([
      {
        type: "user",
        cwd: folder,
        timestamp: tick(0),
        message: { role: "user", content: "Wire the router" },
      },
      claudeCall(
        "Edit",
        "toolu_e1",
        { file_path: at("src/router.tsx") },
        tick(1),
      ),
      claudeDelta(folder, "src/router.tsx", tick(1), false),
      claudeResult("toolu_e1", tick(1)),
      claudeCall(
        "Edit",
        "toolu_e2",
        { file_path: at("src/router.tsx") },
        tick(2),
      ),
      claudeResult("toolu_e2", tick(2)),
      claudeCall("Write", "toolu_w1", { file_path: at("src/new.ts") }, tick(3)),
      claudeDelta(folder, "src/new.ts", tick(3), true),
      claudeResult("toolu_w1", tick(3), { created: at("src/new.ts") }),
      // Failed: it edited nothing.
      claudeCall(
        "Write",
        "toolu_w2",
        { file_path: at("src/broken.ts") },
        tick(4),
      ),
      claudeResult("toolu_w2", tick(4), { error: true }),
      // Not in the repository.
      claudeCall(
        "Edit",
        "toolu_e3",
        { file_path: "/elsewhere/notes.md" },
        tick(5),
      ),
      claudeResult("toolu_e3", tick(5)),
      {
        type: "assistant",
        timestamp: tick(5),
        message: { role: "assistant", stop_reason: "end_turn", content: [] },
      },
      { type: "system", subtype: "turn_duration", timestamp: tick(5) },
    ]),
  );
  const sidechain = { isSidechain: true, cwd: folder };
  await writeFile(
    join(dir, CLAUDE_EDITS_ID, "subagents", "agent-helper.jsonl"),
    jsonl([
      {
        ...sidechain,
        type: "user",
        timestamp: tick(5),
        message: { content: "Add the helper" },
      },
      claudeCall(
        "Edit",
        "toolu_s1",
        { file_path: at("src/router.tsx") },
        tick(6),
        sidechain,
      ),
      claudeCall(
        "Write",
        "toolu_s2",
        { file_path: at("src/helper.ts") },
        tick(7),
        sidechain,
      ),
      {
        ...claudeResult("toolu_s2", tick(7), { created: at("src/helper.ts") }),
        ...sidechain,
      },
    ]),
  );
  await writeFile(
    join(dir, CLAUDE_EDITS_ID, "subagents", "agent-helper.meta.json"),
    JSON.stringify({ agentType: "general-purpose", description: "Add helper" }),
  );
  await writeFile(
    join(dir, `${CLAUDE_TOOLS_ID}.jsonl`),
    jsonl([
      {
        type: "user",
        cwd: folder,
        timestamp: tick(0),
        message: { role: "user", content: "Tidy the notebook" },
      },
      claudeCall(
        "Write",
        "toolu_m1",
        { file_path: at("src/made.ts") },
        tick(1),
      ),
      claudeResult("toolu_m1", tick(1), { created: at("src/made.ts") }),
      claudeCall(
        "MultiEdit",
        "toolu_m2",
        { file_path: at("src/router.tsx"), edits: [] },
        tick(2),
      ),
      claudeCall(
        "NotebookEdit",
        "toolu_m3",
        { notebook_path: at("nb/analysis.ipynb") },
        tick(3),
      ),
    ]),
  );
}

/**
 * A Codex conversation that edited files in `folder` (FE-39), and a thread
 * it spawned:
 *
 * - An `apply_patch` that adds `docs/added.md`, updates `src/router.tsx`,
 *   deletes `old.txt` and moves `src/name.ts` to `src/renamed.ts` — with the
 *   `FileChange` item a newer CLI writes for the same patch, which must not
 *   count it twice.
 * - A `FileChange` alone (a patch sent from an `exec` script) for
 *   `src/script.ts`; one that FAILED for `src/failed.ts`; an older CLI's
 *   `function_call` patch of `src/router.tsx`.
 * - Its thread "Gibbs" (a `worker`) created `src/spawned.ts`.
 */
export async function seedCodexEdits(home: string, folder: string) {
  const day = join(home, ".codex", "sessions", "2026", "09", "27");
  await mkdir(day, { recursive: true });
  const at = (path: string) => join(folder, path);
  const patch = [
    "*** Begin Patch",
    "*** Add File: docs/added.md",
    "+hello",
    "*** Update File: src/router.tsx",
    "@@",
    "-a",
    "+b",
    "*** Delete File: old.txt",
    "*** Update File: src/name.ts",
    "*** Move to: src/renamed.ts",
    "@@",
    "-x",
    "+y",
    "*** End Patch",
    "",
  ].join("\n");
  const fileChange = (
    changes: Record<string, unknown>,
    stamp: string,
    status = "completed",
  ) => ({
    type: "event_msg",
    timestamp: stamp,
    payload: {
      type: "item_completed",
      item: { type: "FileChange", id: "exec-1", changes, status },
    },
  });
  await writeFile(
    join(day, `rollout-2026-09-27T01-00-00-${CODEX_EDITS_ID}.jsonl`),
    jsonl([
      {
        type: "session_meta",
        timestamp: tick(0),
        payload: { id: CODEX_EDITS_ID, cwd: folder, timestamp: tick(0) },
      },
      {
        type: "event_msg",
        timestamp: tick(0),
        payload: { type: "user_message", message: "Reshape the docs" },
      },
      {
        type: "response_item",
        timestamp: tick(1),
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call_patch",
          input: patch,
        },
      },
      fileChange(
        {
          [at("docs/added.md")]: { type: "add", content: "hello\n" },
          [at("src/router.tsx")]: {
            type: "update",
            unified_diff: "",
            move_path: null,
          },
          [at("old.txt")]: { type: "delete", content: "" },
          [at("src/name.ts")]: {
            type: "update",
            unified_diff: "",
            move_path: at("src/renamed.ts"),
          },
        },
        tick(1),
      ),
      fileChange(
        {
          [at("src/script.ts")]: {
            type: "update",
            unified_diff: "",
            move_path: null,
          },
        },
        tick(2),
      ),
      fileChange({ [at("src/failed.ts")]: { type: "add" } }, tick(2), "failed"),
      {
        type: "response_item",
        timestamp: tick(3),
        payload: {
          type: "function_call",
          name: "apply_patch",
          call_id: "call_old",
          arguments: JSON.stringify({
            input:
              "*** Begin Patch\n*** Update File: src/router.tsx\n@@\n-b\n+c\n*** End Patch\n",
          }),
        },
      },
    ]),
  );
  await writeFile(
    join(day, `rollout-2026-09-27T01-00-04-${CODEX_EDITS_SPAWNED_ID}.jsonl`),
    jsonl([
      {
        type: "session_meta",
        timestamp: tick(4),
        payload: {
          id: CODEX_EDITS_SPAWNED_ID,
          session_id: CODEX_EDITS_ID,
          cwd: folder,
          timestamp: tick(4),
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: CODEX_EDITS_ID,
                depth: 1,
                agent_path: "/root/spawned",
                agent_nickname: "Gibbs",
                agent_role: "worker",
              },
            },
          },
        },
      },
      fileChange({ [at("src/spawned.ts")]: { type: "add" } }, tick(4)),
    ]),
  );
}

/**
 * A stand-in for an agent's CLI: prints `<name> <args>` and waits, ending on
 * `/exit` — so a spec can resume a conversation without launching one.
 */
export async function agentStandIn(dir: string, name: string) {
  const file = join(dir, `${name}-stand-in.sh`);
  await writeFile(
    file,
    `#!/bin/sh\nprintf 'ran-%s-%s-%s\\n' ${name} "$@"\nwhile IFS= read -r line; do [ "$line" = "/exit" ] && exit 0; done\n`,
    { mode: 0o755 },
  );
  return file;
}

/**
 * A FORK Claude sub-agent of `seedAgentHome`'s conversation (FE-35), as the
 * CLI writes one: a `fork-context-ref` instead of the parent's history, the
 * parent's own call that spawned it, then its directive — wrapped in the
 * rules Claude gives a fork — and its answer.
 *
 * ⚠️ Its own seeder, not part of `seedSubagents`: the FE-33 specs count
 * those three.
 */
export async function seedForkSubagent(home: string, folder: string) {
  const subagents = join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    CLAUDE_ID,
    "subagents",
  );
  await mkdir(subagents, { recursive: true });
  const sidechain = { isSidechain: true, cwd: folder };
  await writeFile(
    join(subagents, "agent-fork.jsonl"),
    jsonl([
      {
        type: "fork-context-ref",
        agentId: "fork",
        parentSessionId: CLAUDE_ID,
        parentLastUuid: "3e2c5bac-1169-4653-99cd-84e85e520c2b",
      },
      // The parent's call, not the fork's: never one of its steps.
      {
        ...sidechain,
        type: "assistant",
        timestamp: "2026-09-26T07:30:00.000Z",
        message: {
          model: "claude-opus-5-5",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_spawn",
              name: "Agent",
              input: { description: "Fork: test", subagent_type: "fork" },
            },
          ],
        },
      },
      {
        ...sidechain,
        type: "user",
        timestamp: "2026-09-26T07:30:01.000Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_spawn",
              content: [{ type: "text", text: "Fork started" }],
            },
            {
              type: "text",
              text: "<fork-boilerplate>\nYou are a worker fork. The transcript above is the parent's history.\n</fork-boilerplate>\n\nYour directive: Say which model you are",
            },
          ],
        },
      },
      {
        ...sidechain,
        type: "assistant",
        timestamp: "2026-09-26T07:30:09.000Z",
        message: {
          model: "claude-opus-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Opus 5.5." }],
        },
      },
    ]),
  );
  await writeFile(
    join(subagents, "agent-fork.meta.json"),
    JSON.stringify({
      agentType: "fork",
      isFork: true,
      description: "Fork: which model",
      model: "inherit",
    }),
  );
}

/**
 * The `rate_limits` a Codex `token_count` carries (FE-41): the 5-hour and the
 * week window, each used `used`% and reset at `resetsAt` (epoch ms) — or null.
 */
export function codexRateLimits(
  primary: { used: number; resetsAt: number } | null,
  secondary: { used: number; resetsAt: number } | null,
) {
  const window = (
    entry: { used: number; resetsAt: number } | null,
    minutes: number,
  ) =>
    entry && {
      used_percent: entry.used,
      window_minutes: minutes,
      // ⚠️ Unix SECONDS, as Codex writes it.
      resets_at: Math.floor(entry.resetsAt / 1000),
    };
  return {
    limit_id: "codex",
    limit_name: null,
    primary: window(primary, 300),
    secondary: window(secondary, 10_080),
    credits: null,
    individual_limit: null,
    spend_control_reached: null,
    plan_type: "plus",
    rate_limit_reached_type: null,
  };
}

/** A Codex `token_count` event, as one rollout line (FE-41). */
export function codexTokenCount(timestamp: string, rateLimits: unknown) {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: rateLimits },
  };
}

/** One row of Codex's `thread_goals` (FE-41). */
export interface GoalRow {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}

/**
 * Codex's goals database, made with `node:sqlite` as `dir/<name>`, with the
 * schema Codex itself creates (FE-41). Answers the file.
 *
 * ⚠️ `node:sqlite` loaded only here: the specs that never make one are spared
 * its experimental warning.
 */
export async function seedCodexGoals(
  dir: string,
  goals: GoalRow[],
  name = "goals_1.sqlite",
): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY NOT NULL,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'active', 'paused', 'blocked', 'usage_limited', 'budget_limited',
        'complete'
      )),
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
    const insert = db.prepare(
      "INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const goal of goals)
      insert.run(
        goal.threadId,
        `goal-${goal.threadId}`,
        goal.objective,
        goal.status,
        goal.tokenBudget,
        goal.tokensUsed,
        goal.timeUsedSeconds,
        1_790_647_016_392,
        1_790_649_031_534,
      );
  } finally {
    db.close();
  }
  return file;
}

/**
 * The numbers `seedAgentHome`'s two conversations end on (FE-38), appended
 * to their transcripts as the CLIs write them: Claude's answers with their
 * usage, two `cost-state`s and two recaps — the newer of each wins — a
 * sub-agent's line and a cut one, neither counted; Codex's `turn_context`
 * and `token_count`s, the newest of which says nothing.
 *
 * Claude: Opus 5.5, ≈ $0.73, 141k in · 4k out, context 142,320, +120 −8,
 * 4m 12s, the newer recap. Codex: gpt-6.1-sol at low effort, 1.8M in ·
 * 17.3k out, context 88,039 of 258,400 (34%).
 *
 * ⚠️ Its own seeder, not part of `seedAgentHome`: a turn's answers and
 * stamps would move what the FE-23/FE-25 specs read off those transcripts.
 */
export async function seedAgentFacts(home: string, folder: string) {
  const claude = join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    `${CLAUDE_ID}.jsonl`,
  );
  await appendFile(
    claude,
    jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_first",
          model: "claude-opus-5-5",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 200,
            output_tokens: 50,
          },
          content: [],
        },
      },
      {
        type: "cost-state",
        totalCostUSD: 0.25,
        totalLinesAdded: 10,
        totalLinesRemoved: 1,
        totalDuration: 60_000,
        modelUsage: {
          "claude-opus-5-5": { inputTokens: 5, outputTokens: 50 },
        },
      },
      {
        type: "system",
        subtype: "away_summary",
        content: "An older recap.",
        timestamp: "2026-09-26T07:00:00.000Z",
      },
      // The answer the newest totals were saved after — twice, as Claude
      // writes one answer: a line per part, the same id and usage.
      ...[1, 2].map(() => ({
        type: "assistant",
        message: {
          id: "msg_second",
          model: "claude-opus-5-5",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 140_000,
            cache_creation_input_tokens: 2318,
            output_tokens: 400,
          },
          content: [],
        },
      })),
      // A sub-agent's answer, in an older CLI's transcript: not this one's.
      {
        type: "assistant",
        isSidechain: true,
        message: {
          model: "claude-haiku-4-5-20251001",
          usage: { input_tokens: 999_999, output_tokens: 999 },
        },
      },
      {
        type: "cost-state",
        totalCostUSD: 0.7312,
        totalLinesAdded: 120,
        totalLinesRemoved: 8,
        totalDuration: 252_000,
        totalAPIDuration: 90_000,
        totalToolDuration: 30_000,
        modelUsage: {
          "claude-opus-5-5": {
            inputTokens: 100,
            outputTokens: 4000,
            cacheReadInputTokens: 130_000,
            cacheCreationInputTokens: 9900,
            costUSD: 0.73,
          },
          "claude-haiku-4-5-20251001": {
            inputTokens: 1000,
            outputTokens: 20,
            costUSD: 0.0012,
          },
        },
      },
      {
        type: "system",
        subtype: "away_summary",
        content: "Fixed the flaky login test; the retry is next.",
        timestamp: "2026-09-26T08:00:00.000Z",
      },
    ]).replace(/\n$/, '\n{"type":"cost-state","totalCostUSD":99\n'),
  );

  const codex = join(
    home,
    ".codex",
    "sessions",
    "2026",
    "09",
    "26",
    `rollout-2026-09-26T07-04-45-${CODEX_ID}.jsonl`,
  );
  await appendFile(
    codex,
    jsonl([
      {
        type: "turn_context",
        payload: { model: "gpt-6.1-sol", effort: "low", cwd: folder },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1_753_176,
              cached_input_tokens: 1_665_152,
              cache_write_input_tokens: 0,
              output_tokens: 17_326,
              reasoning_output_tokens: 348,
              total_tokens: 1_770_502,
            },
            last_token_usage: {
              input_tokens: 88_039,
              cached_input_tokens: 87_040,
              output_tokens: 110,
              total_tokens: 88_149,
            },
            model_context_window: 258_400,
          },
        },
      },
      // Rate limits only: no usage in it.
      {
        type: "event_msg",
        payload: { type: "token_count", info: null, rate_limits: {} },
      },
    ]),
  );
}

export const CLAUDE_BG_ID = "66666666-2222-4333-8444-555555555555";
export const CLAUDE_BG_OLD_ID = "77777777-2222-4333-8444-555555555555";

/**
 * Where Claude writes `conversation`'s background output under `tmp` — the
 * shape it really uses: `<tmp>/claude-<uid>/<project>/<session>/tasks/`.
 */
export function claudeTasksDir(
  tmp: string,
  folder: string,
  conversation: string,
) {
  return join(
    tmp,
    "claude-501",
    claudeProjectDir(folder),
    conversation,
    "tasks",
  );
}

/** What Claude answers a call it put in the background, for `task`. */
function backgroundStarted(
  toolUseId: string,
  at: string,
  toolUseResult: Record<string, unknown>,
  text: string,
) {
  return {
    type: "user",
    isSidechain: false,
    timestamp: at,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }],
    },
    toolUseResult,
  };
}

/** A `<task-notification>` as Claude writes it, mid-turn or as a new turn. */
function taskNotification(
  at: string,
  fields: {
    task: string;
    toolUseId?: string;
    status?: string;
    summary: string;
  },
  queued = false,
) {
  const content = [
    "<task-notification>",
    `<task-id>${fields.task}</task-id>`,
    ...(fields.toolUseId
      ? [`<tool-use-id>${fields.toolUseId}</tool-use-id>`]
      : []),
    ...(fields.status ? [`<status>${fields.status}</status>`] : []),
    `<summary>${fields.summary}</summary>`,
    "</task-notification>",
  ].join("\n");
  const origin = { kind: "task-notification", producer: "session-task" };
  // Arriving mid-turn, Claude files it as a queued command, not a user line.
  return queued
    ? {
        type: "attachment",
        isSidechain: false,
        timestamp: at,
        attachment: {
          type: "queued_command",
          prompt: content,
          commandMode: "task-notification",
          origin,
        },
      }
    : {
        type: "user",
        isSidechain: false,
        timestamp: at,
        origin,
        message: { role: "user", content },
      };
}

/**
 * Two Claude conversations with background tasks (FE-42), and their output
 * files under `tmp`:
 *
 * - `CLAUDE_BG_ID`, written just now: a shell still running (`bgrun01`, with
 *   output), a shell that failed with exit 1 (`bgfail1`), an async agent that
 *   finished (`agbg01`, with its sub-agent file), a Monitor still watching
 *   (`bgmon01`), and a foreground `Bash` that is no task.
 * - `CLAUDE_BG_OLD_ID`, untouched for an hour: a shell that never reported
 *   (`bglost1`) and one Claude marked `stopped` (`bgstop1`) — both lost.
 *
 * A sidechain's background call, and a decoy output file outside the tasks
 * folder, must never be listed or read.
 */
export async function seedBackgroundTasks(
  home: string,
  folder: string,
  tmp: string,
) {
  const claude = join(home, ".claude", "projects", claudeProjectDir(folder));
  await mkdir(claude, { recursive: true });
  const tasks = claudeTasksDir(tmp, folder, CLAUDE_BG_ID);
  await mkdir(tasks, { recursive: true });
  const out = (task: string) => join(tasks, `${task}.output`);
  const said = (task: string) =>
    `Command running in background with ID: ${task}. Output is being written to: ${out(task)}. You will be notified when it completes.`;
  const at = (n: number) => `2026-10-03T04:00:0${n}.000Z`;
  await writeFile(
    join(claude, `${CLAUDE_BG_ID}.jsonl`),
    jsonl([
      {
        type: "user",
        cwd: folder,
        timestamp: at(0),
        message: { role: "user", content: "Run the gate" },
      },
      claudeCall(
        "Bash",
        "toolu_run",
        {
          command: "bun run gate",
          description: "Run the gate",
          run_in_background: true,
        },
        at(1),
      ),
      backgroundStarted(
        "toolu_run",
        at(1),
        {
          stdout: "",
          stderr: "",
          interrupted: false,
          backgroundTaskId: "bgrun01",
        },
        said("bgrun01"),
      ),
      claudeCall(
        "Bash",
        "toolu_fail",
        {
          command: "bun test\nbun run lint",
          description: "Run the tests",
          run_in_background: true,
        },
        at(2),
      ),
      backgroundStarted(
        "toolu_fail",
        at(2),
        {
          stdout: "",
          stderr: "",
          interrupted: false,
          backgroundTaskId: "bgfail1",
        },
        said("bgfail1"),
      ),
      claudeCall(
        "Agent",
        "toolu_agent",
        {
          description: "Explore the views",
          subagent_type: "Explore",
          prompt: "Look around",
        },
        at(3),
      ),
      backgroundStarted(
        "toolu_agent",
        at(3),
        {
          isAsync: true,
          status: "async_launched",
          agentId: "agbg01",
          description: "Explore the views",
        },
        "Async agent launched successfully.\nagentId: agbg01",
      ),
      claudeCall(
        "Monitor",
        "toolu_mon",
        {
          command: "tail -f log",
          description: "Watch the log",
          timeout_ms: 600000,
        },
        at(4),
      ),
      backgroundStarted(
        "toolu_mon",
        at(4),
        { taskId: "bgmon01", timeoutMs: 600000, persistent: false },
        "Monitor started (task bgmon01, expires in 10m).",
      ),
      // In the foreground: no task.
      claudeCall(
        "Bash",
        "toolu_fg",
        { command: "ls", description: "List" },
        at(5),
      ),
      claudeResult("toolu_fg", at(5)),
      // A sub-agent's own background call: never the conversation's.
      {
        ...claudeCall(
          "Bash",
          "toolu_side",
          { command: "sleep 9", run_in_background: true },
          at(5),
        ),
        isSidechain: true,
      },
      // A Monitor event carries no status: still watching.
      taskNotification(
        at(6),
        { task: "bgmon01", summary: 'Monitor event: "Watch the log"' },
        true,
      ),
      // The same notice, queued mid-turn and again as a turn: read once.
      taskNotification(
        at(7),
        {
          task: "bgfail1",
          toolUseId: "toolu_fail",
          status: "failed",
          summary: 'Background command "Run the tests" failed with exit code 1',
        },
        true,
      ),
      taskNotification(at(7), {
        task: "bgfail1",
        toolUseId: "toolu_fail",
        status: "failed",
        summary: 'Background command "Run the tests" failed with exit code 1',
      }),
      taskNotification(at(8), {
        task: "agbg01",
        toolUseId: "toolu_agent",
        status: "completed",
        summary: 'Agent "Explore the views" finished',
      }),
      {
        type: "assistant",
        timestamp: at(9),
        message: { role: "assistant", stop_reason: "end_turn", content: [] },
      },
    ]),
  );
  await writeFile(
    out("bgrun01"),
    "\u001b[32m✓\u001b[0m typecheck\nrunning e2e…\n",
  );
  await writeFile(out("bgfail1"), "1 failed\n");
  const subagents = join(claude, CLAUDE_BG_ID, "subagents");
  await mkdir(subagents, { recursive: true });
  await writeFile(
    join(subagents, "agent-agbg01.jsonl"),
    jsonl([
      {
        type: "user",
        isSidechain: true,
        cwd: folder,
        timestamp: at(3),
        message: { role: "user", content: "Look around" },
      },
    ]),
  );
  await writeFile(
    join(subagents, "agent-agbg01.meta.json"),
    JSON.stringify({ agentType: "Explore", description: "Explore the views" }),
  );
  // Outside the tasks folder: never read, whatever a transcript says.
  await writeFile(join(tmp, "secret.output"), "not yours\n");

  const oldTasks = claudeTasksDir(tmp, folder, CLAUDE_BG_OLD_ID);
  await mkdir(oldTasks, { recursive: true });
  const oldSaid = (task: string) =>
    `Command running in background with ID: ${task}. Output is being written to: ${join(oldTasks, `${task}.output`)}.`;
  const old = join(claude, `${CLAUDE_BG_OLD_ID}.jsonl`);
  await writeFile(
    old,
    jsonl([
      {
        type: "user",
        cwd: folder,
        timestamp: tick(0),
        message: { role: "user", content: "Start the server" },
      },
      claudeCall(
        "Bash",
        "toolu_lost",
        {
          command: "bun dev",
          description: "Start the server",
          run_in_background: true,
        },
        tick(1),
      ),
      backgroundStarted(
        "toolu_lost",
        tick(1),
        { backgroundTaskId: "bglost1" },
        oldSaid("bglost1"),
      ),
      claudeCall(
        "Bash",
        "toolu_stop",
        {
          command: "bun run watch",
          description: "Watch",
          run_in_background: true,
        },
        tick(2),
      ),
      backgroundStarted(
        "toolu_stop",
        tick(2),
        { backgroundTaskId: "bgstop1" },
        oldSaid("bgstop1"),
      ),
      taskNotification(tick(3), {
        task: "bgstop1",
        toolUseId: "toolu_stop",
        status: "stopped",
        summary:
          "Background shell command didn't finish before the previous session ended",
      }),
      {
        type: "assistant",
        timestamp: tick(4),
        message: { role: "assistant", stop_reason: "end_turn", content: [] },
      },
    ]),
  );
  const hourAgo = Date.now() / 1000 - 3600;
  await utimes(old, hourAgo, hourAgo);
  return { tasks, oldTasks, decoy: join(tmp, "secret.output") };
}
