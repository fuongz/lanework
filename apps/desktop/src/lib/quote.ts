/**
 * A passage the next message is about: a whole message replied to, or a
 * selection mentioned. Shown in a tab above the composer, never in the
 * field, and sent as a `> ` quote ahead of what is typed.
 */
export interface Quote {
  key: string;
  kind: "reply" | "mention";
  lines: string[];
}

/** A reply quotes a message's opening; a mention, what was selected. */
const MAX_LINES = { reply: 3, mention: 8 } as const;

let quoteKeys = 0;

/** `text` as a quote, or null when it says nothing. */
export function quoteOf(text: string, kind: Quote["kind"]): Quote | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_LINES[kind]);
  return lines.length ? { key: `q${++quoteKeys}`, kind, lines } : null;
}

/** The quotes as markdown, ahead of a message; "" for none. */
export function quoteBlock(quotes: Quote[]): string {
  if (!quotes.length) return "";
  return `${quotes
    .map((quote) => quote.lines.map((line) => `> ${line}`).join("\n"))
    .join("\n\n")}\n\n`;
}

/**
 * A sent message's leading `> ` quotes, one array of lines each, and what
 * follows them: how a bubble shows what the message was about.
 */
export function splitQuotes(text: string): {
  quotes: string[][];
  rest: string;
} {
  const lines = text.split("\n");
  const quotes: string[][] = [];
  let at = 0;
  for (;;) {
    while (at < lines.length && !lines[at].trim()) at++;
    if (at >= lines.length || !lines[at].startsWith(">")) break;
    const quote: string[] = [];
    while (at < lines.length && lines[at].startsWith(">")) {
      const line = lines[at].replace(/^>\s?/, "").trim();
      if (line) quote.push(line);
      at++;
    }
    if (quote.length) quotes.push(quote);
  }
  return { quotes, rest: lines.slice(at).join("\n") };
}
