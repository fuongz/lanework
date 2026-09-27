// FE-28/V1, FE-29/V1+V2: adding and removing OUR Stop hook in Claude Code's
// settings and in Codex's hooks.json leaves everything else in those files
// exactly as it was; Codex's config.toml is read correctly; and a Codex
// rollout is condensed into the right checkpoint.
//
// ⚠️ No Electron here: `claude-settings.ts` is pure on purpose, and these are
// the rules that decide whether turning a switch on can damage a file that
// belongs to the user.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildBody, digestCodex } from "../electron/hook/lanework-checkpoint";
import {
  buildHookCommand,
  buildShim,
  findHook,
  findHookPosition,
  parseSettings,
  readSettings,
  shellQuote,
  withHook,
  withoutHook,
  writeSettings,
} from "../electron/main/handoff/claude-settings";
import { parseCodexConfig, trustKey } from "../electron/main/handoff/codex";

const SHIM = "/Users/ana/.lanew/hooks/lanework-checkpoint";
const COMMAND = buildHookCommand({ shimPath: SHIM, agent: "claude-code" });

const OTHER = {
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
  },
  model: "opus",
  permissions: { allow: ["Bash(git status)"] },
};

test("an empty or missing file gets exactly one hook", () => {
  const read = parseSettings(null);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  const next = withHook(read.settings, COMMAND);
  expect(findHook(next)).toBe(COMMAND);
  expect(next).toEqual({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: COMMAND, timeout: 10 }] }],
    },
  });
});

test("other hooks, events and keys are passed through untouched", () => {
  const next = withHook(OTHER, COMMAND);
  expect(next.model).toBe("opus");
  expect(next.permissions).toEqual(OTHER.permissions);
  const hooks = next.hooks as typeof OTHER.hooks;
  expect(hooks.PreToolUse).toEqual(OTHER.hooks.PreToolUse);
  expect(hooks.Stop[0]).toEqual(OTHER.hooks.Stop[0]);
  expect(hooks.Stop).toHaveLength(2);
});

test("switching on twice does not add a second copy, and replaces the command", () => {
  const once = withHook(OTHER, COMMAND);
  const newer = buildHookCommand({
    shimPath: "/Users/a b/.lanew/hooks/lanework-checkpoint",
    agent: "codex",
  });
  const twice = withHook(once, newer);
  const commands = JSON.stringify(twice).match(/lanework-checkpoint/g) ?? [];
  expect(commands).toHaveLength(1);
  expect(findHook(twice)).toBe(newer);
  expect(newer).toBe(
    "'/Users/a b/.lanew/hooks/lanework-checkpoint' --agent codex",
  );
});

test("switching off removes only ours and restores the original shape", () => {
  expect(withoutHook(withHook(OTHER, COMMAND))).toEqual(OTHER);
  // A file that only ever held our hook goes back to having no `hooks` at all.
  expect(withoutHook(withHook({ model: "opus" }, COMMAND))).toEqual({
    model: "opus",
  });
  // Ours sharing a group with someone else's: the group stays, minus ours.
  const shared = {
    hooks: {
      Stop: [
        {
          hooks: [
            { type: "command", command: "notify.sh" },
            { type: "command", command: COMMAND },
          ],
        },
      ],
    },
  };
  expect(withoutHook(shared)).toEqual({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "notify.sh" }] }] },
  });
});

test("a file that is not a JSON object is refused, never rewritten", () => {
  expect(parseSettings('{ "model": ').ok).toBe(false);
  expect(parseSettings("[]").ok).toBe(false);
  expect(parseSettings("   ").ok).toBe(true);
});

test("paths with spaces and quotes are quoted for the shell", () => {
  expect(shellQuote("/Users/a b/it's")).toBe(`'/Users/a b/it'\\''s'`);
  expect(COMMAND).toBe(`'${SHIM}' --agent claude-code`);
});

test("the file round-trips through disk, and a broken one is left alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lanework-claude-"));
  const path = join(dir, "settings.json");
  try {
    await writeSettings(withHook(OTHER, COMMAND), path);
    const read = await readSettings(path);
    expect(read.ok && findHook(read.settings)).toBe(COMMAND);

    await writeFile(path, "{ broken", "utf8");
    expect((await readSettings(path)).ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("{ broken");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── FE-29 ──────────────────────────────────────────────────────────────────

test("the shim runs the bundled hook under Electron's Node, paths quoted", () => {
  const shim = buildShim({
    execPath: "/Applications/Lane work.app/Contents/MacOS/Lanework",
    hookPath: "/x/lanework-checkpoint.cjs",
    apiUrl: "https://api.lanework.dev",
    configPath: "/Users/ana/.lanew/hooks/config.json",
  });
  expect(shim.startsWith("#!/bin/sh\n")).toBe(true);
  expect(shim).toContain("export ELECTRON_RUN_AS_NODE=1");
  expect(shim).toContain(
    "export LANEWORK_HOOK_CONFIG='/Users/ana/.lanew/hooks/config.json'",
  );
  expect(shim).toContain(
    `exec '/Applications/Lane work.app/Contents/MacOS/Lanework' '/x/lanework-checkpoint.cjs' --api 'https://api.lanework.dev' "$@"`,
  );
});

/** ~/.codex/hooks.json as supacode leaves it: three events, one Stop hook. */
const SUPACODE = {
  hooks: {
    SessionStart: [
      {
        hooks: [
          { type: "command", command: "a # supacode-managed-hook", timeout: 5 },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: "b # supacode-managed-hook",
            timeout: 10,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: "c # supacode-managed-hook",
            timeout: 10,
          },
        ],
      },
    ],
  },
};

test("Codex: our hook goes after supacode's and comes out cleanly", () => {
  const codex = buildHookCommand({ shimPath: SHIM, agent: "codex" });
  const on = withHook(SUPACODE, codex);
  expect(findHook(on)).toBe(codex);
  // Codex keys approval by position: supacode's stays at 0, ours is group 1.
  expect(findHookPosition(on)).toEqual({ group: 1, index: 0 });
  const hooks = on.hooks as typeof SUPACODE.hooks;
  expect(hooks.Stop[0]).toEqual(SUPACODE.hooks.Stop[0]);
  expect(hooks.SessionStart).toEqual(SUPACODE.hooks.SessionStart);
  expect(withoutHook(on)).toEqual(SUPACODE);
});

test("Codex: config.toml says whether hooks are on and what is approved", () => {
  const hooksPath = "/Users/ana/.codex/hooks.json";
  const key = trustKey(hooksPath, { group: 1, index: 0 });
  expect(key).toBe("/Users/ana/.codex/hooks.json:stop:1:0");
  const config = parseCodexConfig(
    [
      'model = "gpt-5"',
      "",
      "[features]",
      "js_repl = false",
      "hooks = true  # needed for hooks",
      "",
      "[hooks.state]",
      "",
      `[hooks.state."${hooksPath}:stop:0:0"]`,
      'trusted_hash = "sha256:071a"',
      "",
      `[hooks.state."${key}"]`,
      'trusted_hash = "sha256:ffff"',
    ].join("\n"),
  );
  expect(config.hooksEnabled).toBe(true);
  expect(config.trusted.has(key)).toBe(true);
  expect(parseCodexConfig("[features]\nhooks = false").hooksEnabled).toBe(
    false,
  );
  expect(parseCodexConfig("features.hooks = true").hooksEnabled).toBe(true);
  // Nothing readable is "not set" — never a false "approved".
  const empty = parseCodexConfig("");
  expect(empty.hooksEnabled).toBe(false);
  expect(empty.trusted.size).toBe(0);
});

/** A trimmed Codex rollout: the item_completed events the hook reads. */
function rollout(items: unknown[]): string {
  return items
    .map((item) =>
      JSON.stringify({
        type: "event_msg",
        payload: { type: "item_completed", item },
      }),
    )
    .join("\n");
}

test("Codex: a rollout becomes the card, request, files and commands", () => {
  const root = "/Users/ana/lanework";
  const text = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "# AGENTS.md instructions for x" },
        ],
      },
    }),
    rollout([
      {
        type: "UserMessage",
        content: [
          {
            type: "text",
            text: "resume FE-29, token sk-ant-api03-" + "x".repeat(40),
          },
        ],
      },
      {
        type: "McpToolCall",
        server: "lanework",
        tool: "get_review",
        arguments: { board_id: "b", card: "FE-29" },
      },
      {
        type: "CommandExecution",
        command: ["/bin/zsh", "-lc", "bun run typecheck\necho done"],
        exit_code: 0,
      },
      {
        type: "CommandExecution",
        command: ["/bin/zsh", "-lc", "bun test"],
        exit_code: 1,
      },
      {
        type: "FileChange",
        changes: { [`${root}/apps/desktop/x.ts`]: { type: "update" } },
      },
      {
        type: "McpToolCall",
        server: "node_repl",
        tool: "js",
        arguments: { card: "NOT-1" },
      },
      {
        type: "AgentMessage",
        content: [{ type: "Text", text: "Typecheck passes; tests fail." }],
      },
    ]),
  ].join("\n");
  const d = digestCodex(text, root, null);
  expect(d.taskId).toBe("FE-29");
  expect(d.request).toContain("resume FE-29");
  expect(d.files).toEqual(["apps/desktop/x.ts"]);
  expect(d.commands).toEqual([
    { command: "bun run typecheck", ok: true },
    { command: "bun test", ok: false },
  ]);
  expect(d.lastReply).toBe("Typecheck passes; tests fail.");

  // The hook's stdin answer wins when Codex sends one.
  expect(digestCodex(text, root, "From stdin.").lastReply).toBe("From stdin.");

  const body = JSON.stringify(
    buildBody(d, { host: "h", session: "s", git: {} }),
  );
  expect(body).not.toContain("x".repeat(40));
  expect(body).toContain("[REDACTED]");
});

test("Codex: an older rollout (code mode only) still finds the card", () => {
  const text = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "look at BE-17" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "c1",
        input:
          'const r = await tools.mcp__lanework__get_review({ board_id: "b", card: "BE-17" });\nawait tools.exec_command({cmd:"git status"});\n*** Update File: /r/a.ts',
      },
    }),
  ].join("\n");
  const d = digestCodex(text, "/r", null);
  expect(d.taskId).toBe("BE-17");
  expect(d.request).toBe("look at BE-17");
  expect(d.commands).toEqual([{ command: "git status", ok: null }]);
  expect(d.files).toEqual(["a.ts"]);
});

// ── INF-03 ─────────────────────────────────────────────────────────────────

test("plugin: the hook stands down only when the desktop app's hook is installed", async () => {
  const { desktopHookInstalled } = await import("../electron/hook/cli");
  const dir = await mkdtemp(join(tmpdir(), "lanework-plugin-claude-"));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    expect(desktopHookInstalled()).toBe(false);
    await writeSettings(OTHER, join(dir, "settings.json"));
    expect(desktopHookInstalled()).toBe(false);
    await writeSettings(withHook(OTHER, COMMAND), join(dir, "settings.json"));
    expect(desktopHookInstalled()).toBe(true);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("plugin: push-wip is a setting in ~/.config/lanework, off until chosen", async () => {
  const { config, pluginConfigPath } = await import("../electron/hook/cli");
  const dir = await mkdtemp(join(tmpdir(), "lanework-plugin-xdg-"));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  const log = console.log;
  console.log = () => {};
  try {
    expect(pluginConfigPath()).toBe(join(dir, "lanework", "hook.json"));
    config("push-wip", "on");
    expect(JSON.parse(await readFile(pluginConfigPath(), "utf8"))).toEqual({
      pushWip: true,
    });
    config("push-wip", "off");
    expect(JSON.parse(await readFile(pluginConfigPath(), "utf8")).pushWip).toBe(
      false,
    );
  } finally {
    console.log = log;
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("plugin: on Linux the credential is a 0600 file under ~/.config/lanework", async () => {
  const credential = await import("../electron/hook/credential");
  const dir = await mkdtemp(join(tmpdir(), "lanework-plugin-cred-"));
  const file = join(dir, "credential");
  const saved = process.env.LANEWORK_HOOK_SECRET_FILE;
  process.env.LANEWORK_HOOK_SECRET_FILE = file;
  try {
    expect(credential.readSecret("https://api.test")).toBeNull();
    credential.writeSecret("https://api.test", "lw_mch_abc");
    expect(credential.readSecret("https://api.test")).toBe("lw_mch_abc");
    const { stat } = await import("node:fs/promises");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    credential.deleteSecret("https://api.test");
    expect(credential.readSecret("https://api.test")).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.LANEWORK_HOOK_SECRET_FILE;
    else process.env.LANEWORK_HOOK_SECRET_FILE = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
