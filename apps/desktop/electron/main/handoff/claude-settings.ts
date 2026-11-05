// Reads and rewrites Claude Code's user settings to add or remove our
// checkpoint hook, and nothing else. For Claude Code that is three entries
// running one command: `Stop`, `PreCompact` and `SessionStart` matching
// `compact` (FE-117, `CLAUDE_HOOK_EVENTS`); for Codex, `Stop` only. Codex's `hooks.json` has the same shape,
// `{ hooks: { Stop: [{ hooks: [{ type, command }] }] } }`, so every rule here
// serves it too (`codex.ts`).
//
// NOTE: `~/.claude/settings.json` belongs to the user and to Claude Code.
// Every rule below exists so that turning our switch on and off leaves that
// file as it was, apart from our one entry:
//
// - Our entry is recognised by the hook's filename in its command. Only that
//   entry (in any event) is replaced or removed. Other Stop hooks, other events and every
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

/** One event our command runs on, and the matcher its group carries. */
export type HookEventSpec = { event: string; matcher?: string };

/**
 * Where the app installs the hook for Claude Code (FE-117/D1).
 *
 * - `PreCompact`, no matcher: both `/compact` and auto-compaction. The hook
 *   writes a pre-compact checkpoint and prints nothing (its stdout would be
 *   appended to the compaction instructions).
 * - `SessionStart`, matcher `compact`: only the session that a compaction
 *   restarts. The hook prints its one reminder there, nowhere else.
 */
export const CLAUDE_HOOK_EVENTS: readonly HookEventSpec[] = [
  { event: "Stop" },
  { event: "PreCompact" },
  { event: "SessionStart", matcher: "compact" },
];

/**
 * Where the app installs the hook for Codex: `Stop` only.
 *
 * ⚠️ Codex 0.165 lists PreCompact and SessionStart (source `compact`) too, but
 * each new entry needs its own approval in Codex, which Settings does not
 * track, and nothing documents that Codex starts a `compact` session after
 * compacting (FE-117/D5). Not guessed.
 */
export const CODEX_HOOK_EVENTS: readonly HookEventSpec[] = [{ event: "Stop" }];

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

const holdsOurs = (groups: unknown): boolean =>
  Array.isArray(groups) &&
  groups.some(
    (group) =>
      isObject(group) &&
      Array.isArray((group as HookGroup).hooks) &&
      ((group as HookGroup).hooks as unknown[]).some(isOurs),
  );

/**
 * `settings` with every copy of our hook removed, in every event, and empty
 * shells dropped.
 *
 * An event array that holds none of ours is passed through as it is.
 */
export function withoutHook(settings: Json): Json {
  if (!isObject(settings.hooks)) return settings;
  const hooks: Json = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!holdsOurs(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = (groups as unknown[]).flatMap((group: unknown) => {
      if (!isObject(group) || !Array.isArray((group as HookGroup).hooks))
        return [group];
      const entries = ((group as HookGroup).hooks as unknown[]).filter(
        (entry) => !isOurs(entry),
      );
      // A group that held only ours goes; one that still holds others stays.
      return entries.length ? [{ ...group, hooks: entries }] : [];
    });
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

/**
 * `settings` with exactly one copy of our hook per event in `events`, each
 * running `command`, appended last in its event.
 *
 * Stop only by default: Codex's file, whose approvals are keyed by position.
 */
export function withHook(
  settings: Json,
  command: string,
  events: readonly HookEventSpec[] = CODEX_HOOK_EVENTS,
): Json {
  const clean = withoutHook(settings);
  const hooks: Json = isObject(clean.hooks) ? { ...clean.hooks } : {};
  for (const { event, matcher } of events) {
    const groups = Array.isArray(hooks[event])
      ? (hooks[event] as unknown[])
      : [];
    hooks[event] = [
      ...groups,
      {
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: "command", command, timeout: 10 }],
      },
    ];
  }
  return { ...clean, hooks };
}

/**
 * Whether every event in `events` runs `command`, under its matcher.
 *
 * `enable` and the launch sync leave a file that already says so untouched.
 */
export function hasHookEvents(
  settings: Json,
  command: string,
  events: readonly HookEventSpec[],
): boolean {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  return events.every(({ event, matcher }) => {
    const groups = hooks[event];
    return (
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          isObject(group) &&
          ((group as HookGroup).matcher ?? undefined) === matcher &&
          Array.isArray((group as HookGroup).hooks) &&
          ((group as HookGroup).hooks as unknown[]).some(
            (entry) =>
              isOurs(entry) && (entry as HookEntry).command === command,
          ),
      )
    );
  });
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
