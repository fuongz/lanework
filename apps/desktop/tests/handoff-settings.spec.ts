// FE-28/V1: adding and removing OUR Stop hook in Claude Code's user settings
// leaves everything else in that file exactly as it was.
//
// ⚠️ No Electron here: `claude-settings.ts` is pure on purpose, and these are
// the rules that decide whether turning a switch on can damage a file that
// belongs to the user.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  buildHookCommand,
  findHook,
  parseSettings,
  readSettings,
  shellQuote,
  withHook,
  withoutHook,
  writeSettings,
} from "../electron/main/handoff/claude-settings";

const COMMAND = buildHookCommand({
  execPath: "/Applications/Lanework.app/Contents/MacOS/Lanework",
  hookPath:
    "/Applications/Lanework.app/Contents/Resources/app.asar.unpacked/dist/electron/hook/lanework-checkpoint.cjs",
  apiUrl: "https://api.lanework.dev",
  pushWip: false,
});

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
    execPath: "/Applications/Lanework 2.app/Contents/MacOS/Lanework",
    hookPath: "/x/lanework-checkpoint.cjs",
    apiUrl: "https://api.lanework.dev",
    pushWip: true,
  });
  const twice = withHook(once, newer);
  const commands = JSON.stringify(twice).match(/lanework-checkpoint/g) ?? [];
  expect(commands).toHaveLength(1);
  expect(findHook(twice)).toBe(newer);
  expect(newer).toContain("--push-wip");
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
  expect(COMMAND.startsWith("ELECTRON_RUN_AS_NODE=1 '")).toBe(true);
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
