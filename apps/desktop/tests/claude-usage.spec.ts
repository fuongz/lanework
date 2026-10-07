import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  claudeAuthOf,
  createClaudeAuthProbe,
} from "../electron/main/terminal/agents";
import { claudeStatuslineArgs } from "../electron/main/terminal/claude-statusline";
import {
  claudeQuotaOf,
  readClaudeQuota,
} from "../electron/main/terminal/claude-usage";
import { createSessions } from "../electron/main/terminal/sessions";

test("Claude bridge whitelists quota and preserves configured statusLine output", async () => {
  const home = await mkdtemp(join(tmpdir(), "lanew-claude-"));
  const file = join(home, "claude-usage.json");
  const bridge = resolve("dist/electron/statusline/claude-usage.cjs");
  const input = JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 11, resets_at: 1900000000 },
      seven_day: { used_percentage: 22 },
    },
    secret: "must-not-cache",
    session_id: "private",
  });
  const run = (value: string) =>
    new Promise<string>((done, reject) => {
      const child = spawn(process.execPath, [bridge, file, "cat"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (data) => {
        out += data;
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? done(out) : reject(new Error(`bridge exit ${code}`)),
      );
      child.stdin.end(value);
    });
  expect(await run(input)).toBe(input);
  const cached = JSON.parse(await readFile(file, "utf8"));
  expect(Object.keys(cached).sort()).toEqual(["at", "primary", "secondary"]);
  expect(cached.primary).toEqual({
    usedPercent: 11,
    windowMinutes: 300,
    resetsAt: 1900000000000,
  });
  expect(cached.secondary.resetsAt).toBeNull();
  expect(await run("malformed input")).toBe("malformed input");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(cached);
  expect(
    claudeQuotaOf({ rate_limits: { five_hour: { used_percentage: "11" } } }),
  ).toBeNull();
  await writeFile(
    file,
    JSON.stringify({ ...cached, at: "2000-01-01T00:00:00Z" }),
  );
  expect((await readClaudeQuota(file)).stale).toBe(true);
});

test("Claude process settings preserve local command and skip invalid or managed settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "lanew-claude-settings-"));
  const config = join(home, ".claude");
  const cwd = join(home, "repo");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await mkdir(config, { recursive: true });
  const bridge = join(home, "bridge.cjs");
  await writeFile(bridge, "");
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({
      statusLine: { type: "command", command: "echo user", padding: 2 },
    }),
  );
  await writeFile(
    join(cwd, ".claude/settings.local.json"),
    JSON.stringify({ statusLine: { type: "command", command: "echo local" } }),
  );
  const options = {
    home,
    config,
    bridge,
    cache: join(home, "cache.json"),
    executable: "/test app/electron",
    managed: [],
  };
  const args = claudeStatuslineArgs(cwd, options);
  expect(args).toContain("--settings");
  expect(args).toContain("echo local");
  expect(args).toContain('"padding":2');
  expect(args).not.toContain("echo user");
  await writeFile(join(cwd, ".claude/settings.local.json"), "invalid");
  expect(claudeStatuslineArgs(cwd, options)).toBe("");
  expect(claudeStatuslineArgs(cwd, { ...options, managed: [bridge] })).toBe("");
});

test("Claude auth probe uses shell resolution, caches labels and times out", async () => {
  const home = await mkdtemp(join(tmpdir(), "lanew-claude-auth-"));
  const shell = join(home, "shell");
  await writeFile(
    shell,
    '#!/bin/sh\nprintf "profile noise\\n__lanework_claude_auth__\\n"\nprintf \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","accessToken":"secret"}\'\n',
    { mode: 0o700 },
  );
  const probe = createClaudeAuthProbe({
    shell: { file: shell, args: [] },
    timeoutMs: 1500,
  });
  expect(await probe()).toEqual({
    loggedIn: true,
    plan: "max",
    authMode: "claude.ai",
    identity: null,
  });
  await writeFile(shell, "#!/bin/sh\nexec sleep 3\n", { mode: 0o700 });
  expect((await probe()).plan).toBe("max");
  const start = Date.now();
  expect(
    await createClaudeAuthProbe({
      shell: { file: shell, args: [] },
      timeoutMs: 100,
    })(),
  ).toEqual({ loggedIn: false, plan: null, authMode: null, identity: null });
  expect(Date.now() - start).toBeLessThan(1000);
  expect(
    claudeAuthOf({ subscriptionType: "accessToken-secret" }).plan,
  ).toBeNull();
});

test("Claude launch and resume receive process settings with the production host callback", async () => {
  const home = await mkdtemp(join(tmpdir(), "lanew-claude-launch-"));
  const bridge = resolve("dist/electron/statusline/claude-usage.cjs");
  const fake = join(home, "claude");
  const capture = join(home, "args.txt");
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\n`, {
    mode: 0o700,
  });
  const sessions = createSessions({
    shell: { file: "/bin/sh", args: [] },
    agentCommand: (agent) => (agent === "claude" ? fake : agent),
    claudeStatusline: (cwd) =>
      claudeStatuslineArgs(cwd, {
        home,
        config: join(home, ".claude"),
        bridge,
        managed: [],
        cache: join(home, "claude-usage.json"),
      }),
  });
  try {
    for (const resume of [undefined, "11111111-2222-4333-8444-555555555555"]) {
      await writeFile(capture, "");
      const session = sessions.spawn({
        workspace: "test",
        cwd: home,
        kind: "claude",
        cols: 80,
        rows: 24,
        resume,
      });
      sessions.attach({ send: () => {} }, session.id, 80, 24);
      await expect
        .poll(() => readFile(capture, "utf8"))
        .toContain("--settings");
      const args = await readFile(capture, "utf8");
      expect(args).toContain("statusline/claude-usage.cjs");
      expect(args).toContain("ELECTRON_RUN_AS_NODE=1");
      expect(args).toContain(resume ? "--resume" : "--session-id");
      sessions.kill(session.id);
    }
  } finally {
    sessions.killAll();
  }
});
