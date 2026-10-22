import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

/**
 * A markdown editor that edits the text itself, built on CodeMirror.
 *
 * - NOTE: CodeMirror, not a rich-text editor. A card's body is markdown that
 *   agents write through the MCP server. A WYSIWYG editor parses to a
 *   document model and re-serializes, renormalizing list markers, escapes and
 *   blank lines, so changing one word in a card an agent wrote would rewrite
 *   the whole body. This edits the text buffer: what goes in comes out.
 * - Not `basicSetup`: line numbers, a fold gutter, an active-line highlight
 *   and bracket matching are a code editor's furniture. Prose needs wrapping,
 *   history, list continuation and the markdown grammar.
 * - Fenced code blocks are highlighted as markdown, not by nested language.
 *   `@codemirror/language-data` would pull every grammar it knows into the
 *   bundle for bodies that are prose with the occasional snippet.
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
  /** On ⌘↵, bound here because the editor would otherwise eat it. */
  onSubmit?: () => void;
  /** On Escape, bound here for the same reason. */
  onCancel?: () => void;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // NOTE: Every prop the build effect reads lives in this ref, and the editor
  // is built once. As dependencies they would rebuild the editor on each
  // keystroke (`value` changes every time), dropping undo history and cursor.
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
          // NOTE: Highest precedence. The default keymap binds Mod-Enter to
          // `insertBlankLine` and Escape to `simplifySelection`, so a
          // composer's ⌘↵ save and Escape exit would be swallowed by the
          // field a person is most likely to be in.
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

  // NOTE: Compared against the editor's own document before dispatching.
  // Without that guard every keystroke echoes back through this effect, resets
  // the document to the same text and puts the cursor at the start.
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
 * The compartment that toggles read-only without rebuilding the editor.
 *
 * Going offline mid-sentence must not cost somebody their undo history. One
 * instance for the module is correct: a compartment is a key, and each editor
 * resolves it against its own configuration.
 */
const READ_ONLY = new Compartment();

/** The editor's look, in the app's own type rather than a code editor's. */
const THEME = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  // No focus ring, like the title field beside it: these two are the panel,
  // and a box drawn around one reads as a form on a surface meant to read as
  // a document.
  "&.cm-focused": { outline: "none" },
  // The content font: what is written here is what `MarkdownBody` shows once
  // saved, and should not change face on the way.
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
 * Markdown highlighting while it is being written.
 *
 * Weight and colour only; the syntax characters stay on screen. An editor
 * that hid the `##` would be a WYSIWYG editor with extra steps, and the person
 * writing a card has to see the markup they are about to save.
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
