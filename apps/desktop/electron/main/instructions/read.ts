// The instruction files Claude Code and Codex read for a project, found the
// way each CLI finds them, and a watch on where they live.
//
// NOTE: Read-only, and nothing here imports Electron. Main calls it, and a
// spec drives it under plain Node against a fake home folder.
import { createHash } from "node:crypto";
import { constants, type FSWatcher, watch } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
} from "node:path";
import {
  type ClaudeInstructionMode,
  type EffectiveInstructions,
  type EffectiveSection,
  findImports,
  type InstructionAgent,
  type InstructionContent,
  type InstructionFile,
  type InstructionList,
  type InstructionLoad,
  type InstructionNode,
  type InstructionScope,
} from "../../../shared/instructions";
import { splitFrontmatter } from "../frontmatter";
import { gitReadOut } from "../git/runner";
import { readsAllowed } from "../git/trust-gate";

/** The most of one file a read takes. Instruction files are a few KB. */
export const INSTRUCTION_READ_MAX = 256 * 1024;
/** The most of a settings file a read takes; a larger one is not read. */
const SETTINGS_MAX = 1024 * 1024;
/** `~/.claude.json` keeps every project's history, so it runs to megabytes. */
const CLAUDE_JSON_MAX = 32 * 1024 * 1024;
/** The most an Effective view gathers, every file together (FE-37/D4). */
const EFFECTIVE_MAX = 1024 * 1024;
/** Claude follows imports four hops deep and no further. */
const IMPORT_HOPS = 4;
/** The most files one scan for nested files finds (FE-37/D5). */
const NESTED_FILES = 200;
/** The most folders one scan for nested files enters (FE-37/D5). */
const NESTED_DIRS = 5000;
/** The most rule files one `.claude/rules` folder lists. */
const RULES_MAX = 200;
/** Codex's own default for `project_doc_max_bytes`. */
const CODEX_DOC_MAX = 32 * 1024;
/** How long after a write it is reported, so a burst is one change. */
const SETTLE_MS = 300;
/** The most folders one listing watches. */
const WATCH_DIRS = 32;

/** The folders a nested scan never enters: no instructions live there. */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
/** The files a scan below the project's folder looks for. */
const NESTED_NAMES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "AGENTS.override.md",
] as const;
/** The files that make Claude read CLAUDE.md rather than AGENTS.md. */
const CLAUDE_FILES = ["CLAUDE.md", join(".claude", "CLAUDE.md")];

export interface InstructionRoots {
  /** The project's folder: where an agent starts in it. */
  folder: string;
  /** The home `~/` imports resolve against. */
  home: string;
  /** `$CLAUDE_CONFIG_DIR`, or `~/.claude`. */
  claudeHome: string;
  /** `$CODEX_HOME`, or `~/.codex`. */
  codexHome: string;
  /** Claude's `.claude.json`, where it records approving external imports. */
  claudeJson: string;
  /** The managed policy CLAUDE.md for this OS. Null where there is none. */
  managed: string | null;
}

/** Where an organisation puts a CLAUDE.md that applies to every user. */
export function managedClaudeMd(
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "darwin")
    return "/Library/Application Support/ClaudeCode/CLAUDE.md";
  if (platform === "linux") return "/etc/claude-code/CLAUDE.md";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\CLAUDE.md";
  return null;
}

/** The id a file is named by outside main: a digest of where it is. */
export function instructionId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/** One listing, with what main alone keeps: each id's path. */
export interface InstructionTree {
  list: InstructionList;
  /** Id → absolute path. NOTE: These are the only files a read may open. */
  paths: Map<string, string>;
  /** Id → the most Codex reads of it, where `project_doc_max_bytes` cuts. */
  limits: Map<string, number>;
  /** The folders a watch follows (FE-37/D7). */
  dirs: string[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The first `max` bytes of `path`, and its size, if it is a regular file.
 *
 * A project commits whatever it likes under `.claude/` (SX-07): a link to
 * `/dev/zero` would buffer until the heap runs out, and a FIFO would block
 * the read forever. So the path is stat'ed first and refused unless it is a
 * regular file, then opened without blocking and checked again on the open
 * handle, in case it changed in between.
 *
 * @throws When the path is missing or not a regular file.
 */
async function readHead(
  path: string,
  max: number,
): Promise<{ text: string; size: number }> {
  if (!(await stat(path)).isFile()) throw new Error("That is not a file.");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("That is not a file.");
    const length = Math.min(info.size, max);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      size: info.size,
    };
  } finally {
    await handle.close();
  }
}

/** The whole of `path` when it is a regular file of at most `max` bytes. */
async function readWhole(path: string, max: number): Promise<string | null> {
  try {
    const { text, size } = await readHead(path, max);
    return size > max ? null : text;
  } catch {
    return null;
  }
}

async function readJson(
  path: string,
  max = SETTINGS_MAX,
): Promise<Json | null> {
  const text = await readWhole(path, max);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string | null> {
  return readWhole(path, SETTINGS_MAX);
}

const isFile = (path: string) =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

const inside = (root: string, path: string) => {
  const within = relative(root, path);
  return !within.startsWith("..") && !isAbsolute(within);
};

/** Every folder from the filesystem's root down to `folder`, in that order. */
function ancestors(folder: string): string[] {
  const chain: string[] = [];
  let dir = resolve(folder);
  for (;;) {
    chain.unshift(dir);
    const parent = dirname(dir);
    if (parent === dir) return chain;
    dir = parent;
  }
}

/**
 * The working tree's root, as Codex finds it, or else the folder itself.
 *
 * NOTE: An automatic read (FE-77/D6): a folder the user has not trusted, or
 * one with risky git config they declined, reads as if it were no repository.
 */
async function projectRoot(folder: string): Promise<string> {
  try {
    if (!(await readsAllowed(folder))) return folder;
    const stdout = await gitReadOut(folder, ["rev-parse", "--show-toplevel"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const root = stdout.trim();
    if (root && inside(root, folder)) return root;
  } catch {
    // Not a repository, or no git on PATH.
  }
  return folder;
}

/**
 * Split a rule file the way Claude loads one.
 *
 * `paths` is the frontmatter's `paths` key, a YAML list or a comma-separated
 * string. `body` is the rest of the file.
 */
export function splitRule(text: string): { paths: string[]; body: string } {
  const { frontmatter, body } = splitFrontmatter(text);
  if (frontmatter === null) return { paths: [], body };
  const paths: string[] = [];
  const lines = frontmatter.split(/\r?\n/);
  const unquote = (value: string) =>
    value.trim().replace(/^(["'])(.*)\1$/, "$2");
  for (let index = 0; index < lines.length; index++) {
    const head = /^paths:[ \t]*(.*)$/.exec(lines[index] ?? "");
    if (!head) continue;
    const inline = head[1]?.trim() ?? "";
    if (inline)
      paths.push(
        ...inline
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map(unquote)
          .filter(Boolean),
      );
    else
      while (/^[ \t]+-[ \t]+/.test(lines[index + 1] ?? ""))
        paths.push(unquote((lines[++index] ?? "").replace(/^[ \t]+-/, "")));
  }
  return { paths: paths.filter(Boolean), body };
}

/**
 * A TOML value as `config.toml` writes the keys read here.
 *
 * An integer, a string, or an array of strings. Null for anything else.
 */
function tomlValue(raw: string): string | string[] | number | null {
  const value = raw.replace(/\s+#.*$/, "").trim();
  if (/^\d+$/.test(value)) return Number(value);
  if (value.startsWith("["))
    return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(
      (match) => match[1] ?? match[2] ?? "",
    );
  const string = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/.exec(value);
  return string ? (string[1] ?? string[2] ?? "") : null;
}

/**
 * The two keys of Codex's `config.toml` that decide what it reads.
 *
 * How many bytes of project docs, and which names besides AGENTS.md count as
 * one. Top level only: a key after the first `[table]` belongs to the table.
 */
export function codexDocConfig(toml: string | null): {
  maxBytes: number;
  fallbacks: string[];
} {
  let maxBytes = CODEX_DOC_MAX;
  let fallbacks: string[] = [];
  for (const line of (toml ?? "").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const value = tomlValue(match[2] ?? "");
    if (match[1] === "project_doc_max_bytes" && typeof value === "number")
      maxBytes = value;
    if (match[1] === "project_doc_fallback_filenames" && Array.isArray(value))
      fallbacks = value.filter(
        (name) =>
          name &&
          name !== "." &&
          name !== ".." &&
          !name.includes("/") &&
          !name.includes("\\"),
      );
  }
  return { maxBytes, fallbacks };
}

const MODES: readonly ClaudeInstructionMode[] = [
  "claude-md-or-agents-md",
  "claude-md-and-agents-md",
  "claude-md",
  "managed-only",
];

/**
 * Claude's **Project instructions** setting, from the user's settings.
 *
 * Besides managed settings, the user's are the only layer it is read from.
 * The built-in plugin turned off means CLAUDE.md only.
 */
function claudeMode(settings: Json | null): ClaudeInstructionMode {
  const plugins = settings?.enabledPlugins;
  if (isObject(plugins) && plugins["agents-md@builtin"] === false)
    return "claude-md";
  const configs = settings?.pluginConfigs;
  const plugin = isObject(configs) ? configs["agents-md@builtin"] : null;
  const options = isObject(plugin) ? plugin.options : null;
  const value = isObject(options) ? options.instructionFiles : null;
  return MODES.find((mode) => mode === value) ?? "claude-md-or-agents-md";
}

/** Where `@written` in `from` leads: `~/` from home, else from its folder. */
function importTarget(home: string, from: string, written: string): string {
  if (written.startsWith("~/")) return join(home, written.slice(2));
  if (isAbsolute(written)) return resolve(written);
  return resolve(dirname(from), written);
}

/** An `@word` that names no file is a mention, not an import. */
const pathLike = (written: string) => /[/.~]/.test(written);

const node = (
  file: string,
  scope: InstructionScope,
  load: InstructionLoad,
  note: string | null,
  children: InstructionNode[] = [],
  agents: InstructionAgent[] = [],
): InstructionNode => ({ file, scope, load, note, agents, children });

/** Gathers one listing: every file it names, once, by id. */
class Gatherer {
  readonly files: Record<string, InstructionFile> = {};
  readonly paths = new Map<string, string>();
  readonly limits = new Map<string, number>();
  private readonly watched = new Set<string>();

  constructor(readonly roots: InstructionRoots) {}

  /** `path` as a file of the listing, registered so a read may open it. */
  async file(path: string): Promise<InstructionFile> {
    const absolute = resolve(path);
    const id = instructionId(absolute);
    const known = this.files[id];
    if (known) return known;
    const info = await stat(absolute).catch(() => null);
    const file: InstructionFile = {
      id,
      path: absolute,
      name: inside(this.roots.folder, absolute)
        ? relative(this.roots.folder, absolute)
        : absolute,
      size: info?.isFile() ? info.size : 0,
      mtimeMs: info?.isFile() ? info.mtimeMs : 0,
      missing: !info?.isFile(),
      markdown: extname(absolute).toLowerCase() === ".md",
    };
    this.files[id] = file;
    this.paths.set(id, absolute);
    if (info?.isFile()) this.watch(dirname(absolute));
    return file;
  }

  /** A folder whose writes change the listing (FE-37/D7). */
  watch(dir: string): void {
    this.watched.add(resolve(dir));
  }

  get dirs(): string[] {
    return [...this.watched].slice(0, WATCH_DIRS);
  }

  async text(file: InstructionFile): Promise<string> {
    if (file.missing || !file.markdown) return "";
    return readHead(file.path, INSTRUCTION_READ_MAX).then(
      ({ text }) => text,
      () => "",
    );
  }
}

/** Claude's reading, from managed policy down to the project's own rules. */
class ClaudeReader {
  /** Real paths already in context. A second sighting is not read again. */
  private readonly seen = new Set<string>();
  private approval: "approved" | "declined" | "pending" = "pending";
  private excludes: string[] = [];
  mode: ClaudeInstructionMode = "claude-md-or-agents-md";
  /**
   * Whether a CLAUDE.md is in the folder or above.
   *
   * One keeps AGENTS.md out in the default mode.
   */
  counting = false;

  constructor(private readonly at: Gatherer) {}

  private get roots() {
    return this.at.roots;
  }

  async prepare(): Promise<void> {
    const { claudeHome, folder, claudeJson } = this.roots;
    const [user, project, local, state] = await Promise.all([
      readJson(join(claudeHome, "settings.json")),
      readJson(join(folder, ".claude", "settings.json")),
      readJson(join(folder, ".claude", "settings.local.json")),
      readJson(claudeJson, CLAUDE_JSON_MAX),
    ]);
    this.mode = claudeMode(user);
    this.excludes = [user, project, local].flatMap((settings) =>
      Array.isArray(settings?.claudeMdExcludes)
        ? settings.claudeMdExcludes.filter(
            (pattern): pattern is string => typeof pattern === "string",
          )
        : [],
    );
    const projects = state?.projects;
    const entry = isObject(projects) ? projects[folder] : null;
    if (isObject(entry) && entry.hasClaudeMdExternalIncludesApproved === true)
      this.approval = "approved";
    else if (
      isObject(entry) &&
      entry.hasClaudeMdExternalIncludesWarningShown === true
    )
      this.approval = "declined";
    for (const dir of ancestors(folder))
      for (const name of [...CLAUDE_FILES, "CLAUDE.local.md"])
        if (await isFile(join(dir, name))) this.counting = true;
  }

  private excluded(path: string): boolean {
    return this.excludes.some((pattern) => {
      try {
        return matchesGlob(path, pattern);
      } catch {
        return false;
      }
    });
  }

  private async real(path: string): Promise<string> {
    return realpath(path).catch(() => resolve(path));
  }

  /**
   * Whether this is the first time `path` is read.
   *
   * Marks it read when it is.
   */
  private async first(path: string): Promise<boolean> {
    const real = await this.real(path);
    if (this.seen.has(real)) return false;
    this.seen.add(real);
    return true;
  }

  async loaded(path: string): Promise<boolean> {
    return this.seen.has(await this.real(path));
  }

  /**
   * What `from` imports, `hop` hops deep.
   *
   * @param trusted Whether the chain started in the user's own files, whose
   *   imports Claude never asks about.
   */
  async imports(
    from: string,
    text: string,
    hop: number,
    trusted: boolean,
  ): Promise<InstructionNode[]> {
    const nodes: InstructionNode[] = [];
    for (const match of findImports(text)) {
      const target = importTarget(this.roots.home, from, match.path);
      const exists = await isFile(target);
      if (!exists && !pathLike(match.path)) continue;
      const file = await this.at.file(target);
      if (!exists) {
        nodes.push(
          node(file.id, "import", "skipped", "No file here: nothing loads."),
        );
        continue;
      }
      if (hop > IMPORT_HOPS) {
        nodes.push(
          node(
            file.id,
            "import",
            "skipped",
            "More than four imports deep: Claude stops before this one.",
          ),
        );
        continue;
      }
      const external =
        !trusted && !inside(this.roots.folder, await this.real(target));
      if (external && this.approval !== "approved") {
        nodes.push(
          node(
            file.id,
            "import",
            "skipped",
            this.approval === "declined"
              ? "Outside the project, and its imports were declined for it."
              : "Outside the project: Claude asks before loading it.",
          ),
        );
        continue;
      }
      if (!(await this.first(target))) {
        nodes.push(node(file.id, "import", "skipped", "Already loaded above."));
        continue;
      }
      nodes.push(
        node(
          file.id,
          "import",
          "launch",
          external ? "Outside the project; you approved its imports." : null,
          await this.imports(
            target,
            await this.at.text(file),
            hop + 1,
            trusted,
          ),
        ),
      );
    }
    return nodes;
  }

  /** One file read at launch, with everything it imports. */
  private async top(
    path: string,
    scope: InstructionScope,
    options: { trusted: boolean; note?: string | null } = { trusted: false },
  ): Promise<InstructionNode> {
    const file = await this.at.file(path);
    if (scope !== "managed" && this.excluded(file.path))
      return node(file.id, scope, "skipped", "Left out by claudeMdExcludes.");
    if (scope !== "managed" && this.mode === "managed-only")
      return node(
        file.id,
        scope,
        "skipped",
        "Project instructions is set to managed-only.",
      );
    if (!(await this.first(path)))
      return node(file.id, scope, "skipped", "Already loaded above.");
    return node(
      file.id,
      scope,
      "launch",
      options.note ?? null,
      await this.imports(path, await this.at.text(file), 1, options.trusted),
    );
  }

  /** Every `.md` under `dir`, each loaded at launch or on matching files. */
  private async rules(dir: string, trusted: boolean) {
    const found: string[] = [];
    const walk = async (at: string) => {
      this.at.watch(at);
      const entries = await readdir(at, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
        if (found.length >= RULES_MAX) return;
        else if (entry.isDirectory()) await walk(join(at, entry.name));
        else if (entry.name.endsWith(".md")) found.push(join(at, entry.name));
    };
    await walk(dir);
    const nodes: InstructionNode[] = [];
    for (const path of found) {
      const file = await this.at.file(path);
      const { paths, body } = splitRule(await this.at.text(file));
      if (!paths.length) {
        nodes.push(await this.top(path, "rules", { trusted }));
        continue;
      }
      // NOTE: A conditional rule is never marked read, so a CLAUDE.md that
      // imports the same file still loads it at launch.
      nodes.push(
        this.excluded(file.path)
          ? node(file.id, "rules", "skipped", "Left out by claudeMdExcludes.")
          : node(
              file.id,
              "rules",
              "conditional",
              `Loads when Claude reads or edits ${paths.join(", ")}.`,
              await this.imports(path, body, 1, trusted),
            ),
      );
    }
    return nodes;
  }

  async list(): Promise<InstructionNode[]> {
    const { managed, claudeHome, folder } = this.roots;
    const nodes: InstructionNode[] = [];
    this.at.watch(claudeHome);
    if (managed && (await isFile(managed)))
      nodes.push(await this.top(managed, "managed", { trusted: true }));
    const user = join(claudeHome, "CLAUDE.md");
    if (await isFile(user))
      nodes.push(await this.top(user, "user", { trusted: true }));
    nodes.push(...(await this.rules(join(claudeHome, "rules"), true)));

    const agents =
      this.mode === "claude-md-and-agents-md" ||
      (this.mode === "claude-md-or-agents-md" && !this.counting);
    const why =
      this.mode === "claude-md-and-agents-md"
        ? "Project instructions reads AGENTS.md beside CLAUDE.md."
        : "No CLAUDE.md here or above, so Claude reads AGENTS.md.";
    const instead =
      this.mode === "claude-md-or-agents-md"
        ? "Claude reads CLAUDE.md instead: there is one here or above."
        : `Project instructions is set to ${this.mode}.`;
    for (const dir of ancestors(folder)) {
      const scope: InstructionScope = dir === folder ? "project" : "parent";
      if (dir === folder) {
        this.at.watch(dir);
        this.at.watch(join(dir, ".claude"));
      }
      for (const name of CLAUDE_FILES) {
        const path = join(dir, name);
        // `~/.claude/CLAUDE.md` is the user's own file, already listed.
        if (resolve(path) === resolve(user) || !(await isFile(path))) continue;
        nodes.push(await this.top(path, scope));
      }
      const local = join(dir, "CLAUDE.local.md");
      if (await isFile(local)) nodes.push(await this.top(local, "local"));
      for (const name of ["AGENTS.md", join(".claude", "AGENTS.md")]) {
        const path = join(dir, name);
        if (!(await isFile(path))) continue;
        if (agents)
          nodes.push(
            await this.top(path, scope, { trusted: false, note: why }),
          );
        // Already read through an import: listed there, not twice.
        else if (!(await this.loaded(path)))
          nodes.push(
            node((await this.at.file(path)).id, scope, "skipped", instead),
          );
      }
    }
    nodes.push(...(await this.rules(join(folder, ".claude", "rules"), false)));
    return nodes;
  }

  /**
   * Whether and when Claude reads a nested AGENTS.md in `dir`, by its mode.
   *
   * @returns The note to show, or null when Claude does not read it.
   */
  async nestedAgents(dir: string): Promise<string | null> {
    if (this.mode === "claude-md-and-agents-md")
      return "Claude reads it once it opens a file there, after that folder's CLAUDE.md.";
    if (this.mode !== "claude-md-or-agents-md" || this.counting) return null;
    for (const name of [...CLAUDE_FILES, "CLAUDE.local.md"])
      if (await isFile(join(dir, name))) return null;
    return "Claude reads it once it opens a file there.";
  }
}

/**
 * Whether a file is missing or holds only whitespace (in its first 4 KB).
 *
 * Codex skips such a file, and it costs no budget.
 */
async function blank(file: InstructionFile): Promise<boolean> {
  if (file.missing || file.size === 0) return true;
  const head = await readHead(file.path, Math.min(file.size, 4096)).then(
    ({ text }) => text,
    () => "",
  );
  return !head.trim();
}

/**
 * The `trust_level` Codex's `config.toml` gives the first of `dirs` it has
 * an entry for.
 *
 * @param dirs The folder, then the project's root.
 * @returns Null when none has an entry.
 */
export function codexTrust(
  toml: string | null,
  dirs: string[],
): "trusted" | "untrusted" | null {
  const levels = new Map<string, string>();
  let project: string | null = null;
  for (const line of (toml ?? "").split(/\r?\n/)) {
    const table = /^\s*\[(.+)\]\s*(?:#.*)?$/.exec(line);
    if (table) {
      const key = /^projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(
        (table[1] ?? "").trim(),
      );
      project = key
        ? (key[1]?.replace(/\\(.)/g, "$1") ?? key[2] ?? null)
        : null;
      continue;
    }
    const level = /^\s*trust_level\s*=\s*(.+)$/.exec(line);
    const value = level ? tomlValue(level[1] ?? "") : null;
    if (project && typeof value === "string")
      levels.set(resolve(project), value);
  }
  for (const dir of dirs) {
    const level = levels.get(resolve(dir));
    if (level === "trusted" || level === "untrusted") return level;
  }
  return null;
}

/**
 * Codex's reading: its own AGENTS.md, then one file per folder from the
 * project's root down to the folder it starts in, under one byte budget.
 *
 * NOTE: As Codex itself picks (codex-rs `agents_md.rs`), a folder's slot goes
 * to the first of its names that exists. An empty AGENTS.override.md keeps
 * that folder's AGENTS.md out. The global file is never cut or counted.
 */
async function codexList(at: Gatherer): Promise<InstructionNode[]> {
  const { codexHome, folder } = at.roots;
  at.watch(codexHome);
  const nodes: InstructionNode[] = [];
  const override = await at.file(join(codexHome, "AGENTS.override.md"));
  const global = await at.file(join(codexHome, "AGENTS.md"));
  // Globally, unlike in a folder, an empty override falls through.
  const own = !(await blank(override))
    ? override
    : !(await blank(global))
      ? global
      : null;
  for (const file of [override, global])
    if (!file.missing)
      nodes.push(
        file === own
          ? node(file.id, "user", "launch", null)
          : node(
              file.id,
              "user",
              "skipped",
              own
                ? `${basename(own.path)} is read instead.`
                : "Empty: there is nothing to read.",
            ),
      );

  const toml = await readText(join(codexHome, "config.toml"));
  const { maxBytes, fallbacks } = codexDocConfig(toml);
  const root = await projectRoot(folder);
  const untrusted = codexTrust(toml, [folder, root]) === "untrusted";
  const chain = ancestors(folder).filter((dir) => inside(root, dir));
  let budget = maxBytes;
  for (const dir of chain) {
    const scope: InstructionScope = dir === folder ? "project" : "parent";
    let picked: InstructionFile | null = null;
    for (const name of ["AGENTS.override.md", "AGENTS.md", ...fallbacks]) {
      const path = join(dir, name);
      if (!(await isFile(path))) continue;
      const file = await at.file(path);
      const skip = (note: string) =>
        nodes.push(node(file.id, scope, "skipped", note));
      if (picked) {
        skip(`Codex reads ${basename(picked.path)} in this folder instead.`);
        continue;
      }
      picked = file;
      if (untrusted)
        skip(
          "This project is untrusted in Codex's config.toml: no AGENTS.md loads.",
        );
      else if (await blank(file)) skip("Empty: there is nothing to read.");
      else if (maxBytes <= 0)
        skip("project_doc_max_bytes is 0: Codex reads no project docs.");
      else if (budget <= 0)
        skip(
          `Past project_doc_max_bytes (${maxBytes} bytes): Codex reads no more.`,
        );
      else {
        if (file.size > budget) at.limits.set(file.id, budget);
        nodes.push(
          node(
            file.id,
            scope,
            "launch",
            file.size > budget
              ? `Cut after ${budget} bytes by project_doc_max_bytes (${maxBytes}).`
              : null,
          ),
        );
        budget -= file.size;
      }
    }
  }
  return nodes;
}

/**
 * Instruction files below the folder, each with who reads it and when.
 *
 * They load only as an agent works in them (FE-37/D5). The scan is bounded:
 * `node_modules`, `.git` and the worktrees under `.claude/worktrees` are
 * never entered, a linked folder is never followed, and the scan stops at
 * `NESTED_FILES` files or `NESTED_DIRS` folders.
 */
async function nestedList(
  at: Gatherer,
  claude: ClaudeReader,
): Promise<{ nodes: InstructionNode[]; truncated: boolean }> {
  const { folder } = at.roots;
  const worktrees = join(folder, ".claude", "worktrees");
  const found: { dir: string; name: (typeof NESTED_NAMES)[number] }[] = [];
  const queue = [folder];
  let visited = 0;
  let truncated = false;
  while (queue.length) {
    const dir = queue.shift() as string;
    if (++visited > NESTED_DIRS) {
      truncated = true;
      break;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && path !== worktrees)
          queue.push(path);
      } else if (
        dir !== folder &&
        entry.isFile() &&
        (NESTED_NAMES as readonly string[]).includes(entry.name)
      ) {
        if (found.length >= NESTED_FILES) truncated = true;
        else
          found.push({
            dir,
            name: entry.name as (typeof NESTED_NAMES)[number],
          });
      }
    }
    if (truncated) break;
  }

  const nodes: InstructionNode[] = [];
  for (const { dir, name } of found) {
    const file = await at.file(join(dir, name));
    const where = `${relative(folder, dir)}/`;
    if (name === "CLAUDE.md" || name === "CLAUDE.local.md") {
      nodes.push(
        node(
          file.id,
          "nested",
          "conditional",
          `Claude reads it once it opens a file in ${where}.`,
          await claude.imports(file.path, await at.text(file), 1, false),
          ["claude"],
        ),
      );
      continue;
    }
    const codex =
      name === "AGENTS.override.md"
        ? `Codex reads it instead of ${where}AGENTS.md when it starts in ${where} or below.`
        : `Codex reads it when it starts in ${where} or below.`;
    const byClaude =
      name === "AGENTS.md" ? await claude.nestedAgents(dir) : null;
    nodes.push(
      node(
        file.id,
        "nested",
        "conditional",
        byClaude ? `${codex} ${byClaude}` : codex,
        byClaude
          ? await claude.imports(file.path, await at.text(file), 1, false)
          : [],
        byClaude ? ["codex", "claude"] : ["codex"],
      ),
    );
  }
  return { nodes, truncated };
}

/** Everything Claude and Codex read for `roots.folder`. */
export async function listInstructions(
  roots: InstructionRoots,
): Promise<InstructionTree> {
  const at = new Gatherer(roots);
  const claude = new ClaudeReader(at);
  await claude.prepare();
  const claudeNodes = await claude.list();
  const codexNodes = await codexList(at);
  const nested = await nestedList(at, claude);
  return {
    list: {
      folder: roots.folder,
      files: at.files,
      claude: claudeNodes,
      codex: codexNodes,
      nested: nested.nodes,
      nestedTruncated: nested.truncated,
      claudeMode: claude.mode,
    },
    paths: at.paths,
    limits: at.limits,
    dirs: at.dirs,
  };
}

/**
 * Whether Claude reads file `id` as a rule.
 *
 * A rule's frontmatter is not part of what Claude reads, so its text differs
 * from the file.
 */
const ruleLike = (tree: InstructionTree, id: string): boolean => {
  const walk = (nodes: InstructionNode[]): boolean =>
    nodes.some(
      (entry) =>
        (entry.file === id && entry.scope === "rules") || walk(entry.children),
    );
  return walk(tree.list.claude);
};

/**
 * One file of the listing for the viewer, at most `INSTRUCTION_READ_MAX`.
 *
 * NOTE: Named by id, and only an id that `tree` minted opens anything, so the
 * renderer can never point a read at a path. Only Markdown is read
 * (FE-37/D6).
 *
 * @throws When the id is unknown, or the file is missing, not Markdown, or
 *   not a file.
 */
export async function readInstruction(
  tree: InstructionTree,
  roots: InstructionRoots,
  id: string,
): Promise<InstructionContent> {
  const path = tree.paths.get(id);
  const file = tree.list.files[id];
  if (!path || !file)
    throw new Error("That file is not one this project's agents read.");
  if (file.missing) throw new Error("There is no file there.");
  if (!file.markdown)
    throw new Error("Only Markdown files are shown here; reveal it instead.");
  const { text: raw, size } = await readHead(path, INSTRUCTION_READ_MAX);
  const rule = ruleLike(tree, id) ? splitRule(raw) : null;
  const body = rule ? rule.body : raw;
  return {
    file: { ...file, size },
    body,
    raw,
    paths: rule?.paths ?? [],
    imports: findImports(body).map((match) => {
      const target = instructionId(importTarget(roots.home, path, match.path));
      return { path: match.path, file: tree.paths.has(target) ? target : null };
    }),
    truncated: size > INSTRUCTION_READ_MAX,
  };
}

/**
 * All that `agent` reads at launch: what a conversation starts with.
 *
 * In order, with imports right after the file that names them (FE-37/D4).
 */
export async function effectiveInstructions(
  tree: InstructionTree,
  agent: InstructionAgent,
): Promise<EffectiveInstructions> {
  const sections: EffectiveSection[] = [];
  let total = 0;
  const walk = async (nodes: InstructionNode[]) => {
    for (const entry of nodes) {
      if (entry.load !== "launch") continue;
      const file = tree.list.files[entry.file];
      const path = tree.paths.get(entry.file);
      if (!file || !path) continue;
      let text: string | null = null;
      let truncated = false;
      if (file.markdown && !file.missing) {
        const limit = Math.min(
          tree.limits.get(entry.file) ?? file.size,
          INSTRUCTION_READ_MAX,
          Math.max(EFFECTIVE_MAX - total, 0),
        );
        const raw = await readHead(path, Math.min(file.size, limit)).then(
          ({ text }) => text,
          () => "",
        );
        text = entry.scope === "rules" ? splitRule(raw).body : raw;
        truncated = file.size > limit;
        total += raw.length;
      }
      sections.push({ file: entry.file, scope: entry.scope, text, truncated });
      await walk(entry.children);
    }
  };
  await walk(agent === "claude" ? tree.list.claude : tree.list.codex);
  return { agent, files: tree.list.files, sections };
}

/** Whether a write to `name` can change a listing. Anything else is noise. */
function relevant(name: string | null): boolean {
  if (name === null) return true;
  const base = name.split(/[\\/]/).at(-1) ?? name;
  return (
    base.endsWith(".md") ||
    base === "settings.json" ||
    base === "settings.local.json" ||
    base === "config.toml" ||
    base === ".claude.json" ||
    base === "rules" ||
    base === ".claude"
  );
}

/**
 * Call `onChange` when an instruction file in `dirs` is written (FE-37/D7).
 *
 * A burst of writes calls it once.
 *
 * NOTE: One plain watch per folder, never recursive, and only names that can
 * matter wake it: `~/.claude` is written on every prompt anyone sends.
 *
 * @returns A function that stops the watch.
 */
export function watchInstructions(
  dirs: string[],
  onChange: () => void,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const watchers: FSWatcher[] = [];
  const changed = (_event: string, name: string | Buffer | null) => {
    if (stopped || timer || !relevant(name === null ? null : String(name)))
      return;
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) onChange();
    }, SETTLE_MS);
  };
  for (const dir of dirs)
    try {
      const watcher = watch(dir, changed);
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // Not there yet: the next listing watches it if it appears.
    }
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
