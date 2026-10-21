// Run with `bun test apps/desktop/electron/main/agent-setup`.
//
// The `lanework` MCP entry switches between the offline server (stdio) and
// the cloud one (HTTP), and never touches any other server (FE-52/D8).
//
// NOTE: HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and LANEWORK_HOME all point into
// a temp dir: nothing here may reach the real `~/.claude.json` or `~/.codex`.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MCP_URL } from "../../../shared/agent-notes";
import { agentHome } from "../agent-home";
import {
  buildMcpShim,
  codexState,
  installLaneworkMcp,
  isStaleShim,
  laneworkMcpStatus,
  mcpServerPath,
  mcpShimPath,
  removeLaneworkMcp,
  setMcpHome,
  syncLaneworkMcp,
  withClaudeMcp,
  withCodexMcp,
  withoutCodexMcp,
} from "./mcp-entry";

const saved = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  LANEWORK_HOME: process.env.LANEWORK_HOME,
};
let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "lanew-mcp-entry-"));
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.CODEX_HOME = join(root, "codex");
  process.env.LANEWORK_HOME = join(root, "lanew");
  setMcpHome(() => agentHome(join(root, "home")));
});

after(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
});

const SHIM = "/Users/me/.lanew/bin/lanework-mcp";

describe("lanework MCP entry", () => {
  test("a shim of ours is stale only in a temp home, or when it is gone", () => {
    // This app's own shim, a test run's, one whose home is gone, and
    // something else entirely. One still on disk outside a temp folder (a dev
    // build's) is not stale, but a test cannot make one without a real home.
    assert.equal(isStaleShim(SHIM, SHIM), false);
    assert.equal(
      isStaleShim("/tmp/lw-verify/home/bin/lanework-mcp", SHIM),
      true,
    );
    assert.equal(
      isStaleShim("/Users/me/.gone-home/bin/lanework-mcp", SHIM),
      true,
    );
    assert.equal(isStaleShim("my-own-build", SHIM), false);
    assert.equal(isStaleShim(undefined, SHIM), false);
  });

  test("Claude: our entry switches mode and every other key stays", () => {
    const before = {
      numStartups: 4,
      mcpServers: { other: { type: "stdio", command: "other-mcp" } },
      projects: { "/x": { mcpServers: {} } },
    };
    const local = withClaudeMcp(before, "local", SHIM);
    assert.deepEqual(local.mcpServers, {
      other: { type: "stdio", command: "other-mcp" },
      lanework: { type: "stdio", command: SHIM, args: [] },
    });
    assert.equal(local.numStartups, 4);
    assert.deepEqual(local.projects, before.projects);
    const cloud = withClaudeMcp(local, "cloud", SHIM);
    assert.deepEqual((cloud.mcpServers as Record<string, unknown>).lanework, {
      type: "http",
      url: MCP_URL,
    });
  });

  test("Codex: our table is replaced in place of the old one; others stay", () => {
    const before = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.lanework]",
      'url = "https://mcp.lanework.dev/v1"',
      "",
      "[mcp_servers.lanework.env]",
      'X = "1"',
      "",
      "[mcp_servers.other]",
      'command = "other-mcp"',
      'note = """',
      "[not a table]",
      '"""',
      "",
    ].join("\n");
    assert.equal(codexState(before, SHIM).mode, "cloud");
    const local = withCodexMcp(before, "local", SHIM);
    assert.equal(codexState(local, SHIM).mode, "local");
    assert.equal(codexState(local, SHIM).transport, "stdio");
    assert.ok(local.includes("[mcp_servers.other]"));
    assert.ok(local.includes('command = "other-mcp"'));
    assert.ok(
      local.includes("[not a table]"),
      "a multi-line string is left whole",
    );
    assert.ok(!local.includes("[mcp_servers.lanework.env]"));
    assert.equal(local.match(/\[mcp_servers\.lanework\]/g)?.length, 1);
    const removed = withoutCodexMcp(local);
    assert.equal(codexState(removed, SHIM).installed, false);
    assert.ok(removed.includes('model = "gpt-5"'));
  });

  test("the shim runs the bundled server as plain Node against this app home", () => {
    const shim = buildMcpShim({
      execPath: "/Applications/Lanework.app/Contents/MacOS/Lanework",
      serverPath: mcpServerPath(
        "/Applications/Lanework.app/Contents/Resources/app.asar/dist/electron/main",
      ),
      home: "/Users/me/.lanew",
    });
    assert.ok(shim.includes("export ELECTRON_RUN_AS_NODE=1"));
    assert.ok(shim.includes("export LANEWORK_HOME='/Users/me/.lanew'"));
    assert.ok(
      shim.includes("app.asar.unpacked/dist/electron/mcp-local/server.cjs"),
    );
  });

  test("install, sync and remove touch only the temp home's files", async () => {
    const claudeJson = join(root, "claude", ".claude.json");
    const codexToml = join(root, "codex", "config.toml");
    mkdirSync(join(root, "claude"), { recursive: true });
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { other: { command: "x" } }, keep: true }),
    );

    await installLaneworkMcp("claude-code", "local");
    await installLaneworkMcp("codex", "local");
    let status = await laneworkMcpStatus("local");
    assert.equal(status.claude.mode, "local");
    assert.equal(status.codex.mode, "local");
    assert.equal(status.claude.configPath, claudeJson);
    assert.ok(readFileSync(mcpShimPath(), "utf8").startsWith("#!/bin/sh"));

    // Signing in repoints entries that are ours…
    await syncLaneworkMcp("machine");
    status = await laneworkMcpStatus("cloud");
    assert.equal(status.claude.mode, "cloud");
    assert.equal(status.codex.mode, "cloud");
    const json = JSON.parse(readFileSync(claudeJson, "utf8"));
    assert.deepEqual(json.mcpServers.other, { command: "x" });
    assert.equal(json.keep, true);

    // …but never one that points somewhere else.
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { lanework: { command: "my-own-build" } } }),
    );
    await syncLaneworkMcp("local");
    assert.deepEqual(
      JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers.lanework,
      {
        command: "my-own-build",
      },
    );

    // A shim of ours from a test run's temp home is stale: repointed.
    const stale = join(tmpdir(), "lw-verify", "home", "bin", "lanework-mcp");
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { lanework: { command: stale } } }),
    );
    status = await laneworkMcpStatus("local");
    assert.equal(status.claude.ours, true);
    assert.equal(status.claude.mode, null);
    await syncLaneworkMcp("local");
    assert.equal(
      JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers.lanework.command,
      mcpShimPath(),
    );

    await removeLaneworkMcp("claude-code");
    await removeLaneworkMcp("codex");
    status = await laneworkMcpStatus(null);
    assert.equal(status.claude.installed, false);
    assert.equal(status.codex.installed, false);
    assert.ok(
      readFileSync(codexToml, "utf8").trim() === "" ||
        !readFileSync(codexToml, "utf8").includes("lanework"),
    );
  });

  test("a Claude config that is not JSON is refused, not overwritten", async () => {
    const claudeJson = join(root, "claude", ".claude.json");
    writeFileSync(claudeJson, "{ half written");
    await assert.rejects(
      installLaneworkMcp("claude-code", "cloud"),
      /not valid JSON/,
    );
    assert.equal(readFileSync(claudeJson, "utf8"), "{ half written");
    assert.equal((await laneworkMcpStatus("cloud")).claude.unreadable, true);
  });
});
