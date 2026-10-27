import {
  type ClipboardEvent,
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "#/lib/utils";

// The composer's field (FE-93/D1): plain text with chips in it.
//
// The message is a string, `/better-ui look at @src/cli.ts`, and stays one:
// it is what the draft keeps and what is sent. A `/command` that starts it,
// or an `@path` between spaces, that `chipFor` knows is drawn as a chip in
// its place. The field is `contenteditable="plaintext-only"`: Enter and paste
// stay plain text, and a chip is a `contenteditable="false"` span the browser
// deletes whole.
//
// NOTE: The DOM is the browser's while typing; it is rebuilt from the text
// only when the two disagree on where the chips are (a pick from the list, a
// draft restored, a chip typed or deleted) or the browser left markup of its
// own (`<br>`, `<div>`). Never during an IME composition.

/** How one chip looks. */
export interface ChipSpec {
  /** What it stands for in the text: `/better-ui`, `@src/cli.ts`. */
  value: string;
  label: string;
  /** The hover text: its full path, or its description. */
  title: string;
  icon: ReactNode;
  /** `muted` for a command that is not a skill (FE-93/D3). */
  tone: "primary" | "muted";
}

type Segment = { text: string } | { chip: ChipSpec };

/**
 * `text` as plain runs and chips.
 *
 * A token is a `/…` at the very start, or an `@…` after a space or the
 * start, running to the next space or the end.
 */
function segment(
  text: string,
  chipFor: (token: string) => ChipSpec | null,
): Segment[] {
  const out: Segment[] = [];
  const token = /[/@]\S+/g;
  let last = 0;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    const at = match.index;
    if (at > 0 && !/\s/.test(text.charAt(at - 1))) continue;
    if (match[0].startsWith("/") && at !== 0) continue;
    const chip = chipFor(match[0]);
    if (!chip) continue;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ chip });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function signature(segments: Segment[]): string {
  return segments
    .map((part) => ("chip" in part ? `c${part.chip.value}` : `t${part.text}`))
    .join("\u0000");
}

const isChip = (node: Node): node is HTMLElement =>
  node instanceof HTMLElement && node.dataset.value !== undefined;
/**
 * The `<br>` that ends the field: ours, or the one Chrome adds to hold an
 * empty last line. Never a line of the text.
 */
const isTail = (node: Node) =>
  node.nodeName === "BR" &&
  ((node as HTMLElement).dataset.tail !== undefined ||
    (node.parentElement?.getAttribute("role") === "textbox" &&
      node.parentElement.lastChild === node));

/** The field's text: a chip is its value, a `<br>` or a new block a line. */
function serialize(root: Node): string {
  let out = "";
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? "";
      else if (isChip(child)) out += child.dataset.value;
      else if (child.nodeName === "BR") {
        if (!isTail(child)) out += "\n";
      } else if (child.nodeName === "DIV" || child.nodeName === "P") {
        if (out && !out.endsWith("\n")) out += "\n";
        walk(child);
      } else walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * The chips and runs the DOM shows now, as {@link signature} writes them;
 * null when it holds markup the field never builds.
 */
function domSignature(root: HTMLElement): string | null {
  const parts: string[] = [];
  let run: string | null = null;
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      run = (run ?? "") + (child.textContent ?? "");
      continue;
    }
    if (run) parts.push(`t${run}`);
    run = null;
    if (isChip(child)) parts.push(`c${child.dataset.value}`);
    else if (!(isTail(child) && child === root.lastChild)) return null;
  }
  if (run) parts.push(`t${run}`);
  return parts.join("\u0000");
}

/** Where `node`/`offset` is in the text. */
function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  const holder = document.createElement("div");
  holder.append(range.cloneContents());
  return serialize(holder).length;
}

/** The DOM point at text offset `target`: after a chip it falls inside. */
function pointAt(root: HTMLElement, target: number): [Node, number] {
  let count = 0;
  const children = [...root.childNodes];
  for (const [index, child] of children.entries()) {
    if (child.nodeType === Node.TEXT_NODE) {
      const length = child.textContent?.length ?? 0;
      if (target <= count + length) return [child, target - count];
      count += length;
    } else if (isChip(child)) {
      count += child.dataset.value?.length ?? 0;
      if (target <= count) return [root, index + 1];
    }
  }
  const last = root.lastChild;
  return [root, last && isTail(last) ? children.length - 1 : children.length];
}

let chipKeys = 0;

export interface ChipEditorHandle {
  focus: () => void;
  /** The selection as text offsets; null when it is not in the field. */
  selection: () => { start: number; end: number } | null;
  /** Select `start`…`end` (the caret, without `end`) and focus. */
  select: (start: number, end?: number) => void;
}

export const ChipEditor = forwardRef<
  ChipEditorHandle,
  {
    value: string;
    chipFor: (token: string) => ChipSpec | null;
    /** Changes when `chipFor` would answer differently: the chips are redrawn. */
    chipsVersion: number;
    readOnly?: boolean;
    placeholder: string;
    label: string;
    className?: string;
    onChange: (text: string, caret: number) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
    onBlur?: () => void;
    onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  }
>(function ChipEditor(
  {
    value,
    chipFor,
    chipsVersion,
    readOnly,
    placeholder,
    label,
    className,
    onChange,
    onKeyDown,
    onBlur,
    onPaste,
  },
  ref,
) {
  const root = useRef<HTMLDivElement>(null);
  const [chips, setChips] = useState<
    { node: HTMLElement; spec: ChipSpec; key: number }[]
  >([]);
  const chipForRef = useRef(chipFor);
  chipForRef.current = chipFor;

  const selection = () => {
    const node = root.current;
    const picked = window.getSelection();
    if (!node || !picked || picked.rangeCount === 0) return null;
    const range = picked.getRangeAt(0);
    if (!node.contains(range.startContainer)) return null;
    const start = offsetOf(node, range.startContainer, range.startOffset);
    const end = range.collapsed
      ? start
      : offsetOf(node, range.endContainer, range.endOffset);
    return { start, end };
  };

  const select = (start: number, end = start) => {
    const node = root.current;
    const picked = window.getSelection();
    if (!node || !picked) return;
    node.focus();
    const range = document.createRange();
    range.setStart(...pointAt(node, start));
    range.setEnd(...pointAt(node, end));
    picked.removeAllRanges();
    picked.addRange(range);
  };

  useImperativeHandle(ref, () => ({
    focus: () => root.current?.focus(),
    selection,
    select,
  }));

  /** The DOM drawn again from `text`, keeping the selection. */
  const draw = (text: string, force: boolean) => {
    const node = root.current;
    if (!node) return;
    const segments = segment(text, chipForRef.current);
    if (
      !force &&
      serialize(node) === text &&
      domSignature(node) === signature(segments)
    )
      return;
    const kept = document.activeElement === node ? selection() : null;
    const made: { node: HTMLElement; spec: ChipSpec; key: number }[] = [];
    node.replaceChildren(
      ...segments.map((part) => {
        if ("text" in part) return document.createTextNode(part.text);
        const span = document.createElement("span");
        span.contentEditable = "false";
        span.dataset.value = part.chip.value;
        span.title = part.chip.title;
        span.className = cn(
          "mx-px inline-flex items-baseline gap-1 align-baseline font-medium select-all",
          part.chip.tone === "primary"
            ? "text-primary"
            : "text-muted-foreground",
        );
        made.push({ node: span, spec: part.chip, key: ++chipKeys });
        return span;
      }),
    );
    // A last line break draws an empty line only with something after it.
    if (text.endsWith("\n")) {
      const tail = document.createElement("br");
      tail.dataset.tail = "";
      node.append(tail);
    }
    setChips(made);
    if (kept) select(kept.start, kept.end);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: drawn when the text or what chips are changes.
  useLayoutEffect(() => {
    draw(value, false);
  }, [value, chipsVersion]);

  const composing = useRef(false);
  const input = () => {
    const node = root.current;
    if (!node) return;
    const text = serialize(node);
    const caret = selection()?.start ?? text.length;
    // Markup of the browser's own, or chips that moved: drawn again now, so
    // the caret math below stays on text and chips.
    if (!composing.current) draw(text, false);
    onChange(text, caret);
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a textarea cannot hold chips (FE-93/D1). */}
      <div
        ref={root}
        role="textbox"
        tabIndex={0}
        aria-multiline="true"
        aria-label={label}
        aria-readonly={readOnly || undefined}
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        data-empty={value === "" || undefined}
        contentEditable={readOnly ? "false" : "plaintext-only"}
        suppressContentEditableWarning
        spellCheck
        onInput={input}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          input();
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onPaste={onPaste}
        onCopy={(event) => {
          const range = window.getSelection()?.getRangeAt(0);
          if (!range || range.collapsed) return;
          const holder = document.createElement("div");
          holder.append(range.cloneContents());
          event.clipboardData.setData("text/plain", serialize(holder));
          event.preventDefault();
        }}
        onCut={(event) => {
          const range = window.getSelection()?.getRangeAt(0);
          if (!range || range.collapsed || readOnly) return;
          const holder = document.createElement("div");
          holder.append(range.cloneContents());
          event.clipboardData.setData("text/plain", serialize(holder));
          event.preventDefault();
          document.execCommand("delete");
        }}
        className={cn(
          "relative break-words whitespace-pre-wrap outline-none",
          "data-[empty]:before:text-muted-foreground data-[empty]:before:pointer-events-none data-[empty]:before:absolute data-[empty]:before:content-[attr(data-placeholder)]",
          className,
        )}
      />
      {chips.map(({ node, spec, key }) =>
        createPortal(
          <>
            <span className="flex size-3.5 shrink-0 self-center">
              {spec.icon}
            </span>
            <span>{spec.label}</span>
          </>,
          node,
          String(key),
        ),
      )}
    </>
  );
});
