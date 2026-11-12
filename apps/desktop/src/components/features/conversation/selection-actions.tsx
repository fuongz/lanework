import {
  HelpCircleIcon,
  QuoteDownIcon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** The toolbar's height and the gap it keeps from the selection, in px. */
const BAR = 36;
const GAP = 8;
/** The named highlight that keeps a selection painted once the field takes focus. */
const HIGHLIGHT = "quote-selection";

interface Picked {
  text: string;
  range: Range;
  rect: DOMRect;
}

/** The turn element `node` sits in, if any. */
function turnOf(node: Node | null): Element | null {
  const element =
    node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest("[data-turn]") ?? null;
}

/** The selection, when it is text within one turn under `root`. */
function readSelection(root: HTMLElement): Picked | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0)
    return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return null;
  if (!root.contains(anchorNode) || !root.contains(focusNode)) return null;
  const turn = turnOf(anchorNode);
  if (!turn || turn !== turnOf(focusNode)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  return { text, range, rect: range.getBoundingClientRect() };
}

let styled = false;

function paint(range: Range | null) {
  const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  if (!highlights) return;
  // NOTE: Here, not in app.css: the CSS build does not know `::highlight`
  // yet and warns on every build.
  if (!styled) {
    styled = true;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      `::highlight(${HIGHLIGHT}) { background-color: var(--selection); }`,
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
  if (range) highlights.set(HIGHLIGHT, new Highlight(range));
  else highlights.delete(HIGHLIGHT);
}

/**
 * Selection actions: text selected in one message of the transcript gets a
 * floating bar under it. Ask about it (type, Enter), Explain it, or Mention
 * it, which quotes it above the composer for the next message.
 *
 * Explain and Ask send at once, with the passage as a `> ` quote.
 */
export function SelectionActions({
  root,
  onAsk,
  onMention,
}: {
  root: RefObject<HTMLElement | null>;
  /** Sends a message about `text`: Explain's, or the question typed. */
  onAsk: (text: string, question: string) => void;
  onMention: (text: string) => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [question, setQuestion] = useState("");
  /** The field has the focus, and the native selection is gone from view. */
  const [typing, setTyping] = useState(false);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const inBar = (target: EventTarget | null) =>
      target instanceof Node && !!bar.current?.contains(target);
    const read = (event: Event) => {
      if (inBar(event.target) || !root.current) return;
      // After the browser has settled the selection the click made.
      requestAnimationFrame(() => {
        const next = root.current ? readSelection(root.current) : null;
        setPicked(next);
        if (!next) setQuestion("");
      });
    };
    const onSelectionChange = () => {
      // Typing in the bar's field moves the selection there: keep the pick.
      if (inBar(document.activeElement)) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setPicked(null);
        setQuestion("");
      }
    };
    const onScroll = () =>
      setPicked((current) =>
        current
          ? { ...current, rect: current.range.getBoundingClientRect() }
          : current,
      );
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicked(null);
    };
    document.addEventListener("mouseup", read);
    document.addEventListener("keyup", read);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mouseup", read);
      document.removeEventListener("keyup", read);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("keydown", onKey);
    };
  }, [root]);

  // The selection stays painted while the bar's field has the focus.
  useEffect(() => {
    paint(typing ? (picked?.range ?? null) : null);
    return () => paint(null);
  }, [typing, picked?.range]);

  if (!picked) return null;

  const done = () => {
    setPicked(null);
    setTyping(false);
    setQuestion("");
    window.getSelection()?.removeAllRanges();
  };
  const ask = () => {
    const said = question.trim();
    if (!said) return;
    onAsk(picked.text, said);
    done();
  };

  const width = bar.current?.offsetWidth ?? 360;
  const below = picked.rect.bottom + GAP + BAR <= window.innerHeight;
  const top = below ? picked.rect.bottom + GAP : picked.rect.top - GAP - BAR;
  const left = Math.min(
    Math.max(8, picked.rect.left + picked.rect.width / 2 - width / 2),
    window.innerWidth - width - 8,
  );

  return createPortal(
    <div
      ref={bar}
      role="toolbar"
      aria-label="Selection actions"
      style={{ top, left }}
      className="bg-popover text-popover-foreground border-border/70 animate-in fade-in-0 zoom-in-95 fixed z-50 flex h-9 items-center gap-0.5 rounded-full border ps-3 pe-1 shadow-[0_1px_2px_rgb(0_0_0/0.05),0_10px_30px_-8px_rgb(0_0_0/0.18)] duration-100 motion-reduce:animate-none"
      // A press in the bar must not drop the selection it acts on.
      onMouseDown={(event) => {
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
      }}
    >
      <input
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            ask();
          }
        }}
        placeholder="Ask about this…"
        aria-label="Ask about this"
        className="placeholder:text-muted-foreground w-32 bg-transparent text-xs outline-none"
      />
      {question.trim() ? (
        <BarButton icon={SentIcon} label="Ask" onClick={ask} />
      ) : null}
      <span aria-hidden="true" className="bg-border mx-1 h-4 w-px" />
      <BarButton
        icon={HelpCircleIcon}
        label="Explain"
        onClick={() => {
          onAsk(picked.text, "Explain this.");
          done();
        }}
      />
      <BarButton
        icon={QuoteDownIcon}
        label="Mention"
        onClick={() => {
          onMention(picked.text);
          done();
        }}
      />
    </div>,
    document.body,
  );
}

function BarButton({
  icon,
  label,
  onClick,
}: {
  icon: typeof HelpCircleIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-foreground/[0.06] flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs transition-colors"
    >
      <HugeiconsIcon
        icon={icon}
        className="size-3.5"
        strokeWidth={1.8}
        aria-hidden="true"
      />
      {label}
    </button>
  );
}
