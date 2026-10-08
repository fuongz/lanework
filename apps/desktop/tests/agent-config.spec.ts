// FE-47: the user's own Claude Code and Codex config files, edited in
// Settings → Agents. The read/write module is driven under plain Node on a
// fake home (V1, V2), the quick-setting edits as pure functions (D6), and the
// last case boots the app and edits `config.toml` through the editor (V3).
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  BACKUPS_KEPT,
  listConfigFiles,
  pathOf,
  readConfigFile,
  writeConfigFile,
} from "../electron/main/agent-config/files";
import type { AgentHome } from "../electron/main/agent-home";
import { CONFIG_FILE_IDS, isConfigFileId } from "../shared/agent-config";
import {
  claudeDefaultMode,
  codexFeatures,
  syntaxError,
  withClaudeDefaultMode,
  withCodexFeature,
} from "../shared/agent-config-text";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function fakeHome(): Promise<{ root: string; where: AgentHome }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lanew-config-")));
  const home = join(root, "home");
  return {
    root,
    where: {
      home,
      claudeDir: join(home, ".claude"),
      claudeJson: join(home, ".claude.json"),
      codexDir: join(home, ".codex"),
    },
  };
}

const CONFIG = `# my codex
model = "gpt-5"

[features]
js_repl = false # keep off
hooks = true

[mcp_servers.lanework]
url = "https://mcp.lanework.dev/v1"
`;

test("a write is refused for a stale hash or a file that would not parse, and backed up when it lands", async () => {
  const { root, where } = await fakeHome();
  try {
    const path = pathOf("codex-config", where);
    await put(path, CONFIG);
    const opened = await readConfigFile("codex-config", where);
    expect(opened.text).toBe(CONFIG);

    // Not TOML: nothing written, the file as it was.
    const broken = await writeConfigFile(
      "codex-config",
      "[features\nhooks =",
      opened.hash,
      where,
    );
    expect(broken.status).toBe("invalid");
    expect(await readFile(path, "utf8")).toBe(CONFIG);

    // Changed on disk after it was opened: a conflict, and the other edit kept.
    await writeFile(path, `${CONFIG}# edited elsewhere\n`);
    const stale = await writeConfigFile(
      "codex-config",
      CONFIG,
      opened.hash,
      where,
    );
    expect(stale.status).toBe("conflict");
    expect(await readFile(path, "utf8")).toContain("edited elsewhere");

    // Saved seven times in one second: five copies kept, never one overwritten.
    let hash = (await readConfigFile("codex-config", where)).hash;
    const now = new Date(2026, 9, 8, 11, 30, 0);
    let last = "";
    for (let n = 0; n < 7; n++) {
      last = `${CONFIG}# save ${n} — ünïcode\n`;
      const result = await writeConfigFile(
        "codex-config",
        last,
        hash,
        where,
        now,
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.backup).toMatch(
        /^~\/\.codex\/config\.toml\.lanework-bak-20261008113000/,
      );
      hash = result.content.hash;
    }
    expect(await readFile(path, "utf8")).toBe(last);
    const copies = (await readdir(dirname(path))).filter((name) =>
      name.startsWith("config.toml.lanework-bak-"),
    );
    expect(copies).toHaveLength(BACKUPS_KEPT);
    // No temp file left behind.
    expect(
      (await readdir(dirname(path))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);

    // JSON is checked too, and a file not there yet is created from `""`.
    const missing = await readConfigFile("claude-settings", where);
    expect(missing).toMatchObject({ text: "", hash: "" });
    expect(
      (await writeConfigFile("claude-settings", "{ nope", "", where)).status,
    ).toBe("invalid");
    const created = await writeConfigFile(
      "claude-settings",
      '{\n  "model": "opus"\n}\n',
      "",
      where,
    );
    expect(created).toMatchObject({ status: "ok", backup: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only the listed files can be named, and a symlinked config stays a link", async () => {
  const { root, where } = await fakeHome();
  try {
    for (const id of [
      "../.ssh/id_rsa",
      "/etc/hosts",
      "codex-config/../x",
      "auth",
      "",
      7,
      null,
    ])
      expect(isConfigFileId(id)).toBe(false);
    for (const id of CONFIG_FILE_IDS) expect(isConfigFileId(id)).toBe(true);

    // Every path the module can make is inside the agents' homes.
    for (const id of CONFIG_FILE_IDS) {
      const path = pathOf(id, where);
      expect(
        path.startsWith(`${where.claudeDir}/`) ||
          path.startsWith(`${where.codexDir}/`),
      ).toBe(true);
    }
    const listed = await listConfigFiles(where);
    expect(
      listed.filter((file) => file.kind === "config").map((file) => file.id),
    ).toEqual([...CONFIG_FILE_IDS]);
    expect(listed.every((file) => file.path.startsWith("~/"))).toBe(true);
    // The list says where and how big — never what the file says.
    await put(pathOf("codex-config", where), 'token = "listsecret"\n');
    expect(JSON.stringify(await listConfigFiles(where))).not.toContain(
      "listsecret",
    );

    // A dotfiles link: the write goes through to what it points at.
    const real = join(root, "dotfiles", "settings.json");
    await put(real, "{}\n");
    await mkdir(where.claudeDir, { recursive: true });
    await symlink(real, pathOf("claude-settings", where));
    const opened = await readConfigFile("claude-settings", where);
    const result = await writeConfigFile(
      "claude-settings",
      '{ "a": 1 }\n',
      opened.hash,
      where,
    );
    expect(result.status).toBe("ok");
    expect((await stat(pathOf("claude-settings", where))).isFile()).toBe(true);
    expect(
      (await lstat(pathOf("claude-settings", where))).isSymbolicLink(),
    ).toBe(true);
    expect(await readFile(real, "utf8")).toBe('{ "a": 1 }\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const SKILL = `---
name: review
description: >
  Review a diff
  before it lands.
---
Review the diff.
`;

test("skills: listed by folder, edited in place, and only real skill folders can be named", async () => {
  const { root, where } = await fakeHome();
  try {
    const claudeSkill = join(where.claudeDir, "skills", "review", "SKILL.md");
    await put(claudeSkill, SKILL);
    await put(
      join(where.home, ".agents", "skills", "deploy", "SKILL.md"),
      "# deploy\n",
    );
    await put(join(where.codexDir, "skills", "old", "SKILL.md"), "# old\n");
    // Not listed: Codex's own, a folder with no SKILL.md, a loose file.
    await put(
      join(where.codexDir, "skills", ".system", "x", "SKILL.md"),
      "# x\n",
    );
    await mkdir(join(where.claudeDir, "skills", "empty"), { recursive: true });
    await put(join(where.claudeDir, "skills", "notes.md"), "# notes\n");
    // A dotfiles link to a skill folder elsewhere is the user's skill too.
    await put(join(root, "shared-skills", "linked", "SKILL.md"), "# linked\n");
    await symlink(
      join(root, "shared-skills", "linked"),
      join(where.claudeDir, "skills", "linked"),
    );

    const skills = (await listConfigFiles(where)).filter(
      (file) => file.kind === "skill",
    );
    expect(skills.map((file) => [file.id, file.agent])).toEqual([
      ["skill:claude:linked", "claude"],
      ["skill:claude:review", "claude"],
      ["skill:agents:deploy", "codex"],
      ["skill:codex:old", "codex"],
    ]);
    expect(skills[1]).toMatchObject({
      label: "review",
      description: "Review a diff before it lands.",
      path: "~/.claude/skills/review/SKILL.md",
      format: "markdown",
    });

    for (const id of [
      "skill:claude:../../.ssh",
      "skill:claude:.system",
      "skill:claude:a/b",
      "skill:nope:review",
      "skill:claude:",
    ])
      expect(isConfigFileId(id)).toBe(false);

    const opened = await readConfigFile("skill:claude:review", where);
    const result = await writeConfigFile(
      "skill:claude:review",
      `${SKILL}More.\n`,
      opened.hash,
      where,
    );
    expect(result.status).toBe("ok");
    expect(await readFile(claudeSkill, "utf8")).toBe(`${SKILL}More.\n`);
    // A skill is edited, never made: a folder that is not there stays absent.
    expect(
      (await writeConfigFile("skill:claude:ghost", "# ghost\n", "", where))
        .status,
    ).toBe("invalid");
    expect(
      await stat(join(where.claudeDir, "skills", "ghost")).catch(() => null),
    ).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a quick setting changes one line and keeps every comment", () => {
  expect(codexFeatures(CONFIG)).toEqual({ js_repl: false, hooks: true });

  // In place, the trailing comment kept.
  const off = withCodexFeature(CONFIG, "js_repl", true);
  expect(off).toBe(
    CONFIG.replace("js_repl = false # keep off", "js_repl = true # keep off"),
  );

  // Added at the end of [features], before the next table.
  const added = withCodexFeature(CONFIG, "api_key_model_discovery", false);
  expect(added).toContain(
    "hooks = true\napi_key_model_discovery = false\n\n[mcp_servers.lanework]",
  );
  expect(syntaxError("toml", added)).toBeNull();
  expect(codexFeatures(added).api_key_model_discovery).toBe(false);

  // No [features] table at all: one is added at the end.
  expect(withCodexFeature('model = "x"\n', "hooks", false)).toBe(
    'model = "x"\n\n[features]\nhooks = false\n',
  );
  // A dotted key at the top level is the one that changes.
  expect(withCodexFeature("features.hooks = false\n", "hooks", true)).toBe(
    "features.hooks = true\n",
  );

  const settings =
    '{\n  "permissions": {\n    "defaultMode": "default",\n    "allow": []\n  },\n  "model": "opus"\n}\n';
  expect(claudeDefaultMode(settings)).toBe("default");
  expect(withClaudeDefaultMode(settings, "plan")).toBe(
    settings.replace('"default"', '"plan"'),
  );
  expect(
    claudeDefaultMode(
      withClaudeDefaultMode('{ "model": "opus" }', "auto") ?? "",
    ),
  ).toBe("auto");
  expect(withClaudeDefaultMode("{ nope", "plan")).toBeNull();

  expect(syntaxError("json", "")).toBeNull();
  expect(syntaxError("json", "{,}")).not.toBeNull();
  expect(syntaxError("toml", "a = ")).toMatch(/^Line 1/);
});

test("in the app: edit config.toml — a switch saves one line, broken TOML cannot be saved, an outside edit is a conflict", async () => {
  const plane = await startStubPlane({});
  const profile = await realpath(
    await mkdtemp(join(tmpdir(), "lanew-config-ui-")),
  );
  const home = join(profile, "home");
  await seedCredential(home, plane.origin);
  // `launchEnv` points CODEX_HOME at `<profile>/codex`.
  const configFile = join(profile, "codex", "config.toml");
  await put(configFile, CONFIG);
  const skillFile = join(profile, "claude", "skills", "review", "SKILL.md");
  await put(skillFile, SKILL);
  const app = await electron.launch({
    args: [process.cwd()],
    env: {
      ...launchEnv({ profile, home, apiUrl: plane.origin }),
      LANEWORK_TEST_AGENT_HOME: home,
    },
  });
  try {
    const page: Page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("button", { name: /^Switch project/ })
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.goto("app://lanework/settings/agents");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect.poll(() => page.url()).toContain("/settings/config");

    const tree = page.getByRole("navigation", { name: "Config files" });
    await tree.getByRole("button", { name: /^config\.toml/ }).click();
    const dialog = page.getByRole("region", { name: "config.toml — Codex" });
    await expect(dialog).toBeVisible();
    const editor = dialog.getByTestId("agent-config-editor");
    await expect(editor).toContainText("js_repl = false # keep off");

    // A quick setting: one line added to [features], the rest untouched.
    const discovery = dialog.getByRole("switch", {
      name: "features.api_key_model_discovery",
    });
    await expect(discovery).toBeChecked();
    await discovery.click();
    await expect(discovery).not.toBeChecked();
    const save = dialog.getByRole("button", { name: "Save", exact: true });
    await save.click();
    await expect(dialog.getByRole("status")).toContainText("previous version");
    await expect
      .poll(() => readFile(configFile, "utf8"))
      .toBe(withCodexFeature(CONFIG, "api_key_model_discovery", false));

    // Broken TOML: the error shows, and Save stays off.
    await editor.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.type("\n[broken");
    await expect(dialog.getByTestId("agent-config-syntax")).toContainText(
      "Line",
    );
    await expect(save).toBeDisabled();
    await dialog.getByRole("button", { name: "Revert" }).click();
    await expect(dialog.getByTestId("agent-config-syntax")).toHaveCount(0);

    // Changed on disk behind the editor: Save is refused, Reload shows it.
    await writeFile(configFile, `${CONFIG}# from another editor\n`);
    await editor.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.type("\n# mine");
    await save.click();
    await expect(dialog.getByText(/changed on disk/)).toBeVisible();
    expect(await readFile(configFile, "utf8")).toContain("from another editor");
    await dialog.getByRole("button", { name: "Reload" }).click();
    await expect(editor).toContainText("# from another editor");

    // Edits not saved are asked about before another file opens.
    await editor.click();
    await page.keyboard.type("x");
    page.once("dialog", (prompt) => void prompt.dismiss());
    await tree.getByRole("button", { name: /^hooks\.json/ }).click();
    await expect(dialog).toBeVisible();
    page.once("dialog", (prompt) => void prompt.accept());
    await tree.getByRole("button", { name: /^hooks\.json/ }).click();
    await expect(
      page.getByRole("region", { name: "hooks.json — Codex" }),
    ).toBeVisible();

    // Skills are a page of their own: Claude Code's under its heading.
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Skills" })
      .click();
    const skills = page.getByRole("navigation", { name: "Skills" });
    await skills.getByRole("button", { name: /^review/ }).click();
    const skill = page.getByRole("region", {
      name: "review — Claude Code skill",
    });
    const skillEditor = skill.getByTestId("agent-config-editor");
    await expect(skillEditor).toContainText("Review the diff.");
    await skillEditor.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.type("\nAlso check the tests.");
    await page.keyboard.press("Meta+s");
    await expect(skill.getByRole("status")).toContainText("Saved");
    expect(await readFile(skillFile, "utf8")).toBe(
      `${SKILL}\nAlso check the tests.`,
    );
    expect(await readFile(configFile, "utf8")).toContain("from another editor");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});
