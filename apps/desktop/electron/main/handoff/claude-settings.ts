// Reading and rewriting Claude Code's user settings to add or remove OUR Stop
// hook (FE-28), and nothing else.
//
// ⚠️ `~/.claude/settings.json` belongs to the user and to Claude Code. Every
// rule below exists so that turning our switch on and off leaves that file
// exactly as it was apart from our one entry:
//
//   • Our entry is recognised by the hook's filename in its command, and only
//     that entry is ever replaced or removed — other Stop hooks, other events
//     and every other key are passed through untouched.
//   • A file that exists but is not a JSON object is REFUSED, not "repaired":
//     the user may be halfway through editing it, and overwriting it would
//     destroy their work to install ours.
//   • The write is atomic (temp file + rename), so a crash mid-write cannot
//     leave Claude Code with half a settings file.
//
// Pure apart from `readSettings` / `writeSettings`, and free of Electron, so
// the merge rules are tested directly (tests/handoff-settings.spec.ts).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Present in our hook's command, and in no one else's. */
export const HOOK_MARKER = "lanework-checkpoint";

/** Claude Code's own override for `~/.claude`, which tests also use. */
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
 * The command Claude Code runs after every turn.
 *
 * ⚠️ `ELECTRON_RUN_AS_NODE=1` turns the app binary into a plain Node (FE-28/D5)
 * — the people this is for have no bun and may have no node. The hook passes
 * the variable on to the worker it detaches, or that would boot as an app.
 */
export function buildHookCommand(options: {
  execPath: string;
  hookPath: string;
  apiUrl: string;
  pushWip: boolean;
  secretFile?: string | null;
}): string {
  return [
    "ELECTRON_RUN_AS_NODE=1",
    ...(options.secretFile
      ? [`LANEWORK_HOOK_SECRET_FILE=${shellQuote(options.secretFile)}`]
      : []),
    shellQuote(options.execPath),
    shellQuote(options.hookPath),
    "--api",
    shellQuote(options.apiUrl),
    ...(options.pushWip ? ["--push-wip"] : []),
  ].join(" ");
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

/** `settings` with every copy of our hook taken out, empty shells dropped. */
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

export type SettingsRead =
  | { ok: true; settings: Json }
  | { ok: false; reason: "unreadable" };

/** A missing file is empty settings; anything else must be a JSON object. */
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

export async function writeSettings(
  settings: Json,
  path = claudeSettingsPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.lanework-${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
