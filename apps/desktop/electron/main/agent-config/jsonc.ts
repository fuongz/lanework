// Whether OpenCode's config still parses before a write (FE-105/D1).
//
// NOTE: JSONC, not JSON: comments and trailing commas are OpenCode's own
// syntax, so they pass. The text is only checked, never re-serialized: what
// the user typed is what is written, comments included.
//
// NOTE: The editor runs the same check as you type, in
// `agent-config-editor.tsx`; keep the two in step.
//
// Node only, no Electron.
import {
  type ParseError,
  parse,
  printParseErrorCode,
} from "jsonc-parser/lib/esm/main.js";

/** `CommaExpected` as a person reads it: `Comma expected`. */
function readable(code: string): string {
  const words = code.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Why `text` would not load as OpenCode's config, or null when it would.
 *
 * Blank is fine: OpenCode reads a missing or empty config as `{}`.
 */
export function jsoncSyntaxError(text: string): string | null {
  if (!text.trim()) return null;
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const first = errors[0];
  if (first) {
    const before = text.slice(0, first.offset).split("\n");
    const line = before.length;
    const column = (before[before.length - 1]?.length ?? 0) + 1;
    return `Line ${line}, column ${column}: ${readable(printParseErrorCode(first.error))}`;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "OpenCode's config must be one JSON object.";
  return null;
}
