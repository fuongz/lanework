import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

/**
 * Markdown, edited as markdown.
 *
 * ⚠️ CodeMirror over a rich-text editor, and the reason is the file rather than
 * the typing. A card's body is committed markdown — it lands in
 * `.agents/reviews/*.md`, agents write it through the MCP server, and people
 * read it in a diff. Every WYSIWYG editor parses to a document model and
 * re-serializes on the way out, which renormalizes list markers, escapes and
 * blank lines; changing one word in a card an agent wrote would produce a
 * forty-line diff. This edits the text buffer, so what goes in comes out.
 *
 * ⚠️ Not `basicSetup`. That bundle brings line numbers, a fold gutter, a
 * highlighted active line and bracket matching — a code editor's furniture on a
 * surface for prose. What is here is what prose actually needs: wrapping,
 * history, list continuation and the markdown grammar.
 *
 * ⚠️ Fenced code blocks are highlighted as markdown, NOT by nested language.
 * `@codemirror/language-data` would add that and pull every grammar it knows
 * into the bundle; the card bodies this edits are prose with the occasional
 * snippet, and a megabyte of grammars is not what makes them readable.
 */
export function MarkdownEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  label,
  placeholder: hint,
  readOnly = false,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  /** ⌘↵ — bound here because the editor would otherwise eat it. */
  onSubmit?: () => void;
  /** Escape — same reason. */
  onCancel?: () => void;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // ⚠️ EVERY prop the build effect reads lives in this ref, and the editor is
  // built ONCE. Listing them as dependencies instead would rebuild the whole
  // editor on each keystroke — `value` changes every one — and rebuilding drops
  // the undo history and the cursor with it.
  const latest = useRef({ value, readOnly, onChange, onSubmit, onCancel });
  latest.current = { value, readOnly, onChange, onSubmit, onCancel };

  useEffect(() => {
    if (!host.current) return;

    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          history(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(HIGHLIGHT),
          placeholder(hint ?? ""),
          READ_ONLY.of(EditorState.readOnly.of(latest.current.readOnly)),
          THEME,
          EditorView.contentAttributes.of({ "aria-label": label }),
          // ⚠️ HIGHEST precedence, and both bindings are load-bearing. The
          // default keymap binds Mod-Enter to `insertBlankLine` and Escape to
          // `simplifySelection`, so a composer whose Save is ⌘↵ and whose way
          // out is Escape would find both swallowed by the field a person is
          // most likely to be in when they use them.
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  latest.current.onSubmit?.();
                  return true;
                },
              },
              {
                key: "Escape",
                run: () => {
                  latest.current.onCancel?.();
                  return true;
                },
              },
            ]),
          ),
          // `markdownKeymap` first: Enter continues the list you are in, and
          // Backspace at the head of a bullet removes the bullet rather than
          // the newline before it.
          keymap.of([...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Built once. `value` is synced by the effect below, never by a rebuild.
  }, [label, hint]);

  // ⚠️ Compared against the editor's OWN document before dispatching. Without
  // that guard every keystroke would echo back through this effect, reset the
  // document to the same text and put the cursor at the start of the line.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: READ_ONLY.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  return <div ref={host} className={className} data-slot="markdown-editor" />;
}

/**
 * ⚠️ A compartment, so read-only can be toggled without rebuilding the editor.
 * Going offline mid-sentence must not cost somebody their undo history. One
 * instance for the module is correct: a compartment is a key, and each editor
 * resolves it against its own configuration.
 */
const READ_ONLY = new Compartment();

/** The app's own type, not a code editor's. */
const THEME = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  // ⚠️ The ring is dropped, like the title field beside it. These two ARE the
  // panel, and a box drawn around one on focus reads as a form on a surface
  // meant to read as a document.
  "&.cm-focused": { outline: "none" },
  // The content font (FE-21): what is written here is what `MarkdownBody`
  // shows once saved, and should not change face on the way.
  ".cm-scroller": {
    fontFamily: "var(--content-font)",
    fontWeight: "var(--content-font-weight)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": { padding: "0 6px", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  "&.cm-editor .cm-selectionBackground, ::selection": {
    backgroundColor:
      "color-mix(in oklab, var(--accent-brand) 28%, transparent)",
  },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
});

/**
 * Markdown seen while it is being written.
 *
 * ⚠️ Weight and colour only — the syntax characters stay on screen. An editor
 * that hid the `##` would be a WYSIWYG editor with extra steps, and the person
 * writing a card has to be able to see the markup they are about to commit.
 */
const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--accent-brand)" },
  { tag: tags.url, color: "var(--muted-foreground)" },
  { tag: tags.monospace, fontFamily: "var(--code-font)" },
  { tag: tags.processingInstruction, color: "var(--muted-foreground)" },
  { tag: tags.quote, color: "var(--muted-foreground)" },
]);
