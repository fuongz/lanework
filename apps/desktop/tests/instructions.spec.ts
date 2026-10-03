// What a project's agents are told (FE-37): the CLAUDE.md and AGENTS.md
// files each CLI reads, found under plain Node against a fake home, then the
// Instructions screen end to end.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { MachineRecord } from "../electron/main/auth/store";
import {
  codexDocConfig,
  codexTrust,
  effectiveInstructions,
  INSTRUCTION_READ_MAX,
  type InstructionRoots,
  type InstructionTree,
  instructionId,
  listInstructions,
  readInstruction,
  splitRule,
} from "../electron/main/instructions/read";
import { writeFolders } from "../electron/main/workspaces/store";
import { findImports, type InstructionNode } from "../shared/instructions";
import type { Workspace } from "../shared/workspaces";
import { linkImports } from "../src/lib/instructions";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

const run = promisify(execFile);

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** Write each `path → text` under `root`, folders and all. */
async function seed(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

/** A fake machine: a home with both CLIs' folders, and a repository in it. */
async function machine(): Promise<InstructionRoots & { repo: string }> {
  const home = await tempDir("lanew-instructions-home-");
  const repo = join(home, "work", "repo");
  await mkdir(repo, { recursive: true });
  await run("git", ["init", "-q"], { cwd: repo });
  return {
    repo,
    folder: repo,
    home,
    claudeHome: join(home, ".claude"),
    codexHome: join(home, ".codex"),
    claudeJson: join(home, ".claude.json"),
    managed: null,
  };
}

/** A reading as `[scope/load] name`, imports indented — what a test compares. */
function outline(tree: InstructionTree, nodes: InstructionNode[], depth = 0) {
  const lines: string[] = [];
  for (const node of nodes) {
    const file = tree.list.files[node.file];
    lines.push(
      `${"  ".repeat(depth)}[${node.scope}/${node.load}] ${file?.name}`,
    );
    lines.push(...outline(tree, node.children, depth + 1));
  }
  return lines;
}

const note = (
  tree: InstructionTree,
  nodes: InstructionNode[],
  name: string,
) => {
  const walk = (list: InstructionNode[]): InstructionNode | undefined => {
    for (const node of list) {
      if (tree.list.files[node.file]?.name === name) return node;
      const deeper = walk(node.children);
      if (deeper) return deeper;
    }
  };
  return walk(nodes)?.note ?? null;
};

test("FE-37: an import is an `@path` outside code, never quoted — and the renderer links exactly the same ones", () => {
  const text = [
    "See @README for the overview and @docs/git.md.",
    "Mail me at someone@example.com, or ping @mention.",
    'Literal: `@not/imported.md`, and "@quoted.md" stays text.',
    "- API @Design\\ Docs/api.md",
    "```",
    "@fenced/away.md",
    "```",
    "~~~md",
    "@tilde/away.md",
    "~~~",
    "@after/fence.md",
  ].join("\n");
  expect(findImports(text).map((match) => match.path)).toEqual([
    "README",
    "docs/git.md",
    "mention",
    "Design Docs/api.md",
    "after/fence.md",
  ]);
  const linked = linkImports(text);
  expect(linked).toContain("[@README](#lanework-import-0)");
  expect(linked).toContain("[@docs/git.md](#lanework-import-1).");
  expect(linked).toContain("[@Design\\ Docs/api.md](#lanework-import-3)");
  expect(linked).toContain("`@not/imported.md`");
  expect(linked).toContain("@fenced/away.md\n```");
});

test("FE-37: Claude's reading follows imports — relative, from home, four hops and no further — reads a file once, and lists one that is missing", async () => {
  const roots = await machine();
  await seed(roots.claudeHome, {
    "CLAUDE.md": "@RTK.md\n",
    "RTK.md": "# RTK\n",
  });
  await seed(roots.home, { "notes/mine.md": "Personal notes.\n" });
  await seed(roots.repo, {
    "CLAUDE.md": [
      "Read @AGENTS.md first, then @docs/a.md.",
      "Mine: @~/notes/mine.md. Gone: @missing/gone.md. Mention: @someone.",
      "",
    ].join("\n"),
    "AGENTS.md": "Shared rules. Back to @CLAUDE.md.\n",
    "docs/a.md": "@b.md\n",
    "docs/b.md": "@c.md\n",
    "docs/c.md": "@d.md\n",
    "docs/d.md": "@e.md\n",
    "docs/e.md": "Five deep.\n",
  });
  // Imports of files outside the project were approved for it.
  await writeFile(
    roots.claudeJson,
    JSON.stringify({
      projects: { [roots.repo]: { hasClaudeMdExternalIncludesApproved: true } },
    }),
  );
  const tree = await listInstructions(roots);
  const user = join(roots.claudeHome, "CLAUDE.md");
  expect(outline(tree, tree.list.claude)).toEqual([
    `[user/launch] ${user}`,
    `  [import/launch] ${join(roots.claudeHome, "RTK.md")}`,
    "[project/launch] CLAUDE.md",
    "  [import/launch] AGENTS.md",
    "    [import/skipped] CLAUDE.md",
    "  [import/launch] docs/a.md",
    "    [import/launch] docs/b.md",
    "      [import/launch] docs/c.md",
    "        [import/launch] docs/d.md",
    "          [import/skipped] docs/e.md",
    `  [import/launch] ${join(roots.home, "notes", "mine.md")}`,
    "  [import/skipped] missing/gone.md",
  ]);
  expect(note(tree, tree.list.claude, "docs/e.md")).toMatch(
    /four imports deep/,
  );
  expect(note(tree, tree.list.claude, "missing/gone.md")).toMatch(/No file/);
  expect(
    tree.list.files[instructionId(join(roots.repo, "missing/gone.md"))]
      ?.missing,
  ).toBe(true);
  // A CLAUDE.md here: AGENTS.md is read through its import only.
  expect(tree.list.claudeMode).toBe("claude-md-or-agents-md");

  // Not approved: an import from outside the project waits for Claude to ask.
  await writeFile(roots.claudeJson, JSON.stringify({ projects: {} }));
  const asked = await listInstructions(roots);
  const mine = join(roots.home, "notes", "mine.md");
  expect(outline(asked, asked.list.claude)).toContain(
    `  [import/skipped] ${mine}`,
  );
  expect(note(asked, asked.list.claude, mine)).toMatch(/asks before loading/);

  // Effective: in reading order, imports right after the file naming them.
  const effective = await effectiveInstructions(tree, "claude");
  expect(
    effective.sections.map((section) => tree.list.files[section.file]?.name),
  ).toEqual([
    user,
    join(roots.claudeHome, "RTK.md"),
    "CLAUDE.md",
    "AGENTS.md",
    "docs/a.md",
    "docs/b.md",
    "docs/c.md",
    "docs/d.md",
    mine,
  ]);
  expect(effective.sections[3]?.text).toContain("Shared rules.");
});

test("FE-37: AGENTS.md — Claude reads it only without a CLAUDE.md unless told otherwise; Codex takes one file per folder from the root, under its byte budget", async () => {
  const roots = await machine();
  const folder = join(roots.repo, "app");
  await seed(roots.repo, {
    "AGENTS.md": "Root rules, longer than the budget.\n",
    "app/AGENTS.override.md": "   \n",
    "app/AGENTS.md": "Kept out by the empty override.\n",
  });
  await seed(roots.codexHome, {
    "AGENTS.md": "Global Codex notes.\n",
    "config.toml": [
      "project_doc_max_bytes = 10",
      'project_doc_fallback_filenames = ["TEAM.md", "../x.md"]',
      "",
      "[mcp_servers.x]",
      "project_doc_max_bytes = 99",
      "",
    ].join("\n"),
  });
  const at = { ...roots, folder };
  const tree = await listInstructions(at);
  expect(outline(tree, tree.list.codex)).toEqual([
    `[user/launch] ${join(roots.codexHome, "AGENTS.md")}`,
    `[parent/launch] ${join(roots.repo, "AGENTS.md")}`,
    "[project/skipped] AGENTS.override.md",
    "[project/skipped] AGENTS.md",
  ]);
  expect(note(tree, tree.list.codex, join(roots.repo, "AGENTS.md"))).toMatch(
    /Cut after 10 bytes/,
  );
  expect(note(tree, tree.list.codex, "AGENTS.override.md")).toMatch(/Empty/);
  expect(note(tree, tree.list.codex, "AGENTS.md")).toMatch(
    /reads AGENTS.override.md in this folder instead/,
  );
  const codex = await effectiveInstructions(tree, "codex");
  expect(codex.sections.map((section) => section.text)).toEqual([
    "Global Codex notes.\n",
    "Root rules",
  ]);
  expect(codex.sections[1]?.truncated).toBe(true);

  // No CLAUDE.md anywhere: Claude reads every AGENTS.md from the root down.
  expect(outline(tree, tree.list.claude)).toEqual([
    `[parent/launch] ${join(roots.repo, "AGENTS.md")}`,
    "[project/launch] AGENTS.md",
  ]);

  // Told to read CLAUDE.md only: AGENTS.md is listed, and left out.
  await seed(roots.claudeHome, {
    "settings.json": JSON.stringify({
      pluginConfigs: {
        "agents-md@builtin": { options: { instructionFiles: "claude-md" } },
      },
    }),
  });
  const claudeOnly = await listInstructions(at);
  expect(claudeOnly.list.claudeMode).toBe("claude-md");
  expect(outline(claudeOnly, claudeOnly.list.claude)).toEqual([
    `[parent/skipped] ${join(roots.repo, "AGENTS.md")}`,
    "[project/skipped] AGENTS.md",
  ]);

  // A project Codex is told not to trust reads no AGENTS.md of its own.
  expect(
    codexTrust(`[projects."${roots.repo}"]\ntrust_level = "untrusted"\n`, [
      folder,
      roots.repo,
    ]),
  ).toBe("untrusted");
  expect(
    codexDocConfig('project_doc_fallback_filenames = ["A.md", ".."]'),
  ).toEqual({ maxBytes: 32 * 1024, fallbacks: ["A.md"] });
});

test("FE-37: rules load at launch or on matching files; files in subfolders say who reads them and when; node_modules and worktrees are never entered", async () => {
  const roots = await machine();
  await seed(roots.repo, {
    "CLAUDE.md": "Root.\n",
    ".claude/rules/general.md": "Always.\n",
    ".claude/rules/api/ts.md":
      '---\npaths:\n  - "src/api/**/*.ts"\n  - "lib/*.ts"\n---\n\nTyped APIs.\n',
    "apps/web/CLAUDE.md": "Web only. @../../docs/web.md\n",
    "docs/web.md": "Web docs.\n",
    "apps/desktop/AGENTS.md": "Desktop rules.\n",
    "node_modules/pkg/CLAUDE.md": "Never read.\n",
    ".claude/worktrees/fe-1/CLAUDE.md": "Never read.\n",
  });
  const tree = await listInstructions(roots);
  expect(outline(tree, tree.list.claude)).toEqual([
    "[project/launch] CLAUDE.md",
    "[rules/conditional] .claude/rules/api/ts.md",
    "[rules/launch] .claude/rules/general.md",
  ]);
  expect(note(tree, tree.list.claude, ".claude/rules/api/ts.md")).toBe(
    "Loads when Claude reads or edits src/api/**/*.ts, lib/*.ts.",
  );
  expect(outline(tree, tree.list.nested)).toEqual([
    "[nested/conditional] apps/desktop/AGENTS.md",
    "[nested/conditional] apps/web/CLAUDE.md",
    "  [import/launch] docs/web.md",
  ]);
  const [desktop, web] = tree.list.nested;
  // A CLAUDE.md at the root keeps Claude off AGENTS.md: Codex alone reads it.
  expect(desktop?.agents).toEqual(["codex"]);
  expect(desktop?.note).toBe(
    "Codex reads it when it starts in apps/desktop/ or below.",
  );
  expect(web?.agents).toEqual(["claude"]);
  expect(web?.note).toBe("Claude reads it once it opens a file in apps/web/.");
  // A rule's frontmatter is not what Claude reads of it.
  expect(splitRule("---\npaths: a, b\n---\nBody\n")).toEqual({
    paths: ["a", "b"],
    body: "Body\n",
  });
  const rule = await readInstruction(
    tree,
    roots,
    instructionId(join(roots.repo, ".claude/rules/api/ts.md")),
  );
  expect(rule.paths).toEqual(["src/api/**/*.ts", "lib/*.ts"]);
  expect(rule.body).not.toContain("paths:");
});

test("FE-37: a file is read by an id from the listing alone — an unknown id, a missing file and anything but Markdown are refused, and a long one is cut", async () => {
  const roots = await machine();
  await seed(roots.repo, {
    "CLAUDE.md": "See @package.json and @AGENTS.md, not @nowhere/here.md.\n",
    "AGENTS.md": `${"x".repeat(INSTRUCTION_READ_MAX + 4096)}\n`,
    "package.json": '{ "name": "x" }\n',
  });
  const tree = await listInstructions(roots);
  const id = (path: string) => instructionId(join(roots.repo, path));
  const claude = await readInstruction(tree, roots, id("CLAUDE.md"));
  expect(claude.imports).toEqual([
    { path: "package.json", file: id("package.json") },
    { path: "AGENTS.md", file: id("AGENTS.md") },
    { path: "nowhere/here.md", file: id("nowhere/here.md") },
  ]);
  const long = await readInstruction(tree, roots, id("AGENTS.md"));
  expect(long.truncated).toBe(true);
  expect(long.raw.length).toBe(INSTRUCTION_READ_MAX);
  await expect(
    readInstruction(tree, roots, "0123456789abcdef"),
  ).rejects.toThrow(/not one this project's agents read/);
  // A path the listing never named is no id at all.
  await expect(
    readInstruction(tree, roots, instructionId("/etc/passwd")),
  ).rejects.toThrow(/not one this project's agents read/);
  await expect(
    readInstruction(tree, roots, id("nowhere/here.md")),
  ).rejects.toThrow(/no file there/);
  await expect(
    readInstruction(tree, roots, id("package.json")),
  ).rejects.toThrow(/Only Markdown/);
  // Effective lists it by name, without its text (FE-37/D6).
  const effective = await effectiveInstructions(tree, "claude");
  const json = effective.sections.find(
    (section) => section.file === id("package.json"),
  );
  expect(json?.text).toBeNull();
});

const workspaces: Workspace[] = [
  {
    id: "ws-alpha",
    slug: "alpha",
    name: "Alpha",
    path: null,
    baseBranch: null,
  },
  { id: "ws-beta", slug: "beta", name: "Beta", path: null, baseBranch: null },
  {
    id: "ws-gamma",
    slug: "gamma",
    name: "Gamma",
    path: null,
    baseBranch: null,
  },
];

const board = {
  columns: [{ key: "todo", name: "To-Do", role: "start" }],
  cards: [],
};

async function switchTo(page: Page, name: string) {
  await page.getByRole("button", { name: /^Switch project/ }).click();
  await page.getByRole("option", { name }).first().click();
  await expect(
    page.getByRole("button", { name: `Switch project — currently ${name}` }),
  ).toBeVisible();
}

test("FE-37: Instructions shows what each agent reads, follows an @import, shows the raw file and keeps up with new files", async () => {
  test.skip(process.platform === "win32", "Folders are a POSIX path here.");
  const plane = await startStubPlane({ workspaces });
  for (const workspace of workspaces) plane.setBoard(workspace.id ?? "", board);
  const profile = await mkdtemp(join(tmpdir(), "lanew-instructions-app-"));
  const home = join(profile, "home");
  await mkdir(home, { recursive: true });
  await seedCredential(home, plane.origin);
  // Alpha has instructions; Beta has a folder and none; Gamma has no folder.
  const alpha = await tempDir("lanew-instructions-alpha-");
  const beta = await tempDir("lanew-instructions-beta-");
  await run("git", ["init", "-q"], { cwd: alpha });
  await seed(alpha, {
    "CLAUDE.md": "# Alpha\n\nStart with @AGENTS.md. Gone: @missing/gone.md.\n",
    "AGENTS.md": "Shared by every agent.\n",
  });
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
  await writeFolders(record, "alpha", [alpha]);
  await writeFolders(record, "beta", [beta]);
  if (previous === undefined) delete process.env.LANEWORK_HOME;
  else process.env.LANEWORK_HOME = previous;

  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    const rail = page.getByRole("navigation", { name: "Project" });
    await rail.getByRole("link", { name: "Instructions" }).click();

    // Everything Claude reads at launch opens first, in order (FE-37/D4).
    const effective = page.getByRole("region", {
      name: "Instructions — Effective for Claude",
    });
    await expect(effective.getByRole("article")).toHaveCount(2);
    await expect(effective.getByRole("article").first()).toContainText("Alpha");
    await expect(effective.getByRole("article").last()).toContainText(
      "Shared by every agent.",
    );

    const list = page.getByRole("navigation", { name: "Instruction files" });
    await expect(list.getByRole("heading")).toHaveText(["Claude", "Codex"]);
    await list.getByRole("link", { name: /^CLAUDE\.md/ }).click();
    const claude = page.getByRole("region", {
      name: "Instructions — CLAUDE.md",
    });
    await expect(
      claude.getByTestId("instruction-meta").getByRole("definition").first(),
    ).toHaveText("Claude (Project)");
    // A missing import is not a link.
    await expect(claude).toContainText("@missing/gone.md");
    await expect(
      claude.getByRole("link", { name: "@missing/gone.md" }),
    ).toHaveCount(0);

    await claude.getByRole("button", { name: "Raw" }).click();
    await expect(claude.getByTestId("instruction-raw")).toContainText(
      "# Alpha",
    );
    await claude.getByRole("button", { name: "Raw" }).click();

    await claude.getByRole("link", { name: "@AGENTS.md" }).click();
    const agents = page.getByRole("region", {
      name: "Instructions — AGENTS.md",
    });
    await expect(agents).toContainText("Shared by every agent.");
    // Read by both: Claude through the import, Codex on its own.
    await expect(
      agents.getByTestId("instruction-meta").getByRole("definition").first(),
    ).toHaveText("Claude (Import), Codex (Project)");
    await page.goBack();
    await expect(claude).toBeVisible();

    // A new file is picked up without a reload (FE-37/D7).
    await writeFile(join(alpha, "CLAUDE.local.md"), "Only mine.\n");
    await expect(
      list.getByRole("link", { name: /^CLAUDE\.local\.md/ }),
    ).toBeVisible();

    // A folder nobody wrote instructions for, and no folder at all (V3).
    await switchTo(page, "Beta");
    await rail.getByRole("link", { name: "Instructions" }).click();
    await expect(page.getByText("No instructions yet")).toBeVisible();
    await switchTo(page, "Gamma");
    await rail.getByRole("link", { name: "Instructions" }).click();
    await expect(page.getByText("No folder linked")).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});
