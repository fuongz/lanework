import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type RefCallback, useCallback, useEffect, useRef } from "react";
import {
  ISLAND_HOST,
  ISLAND_HOST_TOP,
  ISLAND_LEAVE_MS,
  ISLAND_MORPH,
  ISLAND_PANEL_RADIUS,
  ISLAND_PILL_RADIUS,
  ISLAND_SURFACE,
  ISLAND_SWAP,
} from "#/components/shared/agents/harness-island";
import { cn } from "#/lib/utils";
import {
  type IslandContent,
  type IslandRenderContext,
  type IslandTone,
  setIslandOpen,
  useIsland,
  useTopIsland,
} from "#/stores/island";

/** The progress bar's colour, by tone, for the black surface. */
const BAR: Record<IslandTone, string> = {
  neutral: "bg-white/70",
  loading: "bg-white/70",
  success: "bg-emerald-400",
  error: "bg-red-400",
  warning: "bg-amber-400",
  info: "bg-sky-400",
};

/**
 * The one island: a black capsule at the top centre of the window showing
 * whichever registered content ranks highest.
 *
 * - ONE surface for every content. When the winner changes, or a content
 *   goes from pill to panel, the same box springs to its new size
 *   (`ISLAND_MORPH`) while the words crossfade (`ISLAND_SWAP`), instead of
 *   one capsule leaving and another arriving.
 * - Reduced motion: a surface per content and view, crossfaded, with no
 *   morph or scale.
 * - A pointer over it holds the content (its timer pauses) and opens a
 *   panel that has one, unless the content opts out; the panel folds a
 *   moment after the pointer leaves, but only when the pointer opened it.
 *   Focus inside holds it the same way.
 * - A click (or Enter) on a pill pins the panel: focus moves into it, and a
 *   press outside folds it. Escape from inside runs the content's
 *   `onEscape`, or folds, and gives focus back.
 * - Alt+T moves focus into the island from anywhere, the way Ding does.
 *   NOTE: Matched on `event.code`, since Option+T types "†" on a Mac, and
 *   skipped once something handled the key: a terminal that took Alt+T
 *   keeps it.
 * - The two live regions are always mounted, one polite and one assertive
 *   (`announceIsland`), so a sentence said as a content arrives is heard.
 * - NOTE: Only the capsule is `no-drag`: the strip across the window has no
 *   region, so the title bar either side still drags. Mount it last in the
 *   shell, because a later region wins over the title bar's drag strip.
 */
export function IslandHost() {
  const top = useTopIsland();
  const id = top?.id ?? null;
  const open = useIsland((state) => (id ? (state.open[id] ?? false) : false));
  const pinned = useIsland((state) =>
    id ? (state.pinned[id] ?? false) : false,
  );
  const polite = useIsland((state) => state.polite);
  const assertive = useIsland((state) => state.assertive);
  const reduced = useReducedMotion() ?? false;

  // The last content, kept for the island's way out: it shrinks away still
  // saying what it said rather than going blank first.
  const last = useRef<IslandContent | null>(null);
  if (top) last.current = top;
  const shown = top ?? last.current;
  const latest = useRef(top);
  latest.current = top;

  const surface = useRef<HTMLDivElement | null>(null);
  // NOTE: A callback ref with a cleanup rather than an object ref. Under
  // reduced motion the surface is keyed by view, so the leaving one unmounts
  // after the new one mounted, and a plain ref would end up null.
  const surfaceRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    surface.current = node;
    return () => {
      if (surface.current === node) surface.current = null;
    };
  }, []);

  const leaveTimer = useRef<number | undefined>(undefined);
  /** The pointer, not a click or the content itself, opened the panel. */
  const hoverOpened = useRef(false);
  const pointerIn = useRef(false);
  const focusIn = useRef(false);
  /** The content told it is held, so it can be told when it is let go. */
  const heldBy = useRef<IslandContent | null>(null);
  /** Where focus was before Alt+T, to give it back on Escape. */
  const returnFocus = useRef<HTMLElement | null>(null);

  /** Tell the current content whether the pointer or focus is on it. */
  const syncHold = useCallback(() => {
    const want = pointerIn.current || focusIn.current ? latest.current : null;
    const before = heldBy.current;
    if (before?.id === want?.id) return;
    // The newest registration of the same content, for current closures.
    const release = before?.id === latest.current?.id ? latest.current : before;
    release?.onHold?.(false);
    heldBy.current = want;
    want?.onHold?.(true);
  }, []);

  const fold = useCallback((contentId: string) => {
    window.clearTimeout(leaveTimer.current);
    hoverOpened.current = false;
    setIslandOpen(contentId, false);
  }, []);

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  // A new winner starts clean: no pending fold, nothing opened by hover.
  // NOTE: Pointer and focus are read again rather than trusted. The old
  // content's button that had focus is about to leave the DOM, which fires
  // no blur, and a reduced-motion surface swap fires no pointerleave; a
  // stale "held" would stop the new content's timer for good. Focus that was
  // inside stays inside, on the surface.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on a change of winner only; `syncHold` reads refs.
  useEffect(() => {
    window.clearTimeout(leaveTimer.current);
    hoverOpened.current = false;
    const node = surface.current;
    const active = document.activeElement;
    if (id !== null && node && active !== node && node.contains(active))
      node.focus({ preventScroll: true });
    pointerIn.current = id !== null && !!node?.matches(":hover");
    focusIn.current = id !== null && !!node?.contains(document.activeElement);
    syncHold();
  }, [id]);

  // Folded by anyone (its own timer, the content): the pointer no longer
  // owns an open.
  useEffect(() => {
    if (!open) hoverOpened.current = false;
  }, [open]);

  // Pinned: focus goes into the panel, since the pill that was pressed is
  // gone. Keyed on the view too, for the reduced-motion surface swap.
  useEffect(() => {
    if (pinned && open) surface.current?.focus({ preventScroll: true });
  }, [pinned, open]);

  // Pinned: a press anywhere else folds it.
  useEffect(() => {
    if (!pinned || !open || id === null) return;
    const onDown = (event: PointerEvent) => {
      if (surface.current?.contains(event.target as Node)) return;
      fold(id);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [pinned, open, id, fold]);

  // Alt+T, from anywhere, while something is showing.
  useEffect(() => {
    if (id === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.code !== "KeyT" ||
        !event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.defaultPrevented
      )
        return;
      const content = latest.current;
      if (!content) return;
      event.preventDefault();
      const active = document.activeElement;
      if (active instanceof HTMLElement && !surface.current?.contains(active))
        returnFocus.current = active;
      if (content.panel) setIslandOpen(content.id, true, true);
      surface.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [id]);

  /** Give focus back to where Alt+T found it, or let it go. */
  const giveFocusBack = () => {
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
    else if (
      document.activeElement instanceof HTMLElement &&
      surface.current?.contains(document.activeElement)
    )
      document.activeElement.blur();
  };

  const context: IslandRenderContext = {
    open: open && !!shown?.panel,
    pinned,
    setOpen: (next, pin = false) => {
      if (id === null) return;
      window.clearTimeout(leaveTimer.current);
      hoverOpened.current = false;
      setIslandOpen(id, next, pin);
    },
    reduced,
  };
  const view = context.open ? "panel" : "pill";
  const progress =
    typeof shown?.progress === "number"
      ? Math.min(1, Math.max(0, shown.progress))
      : null;

  return (
    <div
      data-testid="island-host"
      className={ISLAND_HOST}
      style={{ top: ISLAND_HOST_TOP }}
    >
      {/* Keyed by count, so the same sentence twice is read twice. */}
      <div className="sr-only" role="status" aria-live="polite">
        <span key={polite.n}>{polite.text}</span>
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        <span key={assertive.n}>{assertive.text}</span>
      </div>
      <AnimatePresence initial={false} mode="popLayout">
        {top && shown && (
          <motion.div
            key={reduced ? `${shown.id}:${view}` : "island"}
            ref={surfaceRef}
            role="group"
            aria-label={shown.label}
            tabIndex={-1}
            data-testid="island"
            {...shown.attributes}
            data-island={shown.id}
            data-tone={shown.tone}
            data-view={view}
            layout={!reduced}
            transition={reduced ? { duration: 0.2 } : ISLAND_MORPH}
            initial={{ opacity: 0, scale: reduced ? 1 : 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reduced ? 1 : 0.7 }}
            style={{
              borderRadius: context.open
                ? ISLAND_PANEL_RADIUS
                : (shown.pillRadius ?? ISLAND_PILL_RADIUS),
            }}
            onPointerEnter={() => {
              window.clearTimeout(leaveTimer.current);
              pointerIn.current = true;
              syncHold();
              const content = latest.current;
              if (
                content?.panel &&
                content.openOnHover !== false &&
                !useIsland.getState().open[content.id]
              ) {
                hoverOpened.current = true;
                setIslandOpen(content.id, true);
              }
            }}
            onPointerLeave={() => {
              pointerIn.current = false;
              syncHold();
              if (!hoverOpened.current || id === null) return;
              const contentId = id;
              window.clearTimeout(leaveTimer.current);
              leaveTimer.current = window.setTimeout(() => {
                if (hoverOpened.current && !focusIn.current) fold(contentId);
              }, ISLAND_LEAVE_MS);
            }}
            onFocus={() => {
              window.clearTimeout(leaveTimer.current);
              focusIn.current = true;
              syncHold();
            }}
            onBlur={(event) => {
              if (surface.current?.contains(event.relatedTarget as Node | null))
                return;
              focusIn.current = false;
              syncHold();
              if (hoverOpened.current && !pointerIn.current && id !== null)
                fold(id);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              const content = latest.current;
              if (!content) return;
              // Heard here only, never document-wide: an Escape meant for a
              // dialog under the island must still reach it.
              event.preventDefault();
              event.stopPropagation();
              giveFocusBack();
              if (content.onEscape) content.onEscape();
              else fold(content.id);
            }}
            className={cn(ISLAND_SURFACE, "outline-none")}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={`${shown.id}:${shown.swapKey ?? ""}:${view}`}
                layout={reduced ? false : "position"}
                initial={{ opacity: 0, filter: "blur(4px)" }}
                animate={{ opacity: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, filter: "blur(4px)" }}
                transition={ISLAND_SWAP}
              >
                {context.open && shown.panel
                  ? shown.panel(context)
                  : shown.pill(context)}
              </motion.div>
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {progress !== null && (
                <motion.div
                  key="progress"
                  role="progressbar"
                  aria-label={`${shown.label} progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress * 100)}
                  className={cn(
                    "pointer-events-none absolute inset-x-0 bottom-0 h-[2px] origin-left",
                    BAR[shown.tone],
                  )}
                  initial={{ opacity: 0, scaleX: progress }}
                  animate={{ opacity: 1, scaleX: progress }}
                  exit={{ opacity: 0 }}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : { type: "spring", bounce: 0, duration: 0.3 }
                  }
                />
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
