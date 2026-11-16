import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/** One page of a card: a row's sub items, under Back and its name. */
interface Page {
  id: string;
  label: string;
}

interface Pages {
  stack: Page[];
  slots: Record<string, HTMLElement | null>;
  open: (page: Page, from: HTMLElement) => void;
}

const PagesContext = createContext<Pages | null>(null);

/**
 * A card whose rows open their sub items as pages, one over another, rather
 * than unfolding in place (the conductor's Sessions panel).
 *
 * - The card's own rows stay mounted under a page, and so does each page
 *   under the one above it: a list keeps living, and counting, while it is
 *   out of sight, and a row inside a page can open a page of its own.
 * - Back, or Escape, goes up one page and gives the focus back to the row
 *   that opened it.
 */
export function PanelPages({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Page[]>([]);
  const [slots, setSlots] = useState<Record<string, HTMLElement | null>>({});
  const openers = useRef(new Map<string, HTMLElement>());
  const backRef = useRef<HTMLButtonElement>(null);
  /** Where the focus goes after the stack changes. */
  const focusNext = useRef<HTMLElement | "back" | null>(null);

  const open = useCallback((page: Page, from: HTMLElement) => {
    openers.current.set(page.id, from);
    focusNext.current = "back";
    setStack((before) => [...before, page]);
  }, []);
  const back = () => {
    const top = stack[stack.length - 1];
    if (!top) return;
    focusNext.current = openers.current.get(top.id) ?? null;
    openers.current.delete(top.id);
    setStack(stack.slice(0, -1));
  };
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === "back") backRef.current?.focus();
    else next?.focus();
  });

  const value = useMemo<Pages>(
    () => ({ stack, slots, open }),
    [stack, slots, open],
  );
  // One stable ref callback per slot: a new function on every render would
  // be called with null, then the element, each time, and each call sets
  // state, so the card would render forever.
  const slotRefs = useRef(
    new Map<string, (element: HTMLElement | null) => void>(),
  );
  const slotFor = (id: string) => {
    let ref = slotRefs.current.get(id);
    if (!ref) {
      ref = (element: HTMLElement | null) =>
        setSlots((before) =>
          before[id] === element ? before : { ...before, [id]: element },
        );
      slotRefs.current.set(id, ref);
    }
    return ref;
  };

  return (
    <PagesContext.Provider value={value}>
      <div hidden={stack.length > 0} className="flex flex-col">
        {children}
      </div>
      {stack.map((page, index) => {
        const top = index === stack.length - 1;
        return (
          <section
            key={page.id}
            hidden={!top}
            aria-label={page.label}
            className="flex flex-col"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              back();
            }}
          >
            <header className="border-border flex h-9 min-w-0 items-center gap-1 border-b px-1.5 text-[13px]">
              <button
                ref={top ? backRef : undefined}
                type="button"
                onClick={back}
                aria-label="Back"
                className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] focus-visible:ring-accent-brand grid size-6 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2"
              >
                <HugeiconsIcon
                  icon={ArrowLeft01Icon}
                  className="size-4"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </button>
              <h3 className="min-w-0 truncate font-medium" title={page.label}>
                {page.label}
              </h3>
              {/* The row's own count, kept live by the row. */}
              <span
                ref={slotFor(`${page.id}:count`)}
                className="text-muted-foreground/80 ml-auto shrink-0 pr-1.5 tabular-nums"
              />
            </header>
            <ul ref={slotFor(page.id)} className="flex flex-col py-1" />
          </section>
        );
      })}
    </PagesContext.Provider>
  );
}

/**
 * A row's page, inside {@link PanelPages}; `paged` is false outside one,
 * where the row unfolds in place as before.
 *
 * @returns `open` for the row's click, and `portal`, which puts the sub
 *   items in the page while it is open (and nowhere otherwise).
 */
export function usePanelPage(label: string, count: ReactNode) {
  const id = useId();
  const pages = useContext(PagesContext);
  const paged = pages !== null;
  const shown = Boolean(pages?.stack.some((page) => page.id === id));
  const slot = pages?.slots[id] ?? null;
  const countSlot = pages?.slots[`${id}:count`] ?? null;
  return {
    paged,
    open: (from: HTMLElement) => pages?.open({ id, label }, from),
    portal: (children: ReactNode) =>
      shown && slot ? (
        <>
          {createPortal(children, slot)}
          {countSlot && createPortal(count, countSlot)}
        </>
      ) : null,
  };
}
