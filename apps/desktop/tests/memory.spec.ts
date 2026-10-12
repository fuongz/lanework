// What Claude Code remembers about a project (FE-36): the memory folder read
// under plain Node against a fake home, then the Memory screen end to end.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { MachineRecord } from "../electron/main/auth/store";
import {
  listMemory,
  MEMORY_READ_MAX,
  memoryDir,
  memoryRoot,
  readMemory,
  watchMemory,
} from "../electron/main/memory/read";
import { claudeProjectDir } from "../electron/main/terminal/agent-sessions";
import { writeFolders } from "../electron/main/workspaces/store";
import type { MemoryEntry } from "../shared/memory";
import type { Workspace } from "../shared/workspaces";
import { type Inline, parseMarkdown } from "../src/lib/markdown";
import { memoryTarget } from "../src/lib/memory";
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

/** The memory Claude saved for one project — both frontmatter shapes it has written. */
const MEMORIES: Record<string, string> = {
  "MEMORY.md": [
    "- [Ask first](ask-first.md) — never commit without asking",
    "- [Language preference](feedback_language.md) — Vietnamese",
    "- [Docs site](https://example.com/docs) — elsewhere",
    "",
  ].join("\n"),
  // Today's shape: the kind under `metadata`, with when it changed.
  "ask-first.md": [
    "---",
    "name: ask-first",
    'description: "Ask before creating any git commit"',
    "metadata: ",
    "  node_type: memory",
    "  type: feedback",
    "  originSessionId: 20b0dfef-813d-4d08-a3c7-ba235bdba2ac",
    "  modified: 2026-09-07T08:10:08.360Z",
    "---",
    "",
    "Ask before running `git commit` in this repo.",
    "",
    "**Why:** see [[feedback_language]], and [[nowhere-yet]].",
    "",
  ].join("\n"),
  // An older shape: the kind at the top level.
  "feedback_language.md": [
    "---",
    "name: Language preference",
    "description: User prefers Vietnamese",
    "type: feedback",
    "---",
    "",
    "Dùng tiếng Việt trong toàn bộ cuộc hội thoại.",
    "",
  ].join("\n"),
  "project_auth.md": [
    "---",
    "name: Auth lives in main",
    "description: The credential never reaches the renderer",
    "type: project",
    "---",
    "",
    "Only `store.ts` and `auth/index.ts` import Electron.",
    "",
  ].join("\n"),
  // No frontmatter at all: still a memory, of no known kind.
  "loose.md": "Just a note Claude left.\n",
};

async function seedMemory(dir: string) {
  await mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(MEMORIES))
    await writeFile(join(dir, file), text);
}

const summary = (entries: MemoryEntry[]) =>
  entries.map(({ file, name, title, type, description }) => ({
    file,
    name,
    title,
    type,
    description,
  }));

test("FE-36: a memory folder lists each memory by its frontmatter — both shapes Claude writes — under the title the index gives it, and nothing that is not one", async () => {
  const dir = join(await tempDir("lanew-memory-"), "projects", "x", "memory");
  await seedMemory(dir);
  // None of these is a memory.
  await writeFile(join(dir, "notes.txt"), "not markdown\n");
  await writeFile(join(dir, ".hidden.md"), "a dotfile\n");
  await mkdir(join(dir, "nested"));
  await writeFile(join(dir, "nested", "inner.md"), "one folder down\n");

  const listed = await listMemory(dir);
  expect(listed?.truncated).toBe(false);
  expect(summary(listed?.entries ?? [])).toEqual([
    {
      file: "MEMORY.md",
      name: "MEMORY",
      title: null,
      type: "other",
      description: null,
    },
    {
      file: "ask-first.md",
      // Its name stays its slug — what a `[[ask-first]]` names it by.
      name: "ask-first",
      title: "Ask first",
      type: "feedback",
      description: "Ask before creating any git commit",
    },
    {
      file: "feedback_language.md",
      name: "Language preference",
      title: "Language preference",
      type: "feedback",
      description: "User prefers Vietnamese",
    },
    // Not in the index: no title, and its name is what it is shown as.
    {
      file: "loose.md",
      name: "loose",
      title: null,
      type: "other",
      description: null,
    },
    {
      file: "project_auth.md",
      name: "Auth lives in main",
      title: null,
      type: "project",
      description: "The credential never reaches the renderer",
    },
  ]);
  const entry = (file: string) =>
    listed?.entries.find((one) => one.file === file);
  // When it changed: what its frontmatter says, or else the file's mtime.
  expect(entry("ask-first.md")?.modified).toBe("2026-09-07T08:10:08.360Z");
  expect(Date.parse(entry("loose.md")?.modified ?? "")).toBe(
    Math.floor(entry("loose.md")?.mtimeMs ?? 0),
  );

  // No folder yet is no memory, not an error.
  expect(await listMemory(join(dir, "..", "missing"))).toBeNull();
});

test("FE-36: a memory is read by its file name alone — a path, `..`, another kind of file or a link out of the folder is refused", async () => {
  const root = await tempDir("lanew-memory-");
  const dir = join(root, "memory");
  await seedMemory(dir);
  await writeFile(join(root, "secret.md"), "outside the memory folder\n");
  await mkdir(join(dir, "nested"));
  await writeFile(join(dir, "nested", "inner.md"), "one folder down\n");
  await symlink(join(root, "secret.md"), join(dir, "out.md"));
  await symlink(join(dir, "ask-first.md"), join(dir, "alias.md"));

  for (const bad of [
    "../secret.md",
    "/etc/hosts",
    "nested/inner.md",
    "nested\\inner.md",
    ".hidden.md",
    "notes.txt",
    "out.md",
    "",
  ])
    await expect(readMemory(dir, bad), bad).rejects.toThrow(
      /not a memory file|not in this project's folder/,
    );
  // The link out of the folder is not even listed; the one inside it is.
  const files = (await listMemory(dir))?.entries.map((entry) => entry.file);
  expect(files).not.toContain("out.md");
  expect(files).toContain("alias.md");
  expect((await readMemory(dir, "alias.md")).entry.name).toBe("ask-first");

  // Its body without the frontmatter; the raw file with it.
  const read = await readMemory(dir, "ask-first.md");
  expect(read.body.startsWith("Ask before running `git commit`")).toBe(true);
  expect(read.body).not.toContain("originSessionId");
  expect(read.raw.startsWith("---\nname: ask-first\n")).toBe(true);
  expect(read.meta["metadata.type"]).toBe("feedback");
  expect(read.meta["metadata.originSessionId"]).toBe(
    "20b0dfef-813d-4d08-a3c7-ba235bdba2ac",
  );
  expect(read.truncated).toBe(false);

  // Longer than one read takes: its start, and says so.
  await writeFile(join(dir, "huge.md"), "x".repeat(MEMORY_READ_MAX + 4096));
  const huge = await readMemory(dir, "huge.md");
  expect(huge.truncated).toBe(true);
  expect(huge.raw.length).toBe(MEMORY_READ_MAX);
});

test("FE-36: a repository's memory is its root's — from a subfolder and from a worktree too", async () => {
  const base = await tempDir("lanew-memory-git-");
  const repo = join(base, "repo");
  const git = (...args: string[]) =>
    run(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        // A developer's own signing setup would prompt, and hang the test.
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo },
    );
  await mkdir(join(repo, "apps", "web"), { recursive: true });
  await git("init", "-q");
  await git("commit", "-q", "--allow-empty", "-m", "first");
  await git("worktree", "add", "-q", join(base, "wt"), "-b", "wt");
  const plain = join(base, "plain");
  await mkdir(plain);

  expect(await memoryRoot(repo)).toBe(repo);
  expect(await memoryRoot(join(repo, "apps", "web"))).toBe(repo);
  expect(await memoryRoot(join(base, "wt"))).toBe(repo);
  expect(await memoryRoot(plain)).toBe(plain);
  expect(await memoryDir("/home/.claude", join(repo, "apps", "web"))).toBe(
    join("/home/.claude", "projects", claudeProjectDir(repo), "memory"),
  );
});

test("FE-36: the watch reports writes to the memory folder — and a folder Claude makes later", async () => {
  const project = join(await tempDir("lanew-memory-watch-"), "projects", "x");
  await mkdir(project, { recursive: true });
  const dir = join(project, "memory");
  let changes = 0;
  const stop = watchMemory(dir, () => changes++);
  try {
    // Not there yet: waited for in its parent.
    await mkdir(dir);
    await writeFile(join(dir, "first.md"), "one\n");
    await expect.poll(() => changes, { timeout: 5_000 }).toBeGreaterThan(0);
    const seen = changes;
    await writeFile(join(dir, "second.md"), "two\n");
    await expect.poll(() => changes, { timeout: 5_000 }).toBeGreaterThan(seen);
  } finally {
    stop();
  }
  // Nothing to watch at all is no error either.
  watchMemory(join(project, "..", "missing", "memory"), () => {})();
});

test("FE-36: links are read only where asked — a card body keeps them as written", async () => {
  const source =
    "See [the docs](ask-first.md), [[feedback_language]] and `[[code]]`.";
  const kinds = (spans: Inline[]) => spans.map((span) => span.kind);
  const [card] = parseMarkdown(source);
  expect(card?.kind === "paragraph" && kinds(card.spans)).toEqual([
    "text",
    "code",
    "text",
  ]);
  expect(
    card?.kind === "paragraph" &&
      card.spans.map((span) => ("text" in span ? span.text : "")).join(""),
  ).toBe("See [the docs](ask-first.md), [[feedback_language]] and [[code]].");

  const [memory] = parseMarkdown(source, { links: true });
  expect(memory?.kind === "paragraph" && kinds(memory.spans)).toEqual([
    "text",
    "link",
    "text",
    "link",
    "text",
    "code",
    "text",
  ]);

  // Where each one leads: a memory by file or name, none yet, or not one.
  const dir = join(await tempDir("lanew-memory-"), "memory");
  await seedMemory(dir);
  const entries = (await listMemory(dir))?.entries ?? [];
  const link = (href: string, wiki: boolean) =>
    memoryTarget({ kind: "link", text: href, href, wiki, raw: href }, entries);
  expect(link("feedback_language", true)).toBe("feedback_language.md");
  expect(link("Language preference", true)).toBe("feedback_language.md");
  expect(link("Ask first", true)).toBe("ask-first.md");
  expect(link("nowhere-yet", true)).toBeNull();
  expect(link("ask-first.md", false)).toBe("ask-first.md");
  expect(link("./ask-first.md", false)).toBe("ask-first.md");
  expect(link("gone.md", false)).toBeNull();
  expect(link("https://example.com/docs", false)).toBeUndefined();
  expect(link("../elsewhere/x.md", false)).toBeUndefined();
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

/** Settings › <section>, opened from the app's Settings link (FE-51). */
async function openSettings(page: Page, section: string) {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: section, exact: true })
    .click();
}

/** The project Settings › Memory/Instructions shows (FE-51/D3). */
async function pickProject(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Project" }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

test("FE-36: Memory lists what Claude saved by kind, opens the index, follows links inside, shows the raw file and keeps up with new writes", async () => {
  test.skip(
    process.platform === "win32",
    "Memory folders are a POSIX path here.",
  );
  const plane = await startStubPlane({ workspaces });
  for (const workspace of workspaces) plane.setBoard(workspace.id ?? "", board);
  const profile = await mkdtemp(join(tmpdir(), "lanew-memory-app-"));
  const home = join(profile, "home");
  await mkdir(home, { recursive: true });
  await seedCredential(home, plane.origin);
  // Alpha has memory; Beta has a folder and none; Gamma has no folder here.
  const alpha = await tempDir("lanew-memory-alpha-");
  const beta = await tempDir("lanew-memory-beta-");
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
  // `launchEnv` points CLAUDE_CONFIG_DIR at the profile's own folder.
  const dir = join(
    profile,
    "claude",
    "projects",
    claudeProjectDir(alpha),
    "memory",
  );
  await seedMemory(dir);

  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    await switchTo(page, "Alpha");
    // Settings › Memory opens on the project last open (FE-51/D3).
    await openSettings(page, "Memory");
    const memoryHeader = page
      .getByRole("complementary", { name: "Memory" })
      .locator("header");
    // The memories, the index left out.
    await expect(memoryHeader).toContainText("4");

    // The index opens first, as it is what Claude reads first.
    const index = page.getByRole("region", { name: "Memory — Index" });
    await expect(index.getByRole("heading", { name: "Index" })).toBeVisible();
    const list = page.getByRole("navigation", { name: "Memories" });
    await expect(list.getByRole("heading")).toHaveText([
      "Feedback",
      "Project",
      "Other",
    ]);
    // By the index's titles, newest first within a kind: "Ask first" says it
    // changed in September.
    await expect(list.getByRole("link")).toHaveText([
      /^Index/,
      /^Language preference/,
      /^Ask first/,
      /^Auth lives in main/,
      /^loose/,
    ]);
    // A link out of the memory folder stays as written.
    await expect(index).toContainText("[Docs site](https://example.com/docs)");

    await index.getByRole("link", { name: "Ask first" }).click();
    const ask = page.getByRole("region", { name: "Memory — Ask first" });
    const facts = ask.getByTestId("memory-meta");
    await expect(facts.getByRole("term")).toHaveText([
      "Kind",
      "Changed",
      "File",
    ]);
    await expect(facts.getByRole("definition").first()).toHaveText("Feedback");
    await expect(facts.getByRole("definition").last()).toHaveText(
      "ask-first.md",
    );
    // The body, without the frontmatter.
    await expect(ask).toContainText("Ask before running git commit");
    await expect(ask).not.toContainText("originSessionId");
    // A memory nothing is saved under yet is not a link.
    await expect(ask).toContainText("nowhere-yet");
    await expect(ask.getByRole("link", { name: "nowhere-yet" })).toHaveCount(0);

    // Raw: the whole file, frontmatter and all (FE-36/D9).
    await ask.getByRole("button", { name: "Raw" }).click();
    await expect(ask.getByRole("button", { name: "Raw" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(ask.getByTestId("memory-raw")).toContainText(
      "originSessionId: 20b0dfef-813d-4d08-a3c7-ba235bdba2ac",
    );
    await ask.getByRole("button", { name: "Raw" }).click();

    await ask.getByRole("link", { name: "feedback_language" }).click();
    await expect(
      page.getByRole("region", { name: "Memory — Language preference" }),
    ).toContainText("Dùng tiếng Việt");
    await page.goBack();
    await expect(ask).toBeVisible();

    // Claude saves one more: the list and the count follow (FE-36/D11).
    await writeFile(
      join(dir, "reference_dashboard.md"),
      "---\nname: Grafana board\ndescription: Where latency is graphed\ntype: reference\n---\n\nhttps://grafana.example.com\n",
    );
    await expect(list.getByRole("heading")).toHaveText([
      "Feedback",
      "Project",
      "Reference",
      "Other",
    ]);
    await expect(
      list.getByRole("link", { name: /^Grafana board/ }),
    ).toBeVisible();
    await expect(memoryHeader).toContainText("5");

    // A folder with no memory in it, and no folder at all (V3).
    await pickProject(page, "Beta");
    await expect(page.getByText("No memory yet")).toBeVisible();
    await pickProject(page, "Gamma");
    await expect(page.getByText("No folder linked")).toBeVisible();
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});
