// FE-40: a project's agent setup — MCP servers, skills, commands, hooks,
// permissions and plugins — read off a fake home and repo. The reader is
// driven directly under Node (V2, with the secret check); the last case boots
// the app and looks at Settings → Projects (V3).
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { AgentHome } from "../electron/main/agent-home";
import {
  codexRules,
  readAgentSetup,
  readSetupFile,
} from "../electron/main/agent-setup/read";
import { tomlEntries } from "../electron/main/agent-setup/toml";
import type { MachineRecord } from "../electron/main/auth/store";
import { writeFolders } from "../electron/main/workspaces/store";
import { MCP_URL } from "../shared/agent-notes";
import type { SetupOrigin } from "../shared/agent-setup";
import type { Workspace } from "../shared/workspaces";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

/**
 * Seeded into every place a secret can sit — `env`, `headers`, `args`, a
 * URL's query and password, a hook's command, a rule — and looked for in
 * everything the reader returns.
 *
 * ⚠️ A shape `redact()` does NOT know on its own. Where it may only be
 * dropped (env, args, URLs) the reader must never copy it; where it is
 * shown (a hook's command, a rule) it sits behind `Bearer` or `TOKEN=`,
 * which redaction does strip.
 */
const SECRET = "fe40plainsecret7d1c";

async function put(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
}

const skill = (name: string, description: string, body = `# ${name}\n`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

/** Every source the setup reads, for `folder`, under `where`. */
async function seedSetup(where: AgentHome, folder: string): Promise<void> {
  const { home, claudeDir, claudeJson, codexDir } = where;
  const plugins = join(claudeDir, "plugins", "cache", "market");

  // ── Claude: user and local scopes, and the user's settings ──
  await put(claudeJson, {
    mcpServers: {
      lanework: { type: "http", url: MCP_URL },
      "user-api": {
        type: "http",
        url: `https://api.example.com/mcp?token=${SECRET}`,
        headers: { Authorization: `Bearer ${SECRET}` },
      },
    },
    projects: {
      [folder]: {
        mcpServers: {
          "local-tool": {
            command: "/usr/local/bin/local-tool",
            args: ["--key", SECRET],
            env: { SECRET_KEY: SECRET },
          },
        },
        disabledMcpjsonServers: ["off-server"],
        allowedTools: ["Bash(git status)"],
      },
      "/elsewhere": { mcpServers: { elsewhere: { command: "nope" } } },
    },
  });
  await put(join(claudeDir, "settings.json"), {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command:
                "'/Users/ana/.lanew/hooks/lanework-checkpoint' --agent claude-code",
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: `curl -H "Authorization: Bearer ${SECRET}" https://hooks.example.com`,
            },
            {
              type: "http",
              url: `https://user:${SECRET}@hooks.example.com/in?key=${SECRET}`,
              headers: { "X-Key": SECRET },
            },
          ],
        },
      ],
    },
    permissions: {
      defaultMode: "acceptEdits",
      allow: ["Bash(bun run typecheck)"],
      deny: [`Bash(curl -H "Authorization: Bearer ${SECRET}")`],
      additionalDirectories: ["../shared"],
    },
    autoMode: { environment: ["one", "two"], soft_deny: [SECRET] },
    enabledPlugins: {
      "helper@market": true,
      "quiet@market": false,
      "missing@market": true,
    },
  });
  await put(
    join(claudeDir, "skills", "user-skill", "SKILL.md"),
    skill("user-skill", "Does a user thing.", "# User skill\n\nThe body.\n"),
  );
  await put(join(claudeDir, "commands", "ship.md"), "# Ship it\n\nSteps.\n");

  // ── Claude: plugins ──
  const install = (name: string, version: string) =>
    join(plugins, name, version);
  await put(join(claudeDir, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "helper@market": [
        {
          scope: "user",
          installPath: install("helper", "1.0.0"),
          version: "1.0.0",
        },
      ],
      "quiet@market": [
        {
          scope: "user",
          installPath: install("quiet", "2.0.0"),
          version: "2.0.0",
        },
      ],
      "lanework@lanework": [
        {
          scope: "project",
          projectPath: folder,
          installPath: install("lanework", "0.1.1"),
          version: "0.1.1",
        },
      ],
      "other@market": [
        {
          scope: "project",
          projectPath: "/elsewhere",
          installPath: install("other", "1.0.0"),
          version: "1.0.0",
        },
      ],
    },
  });
  await put(join(install("helper", "1.0.0"), ".mcp.json"), {
    mcpServers: {
      "helper-db": {
        command: "npx",
        args: ["-y", "helper-db", `--password=${SECRET}`],
        env: { DB_PASSWORD: SECRET },
      },
    },
  });
  await put(
    join(install("helper", "1.0.0"), "skills", "helper-skill", "SKILL.md"),
    skill("helper-skill", "From a plugin."),
  );
  await put(
    join(install("helper", "1.0.0"), "commands", "helper-cmd.md"),
    "---\ndescription: A plugin command\n---\nDo it.\n",
  );
  // The bare-map `.mcp.json` some plugins ship.
  await put(join(install("quiet", "2.0.0"), ".mcp.json"), {
    "quiet-server": { url: `https://quiet.example.com/?k=${SECRET}` },
  });
  await put(
    join(install("quiet", "2.0.0"), "skills", "quiet-skill", "SKILL.md"),
    skill("quiet-skill", "From a plugin that is off."),
  );
  await put(join(install("lanework", "0.1.1"), "hooks", "hooks.json"), {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              // INF-03's plugin: its command names no `lanework-checkpoint`.
              command: `"$CLAUDE_PLUGIN_ROOT/bin/lanework" hook`,
            },
          ],
        },
      ],
    },
  });

  // ── Codex: config.toml, hooks, rules, skills ──
  await put(
    join(codexDir, "config.toml"),
    [
      `mcp_servers.inline = { command = "inline-bin", env = { K = "${SECRET}" } }`,
      'approval_policy = "on-request" # the default',
      'sandbox_mode = "workspace-write"',
      "",
      "[features]",
      "hooks = true",
      "",
      "[mcp_servers.node_repl]",
      'command = "/opt/codex/bin/node_repl"',
      "args = [",
      '  "--secret",',
      `  "--token=${SECRET}",`,
      "]",
      "startup_timeout_sec = 10",
      "",
      "[mcp_servers.node_repl.env]",
      `API_KEY = "${SECRET}"`,
      "",
      "[mcp_servers.remote]",
      `url = "https://remote.example.com/mcp?token=${SECRET}"`,
      `bearer_token = "${SECRET}"`,
      `http_headers = { "X-Api-Key" = "${SECRET}" }`,
      "",
      "[mcp_servers.off]",
      'command = "off-server"',
      "enabled = false",
      "",
      '[plugins."docs@openai"]',
      "enabled = true",
      "",
      '[plugins."spare@openai"]',
      "enabled = false",
      "",
      "[[skills.config]]",
      'path = "~/.agents/skills/retired"',
      "enabled = false",
      "",
      "[shell_environment_policy.set]",
      `TOKEN = "${SECRET}"`,
      "",
      `[hooks.state."${join(codexDir, "hooks.json")}:stop:0:0"]`,
      'trusted_hash = "sha256:0000"',
      "",
    ].join("\n"),
  );
  await put(join(codexDir, "hooks.json"), {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command:
                "'/Users/ana/.lanew/hooks/lanework-checkpoint' --agent codex",
            },
          ],
        },
      ],
      SessionStart: [
        {
          hooks: [
            { type: "command", command: `API_TOKEN=${SECRET} ./notify.sh` },
          ],
        },
      ],
    },
  });
  await put(
    join(codexDir, "rules", "default.rules"),
    [
      'prefix_rule(pattern=["bun", "run", "typecheck"], decision="allow")',
      '# a comment, not a rule: prefix_rule(pattern=["rm"])',
      'prefix_rule(pattern = ["git", ["push", "reset"]], decision = "prompt")',
      `prefix_rule(pattern=["curl", "-H", "Authorization: Bearer ${SECRET}"], decision="forbidden")`,
      'network_rule(host="api.example.com", protocol="https", decision="allow")',
      "",
    ].join("\n"),
  );
  await put(
    join(codexDir, "skills", "legacy-skill", "SKILL.md"),
    skill("legacy-skill", "From the old place."),
  );
  await put(
    join(codexDir, "skills", ".system", "builtin", "SKILL.md"),
    skill("builtin", "Ships with Codex."),
  );
  await put(
    join(home, ".agents", "skills", "agent-skill", "SKILL.md"),
    skill("agent-skill", "From ~/.agents."),
  );
  await put(
    join(home, ".agents", "skills", "retired", "SKILL.md"),
    skill("retired", "Switched off in config.toml."),
  );

  // ── The repo ──
  await put(join(folder, ".mcp.json"), {
    mcpServers: {
      "project-api": {
        type: "sse",
        url: `https://project.example.com/sse?auth=${SECRET}`,
      },
      "off-server": { command: "off" },
      "local-tool": { command: "shadowed" },
    },
  });
  await put(join(folder, ".claude", "settings.json"), {
    hooks: {
      PreToolUse: [
        { matcher: "Edit", hooks: [{ type: "command", command: "./lint.sh" }] },
      ],
    },
    permissions: { ask: ["Bash(git push:*)"] },
    enabledPlugins: { "lanework@lanework": true },
  });
  await put(join(folder, ".claude", "settings.local.json"), {
    permissions: { allow: ["WebFetch(domain:example.com)"] },
  });
  await put(
    join(folder, ".claude", "skills", "project-skill", "SKILL.md"),
    "---\nname: project-skill\ndescription: >\n  Folded over\n  two lines.\n---\n# Project skill\n",
  );
  await put(join(folder, ".claude", "commands", "deploy.md"), "Deploy.\n");
  await put(
    join(folder, ".claude", "commands", "ops", "rollback.md"),
    "Roll back.\n",
  );
  await put(
    join(folder, ".agents", "skills", "repo-skill", "SKILL.md"),
    skill("repo-skill", "From the repo's .agents."),
  );
  await put(join(folder, ".codex", "hooks.json"), {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo repo" }] }] },
  });
  await put(
    join(folder, ".codex", "config.toml"),
    '[mcp_servers.repo-mcp]\ncommand = "repo-mcp"\n',
  );
  await put(
    join(folder, ".codex", "rules", "repo.rules"),
    'prefix_rule(pattern=["make"], decision="allow")\n',
  );
}

/** A fake home and repo with every source seeded, and how to read them. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lanew-setup-")));
  const home = join(root, "home");
  const folder = join(root, "repo");
  const where: AgentHome = {
    home,
    claudeDir: join(home, ".claude"),
    claudeJson: join(home, ".claude.json"),
    codexDir: join(home, ".codex"),
  };
  await seedSetup(where, folder);
  return {
    folder,
    where,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function find<T extends SetupOrigin & { name?: string }>(
  list: T[],
  agent: SetupOrigin["agent"],
  scope: SetupOrigin["scope"],
  name: string,
): T {
  const found = list.find(
    (item) =>
      item.agent === agent && item.scope === scope && item.name === name,
  );
  if (!found) throw new Error(`no ${agent} ${scope} ${name}`);
  return found;
}

test("the setup holds no secret: no env, headers, args, URL query or token reaches it", async () => {
  const { folder, where, cleanup } = await fixture();
  try {
    const { setup } = await readAgentSetup(folder, where);
    const json = JSON.stringify(setup);
    expect(json).not.toContain(SECRET);
    // Not even its neighbours: a redaction that kept the key name and lost
    // only part of the value would still say too much.
    expect(json).not.toContain("DB_PASSWORD");
    expect(json).not.toContain("SECRET_KEY");
    expect(json).not.toContain("X-Api-Key");
    expect(json).not.toContain("token=");
    expect(setup.unreadable).toEqual([]);

    // `[mcp_servers.node_repl]` with an `env` table under it is its name,
    // its transport and its program's file name — nothing else.
    const repl = find(setup.mcp, "codex", "user", "node_repl");
    expect(Object.keys(repl).sort()).toEqual(
      [
        "agent",
        "disabled",
        "id",
        "name",
        "plugin",
        "scope",
        "source",
        "target",
        "transport",
      ].sort(),
    );
    expect(repl).toMatchObject({ transport: "stdio", target: "node_repl" });
    // What is shown of a hook's command and a rule went through redact().
    const curl = setup.hooks.find((hook) => hook.detail?.startsWith("curl"));
    expect(curl?.detail).toContain("Bearer [REDACTED]");
    expect(
      setup.permissions.find((rule) => rule.value.startsWith("curl"))?.value,
    ).toContain("[REDACTED]");
  } finally {
    await cleanup();
  }
});

test("every source is read, with its agent, scope and whether it is in use", async () => {
  const { folder, where, cleanup } = await fixture();
  try {
    const { setup, files } = await readAgentSetup(folder, where);

    // MCP: Claude's three scopes and its plugins, Codex's config layers.
    expect(find(setup.mcp, "claude", "user", "lanework")).toMatchObject({
      transport: "http",
      target: "mcp.lanework.dev",
      source: "~/.claude.json",
      disabled: null,
    });
    expect(find(setup.mcp, "claude", "user", "user-api").target).toBe(
      "api.example.com",
    );
    expect(find(setup.mcp, "claude", "local", "local-tool")).toMatchObject({
      transport: "stdio",
      target: "local-tool",
      disabled: null,
    });
    expect(find(setup.mcp, "claude", "project", "local-tool").disabled).toBe(
      "Replaced by the local server of the same name",
    );
    expect(find(setup.mcp, "claude", "project", "off-server").disabled).toMatch(
      /disabledMcpjsonServers/,
    );
    expect(find(setup.mcp, "claude", "project", "project-api")).toMatchObject({
      transport: "sse",
      target: "project.example.com",
      source: ".mcp.json",
    });
    expect(find(setup.mcp, "claude", "plugin", "helper-db")).toMatchObject({
      plugin: "helper@market",
      transport: "stdio",
      target: "npx",
      disabled: null,
    });
    expect(find(setup.mcp, "claude", "plugin", "quiet-server").disabled).toBe(
      "The plugin quiet@market is off",
    );
    expect(setup.mcp.some((server) => server.name === "elsewhere")).toBe(false);
    expect(find(setup.mcp, "codex", "user", "remote").target).toBe(
      "remote.example.com",
    );
    expect(find(setup.mcp, "codex", "user", "inline").target).toBe(
      "inline-bin",
    );
    expect(find(setup.mcp, "codex", "user", "off").disabled).toBe(
      "Off: enabled = false",
    );
    // An untrusted repo's `.codex/` is configured but not loaded.
    expect(find(setup.mcp, "codex", "project", "repo-mcp").disabled).toMatch(
      /trusted/,
    );

    // Skills and commands, each with the file `open` reads (D4).
    for (const [agent, scope, name] of [
      ["claude", "user", "user-skill"],
      ["claude", "project", "project-skill"],
      ["claude", "plugin", "helper-skill"],
      ["codex", "project", "repo-skill"],
      ["codex", "user", "agent-skill"],
      ["codex", "user", "legacy-skill"],
      ["codex", "system", "builtin"],
    ] as const)
      expect(find(setup.skills, agent, scope, name).disabled).toBeNull();
    expect(
      find(setup.skills, "claude", "project", "project-skill").description,
    ).toBe("Folded over two lines.");
    expect(find(setup.skills, "claude", "plugin", "quiet-skill").disabled).toBe(
      "The plugin quiet@market is off",
    );
    expect(find(setup.skills, "codex", "user", "retired").disabled).toMatch(
      /skills\.config/,
    );
    expect(
      setup.commands.map((command) => `${command.scope}:${command.name}`),
    ).toEqual([
      "project:deploy",
      "project:ops/rollback",
      "user:ship",
      "plugin:helper-cmd",
    ]);
    expect(find(setup.commands, "claude", "user", "ship").description).toBe(
      "Ship it",
    );
    const opened = await readSetupFile(
      files.get(find(setup.skills, "claude", "user", "user-skill").id) ?? "",
    );
    expect(opened.frontmatter).toContain("name: user-skill");
    expect(opened.body).toBe("# User skill\n\nThe body.\n");

    // Hooks: Lanework's own marked (D5), Codex's review and trust honoured.
    const hooks = setup.hooks.map((hook) => ({
      key: `${hook.agent}:${hook.scope}:${hook.event}:${hook.type}`,
      lanework: hook.lanework,
      disabled: hook.disabled,
    }));
    expect(hooks).toContainEqual({
      key: "claude:user:Stop:command",
      lanework: true,
      disabled: null,
    });
    expect(hooks).toContainEqual({
      key: "claude:plugin:Stop:command",
      lanework: true,
      disabled: null,
    });
    expect(hooks).toContainEqual({
      key: "codex:user:Stop:command",
      lanework: true,
      disabled: null,
    });
    expect(hooks).toContainEqual({
      key: "codex:user:SessionStart:command",
      lanework: false,
      disabled: "Not reviewed in Codex yet (/hooks)",
    });
    expect(
      hooks.find((hook) => hook.key === "codex:project:Stop:command")?.disabled,
    ).toMatch(/trusted/);
    expect(setup.hooks.find((hook) => hook.type === "http")?.detail).toBe(
      "hooks.example.com",
    );

    // Permissions: Claude's rules and modes, Codex's policies and rules.
    const rules = setup.permissions.map(
      (rule) => `${rule.agent}:${rule.scope}:${rule.kind}:${rule.value}`,
    );
    expect(rules).toEqual(
      expect.arrayContaining([
        "claude:local:allow:WebFetch(domain:example.com)",
        "claude:local:allow:Bash(git status)",
        "claude:project:ask:Bash(git push:*)",
        "claude:user:mode:acceptEdits",
        "claude:user:allow:Bash(bun run typecheck)",
        "claude:user:directory:../shared",
        "claude:user:auto:2 environment, 1 soft deny",
        "codex:local:trust:not set (untrusted)",
        "codex:user:approval:on-request",
        "codex:user:sandbox:workspace-write",
        "codex:user:allow:bun run typecheck",
        "codex:user:ask:git (push|reset)",
        "codex:user:allow:network api.example.com (https)",
        "codex:project:allow:make",
      ]),
    );
    expect(rules.some((rule) => rule.includes(":rm"))).toBe(false);

    // Plugins: on, off, not installed; another folder's install left out.
    const plugins = setup.plugins.map((plugin) => ({
      key: `${plugin.agent}:${plugin.scope}:${plugin.name}`,
      disabled: plugin.disabled,
    }));
    expect(plugins).toEqual([
      { key: "claude:project:lanework@lanework", disabled: null },
      { key: "claude:user:helper@market", disabled: null },
      {
        key: "claude:user:quiet@market",
        disabled: "Turned off in ~/.claude/settings.json",
      },
      {
        key: "claude:user:missing@market",
        disabled: "Not installed on this machine",
      },
      { key: "codex:user:docs@openai", disabled: null },
      { key: "codex:user:spare@openai", disabled: "Off: enabled = false" },
    ]);
  } finally {
    await cleanup();
  }
});

test("a project without a folder has no setup to read", async () => {
  const { where, cleanup } = await fixture();
  try {
    const { setup, files } = await readAgentSetup(null, where);
    expect(setup).toMatchObject({
      folder: null,
      mcp: [],
      skills: [],
      hooks: [],
      plugins: [],
    });
    expect(files.size).toBe(0);
  } finally {
    await cleanup();
  }
});

test("the TOML reader finds tables, dotted keys, inline tables and arrays of tables", () => {
  const entries = tomlEntries(
    [
      'top = "a # not a comment" # a comment',
      '[a."b.c"]',
      "key = { x = 1, y = { z = 'q' } }",
      "list = [",
      '  "one", # trailing',
      '  "two=2",',
      "]",
      "after = true",
      "[[hooks.Stop]]",
      'matcher = "m"',
      "[[hooks.Stop.hooks]]",
      'command = "first"',
      "[[hooks.Stop]]",
      "[[hooks.Stop.hooks]]",
      'command = "second"',
      "[bad key here]",
      "lost = 1",
    ].join("\n"),
  );
  const flat = Object.fromEntries(
    entries.map((entry) => [entry.path.join("/"), entry.raw]),
  );
  expect(flat).toMatchObject({
    top: '"a # not a comment"',
    "a/b.c/key/x": "1",
    "a/b.c/key/y/z": "'q'",
    "a/b.c/after": "true",
    "hooks/Stop/#0/matcher": '"m"',
    "hooks/Stop/#0/hooks/#0/command": '"first"',
    "hooks/Stop/#1/hooks/#0/command": '"second"',
  });
  // A multi-line array is one value, not keys of its own.
  expect(flat["a/b.c/list"]).toContain('"two=2"');
  expect(Object.keys(flat).some((key) => key.includes("two"))).toBe(false);
  // Keys under a header it cannot read are dropped, not misfiled.
  expect(Object.keys(flat).some((key) => key.endsWith("lost"))).toBe(false);
});

test("Codex rules are read as text: prefix and network rules, defaults and comments", () => {
  expect(
    codexRules(
      [
        'prefix_rule(pattern=["ls"])',
        "prefix_rule(",
        '  pattern = ["npm", ["test", "run"]],',
        '  decision = "forbidden",',
        '  justification = "no (really)",',
        ")",
        '# prefix_rule(pattern=["rm"], decision="allow")',
      ].join("\n"),
    ),
  ).toEqual([
    { kind: "allow", value: "ls" },
    { kind: "deny", value: "npm (test|run)" },
  ]);
});

// ── The app ─────────────────────────────────────────────────────────────────

test.describe("in the app", () => {
  const workspaces: Workspace[] = [
    {
      id: "ws-alpha",
      slug: "alpha",
      name: "Alpha",
      path: null,
      baseBranch: null,
    },
    { id: "ws-beta", slug: "beta", name: "Beta", path: null, baseBranch: null },
  ];

  test("Settings › Projects shows the setup: every group, dimmed entries, a command opened, no secret", async () => {
    const plane = await startStubPlane({ workspaces });
    for (const workspace of workspaces)
      plane.setBoard(workspace.id as string, {
        columns: [{ key: "todo", name: "To-Do", role: "start" }],
        cards: [],
      });
    const profile = await realpath(
      await mkdtemp(join(tmpdir(), "lanew-setup-ui-")),
    );
    const home = join(profile, "home");
    const folder = join(profile, "repo");
    const agentHome = join(profile, "agent-home");
    await seedCredential(home, plane.origin);
    // Where `launchEnv` points the app: CLAUDE_CONFIG_DIR and CODEX_HOME in
    // the profile, and the fake home for `~/.agents`.
    await seedSetup(
      {
        home: agentHome,
        claudeDir: join(profile, "claude"),
        claudeJson: join(profile, "claude", ".claude.json"),
        codexDir: join(profile, "codex"),
      },
      folder,
    );
    const previous = process.env.LANEWORK_HOME;
    process.env.LANEWORK_HOME = home;
    const record = {
      machineId: "test-machine",
      userId: "test-user",
      apiUrl: plane.origin,
      name: "test-machine",
      secret: "lw_mch_test-secret",
      owner: null,
    } satisfies MachineRecord;
    await writeFolders(record, "alpha", [folder]);
    if (previous === undefined) delete process.env.LANEWORK_HOME;
    else process.env.LANEWORK_HOME = previous;

    const app = await electron.launch({
      args: [process.cwd()],
      env: {
        ...launchEnv({ profile, home, apiUrl: plane.origin }),
        LANEWORK_TEST_AGENT_HOME: agentHome,
      },
    });
    try {
      const page: Page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page
        .getByRole("button", { name: /^Switch project/ })
        .waitFor({ state: "visible", timeout: 15_000 });
      await page.goto("app://lanework/settings/workspaces");
      await page.getByRole("button", { name: "Select Alpha" }).click();

      const section = page.getByRole("region", { name: "Agent setup" });
      for (const group of [
        "MCP servers",
        "Commands",
        "Hooks",
        "Permissions",
        "Plugins",
      ])
        await expect(section.getByRole("region", { name: group })).toBeVisible({
          timeout: 15_000,
        });

      // D3: a server off for this folder is dimmed, with the reason.
      const mcp = section.getByRole("region", { name: "MCP servers" });
      const off = mcp.locator("[data-disabled]", { hasText: "off-server" });
      await expect(off).toBeVisible();
      await expect(off.getByTestId("agent-setup-disabled")).toContainText(
        "disabledMcpjsonServers",
      );
      await expect(
        mcp.locator("[data-disabled]", { hasText: "mcp.lanework.dev" }),
      ).toHaveCount(0);
      const plugins = section.getByRole("region", { name: "Plugins" });
      await expect(
        plugins.locator("[data-disabled]", { hasText: "quiet@market" }),
      ).toContainText("Turned off in");

      // Skills have their own page now (FE-47/D9), not a group here.
      await expect(section.getByRole("region", { name: "Skills" })).toHaveCount(
        0,
      );

      // D4: a command opens read-only, its body as markdown.
      const commands = section.getByRole("region", { name: "Commands" });
      await commands.getByRole("button", { name: "Open /ship" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Steps.")).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Reveal in Finder" }),
      ).toBeEnabled();
      await dialog.getByRole("button", { name: "Close" }).first().click();
      await expect(dialog).toBeHidden();

      // Nothing secret anywhere on the page.
      expect(await page.content()).not.toContain(SECRET);

      // D5: Lanework's checkpoint hook is marked and leads to Settings › Harness.
      const hooks = section.getByRole("region", { name: "Hooks" });
      await expect(
        hooks.getByText("Lanework checkpoint").first(),
      ).toBeVisible();

      // V3: a project with no folder here says so with ui/empty.
      await page.getByRole("button", { name: "Select Beta" }).click();
      await expect(
        section.locator('[data-slot="empty"]', { hasText: "No folder linked" }),
      ).toBeVisible();
      await expect(
        section.getByRole("region", { name: "Commands" }),
      ).toHaveCount(0);

      await page.getByRole("button", { name: "Select Alpha" }).click();
      await hooks
        .getByRole("button", { name: /Settings › Harness/ })
        .first()
        .click();
      await expect.poll(() => page.url()).toContain("/settings/harness");
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      await plane.close();
      await removeProfile(profile);
    }
  });
});
