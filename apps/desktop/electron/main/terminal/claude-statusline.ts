import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appHomeDir } from "../paths";
import { CLAUDE_USAGE_FILE } from "./claude-usage";

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/** Unknown/broken settings are left to Claude rather than silently overridden. */
export function claudeStatuslineArgs(
  cwd: string,
  options: {
    home?: string;
    config?: string;
    bridge?: string;
    executable?: string;
    cache?: string;
    managed?: string[];
  } = {},
): string {
  if (process.platform === "win32") return "";
  // Source-only Node consumers have no packaged statusLine entry.
  if (!options.bridge && typeof __dirname === "undefined") return "";
  const home = options.home ?? homedir();
  const config =
    options.config ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const bridge =
    options.bridge ?? join(__dirname, "../statusline/claude-usage.cjs");
  if (!existsSync(bridge)) return "";
  const managed = options.managed ?? [
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/etc/claude-code/managed-settings.json",
    join(config, "managed-settings.json"),
    join(config, "remote-settings.json"),
  ];
  // Managed policy can replace the wrapper and its command. Do not compose
  // a guessed policy or change files; the CLI enforces other managed sources.
  if (managed.some(existsSync)) return "";
  try {
    if (
      readdirSync(config).some((name) =>
        /^(managed|remote).*settings/.test(name),
      )
    )
      return "";
  } catch {
    /* Missing user config is normal. */
  }
  let root = cwd;
  while (!existsSync(join(root, ".git")) && dirname(root) !== root)
    root = dirname(root);
  if (!existsSync(join(root, ".git"))) root = cwd;
  const files = [
    join(config, "settings.json"),
    join(root, ".claude/settings.json"),
    join(root, ".claude/settings.local.json"),
  ];
  let status: Record<string, unknown> = {};
  try {
    for (const file of files) {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      if (text.length > 1024 * 1024) return "";
      const settings = JSON.parse(text);
      if (!settings || typeof settings !== "object" || Array.isArray(settings))
        return "";
      if ("statusLine" in settings) {
        const line = settings.statusLine;
        if (
          !line ||
          typeof line !== "object" ||
          Array.isArray(line) ||
          line.type !== "command" ||
          typeof line.command !== "string"
        )
          return "";
        status = { ...status, ...line };
      }
    }
  } catch {
    return "";
  }
  const command = `ELECTRON_RUN_AS_NODE=1 ${quote(options.executable ?? process.execPath)} ${quote(bridge)} ${quote(options.cache ?? join(appHomeDir(), CLAUDE_USAGE_FILE))} ${quote(typeof status.command === "string" ? status.command : "")}`;
  return ` --settings ${quote(JSON.stringify({ statusLine: { ...status, type: "command", command } }))}`;
}
