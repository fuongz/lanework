// Reads and rewrites Claude Code's user settings to add or remove our Stop
// hook, and nothing else. Codex's `hooks.json` has the same shape,
// `{ hooks: { Stop: [{ hooks: [{ type, command }] }] } }`, so every rule here
// serves it too (`codex.ts`).
//
// NOTE: `~/.claude/settings.json` belongs to the user and to Claude Code.
// Every rule below exists so that turning our switch on and off leaves that
// file as it was, apart from our one entry:
//
// - Our entry is recognised by the hook's filename in its command. Only that
//   entry is replaced or removed. Other Stop hooks, other events and every
//   other key pass through untouched.
// - A file that exists but is not a JSON object is refused, not "repaired".
//   The user may be halfway through editing it, and overwriting it would
//   destroy their work.
// - The write goes through `config-file.ts` (INF-05): atomic (temp file +
//   rename), so a crash mid-write cannot leave Claude Code with half a
//   settings file; through a symlink to the file it names; with the file's own
//   mode; and never over a change Claude Code made since the read. Then the
//   file is read and changed again, once.
//
// Pure apart from `readSettings` / `writeSettings`, and free of Electron, so
// the merge rules are tested directly (`tests/handoff-settings.spec.ts`).
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { updateConfigFile } from "../config-file";

/** The text in our hook's command, and in no one else's. */
export const HOOK_MARKER = "lanework-checkpoint";

/**
 * The path of Claude Code's user settings.
 *
 * `CLAUDE_CONFIG_DIR` is Claude Code's own override for `~/.claude`, which
 * tests also use.
 */
export function claudeSettingsPath(): string {
  return join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "settings.json",
  );
}

type Json = Record<string, unknown>;
type HookEntry = { type?: unknown; command?: unknown; timeout?: unknown };
type HookGroup = { matcher?: unknown; hooks?: unknown };

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOurs = (entry: unknown): boolean =>
  isObject(entry) &&
  typeof (entry as HookEntry).command === "string" &&
  ((entry as HookEntry).command as string).includes(HOOK_MARKER);

/** Single-quote for `sh`: the paths may hold spaces (`Application Support`). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The script both CLIs' settings point at, rewritten by the app on every
 * launch.
 *
 * - NOTE: A script, not the command itself (FE-29/D3). Codex runs a hook only
 *   after the user approves it, and pins that approval to the hook's command.
 *   The paths that change (this app's binary, the bundled hook) live in the
 *   script, so the command in the settings files never changes and one
 *   approval lasts.
 * - `ELECTRON_RUN_AS_NODE=1` turns the app binary into a plain Node
 *   (FE-28/D5): the people this is for have no bun and may have no node. The
 *   hook passes the variable on to the worker it detaches, or the worker would
 *   boot as an app.
 */
export function buildShim(options: {
  execPath: string;
  hookPath: string;
  apiUrl: string;
  configPath: string;
  secretFile?: string | null;
  /** The app home, pinned so the hook opens the app's own local store. */
  home?: string | null;
}): string {
  return [
    "#!/bin/sh",
    "# Lanework's checkpoint hook (FE-29). The Lanework app rewrites this file",
    "# on every launch; edits here are lost. Settings → Harness turns it off.",
    "export ELECTRON_RUN_AS_NODE=1",
    `export LANEWORK_HOOK_CONFIG=${shellQuote(options.configPath)}`,
    ...(options.secretFile
      ? [`export LANEWORK_HOOK_SECRET_FILE=${shellQuote(options.secretFile)}`]
      : []),
    ...(options.home
      ? [`export LANEWORK_HOME=${shellQuote(options.home)}`]
      : []),
    `exec ${shellQuote(options.execPath)} ${shellQuote(options.hookPath)} --api ${shellQuote(options.apiUrl)} "$@"`,
    "",
  ].join("\n");
}

/** What goes in a CLI's settings: the shim, and which CLI is calling it. */
export function buildHookCommand(options: {
  shimPath: string;
  agent: "claude-code" | "codex";
}): string {
  return `${shellQuote(options.shimPath)} --agent ${options.agent}`;
}

/**
 * Where our hook sits: `Stop[group].hooks[index]`.
 *
 * Codex keys a hook's approval by this position
 * (`<file>:stop:<group>:<index>`).
 *
 * @returns Null when our hook is not there.
 */
export function findHookPosition(
  settings: Json,
): { group: number; index: number } | null {
  const stop = isObject(settings.hooks) ? settings.hooks.Stop : undefined;
  if (!Array.isArray(stop)) return null;
  for (const [group, entry] of stop.entries()) {
    const hooks = isObject(entry) ? (entry as HookGroup).hooks : undefined;
    if (!Array.isArray(hooks)) continue;
    const index = hooks.findIndex(isOurs);
    if (index !== -1) return { group, index };
  }
  return null;
}

/** Our hook's command in these settings, or null. */
export function findHook(settings: Json): string | null {
  const stop = isObject(settings.hooks) ? settings.hooks.Stop : undefined;
  if (!Array.isArray(stop)) return null;
  for (const group of stop) {
    const hooks = isObject(group) ? (group as HookGroup).hooks : undefined;
    if (!Array.isArray(hooks)) continue;
    const ours = hooks.find(isOurs) as HookEntry | undefined;
    if (ours) return ours.command as string;
  }
  return null;
}

/** `settings` with every copy of our hook removed, and empty shells dropped. */
export function withoutHook(settings: Json): Json {
  if (!isObject(settings.hooks) || !Array.isArray(settings.hooks.Stop))
    return settings;
  const stop = settings.hooks.Stop.flatMap((group: unknown) => {
    if (!isObject(group) || !Array.isArray((group as HookGroup).hooks))
      return [group];
    const hooks = ((group as HookGroup).hooks as unknown[]).filter(
      (entry) => !isOurs(entry),
    );
    // A group that held only ours goes; one that still holds others stays.
    return hooks.length ? [{ ...group, hooks }] : [];
  });
  const { Stop: _, ...otherEvents } = settings.hooks;
  const hooks = stop.length ? { ...otherEvents, Stop: stop } : otherEvents;
  const { hooks: __, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

/** `settings` with exactly one copy of our hook, running `command`. */
export function withHook(settings: Json, command: string): Json {
  const clean = withoutHook(settings);
  const hooks = isObject(clean.hooks) ? clean.hooks : {};
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  return {
    ...clean,
    hooks: {
      ...hooks,
      Stop: [...stop, { hooks: [{ type: "command", command, timeout: 10 }] }],
    },
  };
}

type SettingsRead =
  | { ok: true; settings: Json }
  | { ok: false; reason: "unreadable" };

/**
 * Parse a settings file's text.
 *
 * A missing or blank file is empty settings. Anything else must be a JSON
 * object, or the read is `unreadable`.
 */
export function parseSettings(text: string | null): SettingsRead {
  if (text === null || !text.trim()) return { ok: true, settings: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed)
      ? { ok: true, settings: parsed }
      : { ok: false, reason: "unreadable" };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

export async function readSettings(
  path = claudeSettingsPath(),
): Promise<SettingsRead> {
  const text = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  return parseSettings(text);
}

const settingsText = (settings: Json) =>
  `${JSON.stringify(settings, null, 2)}\n`;

/** Replace the whole settings file with `settings`. */
export async function writeSettings(
  settings: Json,
  path = claudeSettingsPath(),
): Promise<void> {
  await updateConfigFile(path, () => settingsText(settings));
}

/**
 * Change the settings file: `change` gets what it holds now and returns the
 * new settings, or null to leave the file as it is.
 *
 * Run again, once, on what the file holds then, when another tool wrote it in
 * between.
 *
 * @returns Whether the file was written.
 * @throws When the file is not a JSON object; it is never overwritten.
 */
export function updateSettings(
  change: (settings: Json) => Json | null,
  path = claudeSettingsPath(),
): Promise<boolean> {
  return updateConfigFile(path, (text) => {
    const read = parseSettings(text);
    if (!read.ok)
      throw new Error(
        `${path} is not valid JSON. Fix or remove it, then try again — Lanework will not overwrite it.`,
      );
    const next = change(read.settings);
    return next === null ? null : settingsText(next);
  });
}
