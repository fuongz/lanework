// What `/` and `@` offer in the composer (FE-62/D8): slash commands and
// skills, or files in the workspace's folder, fuzzy-matched. A conversation
// on OpenCode is offered OpenCode's, read from its config folders, no
// OpenCode service needed (FE-105/D3). Nothing here imports Electron.
import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  type CommandSource,
  type ConversationAgent,
  commandLabel,
  type Suggestion,
} from "../../../shared/conversation";
import { gitReadOut } from "../git/runner";
import { readsAllowed } from "../git/trust-gate";
import { codexHome } from "../handoff/codex";

/** The most suggestions one query returns. */
const LIMIT = 50;
/** The most files taken from git's list. */
const FILES_MAX = 50_000;
/** The most files a walk collects, when the folder is not a git repo. */
const WALK_MAX = 20_000;
/** How long a folder's file list is reused. */
const CACHE_MS = 10_000;
/** The longest description shown, in characters. */
const DESCRIPTION_MAX = 160;

/** As listed, with a label, the kind and the source. */
function builtIns(items: readonly { value: string; detail: string }[]) {
  return items.map(
    (item): Suggestion => ({
      ...item,
      label: commandLabel(item.value),
      kind: "builtin",
      source: "builtin",
    }),
  );
}

/** Claude's built-in commands that work in a headless session. */
const BUILT_IN: Suggestion[] = builtIns([
  {
    value: "/compact",
    detail: "Compact the conversation, keeping a summary",
  },
  { value: "/context", detail: "Show what fills the context window" },
  { value: "/cost", detail: "Show this session's cost and duration" },
  { value: "/init", detail: "Write a CLAUDE.md for this codebase" },
  { value: "/review", detail: "Review a pull request" },
  {
    value: "/security-review",
    detail: "Security review of the pending changes",
  },
  {
    value: "/pr-comments",
    detail: "Get comments from a GitHub pull request",
  },
  { value: "/release-notes", detail: "Show the release notes" },
]);

/** OpenCode's built-in commands, as it describes them (FE-105/D3). */
const OPENCODE_BUILT_IN: Suggestion[] = builtIns([
  { value: "/init", detail: "Guided AGENTS.md setup" },
  {
    value: "/review",
    detail: "Review changes: a commit, a branch or a PR, else the uncommitted",
  },
]);

/** How well `query` matches `text`: higher is better, null is no match. */
function fuzzyScore(text: string, query: string): number | null {
  if (!query) return 0;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const base = hay.slice(hay.lastIndexOf("/") + 1);
  if (base.startsWith(needle)) return 1000 - hay.length;
  if (base.includes(needle)) return 800 - hay.length;
  const at = hay.indexOf(needle);
  if (at >= 0) return 600 - at - hay.length / 10;
  // Every character in order.
  let from = 0;
  let gaps = 0;
  for (const char of needle) {
    const found = hay.indexOf(char, from);
    if (found < 0) return null;
    gaps += found - from;
    from = found + 1;
  }
  return 300 - gaps - hay.length / 10;
}

/** The best {@link LIMIT} matches of `query`, best first. */
function rank(
  items: Suggestion[],
  query: string,
  key: (item: Suggestion) => string,
) {
  return items
    .map((item) => ({ item, score: fuzzyScore(key(item), query) }))
    .filter(
      (entry): entry is { item: Suggestion; score: number } =>
        entry.score !== null,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT)
    .map((entry) => entry.item);
}

/** How much of a command or skill file is read for its description. */
const HEAD_BYTES = 16 * 1024;

/**
 * The first {@link HEAD_BYTES} of `file`, or "" unless it is a regular file.
 *
 * A project's `.claude/` is the project's to fill (SX-07): a link to
 * `/dev/zero` must not be read whole, and a FIFO must not block. Stat'ed
 * first, opened without blocking, and checked again on the open handle.
 */
async function readHead(file: string): Promise<string> {
  try {
    if (!(await stat(file)).isFile()) return "";
    const handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    );
    try {
      if (!(await handle.stat()).isFile()) return "";
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

/**
 * A markdown file's frontmatter `name`, and its `description` or else its
 * first line of text.
 */
async function describe(
  file: string,
): Promise<{ name: string | null; description: string | null }> {
  const text = await readHead(file);
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const field = (key: string) => {
    const value = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim();
    return value ? value.replace(/^["']|["']$/g, "") : null;
  };
  const body = front ? text.slice(text.indexOf("---", 3) + 3) : text;
  const first = body
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  const description = field("description") ?? first ?? null;
  return {
    name: field("name"),
    description: description ? description.slice(0, DESCRIPTION_MAX) : null,
  };
}

/**
 * Every `.md` under `dir` as `/name`.
 *
 * A file in a subfolder is `/folder:name`, as Claude names it; OpenCode
 * names it `/folder/name`, so it passes `/` as `separator` (FE-105/D3).
 */
async function commandsIn(
  dir: string,
  source: CommandSource,
  separator = ":",
): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const walk = async (at: string, prefix: string, depth: number) => {
    const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && depth < 3)
        await walk(
          join(at, entry.name),
          `${prefix}${entry.name}${separator}`,
          depth + 1,
        );
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const { description } = await describe(join(at, entry.name));
        const value = `/${prefix}${entry.name.slice(0, -3)}`;
        out.push({
          value,
          detail: description,
          label: commandLabel(value),
          kind: "command",
          source,
        });
      }
    }
  };
  await walk(dir, "", 0);
  return out;
}

/**
 * `<dir>/<skill>/SKILL.md` as `/skill`.
 *
 * A dot folder is skipped: Codex keeps the skills it ships in `.system`.
 */
async function skillsIn(
  dir: string,
  source: CommandSource,
): Promise<Suggestion[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: Suggestion[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!(await stat(file).catch(() => null))?.isFile()) continue;
    const { name, description } = await describe(file);
    const value = `/${name ?? entry.name}`;
    out.push({
      value,
      detail: description,
      label: commandLabel(value),
      kind: "skill",
      source,
    });
  }
  return out;
}

/**
 * OpenCode's global config folders, where its user commands and skills live
 * (FE-105/D3): `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`, then
 * `$OPENCODE_CONFIG_DIR` when it is set.
 *
 * NOTE: The environment counts only for the real home, as in
 * `opencodeDataDir` (`terminal/opencode-sessions.ts`): a spec points `home`
 * somewhere else and must not read the machine's commands through it.
 */
export function opencodeConfigDirs(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  realHome = home === homedir(),
): string[] {
  const base =
    realHome && env.XDG_CONFIG_HOME
      ? join(env.XDG_CONFIG_HOME, "opencode")
      : join(home, ".config", "opencode");
  const extra = realHome ? env.OPENCODE_CONFIG_DIR : undefined;
  return extra && extra !== base ? [base, extra] : [base];
}

/**
 * A config folder's commands and skills, the way OpenCode reads them: its
 * `command/` and `commands/` (`.md`, named by path), and its `skill/` and
 * `skills/` (`<name>/SKILL.md`).
 */
function opencodeIn(dir: string, source: CommandSource) {
  return [
    commandsIn(join(dir, "command"), source, "/"),
    commandsIn(join(dir, "commands"), source, "/"),
    skillsIn(join(dir, "skill"), source),
    skillsIn(join(dir, "skills"), source),
  ];
}

/**
 * What OpenCode offers (FE-105/D3): the project's `.opencode`, then the
 * user's config folders ({@link opencodeConfigDirs}).
 *
 * NOTE: OpenCode also reads the skills other agents share, `.claude/skills`
 * and `.agents/skills`, in the project and in the home (its compatibility
 * sources, checked in OpenCode 2.2), so those are offered too. It walks up
 * from the folder for `.opencode`; only the folder's own is read here.
 */
function opencodeGroups(home: string, folder: string | null) {
  return [
    ...(folder ? opencodeIn(join(folder, ".opencode"), "project") : []),
    folder ? skillsIn(join(folder, ".claude", "skills"), "project") : [],
    folder ? skillsIn(join(folder, ".agents", "skills"), "project") : [],
    ...opencodeConfigDirs(home).flatMap((dir) => opencodeIn(dir, "personal")),
    skillsIn(join(home, ".claude", "skills"), "personal"),
    skillsIn(join(home, ".agents", "skills"), "personal"),
  ];
}

/**
 * What Claude and Codex offer: the project's, then the user's, which are
 * Claude's (`~/.claude`), then Codex's (`~/.agents/skills`, then
 * `$CODEX_HOME/skills`) (FE-92/D3).
 */
function claudeGroups(home: string, folder: string | null) {
  return [
    folder ? commandsIn(join(folder, ".claude", "commands"), "project") : [],
    folder ? skillsIn(join(folder, ".claude", "skills"), "project") : [],
    folder ? skillsIn(join(folder, ".agents", "skills"), "project") : [],
    commandsIn(join(home, ".claude", "commands"), "personal"),
    skillsIn(join(home, ".claude", "skills"), "personal"),
    skillsIn(join(home, ".agents", "skills"), "personal"),
    skillsIn(join(codexHome(home), "skills"), "personal"),
  ];
}

/**
 * Every slash command and skill, unranked.
 *
 * The project's come first, then the user's, then the agent's built-in
 * ones. OpenCode's are read from its own folders (FE-105/D3); Claude's and
 * Codex's as before.
 *
 * @param folder The workspace's folder; null leaves out the project's own.
 * @param agent The conversation's agent; Claude's list when not known.
 */
export async function listCommands(
  home: string,
  folder: string | null,
  agent: ConversationAgent = "claude",
): Promise<Suggestion[]> {
  const opencode = agent === "opencode";
  const groups = await Promise.all(
    opencode ? opencodeGroups(home, folder) : claudeGroups(home, folder),
  );
  const builtIn = opencode ? OPENCODE_BUILT_IN : BUILT_IN;
  const seen = new Set<string>();
  const all: Suggestion[] = [];
  // The project's first: it wins a name both have.
  for (const item of [...groups.flat(), ...builtIn]) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    all.push(item);
  }
  return all;
}

/** The commands of {@link listCommands} that match `query`, best first. */
export function rankCommands(all: Suggestion[], query: string): Suggestion[] {
  const clean = query.replace(/^\//, "");
  return rank(all, clean, (item) => item.value.slice(1));
}

/**
 * The folder's tracked and untracked, non-ignored files, as git lists them.
 *
 * Through the runner's read flags (FE-77/D1). An automatic read (D6): a
 * folder whose git config the user has not trusted is walked instead.
 *
 * @returns null when git cannot list them: not a repo, git failed, or the
 *   folder is not trusted for automatic reads.
 */
async function gitFiles(folder: string): Promise<string[] | null> {
  try {
    if (!(await readsAllowed(folder))) return null;
    const stdout = await gitReadOut(
      folder,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { timeout: 5_000, maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean).slice(0, FILES_MAX);
  } catch {
    return null;
  }
}

/**
 * The folder's files from a bounded walk, skipping build and dependency
 * folders.
 */
async function walkFiles(folder: string): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set([
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    ".turbo",
  ]);
  const walk = async (dir: string, depth: number) => {
    if (out.length >= WALK_MAX || depth > 8) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= WALK_MAX) return;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) await walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile())
        out.push(relative(folder, join(dir, entry.name)));
    }
  };
  await walk(folder, 0);
  return out;
}

/** The last file lists, by folder; at most 16 are kept. */
const fileCache = new Map<string, { at: number; files: Promise<string[]> }>();

/**
 * The folder's files, relative to it.
 *
 * Git's list, else a walk; reused for {@link CACHE_MS}.
 */
export function workspaceFiles(folder: string): Promise<string[]> {
  const cached = fileCache.get(folder);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.files;
  const files = gitFiles(folder).then((listed) => listed ?? walkFiles(folder));
  fileCache.set(folder, { at: Date.now(), files });
  if (fileCache.size > 16)
    fileCache.delete(fileCache.keys().next().value as string);
  return files;
}

/** The folders that hold `files`, by file list (FE-93/D2). */
const folderCache = new WeakMap<string[], string[]>();

function foldersOf(files: string[]): string[] {
  const cached = folderCache.get(files);
  if (cached) return cached;
  const seen = new Set<string>();
  for (const file of files) {
    let dir = dirname(file);
    while (dir !== "." && !seen.has(dir)) {
      seen.add(dir);
      dir = dirname(dir);
    }
  }
  const folders = [...seen];
  folderCache.set(files, folders);
  return folders;
}

/**
 * The workspace's files and folders that match `query`: `@path`, and a
 * folder as `@path/` (FE-93/D2).
 */
export async function suggestFiles(
  folder: string,
  query: string,
): Promise<Suggestion[]> {
  const files = await workspaceFiles(folder);
  const clean = query.replace(/^@/, "");
  const parent = (path: string) =>
    dirname(path) === "." ? null : dirname(path);
  const items: Suggestion[] = [
    ...foldersOf(files).map(
      (dir): Suggestion => ({
        value: `@${dir}/`,
        detail: parent(dir),
        label: basename(dir),
        kind: "folder",
      }),
    ),
    ...files.map(
      (path): Suggestion => ({
        value: `@${path}`,
        detail: parent(path),
        label: basename(path),
        kind: "file",
      }),
    ),
  ];
  return rank(items, clean, (item) => item.value.slice(1).replace(/\/$/, ""));
}
