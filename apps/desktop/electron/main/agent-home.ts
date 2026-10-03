// Where Claude Code and Codex keep their own configuration on this machine,
// named once for everything that reads it: readiness (FE-30) and the agent
// setup view (FE-40).
//
// ⚠️ Node only — no Electron — so a spec can point every path at a fake
// home. The dev-build test seam (`LANEWORK_TEST_AGENT_HOME`) needs
// `app.isPackaged`, so applying it is the caller's job: pass its home in.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexHome } from "./handoff/codex";

/** Claude Code's own home: `$CLAUDE_CONFIG_DIR`, as it reads it, or `~/.claude`. */
export const claudeDir = (home = homedir()) =>
  process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");

/**
 * `~/.claude.json`, where `claude mcp add` files the user and local scopes —
 * inside `$CLAUDE_CONFIG_DIR` when that is set.
 */
export const claudeJsonPath = (home = homedir()) =>
  process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(home, ".claude.json");

/** Every place the two CLIs read from, resolved for one home folder. */
export interface AgentHome {
  /** The user's home: Codex's `~/.agents`, and `~` in what is shown. */
  home: string;
  claudeDir: string;
  claudeJson: string;
  codexDir: string;
}

export function agentHome(home = homedir()): AgentHome {
  return {
    home,
    claudeDir: claudeDir(home),
    claudeJson: claudeJsonPath(home),
    codexDir: codexHome(home),
  };
}

/** Notes and configs are small; anything bigger is not one. */
export const CONFIG_MAX_BYTES = 512 * 1024;

/** A small text file, or null: missing, not a file, or too big to be one. */
export async function readText(
  path: string,
  max = CONFIG_MAX_BYTES,
): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > max) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
