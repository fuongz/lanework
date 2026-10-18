import {
  Cancel01Icon,
  InformationCircleIcon,
  WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
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
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import type { BoardConflict } from "../../../../shared/workspaces";

/** How long a notice stands open before it folds into its pill (FE-63/D2a). */
const OPEN_MS = 5000;
const CONFLICT_TITLE = "Someone else changed this card";

/**
 * The service's own words for a lost race, as a sentence — or "" when they
 * only repeat the heading.
 *
 * ⚠️ They arrive as the API's 409 `error`, which may be lowercase with no full
 * stop ("that card changed since you read it"), and the island runs its own
 * sentence on after them; the app's fallback is the heading itself.
 */
function conflictLead(message: string): string {
  const said = message.trim();
  if (!said || said.replace(/[.!?]+$/, "") === CONFLICT_TITLE) return "";
  const sentence = said.charAt(0).toUpperCase() + said.slice(1);
  return /[.!?]$/.test(sentence) ? `${sentence} ` : `${sentence}. `;
}
const LOAD_TITLE = "Could not load this board";
const OFFLINE_TITLE = "Offline";
const OFFLINE_TEXT = "Showing a saved board. Changes will not save.";

interface Notice {
  error: string | null;
  conflict: BoardConflict | null;
  /** Whether a board is on screen: without one, an error is a failed READ. */
  hasView: boolean;
  /** The board on screen is the saved copy: the service could not be reached. */
  offline: boolean;
}

/**
 * The board's notice, or null: a write that failed or lost a race, or a saved
 * board shown offline, while a project is open.
 *
 * ⚠️ Only under `/w/$slug` and only once the project resolved — as the banner
 * it replaces was. With no project the layout draws its own full-page error
 * ("Could not open this project"), and the island saying it again over that
 * is the same sentence twice.
 */
export function useBoardNotice(): Notice | null {
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const error = useBoard((state) => state.error);
  const conflict = useBoard((state) => state.conflict);
  const hasView = useBoard((state) => state.view !== null);
  const offline = useBoard((state) => state.view?.stale === true);
  const ready = useBoard(
    (state) => state.active !== null && state.active.id !== null,
  );
  if (!slug || !ready || (!error && !conflict && !offline)) return null;
  return { error, conflict, hasView, offline };
}

/**
 * A board notice as an island (FE-63): the black capsule of the harness island
 * (FE-61), in the same place, saying a change did not save or lost a race.
 *
 * ⚠️ It ARRIVES OPEN, unlike the harness island — this is the answer to
 * something somebody just did — and folds into its pill after `OPEN_MS`. The
 * pill stays until Dismiss: a failed write that vanished by itself would take
 * the only record of it with it. A pointer over it, or focus in it, holds it
 * open.
 *
 * ⚠️ Offline is a condition of the window, not something that happened once
 * (it was a red bar across the pane): it arrives open like the rest, but its
 * pill has no Dismiss and stays for as long as the board is the saved copy. A
 * failed write or a lost race speaks over it while both are up.
 *
 * ⚠️ Opening by itself never takes focus, and Escape is heard only from inside
 * it: a document-wide Escape for five seconds would close the dialog or the
 * issue somebody was in.
 */
export function BoardNoticeIsland({ notice }: { notice: Notice | null }) {
  const dismiss = useBoard((state) => state.dismiss);
  const [open, setOpen] = useState(true);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const island = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion() ?? false;
  // The last notice, kept for the island's way out: dismissed, it shrinks
  // away still saying what it said rather than going blank first.
  const last = useRef<Notice | null>(null);
  if (notice) last.current = notice;
  const shown = notice ?? last.current;
  const error = notice?.error ?? null;
  const conflict = notice?.conflict ?? null;
  const offline = notice?.offline ?? false;

  const fold = (after: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setOpen(false);
      setPinned(false);
    }, after);
  };
  const hold = () => window.clearTimeout(timer.current);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A new notice — a new failure, a new lost race, going offline — arrives
  // open again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fold` is fresh each render and only reads refs.
  useEffect(() => {
    if (!error && !conflict && !offline) return;
    setOpen(true);
    setPinned(false);
    fold(OPEN_MS);
  }, [error, conflict, offline]);

  // Open: a press anywhere else folds it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (island.current?.contains(event.target as Node)) return;
      window.clearTimeout(timer.current);
      setOpen(false);
      setPinned(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const visible = notice !== null;
  const view = open ? "panel" : "pill";
  return (
    <div
      data-testid="board-notice-host"
      className={ISLAND_HOST}
      style={{ top: ISLAND_HOST_TOP }}
    >
      {/* ⚠️ Worded apart from what the island shows, so the sentence on
          screen is found once. */}
      <p className="sr-only" role="alert">
        {error ? `Board: ${error}` : ""}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {conflict
          ? "Your change was not applied: the card changed on the board."
          : ""}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {offline ? "Offline: changes to this board will not save." : ""}
      </p>
      <AnimatePresence initial={false} mode="popLayout">
        {visible && (
          <motion.div
            key={reduced ? view : "island"}
            ref={island}
            data-testid="board-notice-island"
            data-state={
              shown?.conflict ? "conflict" : shown?.error ? "error" : "offline"
            }
            data-view={view}
            layout={!reduced}
            transition={reduced ? { duration: 0.2 } : ISLAND_MORPH}
            initial={{ opacity: 0, scale: reduced ? 1 : 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reduced ? 1 : 0.7 }}
            style={{
              borderRadius: open ? ISLAND_PANEL_RADIUS : ISLAND_PILL_RADIUS,
            }}
            onPointerEnter={() => {
              hold();
              setOpen(true);
            }}
            onPointerLeave={() => {
              if (!pinned) fold(ISLAND_LEAVE_MS);
            }}
            onFocus={hold}
            onBlur={(event) => {
              if (pinned || island.current?.contains(event.relatedTarget))
                return;
              fold(ISLAND_LEAVE_MS);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              hold();
              setOpen(false);
              setPinned(false);
            }}
            className={ISLAND_SURFACE}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={view}
                layout={reduced ? false : "position"}
                initial={{ opacity: 0, filter: "blur(4px)" }}
                animate={{ opacity: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, filter: "blur(4px)" }}
                transition={ISLAND_SWAP}
              >
                {open && shown ? (
                  <Panel
                    notice={shown}
                    focus={pinned}
                    onDismiss={() => {
                      hold();
                      dismiss();
                    }}
                  />
                ) : shown ? (
                  <Pill
                    notice={shown}
                    onOpen={() => {
                      hold();
                      setPinned(true);
                      setOpen(true);
                    }}
                  />
                ) : null}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type Kind = "error" | "conflict" | "offline";

const GLYPH = {
  error: Cancel01Icon,
  conflict: InformationCircleIcon,
  offline: WifiDisconnected01Icon,
};

function Glyph({ kind, className }: { kind: Kind; className?: string }) {
  return (
    <HugeiconsIcon
      icon={GLYPH[kind]}
      className={cn(
        "size-3.5 shrink-0",
        kind === "conflict" ? "text-white/70" : "text-red-400",
        className,
      )}
      strokeWidth={kind === "error" ? 2.4 : 2}
      aria-hidden="true"
    />
  );
}

/**
 * The folded capsule, in one line.
 *
 * ⚠️ A lost race speaks for the pill when both are up (FE-63/D4): it is the
 * one that carries somebody else's change, and the panel shows both anyway.
 */
function Pill({ notice, onOpen }: { notice: Notice; onOpen: () => void }) {
  const kind: Kind = notice.conflict
    ? "conflict"
    : notice.error
      ? "error"
      : "offline";
  const text =
    kind === "conflict"
      ? CONFLICT_TITLE
      : kind === "offline"
        ? OFFLINE_TITLE
        : notice.hasView
          ? (notice.error ?? "")
          : LOAD_TITLE;
  const more =
    [notice.conflict, notice.error, notice.offline].filter(Boolean).length - 1;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={false}
      aria-label={`${text.replace(/\.$/, "")}. Show details.`}
      className="flex h-7 max-w-[min(360px,calc(100vw-48px))] items-center gap-1.5 rounded-[inherit] pr-2.5 pl-2 text-[12px] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <Glyph kind={kind} />
      <span className="truncate">{text}</span>
      {more > 0 && <span className="text-white/50">+{more}</span>}
    </button>
  );
}

/** The open island: what happened, in full, and Dismiss. */
function Panel({
  notice,
  focus,
  onDismiss,
}: {
  notice: Notice;
  /** Opened by a click or the keyboard: take focus, since the pill is gone. */
  focus: boolean;
  onDismiss: () => void;
}) {
  const self = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus) self.current?.focus({ preventScroll: true });
  }, [focus]);
  const { conflict, error, hasView, offline } = notice;
  return (
    <section
      ref={self}
      tabIndex={-1}
      aria-label="Board notice"
      className="flex w-[min(380px,calc(100vw-32px))] flex-col gap-3 p-4 pt-3.5 outline-none select-text"
    >
      {conflict && (
        <div className="flex items-start gap-2">
          <Glyph kind="conflict" className="mt-0.5" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-[13px] font-semibold tracking-tight">
              {CONFLICT_TITLE}
            </h2>
            <p className="line-clamp-4 text-[12px] text-white/70">
              {conflictLead(conflict.message)}The board now shows “
              {conflict.current.title}”. Your change was not applied.
            </p>
          </div>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2">
          <Glyph kind="error" className="mt-0.5" />
          {/* ⚠️ No "That did not save" over the message (FE-63/D3): the
              message already says what failed, and a READ that failed while a
              board was on screen got headed as a lost edit. Only with no board
              to show is there a heading, because then nothing else says it. */}
          {hasView ? (
            <p className="line-clamp-4 text-[13px] text-white/90">{error}</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="text-[13px] font-semibold tracking-tight">
                {LOAD_TITLE}
              </h2>
              <p className="line-clamp-4 text-[12px] text-white/70">{error}</p>
            </div>
          )}
        </div>
      )}
      {offline && (
        <div className="flex items-start gap-2">
          <Glyph kind="offline" className="mt-0.5" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-[13px] font-semibold tracking-tight">
              {OFFLINE_TITLE}
            </h2>
            <p className="text-[12px] text-white/70">{OFFLINE_TEXT}</p>
          </div>
        </div>
      )}
      {/* ⚠️ Nothing to dismiss when only offline: it ends when the board does. */}
      {(conflict || error) && (
        <div className="flex justify-end">
          <Button
            onClick={onDismiss}
            className="h-7 rounded-full bg-white/[0.14] px-3 text-[12px] text-white hover:bg-white/[0.22] focus-visible:ring-white/40"
          >
            Dismiss
          </Button>
        </div>
      )}
    </section>
  );
}
