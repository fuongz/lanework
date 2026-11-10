import {
  Cancel01Icon,
  InformationCircleIcon,
  WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { ISLAND_LEAVE_MS } from "#/components/shared/agents/harness-island";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import {
  announceIsland,
  ISLAND_PRIORITY,
  type IslandTone,
  setIslandOpen,
  useIsland,
  useIslandContent,
  useIslandFoldOutside,
  useIslandShowing,
} from "#/stores/island";
import type { BoardConflict } from "../../../../shared/projects";

/** How long a notice stays open before it folds into its pill (FE-63/D2a). */
const OPEN_MS = 5000;
const CONFLICT_TITLE = "Someone else changed this card";

/**
 * The service's own words for a lost race, as a sentence, or "" when they
 * only repeat the heading.
 *
 * They arrive as the API's 409 `error`, which may be lowercase with no full
 * stop ("that card changed since you read it"), and the island runs its own
 * sentence on after them. The app's fallback is the heading itself.
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
  /** Whether a board is on screen: without one, an error is a failed read. */
  hasView: boolean;
  /** The board on screen is the saved copy: the service was unreachable. */
  offline: boolean;
}

/**
 * The board's notice while a project is open: a write that failed or lost a
 * race, or a saved board shown offline.
 *
 * Only under `/w/$slug`, and only once the project resolved. With no project
 * the layout draws its own full-page error ("Could not open this project"),
 * and the island saying it again over that is the same sentence twice.
 *
 * @returns null when there is nothing to say.
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

const BOARD_NOTICE_ISLAND_ID = "boardNotice";

/** Its kind, as the specs read it: a lost race speaks over the rest. */
function kindOf(notice: Notice): Kind {
  return notice.conflict ? "conflict" : notice.error ? "error" : "offline";
}

const TONE: Record<Kind, IslandTone> = {
  conflict: "neutral",
  error: "error",
  offline: "warning",
};

/**
 * The board's notice on the island: a change did not save or lost a race.
 *
 * - It arrives open, unlike the harness offer, since it answers something
 *   somebody just did, and folds into its pill after `OPEN_MS`. The pill
 *   stays until Dismiss: a failed write that vanished by itself would take
 *   the only record of it along. A pointer over it, or focus in it, holds it
 *   open; a press outside folds it.
 * - Offline is a condition of the window, not something that happened once.
 *   It arrives open like the rest, but its pill has no Dismiss and stays as
 *   long as the board is the saved copy. A failed write or a lost race
 *   speaks over it while both are up.
 * - Only an open microphone outranks it ({@link ISLAND_PRIORITY}); while one
 *   has the island it says nothing, and it arrives open again after.
 * - NOTE: Opening by itself never takes focus, and Escape is heard only from
 *   inside it. A document-wide Escape for five seconds would close the
 *   dialog or the issue somebody was in.
 *
 * Draws nothing itself: `<IslandHost/>` in the shell does.
 */
export function BoardNoticeIsland() {
  const notice = useBoardNotice();
  const dismiss = useBoard((state) => state.dismiss);
  const showing = useIslandShowing(BOARD_NOTICE_ISLAND_ID);
  const timer = useRef<number | undefined>(undefined);
  useIslandFoldOutside(BOARD_NOTICE_ISLAND_ID);
  // What it says while it has the island; nothing while it waits under one.
  const error = showing ? (notice?.error ?? null) : null;
  const conflict = showing ? (notice?.conflict ?? null) : null;
  const offline = showing ? (notice?.offline ?? false) : false;

  const fold = (after: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => setIslandOpen(BOARD_NOTICE_ISLAND_ID, false),
      after,
    );
  };
  const hold = () => window.clearTimeout(timer.current);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A new notice (a new failure, a new lost race, going offline) arrives open
  // again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fold` is fresh each render and only reads refs.
  useEffect(() => {
    if (!error && !conflict && !offline) return;
    setIslandOpen(BOARD_NOTICE_ISLAND_ID, true);
    fold(OPEN_MS);
  }, [error, conflict, offline]);

  // Worded apart from what the island shows, so the sentence on screen is
  // found once. A failed write interrupts; the rest wait their turn.
  const alert = error ? `Board: ${error}` : "";
  useEffect(() => {
    if (alert) announceIsland(alert, "assertive");
  }, [alert]);
  const raced = conflict
    ? "Your change was not applied: the card changed on the board."
    : "";
  const saved = offline ? "Offline: changes to this board will not save." : "";
  const said = useRef({ raced: "", saved: "" });
  useEffect(() => {
    // Said together when both change at once, since one would replace the
    // other in the host's polite region.
    const fresh = [
      raced !== said.current.raced ? raced : "",
      saved !== said.current.saved ? saved : "",
    ].filter(Boolean);
    said.current = { raced, saved };
    if (fresh.length > 0) announceIsland(fresh.join(" "));
  }, [raced, saved]);

  useIslandContent(
    notice
      ? {
          id: BOARD_NOTICE_ISLAND_ID,
          priority: ISLAND_PRIORITY.boardNotice,
          tone: TONE[kindOf(notice)],
          label: "Board notice",
          open: true,
          attributes: {
            "data-testid": "board-notice-island",
            "data-state": kindOf(notice),
          },
          onHold: (held) => {
            if (held) hold();
            else if (!useIsland.getState().pinned[BOARD_NOTICE_ISLAND_ID])
              fold(ISLAND_LEAVE_MS);
          },
          onEscape: () => {
            hold();
            setIslandOpen(BOARD_NOTICE_ISLAND_ID, false);
          },
          pill: (context) => (
            <Pill
              notice={notice}
              onOpen={() => {
                hold();
                context.setOpen(true, true);
              }}
            />
          ),
          panel: () => (
            <Panel
              notice={notice}
              onDismiss={() => {
                hold();
                dismiss();
              }}
            />
          ),
        }
      : null,
  );
  return null;
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
 * A lost race speaks for the pill when both are up (FE-63/D4): it is the one
 * that carries somebody else's change, and the panel shows both anyway.
 */
function Pill({ notice, onOpen }: { notice: Notice; onOpen: () => void }) {
  const kind = kindOf(notice);
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
  onDismiss,
}: {
  notice: Notice;
  onDismiss: () => void;
}) {
  const { conflict, error, hasView, offline } = notice;
  return (
    <section
      aria-label="Board notice"
      className="flex w-[min(380px,calc(100vw-32px))] flex-col gap-3 p-4 pt-3.5 select-text"
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
          {/* No "That did not save" over the message (FE-63/D3): the message
              already says what failed, and a read that failed while a board
              is on screen would be headed as a lost edit. Only with no board
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
      {/* Nothing to dismiss when only offline: it ends when the board does. */}
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
