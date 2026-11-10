import type { ReactNode } from "react";
import { create } from "zustand";
import {
  announceIsland,
  ISLAND_PRIORITY,
  type IslandRenderContext,
  registerIsland,
  setIslandOpen,
} from "./island";
import { playNotifySound } from "./notify.sound";

export type NotifyType = "success" | "error" | "warning" | "info" | "loading";

/**
 * What a button's `onClick` may hand back: a patch morphs the toast into it,
 * nothing (or a promise of nothing) closes the toast.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: a plain handler returns void, and that must mean "close".
type NotifyClickResult = NotifyPatch | undefined | void;

export interface NotifyButton {
  label: string;
  onClick: () => NotifyClickResult | Promise<NotifyClickResult>;
}

export interface NotifyOptions {
  /** Second line, shown when the toast is open. */
  description?: string;
  /** The main button. A toast with a button stays until dismissed. */
  action?: NotifyButton;
  /** A quieter button beside the action. */
  secondary?: NotifyButton;
  /** Small trailing text, such as "now" or "⌘V". */
  meta?: string;
  /** 0 to 1 draws a thin bar along the bottom; null removes it. */
  progress?: number | null;
  /** Milliseconds before it closes; 0 keeps it until dismissed. */
  duration?: number;
  /** Reuse an id so repeated calls from one place update one toast. */
  id?: string;
}

/** A change to the live toast; a key present, even as undefined, replaces. */
export interface NotifyPatch extends Omit<NotifyOptions, "id"> {
  type?: NotifyType;
  title?: string;
}

/** One message of {@link notify.promise}: a title, or a title and options. */
export type NotifyMessage = string | (NotifyOptions & { title: string });

/** The island content id every toast shares, so a new one morphs in place. */
export const NOTIFY_ISLAND_ID = "notify";
/** How long a toast stays when the caller names no duration. */
export const NOTIFY_DURATION_MS = 5000;

export interface Toast {
  id: string;
  type: NotifyType;
  title: string;
  description?: string;
  action?: NotifyButton;
  secondary?: NotifyButton;
  meta?: string;
  progress: number | null;
  duration: number;
  /** How many identical calls in a row it stands for: "×3". */
  count: number;
}

/** The one live toast, for its renders. */
export const useNotify = create<{ toast: Toast | null }>(() => ({
  toast: null,
}));

let nextId = 0;
let unregister: (() => void) | null = null;

/**
 * Errors, loading and toasts with a button stay until dismissed; so does a
 * duration of 0. Anything else closes on its timer.
 */
export function isSticky(toast: Toast): boolean {
  return (
    toast.duration <= 0 ||
    toast.type === "error" ||
    toast.type === "loading" ||
    toast.action !== undefined ||
    toast.secondary !== undefined
  );
}

/**
 * The longest title the pill shows whole. Past it the pill cuts the title
 * short, so the toast gets a panel that reads it in full.
 */
const PILL_TITLE_MAX = 48;

export function hasPanel(toast: Toast): boolean {
  return !!(
    toast.description ||
    toast.action ||
    toast.secondary ||
    toast.title.length > PILL_TITLE_MAX
  );
}

export function sentence(text: string): string {
  const said = text.trim();
  return /[.!?…]$/.test(said) ? said : `${said}.`;
}

/** Say the toast through the host's live regions: errors interrupt. */
function speak(toast: Toast): void {
  const text = toast.description
    ? `${sentence(toast.title)} ${sentence(toast.description)}`
    : sentence(toast.title);
  announceIsland(text, toast.type === "error" ? "assertive" : "polite");
}

// ── The timer ──────────────────────────────────────────────────────────────
//
// One timer for the one toast. Held (a pointer over the island, or focus in
// it) it stops and keeps what was left; let go, it runs the rest.

let timer: number | undefined;
let remaining = 0;
let startedAt = 0;
let held = false;

function stopTimer(): void {
  window.clearTimeout(timer);
  timer = undefined;
}

function runTimer(): void {
  stopTimer();
  if (held || remaining <= 0) return;
  startedAt = Date.now();
  timer = window.setTimeout(expire, remaining);
}

/**
 * Start the toast's time over.
 *
 * A toast that closes gets its duration. A sticky one with a panel gets
 * {@link NOTIFY_DURATION_MS} before it folds into its pill, as the board
 * notice does: it stays, but stops covering the top of the window.
 */
function restartTimer(toast: Toast): void {
  remaining = isSticky(toast)
    ? hasPanel(toast)
      ? NOTIFY_DURATION_MS
      : 0
    : toast.duration;
  runTimer();
}

function expire(): void {
  timer = undefined;
  remaining = 0;
  const toast = useNotify.getState().toast;
  if (!toast) return;
  if (isSticky(toast)) setIslandOpen(NOTIFY_ISLAND_ID, false);
  else dismiss(toast.id);
}

function hold(next: boolean): void {
  if (next === held) return;
  held = next;
  if (next) {
    if (timer === undefined) return;
    stopTimer();
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
  } else runTimer();
}

// ── The island content ─────────────────────────────────────────────────────

/**
 * How the toast is drawn, set once by the shell's notify island.
 *
 * NOTE: Injected rather than imported: a store may not import components
 * (the layout audit), and the toast's look is a component.
 */
let renders: {
  pill: (context: IslandRenderContext) => ReactNode;
  panel: (context: IslandRenderContext) => ReactNode;
} = { pill: () => null, panel: () => null };

/** Hand the store the toast's pill and panel renders. */
export function bindNotifyRenders(next: typeof renders): void {
  renders = next;
}

/**
 * Put the toast on the island, or take it off.
 *
 * @param reopen a new toast, or one whose words changed: it arrives open when
 *   it has more to say than its title.
 */
function publish(toast: Toast | null, reopen: boolean): void {
  if (!toast) {
    unregister?.();
    unregister = null;
    return;
  }
  const panel = hasPanel(toast);
  unregister = registerIsland({
    id: NOTIFY_ISLAND_ID,
    priority: ISLAND_PRIORITY.notify,
    tone: toast.type,
    label: "Notification",
    pill: (context) => renders.pill(context),
    panel: panel ? (context) => renders.panel(context) : undefined,
    open: panel,
    swapKey: `${toast.id}:${toast.type}:${toast.title}`,
    progress: toast.progress,
    onEscape: () => dismiss(),
    onHold: hold,
  });
  if (reopen) setIslandOpen(NOTIFY_ISLAND_ID, panel);
}

/** Two calls say the same thing: the second is a repeat, not news. */
function same(a: Toast, b: Toast): boolean {
  return (
    a.type === b.type &&
    a.title === b.title &&
    a.description === b.description &&
    a.meta === b.meta &&
    a.action?.label === b.action?.label &&
    a.secondary?.label === b.secondary?.label
  );
}

function clampProgress(value: number | null | undefined): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function show(
  type: NotifyType,
  title: string,
  options: NotifyOptions = {},
): string {
  const current = useNotify.getState().toast;
  const next: Toast = {
    id: options.id ?? `notify-${++nextId}`,
    type,
    title,
    description: options.description,
    action: options.action,
    secondary: options.secondary,
    meta: options.meta,
    progress: clampProgress(options.progress),
    duration: options.duration ?? NOTIFY_DURATION_MS,
    count: 1,
  };
  const repeat =
    current !== null &&
    (options.id === undefined || options.id === current.id) &&
    same(current, next);
  if (repeat) {
    next.id = current.id;
    next.count = current.count + 1;
  }
  // The same id with other words is that toast moving on, not a new one: it
  // sounds only when its status changed.
  const moved = !repeat && current !== null && current.id === next.id;
  useNotify.setState({ toast: next });
  publish(next, true);
  restartTimer(next);
  if (!moved || current?.type !== next.type) playNotifySound(next.type);
  speak(next);
  return next.id;
}

function apply(id: string, patch: NotifyPatch): void {
  const current = useNotify.getState().toast;
  if (!current || current.id !== id) return;
  const next: Toast = { ...current, ...patch, id, count: current.count };
  if (patch.type === undefined) next.type = current.type;
  if (patch.title === undefined) next.title = current.title;
  if (patch.duration === undefined) next.duration = current.duration;
  next.progress =
    "progress" in patch ? clampProgress(patch.progress) : current.progress;
  const status = next.type !== current.type;
  const words =
    next.title !== current.title || next.description !== current.description;
  if (status || next.title !== current.title) next.count = 1;
  const buttons =
    next.action !== current.action || next.secondary !== current.secondary;
  useNotify.setState({ toast: next });
  publish(next, status || words);
  if (status || words || buttons || next.duration !== current.duration)
    restartTimer(next);
  // NOTE: Progress alone neither sounds nor speaks: a bar moving every few
  // hundred milliseconds would chirp and talk over everything.
  if (status) playNotifySound(next.type);
  if (status || words) speak(next);
}

/**
 * Close the toast.
 *
 * @param id close only if it is still this toast; none closes whatever shows.
 */
export function dismiss(id?: string): void {
  const current = useNotify.getState().toast;
  if (!current || (id !== undefined && id !== current.id)) return;
  stopTimer();
  remaining = 0;
  held = false;
  useNotify.setState({ toast: null });
  publish(null, false);
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

/**
 * A button was pressed: morph into the patch it returns, or close.
 *
 * A patch drops both buttons unless it names them again, so a toast never
 * keeps offering the thing that was just done.
 */
export async function press(id: string, button: NotifyButton): Promise<void> {
  const result = button.onClick();
  const patch = isThenable<NotifyClickResult>(result) ? await result : result;
  // A newer toast took the island while the click was settling: leave it.
  if (useNotify.getState().toast?.id !== id) return;
  if (patch) apply(id, { action: undefined, secondary: undefined, ...patch });
  else dismiss(id);
}

function message<T>(
  value: NotifyMessage | ((input: T) => NotifyMessage),
  input: T,
): NotifyPatch {
  const said = typeof value === "function" ? value(input) : value;
  if (typeof said === "string") return { title: said };
  const { id: _id, ...rest } = said;
  return rest;
}

/**
 * Show a toast on the island. Only one is live at a time: a new call morphs
 * it, and the same call again counts "×2".
 *
 * - Success, warning and info close after `duration` (default
 *   {@link NOTIFY_DURATION_MS}). Errors, loading, a button or a duration of
 *   0 keep it until dismissed; one with more to say than its title folds
 *   into its pill after the same time instead.
 * - Hover and keyboard focus pause the timer. Escape inside dismisses it,
 *   and Alt+T moves focus into it (the host's keys).
 * - It sits below every other island and above the harness pill
 *   ({@link ISLAND_PRIORITY}): a toast never covers an open microphone or a
 *   failed write. Its timer runs while it waits underneath, so a passing
 *   "Saved" is not shown a minute late; a sticky one is still there.
 *
 * @returns the toast's id, for {@link notify.update} and {@link notify.dismiss}.
 */
export function notify(
  type: NotifyType,
  title: string,
  options?: NotifyOptions,
): string {
  return show(type, title, options);
}

/**
 * Change the live toast in place. Ignored once another toast took its place:
 * only the newest caller may update the shared toast.
 */
notify.update = (id: string, patch: NotifyPatch): void => apply(id, patch);

/** Close the toast with this id, or whichever is live. */
notify.dismiss = (id?: string): void => dismiss(id);

/**
 * One toast from loading to its result.
 *
 * `success` and `error` may be functions of the value or the error. The
 * result replaces the loading toast's description, meta and buttons rather
 * than keeping them, and drops its progress bar.
 *
 * @returns the toast's id.
 */
notify.promise = <T>(
  promise: Promise<T>,
  messages: {
    loading: NotifyMessage;
    success: NotifyMessage | ((value: T) => NotifyMessage);
    error: NotifyMessage | ((error: unknown) => NotifyMessage);
  },
): string => {
  const { title, ...options } =
    typeof messages.loading === "string"
      ? { title: messages.loading }
      : messages.loading;
  const id = show("loading", title, options);
  const settle = (type: NotifyType, patch: NotifyPatch) =>
    apply(id, {
      description: undefined,
      action: undefined,
      secondary: undefined,
      meta: undefined,
      progress: null,
      duration: NOTIFY_DURATION_MS,
      ...patch,
      type,
    });
  promise.then(
    (value) => settle("success", message(messages.success, value)),
    (error: unknown) => settle("error", message(messages.error, error)),
  );
  return id;
};
