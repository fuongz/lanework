// OpenCode's side of the checkpoint hook (FE-104): a plugin file in its config
// folder, since OpenCode has no Stop hook in a settings file.
//
// NOTE: OpenCode loads every `.ts`/`.js` in `<config>/plugins/` at start, so
// the file IS the switch: written to turn it on, deleted to turn it off.
// The plugin is a few lines that hand the session id and folder to the same
// shim Claude Code and Codex run (`~/.lanew/hooks/lanework-checkpoint`), on
// `session.idle`, the moment a turn ends. The shim, not the plugin, knows
// where the app and the bundled hook are, so the plugin only changes when the
// app home does.
//
// NOTE: The plugin never blocks OpenCode and never throws into it: the shim
// is spawned detached, its stdin written and closed, and every error is
// swallowed. The hook itself logs to ~/.cache/lanework/checkpoint/hook.log.
//
// Electron-free, so a spec can drive it against a fake home.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HOOK_MARKER } from "./claude-settings";

/** The plugin's file name: our marker, so the setup view can tell it apart. */
export const OPENCODE_PLUGIN_FILE = `${HOOK_MARKER}.ts`;

/** `<config>/plugins/lanework-checkpoint.ts`. */
export function opencodePluginPath(configDir: string): string {
  return join(configDir, "plugins", OPENCODE_PLUGIN_FILE);
}

/** The first line of every plugin this app writes: how a file is known ours. */
const HEADER = "// Lanework's checkpoint hook for OpenCode (FE-104).";

/**
 * The plugin, running `shimPath` after every turn.
 *
 * NOTE: No import of `@opencode-ai/plugin`: OpenCode loads a plugin without
 * it, and a user's config folder may not have it installed. The event is read
 * both ways OpenCode has sent it (`properties` in 1.x, `data` in 2.x).
 */
export function buildOpencodePlugin(shimPath: string): string {
  return [
    HEADER,
    "// The Lanework app writes this file and rewrites or deletes it from",
    "// Settings → Agents; edits here are lost.",
    'import { spawn } from "node:child_process";',
    "",
    `const HOOK = ${JSON.stringify(shimPath)};`,
    "",
    "export const LaneworkCheckpoint = async ({ directory }: { directory?: string }) => ({",
    "  event: async ({ event }: { event: any }) => {",
    "    try {",
    '      if (event?.type !== "session.idle") return;',
    "      const sessionID = event.properties?.sessionID ?? event.data?.sessionID;",
    '      if (typeof sessionID !== "string" || !sessionID) return;',
    '      const child = spawn(HOOK, ["--agent", "opencode"], {',
    "        detached: true,",
    '        stdio: ["pipe", "ignore", "ignore"],',
    "      });",
    '      child.on("error", () => {});',
    '      child.stdin?.on("error", () => {});',
    "      child.stdin?.end(",
    "        JSON.stringify({ session_id: sessionID, cwd: directory ?? process.cwd() }),",
    "      );",
    "      child.unref();",
    "    } catch {",
    "      // Never in OpenCode's way: the hook logs its own failures.",
    "    }",
    "  },",
    "});",
    "",
  ].join("\n");
}

/** What the plugin file holds now. */
export type OpencodePluginRead =
  /** No file. */
  | { kind: "missing" }
  /** A plugin of this app's, running `shimPath`. */
  | { kind: "ours"; text: string; shimPath: string | null }
  /** A file of that name somebody else wrote: never touched. */
  | { kind: "foreign" };

export async function readOpencodePlugin(
  path: string,
): Promise<OpencodePluginRead> {
  const text = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : ""),
  );
  if (text === null) return { kind: "missing" };
  if (!text.startsWith(HEADER)) return { kind: "foreign" };
  const hook = /^const HOOK = ("(?:[^"\\]|\\.)*");$/m.exec(text)?.[1];
  let shimPath: string | null = null;
  try {
    shimPath = hook ? (JSON.parse(hook) as string) : null;
  } catch {
    shimPath = null;
  }
  return { kind: "ours", text, shimPath };
}
