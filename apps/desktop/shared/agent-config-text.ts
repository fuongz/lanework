// The text of an agent config file (FE-47): whether it still parses, and the
// one-line edits behind the quick settings (D6). Shared so main checks a write
// with the same rules the editor shows as you type.
import { parse as parseToml, TomlError } from "smol-toml";
import type { ConfigFormat } from "./agent-config";

// ── Syntax ─────────────────────────────────────────────────────────────────

/**
 * Why `text` would not load, or null when it would. Main checks it again
 * before every write; the editor checks it as you type (D4).
 */
export function syntaxError(format: ConfigFormat, text: string): string | null {
  if (format === "markdown") return null;
  if (format === "json") {
    // An empty settings file is one Claude reads as `{}`.
    if (!text.trim()) return null;
    try {
      JSON.parse(text);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Not valid JSON.";
    }
  }
  try {
    parseToml(text);
    return null;
  } catch (error) {
    if (error instanceof TomlError)
      return `Line ${error.line}, column ${error.column}: ${firstLine(error.message)}`;
    return error instanceof Error ? error.message : "Not valid TOML.";
  }
}

const firstLine = (message: string) => message.split("\n")[0] ?? message;

// ── Quick settings (FE-47/D6) ──────────────────────────────────────────────
//
// ⚠️ Each one changes ONE line of the text in the editor and leaves every
// other byte — comments, order, blank lines — as it was. The result goes
// through the same Save as a hand edit.

/** Codex flags worth a switch even before the file names them. */
export const CODEX_KNOWN_FEATURES: {
  key: string;
  on: boolean;
  hint: string;
}[] = [
  {
    key: "hooks",
    on: true,
    hint: "Run hooks from hooks.json — the Lanework checkpoint needs it.",
  },
  {
    key: "api_key_model_discovery",
    on: true,
    hint: "List models through an API key. Turn off when the ChatGPT app's background server disagrees.",
  },
];

const TABLE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const keyLine = (key: string) =>
  new RegExp(`^(\\s*${escapeRegex(key)}\\s*=\\s*)([^#\\n]*?)(\\s*#.*)?$`);
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every `key = true|false` in the `[features]` table, as the file sets it. */
export function codexFeatures(text: string): Record<string, boolean> {
  const found: Record<string, boolean> = {};
  let table: string | null = null;
  for (const line of text.split("\n")) {
    const header = TABLE.exec(line);
    if (header) {
      table = header[1] ?? null;
      continue;
    }
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(true|false)\s*(#.*)?$/.exec(
      line,
    );
    if (match?.[1] && table === "features")
      found[match[1]] = match[2] === "true";
    const dotted =
      /^\s*features\.([A-Za-z0-9_-]+)\s*=\s*(true|false)\s*(#.*)?$/.exec(line);
    if (dotted?.[1] && table === null) found[dotted[1]] = dotted[2] === "true";
  }
  return found;
}

/**
 * `text` with `[features] key = on`: the line that sets it rewritten in
 * place, else a line added at the end of `[features]`, else the table added
 * at the end of the file.
 */
export function withCodexFeature(text: string, key: string, on: boolean) {
  const value = on ? "true" : "false";
  const lines = text.split("\n");
  let table: string | null = null;
  let tableAt = -1;
  let lastInTable = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const header = TABLE.exec(line);
    if (header) {
      table = header[1] ?? null;
      if (table === "features") tableAt = lastInTable = index;
      continue;
    }
    const own =
      table === "features"
        ? keyLine(key).exec(line)
        : table === null
          ? keyLine(`features.${key}`).exec(line)
          : null;
    if (own) {
      lines[index] = `${own[1]}${value}${own[3] ?? ""}`;
      return lines.join("\n");
    }
    if (table === "features" && line.trim()) lastInTable = index;
  }
  if (tableAt >= 0) {
    lines.splice(lastInTable + 1, 0, `${key} = ${value}`);
    return lines.join("\n");
  }
  const tail = text.length && !text.endsWith("\n") ? "\n" : "";
  const gap = text.trim() ? "\n" : "";
  return `${text}${tail}${gap}[features]\n${key} = ${value}\n`;
}

/** Claude's `permissions.defaultMode` values, as its settings docs list them. */
export const CLAUDE_DEFAULT_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

export function claudeDefaultMode(text: string): string | null {
  try {
    const settings = JSON.parse(text) as unknown;
    if (!settings || typeof settings !== "object") return null;
    const permissions = (settings as { permissions?: unknown }).permissions;
    if (!permissions || typeof permissions !== "object") return null;
    const mode = (permissions as { defaultMode?: unknown }).defaultMode;
    return typeof mode === "string" ? mode : null;
  } catch {
    return null;
  }
}

/**
 * `text` with `permissions.defaultMode` set to `mode` — or removed, for
 * null. The `"defaultMode": "…"` line is rewritten in place when there is
 * exactly one; otherwise the file is re-serialized with two-space indents,
 * the way Claude writes it. Null when `text` is not a JSON object.
 */
export function withClaudeDefaultMode(
  text: string,
  mode: string | null,
): string | null {
  let settings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text.trim() ? text : "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    settings = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const pattern = /("defaultMode"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
  const hits = text.match(pattern) ?? [];
  if (mode !== null && hits.length === 1 && claudeDefaultMode(text) !== null)
    return text.replace(pattern, `$1${JSON.stringify(mode)}`);
  const permissions =
    settings.permissions &&
    typeof settings.permissions === "object" &&
    !Array.isArray(settings.permissions)
      ? { ...(settings.permissions as Record<string, unknown>) }
      : {};
  if (mode === null) delete permissions.defaultMode;
  else permissions.defaultMode = mode;
  const next: Record<string, unknown> = { ...settings, permissions };
  if (!Object.keys(permissions).length) delete next.permissions;
  return `${JSON.stringify(next, null, 2)}\n`;
}
