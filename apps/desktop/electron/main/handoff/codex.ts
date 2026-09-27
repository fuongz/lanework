// Codex's side of the checkpoint hook (FE-29): where its hooks live, whether
// hooks are switched on, and whether the user has approved ours.
//
// ⚠️ `config.toml` is READ here and never written (FE-29/D5, D7). Two things
// in it matter and both are the user's to change, not ours:
//
//   • `[features] hooks = true` — without it Codex runs no hook at all. The
//     app shows the line to add rather than editing a TOML file it does not
//     own.
//   • `[hooks.state."<file>:stop:<group>:<index>"] trusted_hash = …` — Codex's
//     own record that the user reviewed a hook. Writing it ourselves would
//     switch off the one safety check Codex puts in front of running code.
//
// The TOML reader is deliberately tiny: table headers and `key = value` lines,
// which is all these two questions need. Anything it cannot read counts as
// "not set", which only ever makes the app show an instruction it did not
// need to — never claim an approval that is not there.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Codex's home — `$CODEX_HOME`, as Codex itself reads it, or `~/.codex`. */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export const codexHooksPath = () => join(codexHome(), "hooks.json");
export const codexConfigPath = () => join(codexHome(), "config.toml");

/** The line the user adds when hooks are off (FE-29/D5). */
export const HOOKS_FEATURE_LINE = "[features]\nhooks = true";

export type CodexConfig = {
  /** `[features] hooks = true` (or `features.hooks = true`). */
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
  let hooksEnabled = false;
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
      (table === "features" && key === "hooks") ||
      (table === "" && key === "features.hooks")
    )
      hooksEnabled = value === "true";
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

/** The key Codex files the approval of the Stop hook at this position under. */
export function trustKey(
  hooksPath: string,
  position: { group: number; index: number },
): string {
  return `${hooksPath}:stop:${position.group}:${position.index}`;
}
