// What `/` and `@` offer in the composer (FE-62/D8): slash commands and
// skills, or files in the workspace's folder, fuzzy-matched. Nothing here
// imports Electron.
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Suggestion } from "../../../shared/conversation";

const LIMIT = 50;
const FILES_MAX = 50_000;
const WALK_MAX = 20_000;
const CACHE_MS = 10_000;
const DESCRIPTION_MAX = 160;

/** Built-in commands that work in a headless session. */
const BUILT_IN: Suggestion[] = [
  { value: "/compact", detail: "Compact the conversation, keeping a summary" },
  { value: "/context", detail: "Show what fills the context window" },
  { value: "/cost", detail: "Show this session's cost and duration" },
  { value: "/init", detail: "Write a CLAUDE.md for this codebase" },
  { value: "/review", detail: "Review a pull request" },
  {
    value: "/security-review",
    detail: "Security review of the pending changes",
  },
  { value: "/pr-comments", detail: "Get comments from a GitHub pull request" },
  { value: "/release-notes", detail: "Show the release notes" },
];

/** How well `query` matches `text`: higher is better, null is no match. */
export function fuzzyScore(text: string, query: string): number | null {
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

/** A markdown file's frontmatter `description`, or its first line of text. */
async function describe(
  file: string,
): Promise<{ name: string | null; description: string | null }> {
  const text = (await readFile(file, "utf8").catch(() => "")).slice(
    0,
    16 * 1024,
  );
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

/** `<dir>/**.md` as `/name` (a subfolder is `/folder:name`, as the CLI names it). */
async function commandsIn(dir: string): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const walk = async (at: string, prefix: string, depth: number) => {
    const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && depth < 3)
        await walk(join(at, entry.name), `${prefix}${entry.name}:`, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const { description } = await describe(join(at, entry.name));
        out.push({
          value: `/${prefix}${entry.name.slice(0, -3)}`,
          detail: description,
        });
      }
    }
  };
  await walk(dir, "", 0);
  return out;
}

/** `<dir>/<skill>/SKILL.md` as `/skill`. */
async function skillsIn(dir: string): Promise<Suggestion[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: Suggestion[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!(await stat(file).catch(() => null))?.isFile()) continue;
    const { name, description } = await describe(file);
    out.push({ value: `/${name ?? entry.name}`, detail: description });
  }
  return out;
}

export async function suggestCommands(
  home: string,
  folder: string | null,
  query: string,
): Promise<Suggestion[]> {
  const groups = await Promise.all([
    folder ? commandsIn(join(folder, ".claude", "commands")) : [],
    folder ? skillsIn(join(folder, ".claude", "skills")) : [],
    commandsIn(join(home, ".claude", "commands")),
    skillsIn(join(home, ".claude", "skills")),
  ]);
  const seen = new Set<string>();
  const all: Suggestion[] = [];
  // The project's first: it wins a name both have.
  for (const item of [...groups.flat(), ...BUILT_IN]) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    all.push(item);
  }
  const clean = query.replace(/^\//, "");
  return rank(all, clean, (item) => item.value.slice(1));
}

function gitFiles(folder: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: folder, timeout: 5_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        resolve(stdout.split("\0").filter(Boolean).slice(0, FILES_MAX));
      },
    );
  });
}

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

const fileCache = new Map<string, { at: number; files: Promise<string[]> }>();

/** The folder's files, relative to it — git's list, else a walk; cached. */
export function workspaceFiles(folder: string): Promise<string[]> {
  const cached = fileCache.get(folder);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.files;
  const files = gitFiles(folder).then((listed) => listed ?? walkFiles(folder));
  fileCache.set(folder, { at: Date.now(), files });
  if (fileCache.size > 16)
    fileCache.delete(fileCache.keys().next().value as string);
  return files;
}

export async function suggestFiles(
  folder: string,
  query: string,
): Promise<Suggestion[]> {
  const files = workspaceFiles(folder);
  const clean = query.replace(/^@/, "");
  const items = (await files).map((path) => ({
    value: `@${path}`,
    detail: dirname(path) === "." ? null : dirname(path),
  }));
  return rank(items, clean, (item) => item.value.slice(1));
}
