// Whether Codex trusts a folder, and the user's answer written back
// (FE-101).
//
// Codex keeps it in `config.toml`, one table per folder:
//
//   [projects."/Users/me/repo"]
//   trust_level = "trusted"
//
// It looks the folder up first, then the project's root. Without an entry the
// folder is untrusted, and Codex loads nothing from its `.codex/`.
//
// NOTE: Node only, no Electron. The file is edited as text: one line changes
// or one table is added, so the user's comments and order stay.
import { join, resolve } from "node:path";
import { codexHome, readText } from "../agent-home";
import { updateConfigFile } from "../config-file";

export type CodexTrustLevel = "trusted" | "untrusted";

/** `config.toml` in Codex's home. */
export const codexConfigFor = (home?: string) =>
  join(codexHome(home), "config.toml");

/** A `[projects."<path>"]` header's path, or null for any other line. */
function projectOf(line: string): string | null {
  const table = /^\s*\[(.+)\]\s*(?:#.*)?$/.exec(line);
  if (!table) return null;
  const key = /^projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(
    (table[1] ?? "").trim(),
  );
  return key ? (key[1]?.replace(/\\(.)/g, "$1") ?? key[2] ?? null) : null;
}

const isTable = (line: string) => /^\s*\[/.test(line);
const TRUST_LINE = /^\s*trust_level\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const TRUST_VALUE = /^(\s*trust_level\s*=\s*)(?:"[^"]*"|'[^']*')/;

/** Every folder's `trust_level`, by resolved path. */
function levels(text: string | null): Map<string, CodexTrustLevel> {
  const out = new Map<string, CodexTrustLevel>();
  let project: string | null = null;
  for (const line of (text ?? "").split(/\r?\n/)) {
    if (isTable(line)) {
      project = projectOf(line);
      continue;
    }
    const match = project ? TRUST_LINE.exec(line) : null;
    const level = match ? (match[1] ?? match[2]) : null;
    if (project && (level === "trusted" || level === "untrusted"))
      out.set(resolve(project), level);
  }
  return out;
}

/**
 * Codex's trust in a folder: its own entry, and the project root's when it
 * has none.
 *
 * @param folders The folder, as given and as its real path.
 * @param root The folder's working-tree root; the folder itself outside one.
 */
export function codexTrustOf(
  text: string | null,
  folders: string[],
  root: string,
): { own: CodexTrustLevel | null; from: string | null; trusted: boolean } {
  const all = levels(text);
  const self = folders.map((folder) => resolve(folder));
  const own = self.map((folder) => all.get(folder)).find(Boolean) ?? null;
  if (own) return { own, from: null, trusted: own === "trusted" };
  const above = self.includes(resolve(root)) ? null : all.get(resolve(root));
  return {
    own: null,
    from: above === "trusted" ? resolve(root) : null,
    trusted: above === "trusted",
  };
}

/** {@link codexTrustOf}, read fresh from `config`. */
export async function readCodexTrust(
  folders: string[],
  root: string,
  config = codexConfigFor(),
) {
  return codexTrustOf(await readText(config), folders, root);
}

const quote = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * `text` with the folder's `trust_level` set to `level`.
 *
 * The line in each of the folder's tables changes, or one goes in under its
 * header. Without a table, one goes at the end, under the last of `folders`.
 * Nothing else moves.
 *
 * @param folders The folder, as given and as its real path.
 */
export function withCodexTrust(
  text: string,
  folders: string[],
  level: CodexTrustLevel,
): string {
  const lines = text.split("\n");
  const want = new Set(folders.map((folder) => resolve(folder)));
  const line = `trust_level = ${quote(level)}`;
  let found = false;
  for (let at = 0; at < lines.length; at++) {
    const project = projectOf(lines[at] ?? "");
    if (project === null || !want.has(resolve(project))) continue;
    found = true;
    let end = at + 1;
    while (end < lines.length && !isTable(lines[end] ?? "")) end++;
    const row = lines
      .slice(at + 1, end)
      .findIndex((entry) => TRUST_LINE.test(entry));
    // The value alone changes: a comment after it stays.
    if (row >= 0)
      lines[at + 1 + row] = (lines[at + 1 + row] ?? "").replace(
        TRUST_VALUE,
        `$1${quote(level)}`,
      );
    else lines.splice(at + 1, 0, line);
  }
  if (found) return lines.join("\n");
  const rest = text.replace(/\n+$/, "");
  const key = resolve(folders.at(-1) ?? "");
  return `${rest ? `${rest}\n\n` : ""}[projects.${quote(key)}]\n${line}\n`;
}

/**
 * Write the user's answer to Codex's trust question for the folder itself
 * (FE-101): `trusted`, or `untrusted` as Codex's own "No" writes it.
 *
 * NOTE: Only on the user's click. A trusted folder's `.codex/` config, hooks
 * and rules load.
 *
 * @param folders The folder, as given and as its real path.
 */
export async function setCodexTrust(
  folders: string[],
  on: boolean,
  config = codexConfigFor(),
): Promise<void> {
  await updateConfigFile(
    config,
    (text) => withCodexTrust(text ?? "", folders, on ? "trusted" : "untrusted"),
    0o600,
  );
}
