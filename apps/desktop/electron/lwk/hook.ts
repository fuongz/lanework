// `lwk hook on|off|status` (FE-152): the rewrite hook (`lwk rewrite`, native:
// `apps/desktop/lwk/src/rewrite.rs`) in Claude Code's user settings,
// `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`). Off
// until the user turns it on. Run by the JS kit (`cli.ts`).
//
// - On: one `PreToolUse` group, matcher `Bash`, running
//   `<app home>/bin/lwk rewrite`, appended after the user's own groups.
//   Already there: the file is left alone.
// - Off: every handler whose command is an `lwk rewrite` is removed, and a
//   group or event left empty by that goes with it. Nothing else changes.
// - A settings file that is not a JSON object is refused, never repaired;
//   the write goes through `../main/config-file.ts` (atomic, mode and
//   symlink kept, never over a change Claude Code made since the read), as
//   the checkpoint hook's does (`../main/handoff/claude-settings.ts`).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { updateConfigFile } from "../main/config-file";
import {
  claudeSettingsPath,
  parseSettings,
  readSettings,
  shellQuote,
} from "../main/handoff/claude-settings";
import { appHomeDir } from "../main/paths";

type Json = Record<string, unknown>;

/** How long Claude Code waits for the hook, in seconds. */
const HOOK_TIMEOUT = 5;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a hook handler is ours: its command runs `lwk rewrite`. */
export function isRewriteHook(entry: unknown): boolean {
  return (
    isObject(entry) &&
    typeof entry.command === "string" &&
    // `lwk`, or a build's `lwk-<arch>` when nothing is installed yet.
    /(^|\/)lwk(-[a-z0-9]+)?'? rewrite$/.test(entry.command)
  );
}

/**
 * The command the hook runs: the installed lwk, else the lwk that ran this
 * script (`LWK_SELF`, set by the native lwk; `process.execPath` here is the
 * app's Node).
 */
export function rewriteHookCommand(): string {
  const installed = join(appHomeDir(), "bin", "lwk");
  const lwk = existsSync(installed)
    ? installed
    : (process.env.LWK_SELF ?? process.execPath);
  return `${shellQuote(lwk)} rewrite`;
}

/** Whether `settings` run our hook on Bash's PreToolUse. */
export function hasRewriteHook(settings: Json): boolean {
  const groups = isObject(settings.hooks)
    ? settings.hooks.PreToolUse
    : undefined;
  return (
    Array.isArray(groups) &&
    groups.some(
      (group) =>
        isObject(group) &&
        group.matcher === "Bash" &&
        Array.isArray(group.hooks) &&
        group.hooks.some(isRewriteHook),
    )
  );
}

/** `settings` without any `lwk rewrite` handler, empty shells dropped. */
export function withoutRewriteHook(settings: Json): Json {
  if (!isObject(settings.hooks)) return settings;
  const groups = settings.hooks.PreToolUse;
  if (!Array.isArray(groups)) return settings;
  const kept = groups.flatMap((group: unknown) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
    if (!group.hooks.some(isRewriteHook)) return [group];
    const entries = group.hooks.filter((entry) => !isRewriteHook(entry));
    return entries.length ? [{ ...group, hooks: entries }] : [];
  });
  // Every key keeps its place; an emptied PreToolUse, then hooks, goes.
  const hooks: Json = {};
  for (const [event, value] of Object.entries(settings.hooks))
    if (event !== "PreToolUse") hooks[event] = value;
    else if (kept.length) hooks[event] = kept;
  if (Object.keys(hooks).length) return { ...settings, hooks };
  const { hooks: _, ...rest } = settings;
  return rest;
}

/** `settings` with our hook last in Bash's PreToolUse. */
export function withRewriteHook(settings: Json, command: string): Json {
  const clean = withoutRewriteHook(settings);
  const hooks: Json = isObject(clean.hooks) ? { ...clean.hooks } : {};
  const groups = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  hooks.PreToolUse = [
    ...groups,
    {
      matcher: "Bash",
      hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT }],
    },
  ];
  return { ...clean, hooks };
}

/** Change the settings file; null from `change` leaves it alone. */
function update(change: (settings: Json) => Json | null): Promise<boolean> {
  return updateConfigFile(claudeSettingsPath(), (text) => {
    const read = parseSettings(text);
    if (!read.ok)
      throw new Error(
        `${claudeSettingsPath()} is not a JSON object; fix it first. Nothing was changed.`,
      );
    const next = change(read.settings);
    return next ? `${JSON.stringify(next, null, 2)}\n` : null;
  });
}

/**
 * Run `lwk hook on|off|status`.
 *
 * @returns The exit code: 0, or 2 for a bad argument or an unreadable file.
 */
export async function runHookCommand(args: string[]): Promise<number> {
  const [action, ...extra] = args;
  const path = claudeSettingsPath();
  try {
    if (extra.length > 0) throw new Error("Usage: lwk hook on|off|status");
    if (action === "status" || action === undefined) {
      const read = await readSettings(path);
      if (!read.ok) throw new Error(`${path} is not a JSON object.`);
      process.stdout.write(
        `${hasRewriteHook(read.settings) ? "on" : "off"}  ${path}\n`,
      );
      return 0;
    }
    if (action === "on") {
      const command = rewriteHookCommand();
      const wrote = await update((settings) =>
        hasRewriteHook(settings) ? null : withRewriteHook(settings, command),
      );
      process.stdout.write(
        `${wrote ? "Turned on" : "Already on"}: plain recursive grep runs as lwk grep in Claude Code (${path}).\n`,
      );
      return 0;
    }
    if (action === "off") {
      const wrote = await update((settings) => {
        const next = withoutRewriteHook(settings);
        return JSON.stringify(next) === JSON.stringify(settings) ? null : next;
      });
      process.stdout.write(
        `${wrote ? "Turned off" : "Already off"} (${path}).\n`,
      );
      return 0;
    }
    throw new Error("Usage: lwk hook on|off|status");
  } catch (error) {
    process.stderr.write(
      `lwk hook: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}
