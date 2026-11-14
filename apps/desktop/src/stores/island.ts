import { type ReactNode, useEffect } from "react";
import { create } from "zustand";

/**
 * Who wins the island, highest first.
 *
 * The order the shell's `yieldTo` props used to encode, as numbers, so a
 * new content slots in without touching the others:
 *
 * | Content          | Priority | Why it ranks there                          |
 * | ---------------- | -------- | ------------------------------------------- |
 * | `dictation`      | 500      | An open microphone nobody noticed.          |
 * | `boardNotice`    | 400      | A write the user just made did not save.    |
 * | `awaiting`       | 300      | An agent stopped and waits on the person.   |
 * | `claudeAuth`     | 250      | Claude refused a turn: sign in again.       |
 * | `mcpAuth`        | 200      | An agent lost its Lanework sign-in.         |
 * | `notify`         | 150      | A toast from `notify()`.                    |
 * | `update`         | 120      | A newer Lanework is out, or ready.          |
 * | `harness`        | 100      | A newer Claude Code or Codex is out.        |
 *
 * Gaps of 50 or more leave room between neighbours.
 */
export const ISLAND_PRIORITY = {
  dictation: 500,
  boardNotice: 400,
  awaiting: 300,
  claudeAuth: 250,
  mcpAuth: 200,
  notify: 150,
  update: 120,
  harness: 100,
} as const;

/** The colour a content speaks in: its glyph, its progress bar. */
export type IslandTone =
  | "neutral"
  | "success"
  | "error"
  | "warning"
  | "info"
  | "loading";

/** What the host hands a content's renders. */
export interface IslandRenderContext {
  /** Whether the panel is showing; false is the pill. */
  open: boolean;
  /**
   * Opened by a click or the keyboard rather than a pointer passing over.
   * The host has moved focus into the surface, and a press outside folds it.
   */
  pinned: boolean;
  /**
   * Open or fold this content.
   *
   * @param pin true for an open the user asked for (a click, Enter): focus
   *   moves into the panel, since the pill they pressed is gone.
   */
  setOpen: (open: boolean, pin?: boolean) => void;
  /** `prefers-reduced-motion`, as the host read it. */
  reduced: boolean;
}

/** One thing the island can show. */
export interface IslandContent {
  /** Stable for the life of the content; registering it again updates it. */
  id: string;
  /** Higher wins; see {@link ISLAND_PRIORITY}. Ties go to the newest. */
  priority: number;
  tone: IslandTone;
  /** The surface's accessible name, e.g. "Harness updates". */
  label: string;
  /** The folded capsule, one line. */
  pill: (context: IslandRenderContext) => ReactNode;
  /** The open island. Without one, the content is always a pill. */
  panel?: (context: IslandRenderContext) => ReactNode;
  /** Whether it starts open the first time it registers. Default false. */
  open?: boolean;
  /** Whether a pointer passing over opens the panel. Default true. */
  openOnHover?: boolean;
  /**
   * Changes when what the content says changes, so the host crossfades it
   * rather than swapping text under a still frame. Defaults to the id.
   */
  swapKey?: string;
  /** 0 to 1 draws a thin bar along the bottom; null or absent draws none. */
  progress?: number | null;
  /** The pill's corner radius, when the default reads wrong for its height. */
  pillRadius?: number;
  /** Escape from inside the surface. Without it, Escape folds the panel. */
  onEscape?: () => void;
  /**
   * The pointer or focus came in (true) or left (false); a content with a
   * timer pauses it while held.
   */
  onHold?: (held: boolean) => void;
  /**
   * Extra `data-*` attributes for the surface while this content shows, such
   * as the `data-testid` and `data-state` the specs look for. The host's own
   * `data-island`, `data-tone` and `data-view` win over these.
   */
  attributes?: Record<`data-${string}`, string | number | undefined>;
}

interface Entry {
  content: IslandContent;
  /** Registration order: a tie in priority goes to the newer. */
  seq: number;
}

/** A sentence for the host's live regions; `n` makes a repeat speak again. */
export interface IslandAnnouncement {
  text: string;
  n: number;
}

interface IslandState {
  entries: Record<string, Entry>;
  /** Each content's own open state, by id. Gone with the content. */
  open: Record<string, boolean>;
  /** Each content's pinned state, by id: see {@link IslandRenderContext}. */
  pinned: Record<string, boolean>;
  polite: IslandAnnouncement;
  assertive: IslandAnnouncement;
}

/**
 * The contents competing for the island, for `<IslandHost/>` to pick from.
 *
 * Each island used to draw its own capsule and step aside through `yieldTo`
 * props. Here they register what they would say, and the host shows the
 * highest priority in one surface that morphs between them.
 */
export const useIsland = create<IslandState>(() => ({
  entries: {},
  open: {},
  pinned: {},
  polite: { text: "", n: 0 },
  assertive: { text: "", n: 0 },
}));

let nextSeq = 0;

/**
 * Add a content to the island, or update the one with its id.
 *
 * An update keeps the content's place among equals and its open state; only
 * the first registration reads `content.open`.
 *
 * @returns unregister. It removes only this registration: once the id was
 *   unregistered and registered again, an old unregister does nothing.
 */
export function registerIsland(content: IslandContent): () => void {
  const before = useIsland.getState().entries[content.id];
  const seq = before?.seq ?? ++nextSeq;
  useIsland.setState((state) => ({
    entries: { ...state.entries, [content.id]: { content, seq } },
    ...(before
      ? {}
      : {
          open: { ...state.open, [content.id]: content.open ?? false },
          pinned: { ...state.pinned, [content.id]: false },
        }),
  }));
  return () => {
    if (useIsland.getState().entries[content.id]?.seq === seq)
      removeIsland(content.id);
  };
}

/** Drop a content and its open state, whoever registered it. */
function removeIsland(id: string): void {
  if (!useIsland.getState().entries[id]) return;
  useIsland.setState((state) => {
    const { [id]: _entry, ...entries } = state.entries;
    const { [id]: _open, ...open } = state.open;
    const { [id]: _pinned, ...pinned } = state.pinned;
    return { entries, open, pinned };
  });
}

/**
 * Keep a content on the island while the calling component is mounted.
 *
 * Pass null while there is nothing to say. The content is registered again
 * on every render, so its renders always close over current props; the
 * registration itself follows the id, and unmounting removes it.
 */
export function useIslandContent(content: IslandContent | null): void {
  const id = content?.id ?? null;
  // NOTE: No dependency list on purpose: every render publishes the latest
  // renders. It cannot loop, because an update changes `entries` only and the
  // caller does not read that.
  useEffect(() => {
    if (content) registerIsland(content);
  });
  useEffect(() => {
    if (id === null) return;
    return () => removeIsland(id);
  }, [id]);
}

/**
 * Open or fold a content by id. A content not registered is left alone.
 *
 * @param pin see {@link IslandRenderContext.setOpen}. Folding always unpins.
 */
export function setIslandOpen(id: string, open: boolean, pin = false): void {
  const state = useIsland.getState();
  if (!state.entries[id]) return;
  const pinned = open && pin;
  if (state.open[id] === open && state.pinned[id] === pinned) return;
  useIsland.setState({
    open: { ...state.open, [id]: open },
    pinned: { ...state.pinned, [id]: pinned },
  });
}

/** Whether a content's panel is open; false while it is not registered. */
export function useIslandOpen(id: string): boolean {
  return useIsland((state) => state.open[id] ?? false);
}

/**
 * Whether this content is the one the island shows now.
 *
 * A boolean on purpose: a content that read the winning object would render
 * again on each of its own registrations, and register again, forever.
 */
export function useIslandShowing(id: string): boolean {
  return useIsland((state) => pickIsland(state.entries)?.id === id);
}

/**
 * While this content shows with its panel open, fold it on a press outside
 * the island and, with `escapeAnywhere`, on Escape anywhere in the window.
 *
 * The host folds on an outside press only a panel the user pinned, and hears
 * Escape only from inside. A content that folded on either before it moved
 * onto the host (its panel opens by itself, or Escape anywhere closed it)
 * keeps doing so with this. The Escape is not consumed: a dialog under the
 * island still gets it.
 */
export function useIslandFoldOutside(
  id: string,
  { escapeAnywhere = false }: { escapeAnywhere?: boolean } = {},
): void {
  const active = useIsland(
    (state) =>
      (state.open[id] ?? false) && pickIsland(state.entries)?.id === id,
  );
  useEffect(() => {
    if (!active) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest(`[data-island="${CSS.escape(id)}"]`) !== null;
    const onDown = (event: PointerEvent) => {
      if (!inside(event.target)) setIslandOpen(id, false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIslandOpen(id, false);
    };
    document.addEventListener("pointerdown", onDown);
    if (escapeAnywhere) document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, id, escapeAnywhere]);
}

/** The content that wins: highest priority, then the newest. */
export function pickIsland(
  entries: Record<string, Entry>,
): IslandContent | null {
  let best: Entry | null = null;
  for (const entry of Object.values(entries))
    if (
      !best ||
      entry.content.priority > best.content.priority ||
      (entry.content.priority === best.content.priority && entry.seq > best.seq)
    )
      best = entry;
  return best?.content ?? null;
}

/** The content the host shows now, or null. */
export function useTopIsland(): IslandContent | null {
  return useIsland((state) => pickIsland(state.entries));
}

/**
 * Say a sentence through the host's live regions.
 *
 * - `assertive` is for errors only: it interrupts whatever the screen reader
 *   was reading. Everything else is `polite`.
 * - The regions belong to the host and stay mounted, so a sentence said in
 *   the same tick a content appears is not lost to a region that did not
 *   exist yet.
 */
export function announceIsland(
  text: string,
  politeness: "polite" | "assertive" = "polite",
): void {
  useIsland.setState((state) => ({
    [politeness]: { text, n: state[politeness].n + 1 },
  }));
}
