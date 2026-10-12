import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  claudeAuthOf,
  createClaudeAuthProbe,
} from "../electron/main/terminal/agents";
import {
  claudeCredentialOf,
  claudeKeychainService,
  claudeOAuthUsageOf,
  createClaudeOAuthUsage,
  fetchClaudeOAuthUsage,
  readClaudeCredential,
  readClaudeCredentialFile,
} from "../electron/main/terminal/claude-oauth-usage";
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

const OAUTH_BODY = {
  five_hour: { utilization: 42.5, resets_at: "2026-10-12T15:00:00.000Z" },
  seven_day: { utilization: 130, resets_at: null },
  seven_day_opus: { utilization: 1 },
  account_email: "private@example.com",
};
const SECRET = "sk-ant-oat01-must-never-leave-main";
const fakeFetch = (
  answer: (url: string, init: RequestInit) => Promise<Response>,
) => answer as unknown as typeof fetch;

test("FE-53: OAuth usage keeps only the two windows from Claude's answer", async () => {
  expect(claudeOAuthUsageOf(OAUTH_BODY)).toEqual({
    primary: {
      usedPercent: 42.5,
      windowMinutes: 300,
      resetsAt: Date.parse("2026-10-12T15:00:00.000Z"),
    },
    secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: null },
  });
  expect(claudeOAuthUsageOf({ five_hour: { utilization: "1" } })).toBeNull();
  expect(claudeOAuthUsageOf(null)).toBeNull();
  expect(
    claudeCredentialOf(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: ` ${SECRET} `,
          refreshToken: "r",
          expiresAt: 1900000000000,
        },
      }),
    ),
  ).toEqual({ token: SECRET, expiresAt: 1900000000000 });
  expect(claudeCredentialOf('{"accessToken":"  "}')).toBeNull();
  expect(claudeCredentialOf("not json")).toBeNull();
  expect(claudeKeychainService("/tmp/profile")).toBe(
    "Claude Code-credentials-902e721c",
  );
  expect(claudeKeychainService(null)).toBe("Claude Code-credentials");

  const home = await mkdtemp(join(tmpdir(), "lanew-claude-oauth-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  const file = join(home, ".claude", ".credentials.json");
  const before = JSON.stringify({
    claudeAiOauth: { accessToken: SECRET, expiresAt: Date.now() + 60_000 },
  });
  await writeFile(file, before);
  expect(
    await readClaudeCredential({ configDir: null, home, platform: "linux" }),
  ).toEqual({ token: SECRET, expiresAt: expect.any(Number) });
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const result = await fetchClaudeOAuthUsage({
    readCredential: () => readClaudeCredentialFile(file),
    url: "https://usage.test/api/oauth/usage",
    fetch: fakeFetch(async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify(OAUTH_BODY), { status: 200 });
    }),
  });
  expect(result.ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://usage.test/api/oauth/usage");
  expect(calls[0].headers.Authorization).toBe(`Bearer ${SECRET}`);
  expect(calls[0].headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  // Read-only: the credential file is exactly as Claude wrote it.
  expect(await readFile(file, "utf8")).toBe(before);
});

test("FE-53: an expired token is reported without a request or a refresh", async () => {
  const home = await mkdtemp(join(tmpdir(), "lanew-claude-expired-"));
  const file = join(home, ".credentials.json");
  const before = JSON.stringify({
    claudeAiOauth: {
      accessToken: SECRET,
      refreshToken: "refresh-must-stay",
      expiresAt: Date.now() - 1,
    },
  });
  await writeFile(file, before);
  let calls = 0;
  const counting = fakeFetch(async () => {
    calls++;
    return new Response("{}");
  });
  const usage = createClaudeOAuthUsage({
    readCredential: () => readClaudeCredentialFile(file),
    fetch: counting,
  });
  const snapshot = await usage.read({ force: true });
  expect(snapshot.error).toBe("expired");
  expect(snapshot.primary).toBeNull();
  expect(typeof snapshot.fetchedAt).toBe("number");
  expect(calls).toBe(0);
  expect(await readFile(file, "utf8")).toBe(before);
  // No credential at all is `unavailable`, and still no request.
  const none = createClaudeOAuthUsage({
    readCredential: async () => null,
    fetch: counting,
  });
  expect((await none.read()).error).toBe("unavailable");
  expect(calls).toBe(0);
});

test("FE-53: 401, 403 and a timeout keep the last good snapshot", async () => {
  let now = 1_000_000;
  let answer: () => Promise<Response> = async () =>
    new Response(JSON.stringify(OAUTH_BODY));
  let calls = 0;
  const usage = createClaudeOAuthUsage({
    readCredential: async () => ({ token: SECRET, expiresAt: null }),
    fetch: fakeFetch(() => {
      calls++;
      return answer();
    }),
    now: () => now,
    timeoutMs: 100,
    minIntervalMs: 60_000,
    forceIntervalMs: 5_000,
  });
  const good = await usage.read();
  expect(good.error).toBeNull();
  expect(good.primary?.usedPercent).toBe(42.5);
  expect(good.at).toBe(new Date(1_000_000).toISOString());
  // Inside the automatic interval: answered from the cache.
  now += 30_000;
  expect((await usage.read()).fetchedAt).toBe(1_000_000);
  expect(calls).toBe(1);
  for (const [status, error] of [
    [401, "expired"],
    [403, "unavailable"],
    [500, "failed"],
  ] as const) {
    answer = async () => new Response("{}", { status });
    now += 5_000;
    // An explicit refresh skips the automatic interval.
    const failed = await usage.read({ force: true });
    expect(failed.error).toBe(error);
    expect(failed.primary).toEqual(good.primary);
    expect(failed.secondary).toEqual(good.secondary);
    expect(failed.at).toBe(good.at);
    expect(failed.fetchedAt).toBe(now);
  }
  // ...but not its own debounce.
  const before = calls;
  now += 1_000;
  await usage.read({ force: true });
  expect(calls).toBe(before);
  // A request that never answers times out and keeps the snapshot too.
  answer = () => new Promise<Response>(() => {});
  now += 5_000;
  const started = Date.now();
  const timedOut = await usage.read({ force: true });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(timedOut.error).toBe("failed");
  expect(timedOut.primary).toEqual(good.primary);
  // A body that is not usage is a failure, not zero usage.
  answer = async () => new Response("<html>", { status: 200 });
  now += 5_000;
  expect((await usage.read({ force: true })).error).toBe("failed");
  expect(usage.current().primary).toEqual(good.primary);
});

test("FE-53: the token never reaches a renderer", async () => {
  const usage = createClaudeOAuthUsage({
    readCredential: async () => ({ token: SECRET, expiresAt: null }),
    fetch: fakeFetch(
      async () =>
        new Response(JSON.stringify({ ...OAUTH_BODY, access_token: SECRET })),
    ),
  });
  const ok = await usage.read();
  expect(JSON.stringify(ok)).not.toContain(SECRET);
  expect(JSON.stringify(ok)).not.toContain("private@example.com");
  expect(Object.keys(ok).sort()).toEqual([
    "at",
    "error",
    "fetchedAt",
    "primary",
    "secondary",
  ]);
  const failing = createClaudeOAuthUsage({
    readCredential: async () => ({ token: SECRET, expiresAt: null }),
    fetch: fakeFetch(async () => {
      throw new Error(`network failed for ${SECRET}`);
    }),
  });
  const failed = await failing.read();
  expect(failed.error).toBe("failed");
  expect(JSON.stringify(failed)).not.toContain(SECRET);
});
