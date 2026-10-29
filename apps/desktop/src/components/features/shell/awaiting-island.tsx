import { useNavigate, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AGENT_LABELS } from "#/../shared/conversation";
import {
  HarnessIcon,
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
import { useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { type AwaitingEntry, useAwaiting } from "#/stores/awaiting";
import { useBoard } from "#/stores/board";

/** How long the island stays open before it folds into its pill (FE-97/D2a). */
const OPEN_MS = 5000;

/** A waiting conversation the island can take the window to. */
interface Waiting extends AwaitingEntry {
  slug: string;
  project: string;
  /** Its title on the rail, once listed. */
  title: string | null;
}

/** "Claude is asking", or "Codex needs permission". */
function headline(entry: Waiting): string {
  const who = entry.agent ? AGENT_LABELS[entry.agent] : "An agent";
  return entry.requests[0]?.question
    ? `${who} is asking`
    : `${who} needs permission`;
}

/**
 * The conversations waiting on the person that are not on screen, oldest
 * first.
 *
 * On screen is its chat open in this window, or the terminal tab resuming
 * it: the question is already in front of the person there. A conversation
 * whose project the window does not know yet is left out, since there is no
 * page to open for it.
 */
export function useAwaitingElsewhere(): Waiting[] {
  const byKey = useAwaiting((state) => state.byKey);
  const workspaces = useBoard((state) => state.workspaces);
  const sessions = useAgentSessions((state) => state.byWorkspace);
  const terminals = useAgentTerminals((state) => state.sessions);
  const {
    slug: viewingSlug,
    conversation: viewing,
    sub,
    task,
    terminalId,
  } = useParams({ strict: false }) as {
    slug?: string;
    conversation?: string;
    sub?: string;
    task?: string;
    terminalId?: string;
  };
  return useMemo(() => {
    const out: Waiting[] = [];
    for (const entry of Object.values(byKey)) {
      const project = workspaces.find(
        (item) => (item.id ?? item.slug) === entry.workspace,
      );
      if (!project) continue;
      if (project.slug === viewingSlug) {
        if (viewing === entry.conversation && !sub && !task) continue;
        const tab = terminalId
          ? terminals[entry.workspace]?.find((item) => item.id === terminalId)
          : undefined;
        if (tab?.resume === entry.conversation) continue;
      }
      const listed = sessions[entry.workspace]?.find(
        (session) => session.id === entry.conversation,
      );
      out.push({
        ...entry,
        slug: project.slug,
        project: project.name,
        title: listed?.title ?? null,
      });
    }
    return out.sort((a, b) => a.since.localeCompare(b.since));
  }, [
    byKey,
    workspaces,
    sessions,
    terminals,
    viewingSlug,
    viewing,
    sub,
    task,
    terminalId,
  ]);
}

/**
 * An agent waiting on the person, as an island: the harness island's black
 * capsule, in the same place (FE-97).
 *
 * - Only while the conversation is not on screen: there, its own card asks.
 * - It arrives open, since nothing else says an agent stopped, and folds into
 *   its pill after `OPEN_MS`. The pill stays until every request is answered:
 *   there is no Dismiss, because a turn left waiting does not end by itself.
 *   A pointer over it, or focus in it, holds it open.
 * - Several waiting: the pill counts them, and Open takes the window to the
 *   oldest, the one waiting longest.
 * - `yieldTo`: an open microphone and a board notice outrank it. It outranks
 *   the Lanework MCP sign-in and the harness update offer, which yield to it.
 * - NOTE: Opening by itself never takes focus, as the board notice's.
 */
export function AwaitingIsland({ yieldTo = false }: { yieldTo?: boolean }) {
  const waiting = useAwaitingElsewhere();
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const island = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion() ?? false;
  const visible = waiting.length > 0 && !yieldTo;
  // The last list, kept for the island's way out: answered, it shrinks away
  // still saying what it said rather than going blank first.
  const last = useRef<Waiting[]>([]);
  if (waiting.length > 0) last.current = waiting;
  const shown = waiting.length > 0 ? waiting : last.current;
  const oldest = shown[0];

  const fold = (after: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setOpen(false);
      setPinned(false);
    }, after);
  };
  const hold = () => window.clearTimeout(timer.current);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A request it has not shown yet (a new conversation waiting, or another
  // question in one) arrives open again.
  const ids = waiting
    .flatMap((entry) => entry.requests.map((request) => request.id))
    .join(" ");
  const seen = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fold` is fresh each render and only reads refs.
  useEffect(() => {
    if (!visible) return;
    const fresh = ids.split(" ").filter((id) => id && !seen.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seen.current.add(id);
    setOpen(true);
    setPinned(false);
    fold(OPEN_MS);
  }, [ids, visible]);

  // Open: a press anywhere else folds it.
  useEffect(() => {
    if (!open || !visible) return;
    const onDown = (event: PointerEvent) => {
      if (island.current?.contains(event.target as Node)) return;
      window.clearTimeout(timer.current);
      setOpen(false);
      setPinned(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, visible]);

  const go = () => {
    if (!oldest) return;
    hold();
    setOpen(false);
    setPinned(false);
    void navigate({
      to: "/w/$slug/agents/chat/$conversation",
      params: { slug: oldest.slug, conversation: oldest.conversation },
    });
  };

  const view = open ? "panel" : "pill";
  return (
    <div
      data-testid="awaiting-host"
      className={ISLAND_HOST}
      style={{ top: ISLAND_HOST_TOP }}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {visible && oldest ? `${headline(oldest)}: ${countText(waiting)}` : ""}
      </p>
      <AnimatePresence initial={false} mode="popLayout">
        {visible && oldest && (
          <motion.div
            key={reduced ? view : "island"}
            ref={island}
            data-testid="awaiting-island"
            data-view={view}
            data-count={shown.length}
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
                {open ? (
                  <Panel waiting={shown} focus={pinned} onOpen={go} />
                ) : (
                  <Pill waiting={shown} onOpen={go} />
                )}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** "Claude is asking", or "2 sessions need you" when several wait. */
function countText(waiting: Waiting[]): string {
  const [first] = waiting;
  if (!first) return "";
  return waiting.length > 1
    ? `${waiting.length} sessions need you`
    : headline(first);
}

/** The waiting agent's mark, or a primary dot when several or unknown. */
function Mark({ waiting }: { waiting: Waiting[] }) {
  const [first] = waiting;
  if (waiting.length === 1 && first?.agent)
    return <HarnessIcon agent={first.agent} className="size-3.5 shrink-0" />;
  return (
    <span
      aria-hidden="true"
      className="bg-primary size-2 shrink-0 rounded-full"
    />
  );
}

/** The folded capsule, in one line: a press opens the oldest. */
function Pill({ waiting, onOpen }: { waiting: Waiting[]; onOpen: () => void }) {
  const text = countText(waiting);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${text}. Open the conversation.`}
      className="flex h-7 max-w-[min(360px,calc(100vw-48px))] items-center gap-1.5 rounded-[inherit] pr-2.5 pl-2 text-[12px] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <Mark waiting={waiting} />
      <span className="truncate">{text}</span>
    </button>
  );
}

/**
 * The open island: what the oldest asks, where, and Open.
 *
 * Several waiting, it says how many more; Open still goes to the oldest.
 */
function Panel({
  waiting,
  focus,
  onOpen,
}: {
  waiting: Waiting[];
  /** Opened by the keyboard: take focus, since the pill is gone. */
  focus: boolean;
  onOpen: () => void;
}) {
  const self = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus) self.current?.focus({ preventScroll: true });
  }, [focus]);
  const [oldest] = waiting;
  if (!oldest) return null;
  const request = oldest.requests[0];
  const asked = request?.question ?? request?.summary ?? "";
  const more = waiting.length - 1;
  return (
    <section
      ref={self}
      tabIndex={-1}
      aria-label="Agent waiting for you"
      className="flex w-[min(380px,calc(100vw-32px))] flex-col gap-3 p-4 pt-3.5 outline-none select-text"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex">
          <Mark waiting={[oldest]} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-[13px] font-semibold tracking-tight">
            {headline(oldest)}
          </h2>
          {asked && (
            <p className="line-clamp-3 text-[12px] text-white/80">
              {request?.question ? (
                asked
              ) : (
                <>
                  <span className="font-medium text-white">
                    {request?.tool}
                  </span>{" "}
                  {asked}
                </>
              )}
            </p>
          )}
          <p className="truncate text-[11px] text-white/50">
            {oldest.title
              ? `${oldest.title} in ${oldest.project}`
              : oldest.project}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-white/50">
          {more > 0
            ? `${more} more ${more === 1 ? "session needs" : "sessions need"} you`
            : ""}
        </span>
        <Button
          onClick={onOpen}
          className="h-7 rounded-full bg-white/[0.14] px-3 text-[12px] text-white hover:bg-white/[0.22] focus-visible:ring-white/40"
        >
          Open
        </Button>
      </div>
    </section>
  );
}
