// Codex's side of the checkpoint hook: where its hooks live, whether hooks
// are switched on, and whether the user has approved ours.
//
// NOTE: `config.toml` is read here and never written (FE-29/D5, D7). Two
// things in it matter, and both are the user's to change, not ours:
//
// - `[features] hooks` is on unless the user wrote `false`. Codex made it a
//   stable feature, on by default; `codex_hooks` is its old name. Turned off,
//   Codex runs no hook at all, and the app shows the line that turns it back
//   on instead of editing a TOML file it does not own.
// - `[hooks.state."<file>:stop:<group>:<index>"] trusted_hash = …` is Codex's
//   own record that the user reviewed a hook. Writing it ourselves would
//   switch off the one safety check Codex puts in front of running code.
//
// The TOML reader is tiny: table headers and `key = value` lines, which is all
// these two questions need. Anything it cannot read counts as "not set": hooks
// on, as Codex defaults, and no approval. It never claims an approval that is
// not there.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Codex's home: `$CODEX_HOME`, as Codex reads it, or `~/.codex`. */
export function codexHome(home = homedir()): string {
  return process.env.CODEX_HOME || join(home, ".codex");
}

export const codexHooksPath = () => join(codexHome(), "hooks.json");
export const codexConfigPath = () => join(codexHome(), "config.toml");

/** The line the user adds when hooks are off (FE-29/D5). */
export const HOOKS_FEATURE_LINE = "[features]\nhooks = true";

type CodexConfig = {
  /**
   * Whether Codex runs hooks at all.
   *
   * False only for `[features] hooks = false` (or `features.hooks`, or the
   * old `codex_hooks`). Codex runs hooks by default.
   */
  hooksEnabled: boolean;
  /** Every `hooks.state` key Codex holds a `trusted_hash` for. */
  trusted: Set<string>;
};

/** Strip a TOML key's quotes: `"a:b"` → `a:b`, bare keys unchanged. */
function unquoteKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1")
    : trimmed;
}

export function parseCodexConfig(text: string): CodexConfig {
  let table = "";
  let hooksEnabled = true;
  const trusted = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1]) {
      table = header[1].trim();
      continue;
    }
    const pair = /^([^=]+?)\s*=\s*(.+)$/.exec(line);
    if (!pair?.[1] || !pair[2]) continue;
    const key = pair[1].trim();
    const value = pair[2].trim();
    if (
      (table === "features" && (key === "hooks" || key === "codex_hooks")) ||
      (table === "" &&
        (key === "features.hooks" || key === "features.codex_hooks"))
    )
      hooksEnabled = value !== "false";
    const state = /^hooks\.state\.(.+)$/.exec(table);
    if (state?.[1] && key === "trusted_hash" && value.length > 2)
      trusted.add(unquoteKey(state[1]));
  }
  return { hooksEnabled, trusted };
}

export async function readCodexConfig(): Promise<CodexConfig> {
  const text = await readFile(codexConfigPath(), "utf8").catch(() => "");
  return parseCodexConfig(text);
}

/** The key Codex files a Stop hook's approval under, for its position. */
export function trustKey(
  hooksPath: string,
  position: { group: number; index: number },
): string {
  return `${hooksPath}:stop:${position.group}:${position.index}`;
}
