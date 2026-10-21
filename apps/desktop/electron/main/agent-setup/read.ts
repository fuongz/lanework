// A project's agent setup, read off the disk: what Claude Code and Codex
// would load in its folder (MCP servers, skills, commands, hooks, permissions
// and plugins), gathered from every config file that says so.
//
// Read-only, and nothing here imports Electron: main calls it, and a spec
// drives it under plain Node against a fake home and repo.
//
// NOTE: The secret line is drawn HERE. Config files are read whole, but only
// these fields are ever copied into the result:
// - an MCP server's name, transport, and its command's file name or its URL's
//   host;
// - a hook's event, matcher, type and command, through the checkpoint hook's
//   `redact()`.
// `env`, `headers`, `args`, tokens and URL query strings are read past, never
// into, and Codex's `shell_environment_policy` is not read at all.
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AgentSetup,
  SetupAgent,
  SetupMcpServer,
  SetupPermissionKind,
  SetupScope,
  SetupTransport,
} from "../../../shared/agent-setup";
import { redact } from "../../hook/lanework-checkpoint";
import { type AgentHome, CONFIG_MAX_BYTES, readText } from "../agent-home";
import { HOOK_MARKER } from "../handoff/claude-settings";
import {
  outsideStrings,
  splitTop,
  stripComment,
  type TomlEntry,
  tomlBool,
  tomlEntries,
  tomlString,
} from "./toml";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/** How much of a `SKILL.md` or command a listing reads, for name and line. */
const HEAD = 8 * 1024;
/** The most of one skill or command `open` reads (FE-40/D4). */
const SETUP_FILE_MAX = 256 * 1024;
/**
 * The size cap for `~/.claude.json`.
 *
 * It also holds Claude's caches, so it gets more room than other configs.
 */
const CLAUDE_JSON_MAX = 16 * 1024 * 1024;
/** The most entries one folder of skills, commands or rules gives. */
const DIR_MAX = 200;

/** How scopes sort: the nearest to the folder first. */
const SCOPE_ORDER: Record<SetupScope, number> = {
  local: 0,
  project: 1,
  user: 2,
  plugin: 3,
  system: 4,
};

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Text that leaves main: redacted, on one line, clipped. */
function shownText(value: string, max = 300): string {
  return clip(redact(value).replace(/\s+/g, " ").trim(), max);
}

const idOf = (...parts: (string | number | null)[]) =>
  parts.map((part) => part ?? "").join(":");

/** A URL's host and nothing else: no user, password, path or query. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * A command's program, by its file name, never its arguments.
 *
 * NOTE: Up to the first argument that looks like a flag, a path or a quote,
 * then its file name, then up to the first space: `/Applications/My
 * App.app/…/x` stays `x`, and `npx -y pkg`, `/usr/bin/node /srv/x.js` or
 * `node x.js --token=…` give `npx` and `node`. An argument can carry a
 * secret, so none may leak through.
 */
function programOf(command: string): string | null {
  const trimmed = command.trim();
  const quoted = /^"([^"]+)"|^'([^']+)'/.exec(trimmed);
  const program = quoted
    ? (quoted[1] ?? quoted[2] ?? "")
    : (trimmed.split(/\s+(?=[-/~."'])/)[0] ?? "");
  const name = basename(program).split(/\s+/)[0];
  return name ? redact(name) : null;
}

function transportOf(
  declared: string | null,
  command: string | null,
  url: string | null,
): SetupTransport {
  const kind = declared?.toLowerCase().replace(/[_-]/g, "");
  if (kind === "stdio") return "stdio";
  if (kind === "http" || kind === "streamablehttp") return "http";
  if (kind === "sse") return "sse";
  if (kind === "ws" || kind === "websocket") return "ws";
  return command ? "stdio" : url ? "http" : "unknown";
}

/** The only fields of an MCP server that leave main. */
function serverFields(entry: {
  type?: string | null;
  command?: string | null;
  url?: string | null;
}): Pick<SetupMcpServer, "transport" | "target"> {
  const command = entry.command ?? null;
  const url = entry.url ?? null;
  return {
    transport: transportOf(entry.type ?? null, command, url),
    target: url ? hostOf(url) : command ? programOf(command) : null,
  };
}

const jsonServer = (entry: unknown) =>
  serverFields(
    isObject(entry)
      ? {
          type: text(entry.type) ?? text(entry.transport),
          command: text(entry.command),
          url: text(entry.url),
        }
      : {},
  );

// ── Files ──────────────────────────────────────────────────────────────────

/**
 * The first `bytes` of a file, and whether there was more.
 *
 * @returns null when the file is missing, not a file, or cannot be read.
 */
async function readHead(
  path: string,
  bytes: number,
): Promise<{ text: string; truncated: boolean } | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    handle = await open(path, "r");
    const size = Math.min(info.size, bytes);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: info.size > bytes,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** A file's `---` frontmatter, without the fences, and the rest. */
export function splitFrontmatter(source: string): {
  frontmatter: string | null;
  body: string;
} {
  const text = source.replace(/^﻿/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match
    ? { frontmatter: match[1] ?? "", body: text.slice(match[0].length) }
    : { frontmatter: null, body: text };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/g, "'");
  return tomlString(value) ?? value;
}

/**
 * The top-level `key: value` pairs of a frontmatter.
 *
 * A block scalar (`description: >`) or indented lines are folded onto one
 * line. Not a YAML parser: a name and a description are all a row shows, and
 * the file itself opens as written (FE-40/D4).
 */
export function frontmatterFields(frontmatter: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(lines[index] ?? "");
    if (!match?.[1]) continue;
    const value = (match[2] ?? "").trim();
    if (value && !/^[>|][+-]?$/.test(value)) {
      fields[match[1]] = unquote(value);
      continue;
    }
    const block: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? "";
      if (next.trim() && !/^[ \t]/.test(next)) break;
      block.push(next.trim());
      index++;
    }
    fields[match[1]] = block.join(" ").trim();
  }
  return fields;
}

/** Names in a folder, dot-entries left out, sorted, capped. */
async function listDir(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => !name.startsWith("."))
    .sort()
    .slice(0, DIR_MAX);
}

const isDir = (path: string) =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

/** `rel` under `root`, or null when it would leave it. */
function inside(root: string, rel: string): string | null {
  const path = resolve(root, rel);
  return path === root || path.startsWith(`${root}${sep}`) ? path : null;
}

// ── The read ───────────────────────────────────────────────────────────────

type Origin = {
  agent: SetupAgent;
  scope: SetupScope;
  plugin: string | null;
  disabled: string | null;
};

interface Read {
  folder: string;
  /** The folder as each CLI may have keyed it: as linked, and its realpath. */
  folders: string[];
  where: AgentHome;
  setup: AgentSetup;
  /** Every skill's and command's file, by the id handed out with it. */
  files: Map<string, string>;
}

/** A file's path as a person reads it: in the folder, under `~`, or as is. */
function shown(read: Read, path: string): string {
  const { folder, where } = read;
  if (path === folder || path.startsWith(`${folder}${sep}`))
    return relative(folder, path) || ".";
  if (path.startsWith(`${where.home}${sep}`))
    return `~/${relative(where.home, path)}`;
  return path;
}

/**
 * A config file's text; null when it is not there.
 *
 * One that is there but too big to be a config is reported in `unreadable`,
 * not silently skipped.
 */
async function readConfig(
  read: Read,
  path: string,
  max = CONFIG_MAX_BYTES,
): Promise<string | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.size > max) {
    read.setup.unreadable.push(shown(read, path));
    return null;
  }
  return readText(path, max);
}

async function readJson(
  read: Read,
  path: string,
  max = CONFIG_MAX_BYTES,
): Promise<Json | null> {
  const raw = await readConfig(read, path, max);
  if (raw === null || !raw.trim()) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (isObject(value)) return value;
  } catch {
    // Reported as unreadable below.
  }
  read.setup.unreadable.push(shown(read, path));
  return null;
}

async function readToml(read: Read, path: string): Promise<TomlEntry[]> {
  const raw = await readConfig(read, path);
  return raw === null ? [] : tomlEntries(raw);
}

// ── Skills and commands ────────────────────────────────────────────────────

async function skillsIn(
  read: Read,
  dir: string,
  origin: Origin,
  turnedOff?: (skillDir: string, file: string) => string | null,
): Promise<void> {
  const found = await Promise.all(
    (await listDir(dir)).map(async (name) => {
      const file = join(dir, name, "SKILL.md");
      const head = await readHead(file, HEAD);
      return head ? { name, file, head } : null;
    }),
  );
  for (const entry of found) {
    if (!entry) continue;
    const fields = frontmatterFields(
      splitFrontmatter(entry.head.text).frontmatter ?? "",
    );
    const id = idOf(
      "skill",
      origin.agent,
      origin.scope,
      origin.plugin,
      shown(read, dir),
      entry.name,
    );
    read.files.set(id, entry.file);
    read.setup.skills.push({
      ...origin,
      id,
      source: shown(read, entry.file),
      disabled:
        origin.disabled ??
        turnedOff?.(join(dir, entry.name), entry.file) ??
        null,
      name: shownText(text(fields.name) ?? entry.name, 120),
      description: text(fields.description)
        ? shownText(fields.description as string, 280)
        : null,
    });
  }
}

/** A command's line: its `description`, or its first line of prose. */
function commandLine(source: string): string | null {
  const { frontmatter, body } = splitFrontmatter(source);
  const described = text(frontmatterFields(frontmatter ?? "").description);
  if (described) return shownText(described, 200);
  const first = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return first ? shownText(first, 200) : null;
}

/** `*.md` in `dir` and one folder down (Claude's `commands/frontend/x.md`). */
async function commandsIn(
  read: Read,
  dir: string,
  origin: Origin,
): Promise<void> {
  const files: { name: string; file: string }[] = [];
  for (const name of await listDir(dir)) {
    const path = join(dir, name);
    if (name.endsWith(".md"))
      files.push({ name: name.slice(0, -3), file: path });
    else if (await isDir(path))
      for (const inner of await listDir(path))
        if (inner.endsWith(".md"))
          files.push({
            name: `${name}/${inner.slice(0, -3)}`,
            file: join(path, inner),
          });
  }
  const heads = await Promise.all(
    files.map(({ file }) => readHead(file, HEAD)),
  );
  files.forEach(({ name, file }, index) => {
    const head = heads[index];
    if (!head) return;
    const id = idOf(
      "command",
      origin.agent,
      origin.scope,
      origin.plugin,
      shown(read, dir),
      name,
    );
    read.files.set(id, file);
    read.setup.commands.push({
      ...origin,
      id,
      source: shown(read, file),
      name,
      description: commandLine(head.text),
    });
  });
}

// ── Hooks ──────────────────────────────────────────────────────────────────

function hookDetail(type: string, hook: Json): string | null {
  if (type === "http") {
    const url = text(hook.url);
    return url ? hostOf(url) : null;
  }
  if (type === "mcp_tool") {
    const parts = [text(hook.server), text(hook.tool)].filter(Boolean);
    return parts.length ? shownText(parts.join(" ")) : null;
  }
  const value = text(hook.command) ?? text(hook.prompt);
  return value ? shownText(value, 400) : null;
}

/**
 * The hooks of one `{ <Event>: [{ matcher?, hooks: [...] }] }` map.
 *
 * Claude's settings, Codex's `hooks.json` and plugins all share that shape.
 */
function hooksFrom(
  read: Read,
  map: unknown,
  base: Origin & { source: string },
  turnedOff: (event: string, group: number, index: number) => string | null,
): void {
  if (!isObject(map)) return;
  for (const [event, groups] of Object.entries(map)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group: unknown, groupIndex) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return;
      const matcher = text(group.matcher);
      group.hooks.forEach((hook: unknown, index) => {
        if (!isObject(hook)) return;
        const type = text(hook.type) ?? "command";
        const command = text(hook.command);
        read.setup.hooks.push({
          ...base,
          id: idOf(
            "hook",
            base.agent,
            base.scope,
            base.plugin,
            base.source,
            event,
            groupIndex,
            index,
          ),
          disabled: base.disabled ?? turnedOff(event, groupIndex, index),
          event,
          matcher: matcher ? shownText(matcher, 120) : null,
          type,
          detail: hookDetail(type, hook),
          // FE-40/D5: the app's hook names its script; the plugin's (INF-03)
          // is the Stop hook of the lanework plugin.
          lanework:
            (command?.includes(HOOK_MARKER) ?? false) ||
            (base.plugin?.startsWith("lanework@") === true && event === "Stop"),
        });
      });
    });
  }
}

// ── Permissions ────────────────────────────────────────────────────────────

function permission(
  read: Read,
  base: Origin & { source: string },
  kind: SetupPermissionKind,
  value: string,
): void {
  const index = read.setup.permissions.length;
  read.setup.permissions.push({
    ...base,
    id: idOf("permission", base.agent, base.scope, base.source, kind, index),
    kind,
    value,
  });
}

function claudePermissions(
  read: Read,
  settings: Json | null,
  base: Origin & { source: string },
): void {
  const rules = isObject(settings?.permissions) ? settings.permissions : null;
  if (rules) {
    const mode = text(rules.defaultMode);
    if (mode) permission(read, base, "mode", shownText(mode, 60));
    for (const kind of ["allow", "ask", "deny"] as const)
      for (const rule of strings(rules[kind]))
        permission(read, base, kind, shownText(rule));
    for (const dir of strings(rules.additionalDirectories))
      permission(read, base, "directory", shownText(dir));
  }
  // Auto mode's rules are prose, and long: counted, never shown.
  const auto = isObject(settings?.autoMode) ? settings.autoMode : null;
  if (auto) {
    const counts = Object.entries(auto)
      .filter(([, value]) => Array.isArray(value))
      .map(
        ([key, value]) =>
          `${(value as unknown[]).length} ${key.replace(/[_-]/g, " ")}`,
      );
    if (counts.length) permission(read, base, "auto", counts.join(", "));
  }
}

/** A Codex rule's `decision`, as the permission kind it reads as. */
const DECISIONS: Record<string, SetupPermissionKind> = {
  allow: "allow",
  prompt: "ask",
  forbidden: "deny",
};

/**
 * A rule's `pattern` as one line of text.
 *
 * `["git", ["status", "diff"]]` reads `git (status|diff)`.
 */
function patternOf(raw: string): string | null {
  const value = raw.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return tomlString(value);
  const parts = splitTop(value.slice(1, -1), ",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (!part.startsWith("[")) return tomlString(part) ?? part;
      const options = splitTop(part.slice(1, -1), ",")
        .map((option) => tomlString(option.trim()))
        .filter(Boolean);
      return `(${options.join("|")})`;
    });
  return parts.length ? parts.join(" ") : null;
}

/**
 * Codex's `prefix_rule(...)` and `network_rule(...)` calls in a `.rules`
 * file, as a decision and what it matches.
 *
 * NOTE: The file is Starlark, read as text and never run. A call this cannot
 * read is skipped.
 */
export function codexRules(
  source: string,
): { kind: SetupPermissionKind; value: string }[] {
  const code = source.split(/\r?\n/).map(stripComment).join("\n");
  const rules: { kind: SetupPermissionKind; value: string }[] = [];
  for (const call of code.matchAll(/\b(prefix_rule|network_rule)\s*\(/g)) {
    const start = (call.index ?? 0) + call[0].length;
    let depth = 1;
    let end = -1;
    outsideStrings(code.slice(start), (char, index) => {
      if (char === "(" || char === "[" || char === "{") depth++;
      else if (char === ")" || char === "]" || char === "}") depth--;
      if (depth > 0) return false;
      end = start + index;
      return true;
    });
    if (end < 0) continue;
    const args: Record<string, string> = {};
    for (const pair of splitTop(code.slice(start, end), ",")) {
      const match = /^\s*([A-Za-z_]+)\s*=\s*([\s\S]+?)\s*$/.exec(pair);
      if (match?.[1] && match[2]) args[match[1]] = match[2];
    }
    const decision = args.decision ? tomlString(args.decision) : "allow";
    const kind = DECISIONS[decision ?? ""] ?? "ask";
    if (call[1] === "prefix_rule") {
      const pattern = args.pattern ? patternOf(args.pattern) : null;
      if (pattern) rules.push({ kind, value: shownText(pattern) });
    } else {
      const host = args.host ? tomlString(args.host) : null;
      const protocol = args.protocol ? tomlString(args.protocol) : null;
      if (host)
        rules.push({
          kind,
          value: shownText(
            `network ${host}${protocol ? ` (${protocol})` : ""}`,
          ),
        });
    }
  }
  return rules;
}

async function codexRulesIn(
  read: Read,
  dir: string,
  base: Origin,
): Promise<void> {
  for (const name of await listDir(dir)) {
    if (!name.endsWith(".rules")) continue;
    const path = join(dir, name);
    const source = await readConfig(read, path);
    if (source === null) continue;
    for (const rule of codexRules(source))
      permission(
        read,
        { ...base, source: shown(read, path) },
        rule.kind,
        rule.value,
      );
  }
}

// ── Claude Code ────────────────────────────────────────────────────────────

type SettingsFile = {
  scope: "user" | "project" | "local";
  path: string;
  json: Json | null;
};

type Installed = {
  name: string;
  scope: "user" | "project" | "local";
  root: string;
  version: string | null;
};

/** Which of a plugin's installs wins: the narrowest scope. */
const INSTALL_RANK = { local: 0, project: 1, user: 2 } as const;

/** Each installed plugin's install that applies to this folder, if any. */
function installedHere(read: Read, json: Json | null): Installed[] {
  const plugins = isObject(json?.plugins) ? json.plugins : {};
  const found: Installed[] = [];
  for (const [name, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) continue;
    const fits = entries
      .filter(isObject)
      .filter((entry) => {
        const root = text(entry.installPath);
        if (!root || !isAbsolute(root)) return false;
        // A project or local install is for that one folder.
        return (
          entry.scope === "user" ||
          (typeof entry.projectPath === "string" &&
            read.folders.includes(entry.projectPath))
        );
      })
      .map(
        (entry): Installed => ({
          name,
          scope:
            entry.scope === "local" || entry.scope === "project"
              ? entry.scope
              : "user",
          root: entry.installPath as string,
          version: text(entry.version),
        }),
      )
      .sort((a, b) => INSTALL_RANK[a.scope] - INSTALL_RANK[b.scope]);
    if (fits[0]) found.push(fits[0]);
  }
  return found;
}

/** The last word on a plugin: the narrowest settings file that names it. */
function pluginSwitch(
  settings: SettingsFile[],
  name: string,
): { on: boolean; file: SettingsFile } | null {
  let found: { on: boolean; file: SettingsFile } | null = null;
  for (const file of settings) {
    const map = file.json?.enabledPlugins;
    if (isObject(map) && name in map) found = { on: map[name] === true, file };
  }
  return found;
}

/** A plugin's MCP servers, skills, commands and hooks. */
async function pluginContents(
  read: Read,
  plugin: Installed,
  off: string | null,
): Promise<void> {
  const origin: Origin = {
    agent: "claude",
    scope: "plugin",
    plugin: plugin.name,
    disabled: off,
  };
  const { root } = plugin;
  const manifest = await readJson(
    read,
    join(root, ".claude-plugin", "plugin.json"),
  );

  const addServers = (map: unknown, path: string) => {
    if (!isObject(map)) return;
    for (const [name, entry] of Object.entries(map))
      read.setup.mcp.push({
        ...origin,
        id: idOf(
          "mcp",
          "claude",
          "plugin",
          plugin.name,
          shown(read, path),
          name,
        ),
        source: shown(read, path),
        name,
        ...jsonServer(entry),
      });
  };
  // `.mcp.json` at the plugin's root (`{ mcpServers }` or the map itself),
  // and whatever its manifest names, inline or as a file.
  const mcpPath = join(root, ".mcp.json");
  const mcpFile = await readJson(read, mcpPath);
  if (mcpFile)
    addServers(
      isObject(mcpFile.mcpServers) ? mcpFile.mcpServers : mcpFile,
      mcpPath,
    );
  const manifestPath = join(root, ".claude-plugin", "plugin.json");
  if (isObject(manifest?.mcpServers))
    addServers(manifest.mcpServers, manifestPath);
  else if (typeof manifest?.mcpServers === "string") {
    const path = inside(root, manifest.mcpServers);
    const file = path && path !== mcpPath ? await readJson(read, path) : null;
    if (path && file)
      addServers(isObject(file.mcpServers) ? file.mcpServers : file, path);
  }

  await skillsIn(read, join(root, "skills"), origin);
  await commandsIn(read, join(root, "commands"), origin);

  const hooksPath =
    typeof manifest?.hooks === "string"
      ? inside(root, manifest.hooks)
      : join(root, "hooks", "hooks.json");
  if (isObject(manifest?.hooks))
    hooksFrom(
      read,
      manifest.hooks.hooks ?? manifest.hooks,
      { ...origin, source: shown(read, manifestPath) },
      () => null,
    );
  else if (hooksPath) {
    const file = await readJson(read, hooksPath);
    if (file)
      hooksFrom(
        read,
        file.hooks,
        { ...origin, source: shown(read, hooksPath) },
        () => null,
      );
  }
}

async function readClaude(read: Read): Promise<void> {
  const { folder, where } = read;
  const [claudeJson, installedJson, ...files] = await Promise.all([
    readJson(read, where.claudeJson, CLAUDE_JSON_MAX),
    readJson(read, join(where.claudeDir, "plugins", "installed_plugins.json")),
    readJson(read, join(where.claudeDir, "settings.json")),
    readJson(read, join(folder, ".claude", "settings.json")),
    readJson(read, join(folder, ".claude", "settings.local.json")),
  ]);
  const settings: SettingsFile[] = [
    {
      scope: "user",
      path: join(where.claudeDir, "settings.json"),
      json: files[0] ?? null,
    },
    {
      scope: "project",
      path: join(folder, ".claude", "settings.json"),
      json: files[1] ?? null,
    },
    {
      scope: "local",
      path: join(folder, ".claude", "settings.local.json"),
      json: files[2] ?? null,
    },
  ];
  const projects = isObject(claudeJson?.projects) ? claudeJson.projects : {};
  const local = read.folders.map((key) => projects[key]).find(isObject) as
    | Json
    | undefined;
  const claudeJsonShown = shown(read, where.claudeJson);
  const base = (
    scope: SetupScope,
    source: string,
  ): Origin & { source: string } => ({
    agent: "claude",
    scope,
    source,
    plugin: null,
    disabled: null,
  });

  // MCP: local, then project, then user. That is the order in which Claude
  // lets one name win, so the first of a name is the one it uses.
  const mcpJsonPath = join(folder, ".mcp.json");
  const mcpJson = await readJson(read, mcpJsonPath);
  const offIn = new Map<string, string>();
  for (const [names, source] of [
    [strings(local?.disabledMcpjsonServers), claudeJsonShown],
    ...settings.map(
      (file) =>
        [
          strings(file.json?.disabledMcpjsonServers),
          shown(read, file.path),
        ] as const,
    ),
  ] as const)
    for (const name of names) if (!offIn.has(name)) offIn.set(name, source);
  const servers: SetupMcpServer[] = [];
  const addServers = (
    map: unknown,
    origin: Origin & { source: string },
    turnedOff: (name: string) => string | null,
  ) => {
    if (!isObject(map)) return;
    for (const [name, entry] of Object.entries(map))
      servers.push({
        ...origin,
        id: idOf("mcp", "claude", origin.scope, null, name),
        disabled: turnedOff(name),
        name,
        ...jsonServer(entry),
      });
  };
  addServers(local?.mcpServers, base("local", claudeJsonShown), () => null);
  addServers(mcpJson?.mcpServers, base("project", ".mcp.json"), (name) => {
    const source = offIn.get(name);
    return source
      ? `Turned off for this folder in ${source} (disabledMcpjsonServers)`
      : null;
  });
  addServers(claudeJson?.mcpServers, base("user", claudeJsonShown), () => null);
  const winner = new Map<string, SetupScope>();
  for (const server of servers) {
    if (server.disabled) continue;
    const won = winner.get(server.name);
    if (won) server.disabled = `Replaced by the ${won} server of the same name`;
    else winner.set(server.name, server.scope);
  }
  read.setup.mcp.push(...servers);

  // Skills and commands of the user and of the repo.
  const user = base("user", "");
  const project = base("project", "");
  await skillsIn(read, join(where.claudeDir, "skills"), user);
  await skillsIn(read, join(folder, ".claude", "skills"), project);
  await commandsIn(read, join(where.claudeDir, "commands"), user);
  await commandsIn(read, join(folder, ".claude", "commands"), project);

  // Hooks and permissions of each settings file.
  const allOff = settings.find((file) => file.json?.disableAllHooks === true);
  for (const file of settings) {
    const origin = base(file.scope, shown(read, file.path));
    hooksFrom(read, file.json?.hooks, origin, () =>
      allOff ? `disableAllHooks is on in ${shown(read, allOff.path)}` : null,
    );
    claudePermissions(read, file.json, origin);
  }
  for (const rule of strings(local?.allowedTools))
    permission(read, base("local", claudeJsonShown), "allow", shownText(rule));

  // Plugins: installed here, switched on or off by the settings files.
  const installed = installedHere(read, installedJson);
  const installedShown = shown(
    read,
    join(where.claudeDir, "plugins", "installed_plugins.json"),
  );
  for (const plugin of installed) {
    const state = pluginSwitch(settings, plugin.name);
    const off = !state
      ? "Not turned on in any settings file (enabledPlugins)"
      : state.on
        ? null
        : `Turned off in ${shown(read, state.file.path)}`;
    read.setup.plugins.push({
      ...base(
        plugin.scope,
        state ? shown(read, state.file.path) : installedShown,
      ),
      id: idOf("plugin", "claude", plugin.scope, plugin.name),
      disabled: off,
      name: plugin.name,
      version: plugin.version,
    });
    await pluginContents(
      read,
      plugin,
      off && `The plugin ${plugin.name} is off`,
    );
  }
  // Switched on somewhere but not installed for this folder on this machine.
  const known = new Set(installed.map((plugin) => plugin.name));
  for (const file of settings) {
    const map = file.json?.enabledPlugins;
    if (!isObject(map)) continue;
    for (const name of Object.keys(map)) {
      if (known.has(name) || pluginSwitch(settings, name)?.file !== file)
        continue;
      known.add(name);
      if (map[name] !== true) continue;
      read.setup.plugins.push({
        ...base(file.scope, shown(read, file.path)),
        id: idOf("plugin", "claude", file.scope, name),
        disabled: "Not installed on this machine",
        name,
        version: null,
      });
    }
  }
}

// ── Codex ──────────────────────────────────────────────────────────────────

/** An event as Codex keys a hook's review: `PreToolUse` → `pre_tool_use`. */
const snake = (event: string) =>
  event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * A `config.toml`'s inline `[hooks]`, in the `hooks.json` shape.
 *
 * Only the fields a row shows. `hooks.state` is Codex's review record, not a
 * hook.
 */
function tomlHooks(entries: TomlEntry[]): Json {
  const hooks: Record<string, Json[]> = {};
  const indexOf = (part: string | undefined) => {
    const match = /^#(\d+)$/.exec(part ?? "");
    return match ? Number(match[1]) : null;
  };
  for (const { path, raw } of entries) {
    const [root, event, groupPart, ...rest] = path;
    if (root !== "hooks" || !event || event === "state") continue;
    const group = indexOf(groupPart);
    if (group === null) continue;
    const groups = hooks[event] ?? [];
    hooks[event] = groups;
    const entry = groups[group] ?? { hooks: [] };
    groups[group] = entry;
    if (rest.length === 1 && rest[0] === "matcher")
      entry.matcher = tomlString(raw);
    const index = indexOf(rest[1]);
    const field = rest[2];
    if (rest[0] !== "hooks" || index === null || !field || rest.length !== 3)
      continue;
    const list = entry.hooks as Json[];
    const hook = list[index] ?? {};
    list[index] = hook;
    if (["type", "command", "prompt", "url", "server", "tool"].includes(field))
      hook[field] = tomlString(raw);
  }
  return hooks;
}

async function readCodex(read: Read): Promise<void> {
  const { folder, folders, where } = read;
  const configPath = join(where.codexDir, "config.toml");
  const projectConfigPath = join(folder, ".codex", "config.toml");
  const [userToml, projectToml] = await Promise.all([
    readToml(read, configPath),
    readToml(read, projectConfigPath),
  ]);
  const configShown = shown(read, configPath);
  const base = (
    scope: SetupScope,
    source: string,
  ): Origin & { source: string } => ({
    agent: "codex",
    scope,
    source,
    plugin: null,
    disabled: null,
  });

  // Trust is looked up at the folder. Without an entry Codex treats it as
  // untrusted, and then loads nothing from its `.codex/`.
  let trust: string | null = null;
  for (const { path, raw } of userToml)
    if (
      path.length === 3 &&
      path[0] === "projects" &&
      folders.includes(path[1] as string) &&
      path[2] === "trust_level"
    )
      trust = tomlString(raw);
  const untrusted =
    trust === "trusted"
      ? null
      : "Codex loads this folder's .codex only once the project is trusted";

  // `[features] hooks` defaults to on; only an explicit false stops them.
  let hooksOff = false;
  const reviewed = new Set<string>();
  const skillsOff: { path: string; enabled: boolean | null }[] = [];
  for (const { path, raw } of userToml) {
    const key = path.join(".");
    if (key === "features.hooks" && tomlBool(raw) === false) hooksOff = true;
    if (
      path[0] === "hooks" &&
      path[1] === "state" &&
      path[3] === "trusted_hash"
    )
      reviewed.add(path[2] as string);
    const index = /^#(\d+)$/.exec(path[2] ?? "")?.[1];
    if (path[0] === "skills" && path[1] === "config" && index && path[3]) {
      const entry = skillsOff[Number(index)] ?? { path: "", enabled: null };
      skillsOff[Number(index)] = entry;
      if (path[3] === "path") entry.path = tomlString(raw) ?? "";
      if (path[3] === "enabled") entry.enabled = tomlBool(raw);
    }
  }
  // Why Codex will not run the hook at `Event[group].hooks[index]` of one of
  // `files` (the same file, as each spelling of the folder names it).
  //
  // NOTE: Codex runs a hook only once it was reviewed in `/hooks`, recorded as
  // `hooks.state."<file>:<event>:<group>:<index>"`. Whether that record is
  // still for THIS command is Codex's to say; its hash is never read.
  const notRun =
    (files: string[]) => (event: string, group: number, index: number) =>
      hooksOff
        ? "Codex hooks are off: [features] hooks = false"
        : files.some((file) =>
              reviewed.has(`${file}:${snake(event)}:${group}:${index}`),
            )
          ? null
          : "Not reviewed in Codex yet (/hooks)";
  const inFolders = (...parts: string[]) =>
    folders.map((key) => join(key, ...parts));

  // Per layer (the trusted repo's config, then the user's): its MCP servers,
  // inline hooks, plugins and policies. The repo's comes first, so its server
  // wins a shared name.
  const layers = [
    {
      scope: "project" as const,
      entries: projectToml,
      path: projectConfigPath,
      spellings: inFolders(".codex", "config.toml"),
      off: untrusted,
    },
    {
      scope: "user" as const,
      entries: userToml,
      path: configPath,
      spellings: [configPath],
      off: null,
    },
  ];
  const servers: SetupMcpServer[] = [];
  for (const layer of layers) {
    const source = shown(read, layer.path);
    const fields = new Map<
      string,
      { command?: string; url?: string; type?: string; enabled?: boolean }
    >();
    for (const { path, raw } of layer.entries) {
      if (path[0] !== "mcp_servers" || path.length < 3) continue;
      const name = path[1] as string;
      const server = fields.get(name) ?? {};
      fields.set(name, server);
      // NOTE: Only these, and only at the server's own level: `env`, `args`,
      // `http_headers` and the rest are never turned into values.
      if (path.length !== 3) continue;
      const value = tomlString(raw) ?? undefined;
      if (path[2] === "command") server.command = value;
      else if (path[2] === "url") server.url = value;
      else if (path[2] === "transport" || path[2] === "type")
        server.type = value;
      else if (path[2] === "enabled")
        server.enabled = tomlBool(raw) ?? undefined;
    }
    for (const [name, server] of fields)
      servers.push({
        ...base(layer.scope, source),
        id: idOf("mcp", "codex", layer.scope, null, name),
        disabled:
          layer.off ??
          (server.enabled === false ? "Off: enabled = false" : null),
        name,
        ...serverFields(server),
      });

    hooksFrom(
      read,
      tomlHooks(layer.entries),
      { ...base(layer.scope, source), disabled: layer.off },
      notRun(layer.spellings),
    );

    const policies = {
      approval: new Set<string>(),
      sandbox: new Set<string>(),
    };
    for (const { path, raw } of layer.entries) {
      if (path.length === 3 && path[0] === "plugins" && path[2] === "enabled")
        read.setup.plugins.push({
          ...base(layer.scope, source),
          id: idOf("plugin", "codex", layer.scope, path[1] as string),
          disabled:
            layer.off ??
            (tomlBool(raw) === false ? "Off: enabled = false" : null),
          name: path[1] as string,
          version: null,
        });
      const policy =
        path[0] === "approval_policy"
          ? policies.approval
          : path[0] === "sandbox_mode"
            ? policies.sandbox
            : null;
      // `approval_policy = { granular = … }` is named, not spelled out.
      const value = path.length === 1 ? tomlString(raw) : path[1];
      if (policy && value) policy.add(shownText(value, 60));
    }
    for (const kind of ["approval", "sandbox"] as const)
      if (policies[kind].size)
        permission(
          read,
          { ...base(layer.scope, source), disabled: layer.off },
          kind,
          [...policies[kind]].join(", "),
        );
  }
  const winner = new Map<string, SetupScope>();
  for (const server of servers) {
    if (server.disabled) continue;
    const won = winner.get(server.name);
    if (won) server.disabled = `Replaced by the ${won} server of the same name`;
    else winner.set(server.name, server.scope);
  }
  read.setup.mcp.push(...servers);
  permission(
    read,
    base("local", configShown),
    "trust",
    trust ? shownText(trust, 60) : "not set (untrusted)",
  );

  // Hooks files: the user's, and the trusted repo's.
  const userHooks = join(where.codexDir, "hooks.json");
  for (const [scope, path, spellings, off] of [
    ["user", userHooks, [userHooks], null],
    [
      "project",
      join(folder, ".codex", "hooks.json"),
      inFolders(".codex", "hooks.json"),
      untrusted,
    ],
  ] as const) {
    const file = await readJson(read, path);
    if (!file) continue;
    hooksFrom(
      read,
      file.hooks,
      { ...base(scope, shown(read, path)), disabled: off },
      notRun([...spellings]),
    );
  }

  // Rules: the user's, and the trusted repo's.
  await codexRulesIn(read, join(where.codexDir, "rules"), base("user", ""));
  await codexRulesIn(read, join(folder, ".codex", "rules"), {
    ...base("project", ""),
    disabled: untrusted,
  });

  // Skills: the repo's `.agents/skills` and trusted `.codex/skills`, the
  // user's `~/.agents/skills` and the older `$CODEX_HOME/skills`, and the
  // ones Codex ships in `.system`.
  const resolveSkill = (path: string) =>
    path.startsWith("~/")
      ? join(where.home, path.slice(2))
      : resolve(where.codexDir, path);
  const off = skillsOff
    .filter((entry) => entry?.path && entry.enabled === false)
    .map((entry) => resolveSkill(entry.path));
  const turnedOff = (dir: string, file: string) =>
    off.includes(dir) || off.includes(file)
      ? `Off in ${configShown} ([[skills.config]] enabled = false)`
      : null;
  await skillsIn(
    read,
    join(folder, ".agents", "skills"),
    base("project", ""),
    turnedOff,
  );
  await skillsIn(
    read,
    join(folder, ".codex", "skills"),
    { ...base("project", ""), disabled: untrusted },
    turnedOff,
  );
  await skillsIn(
    read,
    join(where.home, ".agents", "skills"),
    base("user", ""),
    turnedOff,
  );
  await skillsIn(
    read,
    join(where.codexDir, "skills"),
    base("user", ""),
    turnedOff,
  );
  await skillsIn(
    read,
    join(where.codexDir, "skills", ".system"),
    base("system", ""),
    turnedOff,
  );
}

// ── Entry points ───────────────────────────────────────────────────────────

const emptySetup = (folder: string | null): AgentSetup => ({
  folder,
  mcp: [],
  skills: [],
  commands: [],
  hooks: [],
  permissions: [],
  plugins: [],
  unreadable: [],
  readAt: new Date().toISOString(),
});

/**
 * Sort `list` in place: Claude's rows before Codex's, then by scope.
 *
 * Scopes go local, project, user, plugin, system ({@link SCOPE_ORDER}).
 */
function byOrigin<T extends { agent: SetupAgent; scope: SetupScope }>(
  list: T[],
): T[] {
  return list.sort(
    (a, b) =>
      (a.agent === b.agent ? 0 : a.agent === "claude" ? -1 : 1) ||
      SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope],
  );
}

/**
 * Everything both CLIs would load in `folder`.
 *
 * Also the file behind each skill and command, kept in main by the id the
 * renderer is given, so the renderer never names a path (FE-40/D4).
 */
export async function readAgentSetup(
  folder: string | null,
  where: AgentHome,
): Promise<{ setup: AgentSetup; files: Map<string, string> }> {
  const files = new Map<string, string>();
  if (!folder) return { setup: emptySetup(null), files };
  const real = await realpath(folder).catch(() => folder);
  const read: Read = {
    folder,
    folders: [...new Set([folder, real])],
    where,
    setup: emptySetup(folder),
    files,
  };
  await readClaude(read);
  await readCodex(read);
  const { setup } = read;
  byOrigin(setup.mcp);
  byOrigin(setup.skills);
  byOrigin(setup.commands);
  byOrigin(setup.hooks);
  byOrigin(setup.permissions);
  byOrigin(setup.plugins);
  setup.unreadable = [...new Set(setup.unreadable)];
  return { setup, files };
}

/**
 * One skill or command, capped, its frontmatter apart (FE-40/D4).
 *
 * @throws When the file is no longer there.
 */
export async function readSetupFile(path: string): Promise<{
  frontmatter: string | null;
  body: string;
  truncated: boolean;
}> {
  const head = await readHead(path, SETUP_FILE_MAX);
  if (!head) throw new Error("That file is no longer on this machine.");
  return { ...splitFrontmatter(head.text), truncated: head.truncated };
}
