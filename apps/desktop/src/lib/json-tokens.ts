// JSON, cut into tokens a tool call's panel can colour: keys, strings,
// numbers, literals and punctuation. A reading, never a parse: text that is
// not JSON still comes back whole (as `plain` runs), so a cut-off output or
// a half-streamed input shows as it is, never throws. A string cut off at
// the end of the text (an input cut at its cap) is still a string.
//
// NOTE: Hand-rolled rather than Shiki: a chat may hold hundreds of calls, a
// panel opens on a click, and this costs one pass over the text.

export type JsonTokenKind =
  | "key"
  | "string"
  | "number"
  | "literal"
  | "punctuation"
  | "plain";

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
}

const TOKEN =
  /("(?:[^"\\\n]|\\.)*(?:"|$))(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

/** `text`'s tokens, in order; joined, they are `text` again. */
export function jsonTokens(text: string): JsonToken[] {
  const out: JsonToken[] = [];
  let at = 0;
  const push = (kind: JsonTokenKind, part: string) => {
    if (!part) return;
    const last = out.at(-1);
    if (last && last.kind === kind) last.text += part;
    else out.push({ kind, text: part });
  };
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    push("plain", text.slice(at, index));
    const [whole, string, colon, number, literal, punctuation] = match;
    if (string !== undefined) {
      push(colon ? "key" : "string", string);
      if (colon) push("punctuation", colon);
    } else if (number !== undefined) push("number", number);
    else if (literal !== undefined) push("literal", literal);
    else if (punctuation !== undefined) push("punctuation", punctuation);
    else push("plain", whole);
    at = index + whole.length;
  }
  push("plain", text.slice(at));
  return out;
}

/**
 * `text` pretty-printed when it is a JSON object or array, else null.
 *
 * A tool's output is often one compact line (`{"notesLength":114}`); a cut
 * or non-JSON one stays as it was.
 */
export function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}
