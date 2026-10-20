import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import {
  HighlightStyle,
  StreamLanguage,
  type StreamParser,
  syntaxHighlighting,
} from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import {
  Alert02Icon,
  FolderOpenIcon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { tags } from "@lezer/highlight";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConfigFile,
  ConfigFileContent,
  ConfigFormat,
} from "#/../shared/agent-config";
import {
  CLAUDE_DEFAULT_MODES,
  CODEX_KNOWN_FEATURES,
  claudeDefaultMode,
  codexFeatures,
  syntaxError,
  withClaudeDefaultMode,
  withCodexFeature,
} from "#/../shared/agent-config-text";
import { FileBrowserPath } from "#/components/shared/settings/file-browser";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Switch } from "#/components/ui/switch";
import { ipcMessage } from "#/lib/ipc-error";

const AGENT_NAMES = { claude: "Claude Code", codex: "Codex" } as const;

/**
 * The open file of Settings → Config files (FE-47/D8): its name and path,
 * Save, Revert and Reveal in Finder above it, the quick settings (D6), the
 * text in a code editor, and whatever went wrong below.
 *
 * ⚠️ The text is held here only while the file is open — never put in a
 * store, never logged — because it may hold tokens (D3).
 *
 * ⚠️ Save sends back the hash the file was read at. Main refuses the write
 * when the file changed on disk since — an agent rewrote it, or another
 * editor did — and this offers Reload rather than overwriting (D4).
 */
export function AgentConfigPane({
  file,
  onSaved,
  onDirtyChange,
}: {
  file: ConfigFile;
  /** After a Save lands, so the tree shows the new size and time. */
  onSaved: () => void;
  /** Whether there are edits not saved yet — asked before closing the file. */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [base, setBase] = useState<ConfigFileContent | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = file.id;

  async function load() {
    const surface = window.desktop?.agentConfig;
    if (!surface) return;
    setError(null);
    setConflict(false);
    setSaved(null);
    try {
      const content = await surface.read(id);
      setBase(content);
      setText(content.text);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not open that file."));
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per file opened
  useEffect(() => {
    setBase(null);
    setText("");
    void load();
  }, [id]);

  const format = file.format;
  const problem = useMemo(() => syntaxError(format, text), [format, text]);
  const dirty = !!base && text !== base.text;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  async function save() {
    const surface = window.desktop?.agentConfig;
    if (!base || !surface || problem || !dirty) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await surface.write(id, text, base.hash);
      if (result.status === "conflict") setConflict(true);
      else if (result.status === "invalid") setError(result.error);
      else {
        setBase(result.content);
        setText(result.content.text);
        setSaved(
          result.backup
            ? `Saved. The previous version is at ${result.backup}.`
            : "Saved.",
        );
        onSaved();
      }
    } catch (failure) {
      setError(ipcMessage(failure, "Could not save that file."));
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    try {
      await window.desktop?.agentConfig.reveal(id);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not show that file in Finder."));
    }
  }

  const title =
    file.kind === "skill"
      ? `${file.label} — ${AGENT_NAMES[file.agent]} skill`
      : `${file.label} — ${AGENT_NAMES[file.agent]}`;

  return (
    <section
      aria-label={title}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    >
      <FileBrowserPath
        path={file.path}
        note={file.exists ? undefined : "not created yet; Save creates it"}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reveal in Finder"
          title="Reveal in Finder"
          onClick={() => void reveal()}
        >
          <HugeiconsIcon
            icon={FolderOpenIcon}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!dirty || busy}
          onClick={() => base && setText(base.text)}
        >
          Revert
        </Button>
        <Button
          size="sm"
          disabled={!dirty || !!problem || busy || conflict}
          onClick={() => void save()}
        >
          Save
        </Button>
      </FileBrowserPath>

      {/* What sits above the text: the file's line, the hook note, the quick
          settings. Skills have none of these, and get the editor alone. */}
      {file.kind === "config" && (
        <div className="border-border flex shrink-0 flex-col gap-3 border-b p-4">
          <p className="text-muted-foreground text-xs">{file.description}</p>
          {base?.laneworkHook && (
            <Alert>
              <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={1.8} />
              <AlertDescription>
                Lanework's checkpoint hook is in this file, and the app writes
                it again each time it starts. To turn it off, use the switch in
                Settings › Harness rather than deleting it here.
              </AlertDescription>
            </Alert>
          )}
          {base && id === "codex-config" && (
            <CodexQuickSettings text={text} onChange={setText} />
          )}
          {base && id === "claude-settings" && (
            <ClaudeQuickSettings text={text} onChange={setText} />
          )}
        </div>
      )}

      {/* Edge to edge: the editor is the pane, not a box inside it. */}
      {base ? (
        <CodeEditor
          value={text}
          onChange={setText}
          onSave={() => void save()}
          format={format}
          label={title}
          className="min-h-0 flex-1 overflow-hidden"
        />
      ) : (
        <div className="flex-1" />
      )}

      {(problem || conflict || error || (saved && !dirty)) && (
        <div className="border-border flex shrink-0 flex-col gap-2 border-t px-4 py-2.5">
          {problem && (
            <p
              role="alert"
              data-testid="agent-config-syntax"
              className="text-destructive font-mono text-xs"
            >
              {problem}
            </p>
          )}
          {conflict && (
            <Alert variant="destructive">
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>
                  This file changed on disk after you opened it. Reload to see
                  it — your edits here will be lost.
                </span>
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  Reload
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <p role="alert" className="text-destructive text-[13px]">
              {error}
            </p>
          )}
          {saved && !dirty && (
            <p role="status" className="text-muted-foreground text-[13px]">
              {saved}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Codex's `[features]` as switches (D6): every flag the file sets, and the
 * known ones it does not — shown at Codex's default until one is flipped.
 */
function CodexQuickSettings({
  text,
  onChange,
}: {
  text: string;
  onChange: (next: string) => void;
}) {
  const set = codexFeatures(text);
  const known = new Map(
    CODEX_KNOWN_FEATURES.map((entry) => [entry.key, entry]),
  );
  const keys = [
    ...CODEX_KNOWN_FEATURES.map((entry) => entry.key),
    ...Object.keys(set)
      .filter((key) => !known.has(key))
      .sort(),
  ];
  return (
    <section
      aria-label="Codex features"
      className="border-border flex flex-col rounded-lg border"
    >
      {keys.map((key) => {
        const on = set[key] ?? known.get(key)?.on ?? false;
        return (
          <div
            key={key}
            className="border-border flex items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="font-mono text-xs">{key}</p>
              <p className="text-muted-foreground text-xs">
                {known.get(key)?.hint ?? "Set in [features]."}
                {set[key] === undefined ? " Not set — Codex's default." : ""}
              </p>
            </div>
            <Switch
              aria-label={`features.${key}`}
              checked={on}
              onCheckedChange={(checked) =>
                onChange(withCodexFeature(text, key, checked))
              }
            />
          </div>
        );
      })}
    </section>
  );
}

const NOT_SET = "__not-set__";

/** Claude's `permissions.defaultMode` as a picker (D6). */
function ClaudeQuickSettings({
  text,
  onChange,
}: {
  text: string;
  onChange: (next: string) => void;
}) {
  const mode = claudeDefaultMode(text);
  const broken = withClaudeDefaultMode(text, mode) === null;
  return (
    <section
      aria-label="Claude Code permissions"
      className="border-border flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
    >
      <div className="min-w-0">
        <p className="font-mono text-xs">permissions.defaultMode</p>
        <p className="text-muted-foreground text-xs">
          {broken
            ? "Fix the JSON below to change this here."
            : "How Claude Code asks before it acts, in every project."}
        </p>
      </div>
      <Select
        value={mode ?? NOT_SET}
        onValueChange={(value) => {
          const next = withClaudeDefaultMode(
            text,
            value === NOT_SET ? null : (value as string),
          );
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger aria-label="permissions.defaultMode" disabled={broken}>
          <SelectValue>
            {(value: string) => (value === NOT_SET ? "Not set" : value)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOT_SET}>Not set</SelectItem>
          {CLAUDE_DEFAULT_MODES.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  );
}

/**
 * A config file as text: line numbers, the code font, its grammar.
 *
 * ⚠️ Built once per file, like `MarkdownEditor`: `value` is synced into the
 * document by comparison, so a quick setting or a Revert lands without
 * rebuilding the editor and losing its undo history.
 */
function CodeEditor({
  value,
  onChange,
  onSave,
  format,
  label,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  /** ⌘S. */
  onSave: () => void;
  format: ConfigFormat;
  label: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange, onSave });
  latest.current = { value, onChange, onSave };

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          history(),
          lineNumbers(),
          LANGUAGES[format](),
          syntaxHighlighting(HIGHLIGHT),
          THEME,
          EditorView.contentAttributes.of({
            "aria-label": label,
            "data-testid": "agent-config-editor",
          }),
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  latest.current.onSave();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([...historyKeymap, ...defaultKeymap]),
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
  }, [format, label]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return <div ref={host} className={className} />;
}

/**
 * ⚠️ Markdown is edited as plain text here. A skill opens with YAML
 * frontmatter, and the Markdown grammar reads its closing `---` as the
 * underline of a heading — the whole block would be drawn as a title.
 */
const LANGUAGES: Record<ConfigFormat, () => Extension> = {
  json: () => json(),
  // ⚠️ legacy-modes types its parsers against `@codemirror/streamparser`, a
  // twin of the same interface; the parser itself is what `define` takes.
  toml: () => StreamLanguage.define(toml as unknown as StreamParser<unknown>),
  markdown: () => [],
};

const THEME = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12px",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--code-font)",
    lineHeight: "1.6",
    overflow: "auto",
  },
  // ⚠️ Opaque: the gutter stays put while long lines scroll sideways under
  // it, and a transparent one lets the text run over the line numbers.
  ".cm-gutters": {
    paddingInlineStart: "8px",
    backgroundColor:
      "color-mix(in oklab, var(--foreground) 5%, var(--background))",
    color: "var(--muted-foreground)",
    border: "none",
    borderInlineEnd: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { paddingInline: "4px 10px" },
  ".cm-content": {
    paddingInlineStart: "8px",
    caretColor: "var(--foreground)",
  },
  "&.cm-editor .cm-selectionBackground, ::selection": {
    backgroundColor:
      "color-mix(in oklab, var(--accent-brand) 28%, transparent)",
  },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
});

/**
 * Keys in the brand colour, values in the text colour, tables and literals
 * weighted — the palette's chart tokens are greys, and too faint for code.
 */
const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  {
    tag: [tags.propertyName, tags.definition(tags.propertyName)],
    color: "var(--accent-brand)",
  },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--foreground)" },
  {
    tag: [tags.number, tags.bool, tags.atom, tags.null],
    color: "var(--foreground)",
    fontWeight: "600",
  },
]);
