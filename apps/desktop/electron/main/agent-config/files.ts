// The config files Settings → Agents edits: read, and written back safely. A
// write is refused when the file changed since it was read, or when it would
// no longer parse; otherwise the file is backed up, then replaced atomically.
//
// NOTE: Node only, no Electron: main calls it, and a spec drives it under
// plain Node against a fake home.
//
// NOTE: A file's path comes only from `pathOf(id, where)`. The renderer names
// an id: one of a fixed list, or a skill, whose folder name `parseSkillId`
// has already held to a single segment with no `..` and no leading dot (D9).
import { createHash } from "node:crypto";
import { copyFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  CONFIG_EDIT_MAX,
  CONFIG_FILE_IDS,
  type ConfigFile,
  type ConfigFileContent,
  type ConfigFileId,
  type ConfigFormat,
  type ConfigWriteResult,
  type FixedConfigId,
  parseSkillId,
  SKILL_ROOTS,
  type SkillRoot,
} from "../../../shared/agent-config";
import { syntaxError } from "../../../shared/agent-config-text";
import type { AgentHome } from "../agent-home";
import { frontmatterFields, splitFrontmatter } from "../agent-setup/read";
import { configTarget, replaceConfigFile } from "../config-file";
import { HOOK_MARKER } from "../handoff/claude-settings";

interface Spec {
  agent: "claude" | "codex";
  label: string;
  description: string;
  format: ConfigFormat;
  path: (where: AgentHome) => string;
}

const SPECS: Record<FixedConfigId, Spec> = {
  "claude-settings": {
    agent: "claude",
    label: "settings.json",
    description: "Permissions, hooks, plugins and env for every project.",
    format: "json",
    path: (where) => join(where.claudeDir, "settings.json"),
  },
  "claude-md": {
    agent: "claude",
    label: "CLAUDE.md",
    description: "Instructions Claude Code reads in every project.",
    format: "markdown",
    path: (where) => join(where.claudeDir, "CLAUDE.md"),
  },
  "codex-config": {
    agent: "codex",
    label: "config.toml",
    description: "Model, features, MCP servers and approvals.",
    format: "toml",
    path: (where) => join(where.codexDir, "config.toml"),
  },
  "codex-hooks": {
    agent: "codex",
    label: "hooks.json",
    description: "Hooks Codex runs around a turn.",
    format: "json",
    path: (where) => join(where.codexDir, "hooks.json"),
  },
  "codex-agents-md": {
    agent: "codex",
    label: "AGENTS.md",
    description: "Instructions Codex reads in every project.",
    format: "markdown",
    path: (where) => join(where.codexDir, "AGENTS.md"),
  },
};

/** How many `*.lanework-bak-*` copies of one file are kept (FE-47/D4). */
export const BACKUPS_KEPT = 5;

const BACKUP = ".lanework-bak-";

/** The folder each skill root names (D9). */
function skillRoot(root: SkillRoot, where: AgentHome): string {
  return root === "claude"
    ? join(where.claudeDir, "skills")
    : root === "agents"
      ? join(where.home, ".agents", "skills")
      : join(where.codexDir, "skills");
}

/** The most skills one root lists. */
const SKILLS_MAX = 200;

function formatOf(id: ConfigFileId): ConfigFormat {
  return parseSkillId(id) ? "markdown" : SPECS[id as FixedConfigId].format;
}

/**
 * Where `id` lives: the only way a path is made here.
 *
 * @throws When `id` names no config file.
 */
export function pathOf(id: ConfigFileId, where: AgentHome): string {
  const skill = parseSkillId(id);
  if (skill) return join(skillRoot(skill.root, where), skill.name, "SKILL.md");
  const spec = SPECS[id as FixedConfigId];
  if (!spec) throw new Error("That is not a config file.");
  return spec.path(where);
}

function shown(path: string, home: string): string {
  const rest = relative(home, path);
  return rest && !rest.startsWith("..") && !rest.startsWith(sep)
    ? `~/${rest.split(sep).join("/")}`
    : path;
}

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

export async function listConfigFiles(where: AgentHome): Promise<ConfigFile[]> {
  const fixed = await Promise.all(
    CONFIG_FILE_IDS.map(async (id) => {
      const spec = SPECS[id];
      const path = spec.path(where);
      const info = await stat(path).catch(() => null);
      const isFile = !!info?.isFile();
      return {
        id,
        agent: spec.agent,
        kind: "config" as const,
        label: spec.label,
        description: spec.description,
        path: shown(path, where.home),
        format: spec.format,
        exists: isFile,
        size: isFile ? (info?.size ?? null) : null,
        modifiedAt: isFile && info ? info.mtime.toISOString() : null,
      };
    }),
  );
  const skills = await Promise.all(
    SKILL_ROOTS.map((root) => skillsIn(root, where)),
  );
  return [...fixed, ...skills.flat()];
}

/**
 * The user's skills under one root, by name.
 *
 * A skill is each folder, or link to one, holding a `SKILL.md`. Hidden
 * folders (Codex's `.system`) are not listed.
 */
async function skillsIn(root: SkillRoot, where: AgentHome) {
  const folder = skillRoot(root, where);
  const names = await readdir(folder).catch(() => [] as string[]);
  const found: ConfigFile[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (found.length >= SKILLS_MAX) break;
    const id = `skill:${root}:${name}` as const;
    if (!parseSkillId(id)) continue;
    const path = join(folder, name, "SKILL.md");
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    found.push({
      id,
      agent: root === "claude" ? "claude" : "codex",
      kind: "skill",
      label: name,
      description: await skillDescription(path),
      path: shown(path, where.home),
      format: "markdown",
      exists: true,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  return found;
}

/** A skill's own `description:`, on one line, or an empty string. */
async function skillDescription(path: string): Promise<string> {
  const head = await readFile(path, "utf8")
    .then((text) => text.slice(0, 8 * 1024))
    .catch(() => "");
  const { frontmatter } = splitFrontmatter(head);
  const description = frontmatter
    ? (frontmatterFields(frontmatter).description ?? "")
    : "";
  const line = description.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * The bytes on disk now, or null when there is no file.
 *
 * @throws When the path is not a file, or too big to edit here.
 */
async function current(path: string): Promise<Buffer | null> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile()) throw new Error("That is not a file.");
  if (info.size > CONFIG_EDIT_MAX)
    throw new Error("That file is too big to edit here.");
  return readFile(path);
}

function contentOf(id: ConfigFileId, bytes: Buffer | null): ConfigFileContent {
  const text = bytes ? bytes.toString("utf8") : "";
  return {
    id,
    text,
    hash: bytes ? sha256(bytes) : "",
    laneworkHook:
      (id === "claude-settings" || id === "codex-hooks") &&
      text.includes(HOOK_MARKER),
  };
}

export async function readConfigFile(
  id: ConfigFileId,
  where: AgentHome,
): Promise<ConfigFileContent> {
  return contentOf(id, await current(pathOf(id, where)));
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Copy `path` aside and drop all but the newest few copies (D4). */
async function backUp(path: string, now: Date): Promise<string> {
  const folder = dirname(path);
  const prefix = `${basename(path)}${BACKUP}`;
  let backup = join(folder, `${prefix}${stamp(now)}`);
  // Two saves in one second: the second copy gets a suffix, never overwrites.
  for (
    let n = 2;
    await stat(backup).then(
      () => true,
      () => false,
    );
    n++
  )
    backup = join(folder, `${prefix}${stamp(now)}-${n}`);
  await copyFile(path, backup);
  const copies = (await readdir(folder))
    .filter((name) => name.startsWith(prefix))
    .sort();
  for (const name of copies.slice(0, Math.max(0, copies.length - BACKUPS_KEPT)))
    await rm(join(folder, name), { force: true });
  return backup;
}

/** One write per file at a time, so two Saves cannot interleave. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Write `text` to the file `id` names, if it is still as it was read.
 *
 * Writes to one file run one after the other.
 *
 * @param baseHash The hash the file was read at; empty for a file that did
 *   not exist.
 * @returns `conflict` when the file changed since, `invalid` when the text
 *   would not parse, else `ok` with the new content and the backup's path.
 */
export function writeConfigFile(
  id: ConfigFileId,
  text: string,
  baseHash: string,
  where: AgentHome,
  now = new Date(),
): Promise<ConfigWriteResult> {
  const path = pathOf(id, where);
  const run = (queues.get(path) ?? Promise.resolve()).then(
    () => write(id, path, text, baseHash, where, now),
    () => write(id, path, text, baseHash, where, now),
  );
  queues.set(path, run);
  return run;
}

async function write(
  id: ConfigFileId,
  path: string,
  text: string,
  baseHash: string,
  where: AgentHome,
  now: Date,
): Promise<ConfigWriteResult> {
  if (Buffer.byteLength(text, "utf8") > CONFIG_EDIT_MAX)
    return { status: "invalid", error: "That is too big for a config file." };
  const target = await configTarget(path);
  const before = await current(target);
  if ((before ? sha256(before) : "") !== baseHash)
    return { status: "conflict" };
  // A skill is edited, never made here: its folder is the agent's to create.
  if (!before && parseSkillId(id))
    return { status: "invalid", error: "That skill is no longer there." };
  const error = syntaxError(formatOf(id), text);
  if (error) return { status: "invalid", error };

  const backup = before ? await backUp(target, now) : null;
  // The file's own mode (a config holding tokens is often 0600), through a
  // temp file and a rename; refused when the file changed since `before`.
  if (!(await replaceConfigFile(target, text, before)))
    return { status: "conflict" };
  return {
    status: "ok",
    content: await readConfigFile(id, where),
    backup: backup ? shown(backup, where.home) : null,
  };
}

/** What Finder should show: the file, or its folder before it exists. */
export async function revealTarget(
  id: ConfigFileId,
  where: AgentHome,
): Promise<string> {
  const path = pathOf(id, where);
  const there = await stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
  return there ? path : dirname(path);
}
