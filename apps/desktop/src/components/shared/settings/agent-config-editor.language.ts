// Markdown for the config editor, drawn as a skill reads: its YAML
// frontmatter as keys and values, then headings, lists, quotes, code and
// links.
//
// NOTE: A line-by-line stream mode, not `@codemirror/lang-markdown`. A skill
// opens with frontmatter, and that grammar reads its closing `---` as a
// heading underline, so the whole block would be drawn as a title.
import { HighlightStyle, StreamLanguage } from "@codemirror/language";
import { type Tag, tags } from "@lezer/highlight";

interface State {
  /** Where the frontmatter is: not begun, open, or behind us. */
  front: "start" | "open" | "done";
  /** Inside a ``` fence. */
  fence: boolean;
  /** The rest of this line is a heading's text. */
  heading: boolean;
  /** The rest of this line is a frontmatter value. */
  value: boolean;
  /** Inside an HTML comment that has not closed yet. */
  comment: boolean;
}

const TOKENS: Record<string, Tag> = {
  mark: tags.processingInstruction,
  heading: tags.heading,
  key: tags.propertyName,
  value: tags.string,
  code: tags.monospace,
  strong: tags.strong,
  emphasis: tags.emphasis,
  link: tags.link,
  url: tags.url,
  quote: tags.quote,
  comment: tags.comment,
};

const markdown = StreamLanguage.define<State>({
  name: "markdown",
  startState: () => ({
    front: "start",
    fence: false,
    heading: false,
    value: false,
    comment: false,
  }),
  copyState: (state) => ({ ...state }),
  blankLine: (state) => {
    if (state.front === "start") state.front = "done";
  },
  tokenTable: TOKENS,
  token(stream, state) {
    if (stream.sol()) {
      state.heading = false;
      state.value = false;
    }

    if (state.front !== "done") {
      if (stream.sol() && stream.match(/^---\s*$/)) {
        state.front = state.front === "start" ? "open" : "done";
        return "mark";
      }
      if (state.front === "start") state.front = "done";
      else {
        if (state.value) {
          stream.skipToEnd();
          return "value";
        }
        if (stream.sol() && stream.match(/^[\w.-]+(?=\s*:)/)) return "key";
        if (stream.match(/^\s*:\s*/)) {
          state.value = true;
          return "mark";
        }
        stream.skipToEnd();
        return "value";
      }
    }

    if (stream.sol() && stream.match(/^\s*(```|~~~)/)) {
      state.fence = !state.fence;
      stream.skipToEnd();
      return "mark";
    }
    if (state.fence) {
      stream.skipToEnd();
      return "code";
    }

    if (state.heading) {
      stream.skipToEnd();
      return "heading";
    }
    if (stream.sol()) {
      if (stream.match(/^#{1,6}(?=\s)/)) {
        state.heading = true;
        return "mark";
      }
      if (stream.match(/^\s*>\s?/)) return "quote";
      if (stream.match(/^\s*(?:[-*+]|\d+[.)])(?=\s)/)) return "mark";
    }

    // An HTML comment, as a template's hints are: up to its close, which may
    // be lines away.
    if (state.comment || stream.match("<!--")) {
      state.comment = true;
      while (!stream.eol()) {
        if (stream.match("-->")) {
          state.comment = false;
          break;
        }
        stream.next();
      }
      return "comment";
    }
    if (stream.match(/^`[^`]*`/)) return "code";
    if (stream.match(/^(\*\*|__)(?=\S)(.+?)\1/)) return "strong";
    if (stream.match(/^(\*|_)(?=\S)([^*_]+?)\1/)) return "emphasis";
    if (stream.match(/^\[[^\]]*\](?=\()/)) return "link";
    if (stream.match(/^\([^)\s]*\)/)) return "url";
    if (stream.match(/^<https?:\/\/[^>]+>/)) return "url";
    if (stream.match("|")) return "mark";

    stream.next();
    // Plain text up to the next character that may start a span.
    stream.eatWhile(/[^`*_[(<|]/);
    return null;
  },
});

export function markdownLanguage() {
  return markdown;
}

/**
 * Markup in the muted colour, headings and bold weighted, keys and links in
 * the brand colour, code in the destructive one: the palette has no other
 * hues, and code wants to stand apart from links.
 */
export const MARKDOWN_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.processingInstruction, color: "var(--muted-foreground)" },
  { tag: tags.heading, color: "var(--foreground)", fontWeight: "700" },
  { tag: tags.propertyName, color: "var(--accent-brand)" },
  { tag: tags.string, color: "var(--foreground)" },
  {
    tag: tags.monospace,
    color: "color-mix(in oklab, var(--destructive) 85%, var(--foreground))",
  },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--accent-brand)" },
  { tag: tags.url, color: "var(--muted-foreground)" },
  { tag: tags.quote, color: "var(--muted-foreground)", fontStyle: "italic" },
  // HTML comments: notes for the writer, such as a template's hints.
  { tag: tags.comment, color: "var(--muted-foreground)" },
]);
