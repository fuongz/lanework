import {
  ArrowUp02Icon,
  Cancel01Icon,
  File01Icon,
  Image01Icon,
  Loading03Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type ComposerSettings,
  type OutgoingAttachment,
  PASTE_MAX,
  type Suggestion,
  type SuggestionKind,
} from "#/../shared/conversation";
import { BranchSwitcher } from "#/components/shared/repo/branch-switcher";
import { cn } from "#/lib/utils";
import { AttachMenu, ModelMenu, PermissionMenu } from "./composer.menus";

export interface ComposerHandle {
  /** Put `text` in the composer — a reply's quote — and focus it. */
  insert: (text: string) => void;
}

interface Pending {
  key: string;
  name: string;
  image: boolean;
  out: OutgoingAttachment;
}

/** A `/` at a line's start, or an `@` after a space: what the caret is in. */
function trigger(
  text: string,
  caret: number,
): { kind: SuggestionKind; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const command = /(^|\n)\/([^\s/]*)$/.exec(before);
  if (command)
    return {
      kind: "command",
      query: command[2] ?? "",
      start: caret - (command[2]?.length ?? 0) - 1,
    };
  const file = /(^|\s)@([^\s@]*)$/.exec(before);
  if (file)
    return {
      kind: "file",
      query: file[2] ?? "",
      start: caret - (file[2]?.length ?? 0) - 1,
    };
  return null;
}

let keys = 0;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * The composer (D8): where the next turn is written and sent — or queued
 * behind the running one — with attachments, `/` and `@` suggestions, and the
 * settings it is sent with.
 */
export const Composer = forwardRef<
  ComposerHandle,
  {
    /** The project, for its branch switcher. */
    slug: string;
    /** Take the caret on mount — the new-conversation page has nothing else. */
    autoFocus?: boolean;
    /** The top row's right corner: the conversation's context ring. */
    corner?: ReactNode;
    workspace: string;
    settings: ComposerSettings;
    onSettings: (next: Partial<ComposerSettings>) => void;
    working: boolean;
    queued: number;
    onSend: (
      text: string,
      attachments: OutgoingAttachment[],
      names: { name: string; image: boolean }[],
    ) => Promise<boolean>;
    onStop: () => void;
    onClearQueue: () => void;
  }
>(function Composer(
  {
    slug,
    autoFocus,
    corner,
    workspace,
    settings,
    onSettings,
    working,
    queued,
    onSend,
    onStop,
    onClearQueue,
  },
  ref,
) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [suggest, setSuggest] = useState<{
    kind: SuggestionKind;
    start: number;
    query: string;
    items: Suggestion[];
    index: number;
  } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const asked = useRef(0);
  /**
   * Where the caret goes once the next value is drawn. Placed in a layout
   * effect, never a frame later: keys typed in between would land before it.
   */
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = area.current;
    if (caret.current === null || !node) return;
    node.focus();
    node.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only.
  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, []);

  useImperativeHandle(ref, () => ({
    insert: (value) => {
      const next = text.trim()
        ? `${text.replace(/\s*$/, "")}\n\n${value}`
        : value;
      caret.current = next.length;
      setText(next);
    },
  }));

  // What `/` or `@` offers, asked again as the query changes.
  const lookup = (value: string, caret: number) => {
    const found = trigger(value, caret);
    if (!found) {
      setSuggest(null);
      return;
    }
    const mine = ++asked.current;
    const surface = window.desktop?.conversation;
    if (!surface) return;
    void surface
      .suggest(workspace, found.kind, found.query)
      .then((items) => {
        if (mine !== asked.current) return;
        setSuggest(
          items.length
            ? { ...found, items: items.slice(0, 12), index: 0 }
            : null,
        );
      })
      .catch(() => {
        if (mine === asked.current) setSuggest(null);
      });
  };

  const choose = (item: Suggestion) => {
    if (!suggest) return;
    const node = area.current;
    const next = `${text.slice(0, suggest.start)}${item.value} ${text.slice(node?.selectionStart ?? text.length)}`;
    caret.current = suggest.start + item.value.length + 1;
    setText(next);
    setSuggest(null);
    asked.current++;
  };

  const addFiles = async (files: File[], pasted: boolean) => {
    const surface = window.desktop?.conversation;
    if (!surface) return;
    const added: Pending[] = [];
    for (const file of files) {
      const image = file.type.startsWith("image/");
      let path = "";
      try {
        path = surface.pathForFile(file);
      } catch {
        path = "";
      }
      if (path) {
        added.push({
          key: `a${++keys}`,
          name: file.name,
          image,
          out: { kind: "path", path },
        });
        continue;
      }
      // A pasted screenshot has no path: its bytes go, if small enough.
      if (pasted && image) {
        if (file.size > PASTE_MAX) {
          setError(
            `${file.name || "This image"} is larger than ${PASTE_MAX / 1024 / 1024} MB.`,
          );
          continue;
        }
        const data = await readBase64(file);
        added.push({
          key: `a${++keys}`,
          name: file.name || "image.png",
          image,
          out: {
            kind: "data",
            name: file.name || "image.png",
            mediaType: file.type,
            data,
          },
        });
        continue;
      }
      setError(`Could not attach ${file.name}.`);
    }
    if (added.length) setAttachments((previous) => [...previous, ...added]);
  };

  const empty = !text.trim() && attachments.length === 0;

  const send = async () => {
    if (empty || sending) return;
    setSending(true);
    setError(null);
    const sent = text;
    const files = attachments;
    setText("");
    setAttachments([]);
    setSuggest(null);
    const ok = await onSend(
      sent.trim(),
      files.map((file) => file.out),
      files.map((file) => ({ name: file.name, image: file.image })),
    );
    setSending(false);
    if (!ok) {
      // Nothing was sent: the words come back, not lost.
      setText((current) => current || sent);
      setAttachments((current) => (current.length ? current : files));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSuggest({
          ...suggest,
          index:
            (suggest.index + step + suggest.items.length) %
            suggest.items.length,
        });
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        const item = suggest.items[suggest.index];
        if (item) {
          event.preventDefault();
          choose(item);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggest(null);
        return;
      }
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  };

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const stopping = working && empty;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files; the + menu's Upload file is the keyboard's way to attach.
    <div
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        void addFiles([...event.dataTransfer.files], false);
      }}
      className={cn(
        "bg-card border-border relative flex flex-col gap-1 rounded-xl border px-3 pt-2.5 pb-2 shadow-xs transition-colors",
        dragging && "border-ring",
      )}
    >
      {suggest && (
        <div
          role="listbox"
          aria-label={suggest.kind === "command" ? "Commands" : "Files"}
          className="bg-popover text-popover-foreground ring-foreground/10 absolute right-0 bottom-full left-0 z-20 mb-1.5 max-h-72 overflow-y-auto rounded-xl p-1 shadow-lg ring-1"
        >
          {suggest.items.map((item, index) => (
            <button
              key={item.value}
              type="button"
              role="option"
              aria-selected={index === suggest.index}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(item)}
              onPointerEnter={() => setSuggest({ ...suggest, index })}
              className="aria-selected:bg-foreground/[0.08] flex w-full min-w-0 items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left"
            >
              <span className="shrink-0 font-mono text-[12px]">
                {item.value}
              </span>
              {item.detail && (
                <span className="text-muted-foreground min-w-0 truncate text-xs">
                  {item.detail}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="text-muted-foreground flex h-6 min-w-0 items-center gap-4 text-[13px]">
        {/* The checkout's branch — where the next turn runs — and the way to
            another one. */}
        <BranchSwitcher slug={slug} variant="composer" />
        <span className="ml-auto" />
        {queued > 0 && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs">
            {queued} queued
            <button
              type="button"
              onClick={onClearQueue}
              className="hover:text-foreground underline underline-offset-2 transition-colors"
            >
              Clear
            </button>
          </span>
        )}
        {working && (
          <span role="status" aria-label="Working" className="flex">
            <HugeiconsIcon
              icon={Loading03Icon}
              className="size-4 animate-spin motion-reduce:animate-none"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </span>
        )}
        {corner}
      </div>

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {attachments.map((file) => (
            <span
              key={file.key}
              className="bg-foreground/[0.06] flex max-w-60 items-center gap-1.5 rounded-md py-1 ps-2 pe-1 text-xs"
            >
              <HugeiconsIcon
                icon={file.image ? Image01Icon : File01Icon}
                className={cn(
                  "size-3.5 shrink-0",
                  file.image ? "text-tone-teal" : "text-muted-foreground",
                )}
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span className="truncate">{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() =>
                  setAttachments((previous) =>
                    previous.filter((entry) => entry.key !== file.key),
                  )
                }
                className="text-muted-foreground hover:text-foreground flex size-4 items-center justify-center rounded transition-colors"
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  className="size-3"
                  strokeWidth={2}
                />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={area}
        value={text}
        rows={1}
        aria-label="Message Claude"
        placeholder="Ask, build, / for commands, @ for references…"
        onChange={(event) => {
          setText(event.target.value);
          lookup(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setSuggest(null)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (!files.length) return;
          event.preventDefault();
          void addFiles(files, true);
        }}
        className="placeholder:text-muted-foreground font-content max-h-60 min-h-11 w-full resize-none bg-transparent py-2 text-[14px] leading-relaxed outline-none [field-sizing:content]"
      />

      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="flex min-w-0 items-center gap-1.5">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void addFiles(files, false);
          }}
        />
        <AttachMenu onUpload={() => picker.current?.click()} />
        <ModelMenu settings={settings} onChange={onSettings} />
        <PermissionMenu
          permission={settings.permission}
          onChange={(permission) => onSettings({ permission })}
        />
        <span className="ml-auto" />
        {stopping ? (
          <button
            type="button"
            aria-label="Stop"
            onClick={onStop}
            className="bg-foreground text-background hover:bg-foreground/80 flex size-7 items-center justify-center rounded-lg transition-colors"
          >
            <HugeiconsIcon
              icon={StopIcon}
              className="size-3.5"
              strokeWidth={2}
            />
          </button>
        ) : (
          <button
            type="button"
            aria-label={working ? "Queue message" : "Send"}
            disabled={empty || sending}
            onClick={() => void send()}
            className="bg-foreground text-background hover:bg-foreground/80 disabled:bg-foreground/10 disabled:text-muted-foreground flex size-7 items-center justify-center rounded-lg transition-colors"
          >
            <HugeiconsIcon
              icon={ArrowUp02Icon}
              className="size-4"
              strokeWidth={2}
            />
          </button>
        )}
      </div>
    </div>
  );
});
