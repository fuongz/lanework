import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AGENT_LABELS } from "#/../shared/conversation";
import {
  HarnessIcon,
  ISLAND_LEAVE_MS,
} from "#/components/shared/agents/harness-island";
import { Button } from "#/components/ui/button";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { type AwaitingEntry, useAwaiting } from "#/stores/awaiting";
import { useBoard } from "#/stores/board";
import {
  announceIsland,
  ISLAND_PRIORITY,
  setIslandOpen,
  useIsland,
  useIslandContent,
  useIslandFoldOutside,
  useIslandShowing,
} from "#/stores/island";

/** How long the island stays open before it folds into its pill (FE-97/D2a). */
const OPEN_MS = 5000;

/** A waiting conversation the island can take the window to. */
interface Waiting extends AwaitingEntry {
  slug: string;
  /** Its project's name, for the panel. */
  project: string;
  /** Its project's key, as main names it: what an answer is sent with. */
  projectId: string;
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
  const projects = useBoard((state) => state.projects);
  const sessions = useAgentSessions((state) => state.byProject);
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
      const project = projects.find(
        (item) => (item.id ?? item.slug) === entry.project,
      );
      if (!project) continue;
      if (project.slug === viewingSlug) {
        if (viewing === entry.conversation && !sub && !task) continue;
        const tab = terminalId
          ? terminals[entry.project]?.find((item) => item.id === terminalId)
          : undefined;
        if (tab?.resume === entry.conversation) continue;
      }
      const listed = sessions[entry.project]?.find(
        (session) => session.id === entry.conversation,
      );
      out.push({
        ...entry,
        projectId: entry.project,
        slug: project.slug,
        project: project.name,
        title: listed?.title ?? null,
      });
    }
    return out.sort((a, b) => a.since.localeCompare(b.since));
  }, [
    byKey,
    projects,
    sessions,
    terminals,
    viewingSlug,
    viewing,
    sub,
    task,
    terminalId,
  ]);
}

const AWAITING_ISLAND_ID = "awaiting";

/**
 * An agent waiting on the person, on the island (FE-97).
 *
 * - Only while the conversation is not on screen: there, its own card asks.
 * - It arrives open, since nothing else says an agent stopped, and folds into
 *   its pill after `OPEN_MS`. The pill stays until every request is answered:
 *   there is no Dismiss, because a turn left waiting does not end by itself.
 *   A pointer over it, or focus in it, holds it open; a press outside folds
 *   it.
 * - Several waiting: the pill counts them, and Open takes the window to the
 *   oldest, the one waiting longest.
 * - An open microphone and a board notice outrank it; it outranks the
 *   Lanework MCP sign-in and the harness update offer
 *   ({@link ISLAND_PRIORITY}). A request that arrives while it waits under
 *   another content opens it once it has the island.
 * - NOTE: Opening by itself never takes focus, as the board notice's.
 *
 * Draws nothing itself: `<IslandHost/>` in the shell does.
 */
export function AwaitingIsland() {
  const waiting = useAwaitingElsewhere();
  const navigate = useNavigate();
  const showing = useIslandShowing(AWAITING_ISLAND_ID);
  const timer = useRef<number | undefined>(undefined);
  useIslandFoldOutside(AWAITING_ISLAND_ID);
  const visible = showing && waiting.length > 0;
  const oldest = waiting[0];

  const fold = (after: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => setIslandOpen(AWAITING_ISLAND_ID, false),
      after,
    );
  };
  const hold = () => window.clearTimeout(timer.current);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A request it has not shown yet (a new conversation waiting, or another
  // question in one) arrives open again.
  const ids = waiting
    .flatMap((entry) => entry.requests.map((request) => request.id))
    .join(" ");
  const seen = useRef(new Set<string>());
  const unseen = ids.split(" ").some((id) => id && !seen.current.has(id));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fold` is fresh each render and only reads refs.
  useEffect(() => {
    if (!visible) return;
    const fresh = ids.split(" ").filter((id) => id && !seen.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seen.current.add(id);
    setIslandOpen(AWAITING_ISLAND_ID, true);
    fold(OPEN_MS);
  }, [ids, visible]);

  const said =
    visible && oldest ? `${headline(oldest)}: ${countText(waiting)}` : "";
  useEffect(() => {
    if (said) announceIsland(said);
  }, [said]);

  const go = () => {
    if (!oldest) return;
    hold();
    setIslandOpen(AWAITING_ISLAND_ID, false);
    void navigate({
      to: "/w/$slug/agents/chat/$conversation",
      params: { slug: oldest.slug, conversation: oldest.conversation },
    });
  };

  useIslandContent(
    oldest
      ? {
          id: AWAITING_ISLAND_ID,
          priority: ISLAND_PRIORITY.awaiting,
          tone: "info",
          label: "Agent waiting for you",
          // Only something it has not shown yet arrives open: a request seen
          // before, back after its chat left the screen, comes as the pill.
          open: unseen,
          attributes: {
            "data-testid": "awaiting-island",
            "data-count": waiting.length,
          },
          onHold: (held) => {
            if (held) hold();
            else if (!useIsland.getState().pinned[AWAITING_ISLAND_ID])
              fold(ISLAND_LEAVE_MS);
          },
          onEscape: () => {
            hold();
            setIslandOpen(AWAITING_ISLAND_ID, false);
          },
          pill: () => <Pill waiting={waiting} onOpen={go} />,
          panel: () => <Panel waiting={waiting} onOpen={go} onHold={hold} />,
        }
      : null,
  );
  return null;
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
  onOpen,
  onHold,
}: {
  waiting: Waiting[];
  onOpen: () => void;
  /** Keeps the island open while an answer is on its way. */
  onHold: () => void;
}) {
  const [oldest] = waiting;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!oldest) return null;
  const request = oldest.requests[0];
  const asked = request?.question ?? request?.summary ?? "";
  const more = waiting.length - 1;
  // A tool's permission is answered here; a question needs its card.
  const answerable = request && !request.question;
  const answer = (behavior: "allow" | "deny") => {
    if (!request) return;
    onHold();
    setBusy(request.id);
    setError(null);
    void window.desktop?.conversation
      .answerPermission(oldest.projectId, oldest.conversation, request.id, {
        behavior,
      })
      .catch(() => setError("Could not answer. Open the conversation."))
      .finally(() => setBusy(null));
  };
  const answering = busy !== null && busy === request?.id;
  return (
    // A press anywhere but its answers opens the conversation; Enter on the
    // focused card does the same.
    <section
      aria-label="Agent waiting for you. Press Enter to open the conversation."
      tabIndex={-1}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("button")) onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget)
          onOpen();
      }}
      className="flex w-[min(380px,calc(100vw-32px))] cursor-pointer flex-col gap-3 p-4 pt-3.5 outline-none"
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
        <div className="flex items-center gap-1.5">
          {answerable && (
            <>
              <Button
                disabled={answering}
                onClick={() => answer("deny")}
                className="h-7 rounded-full bg-white/[0.14] px-3 text-[12px] text-white hover:bg-white/[0.22] focus-visible:ring-white/40"
              >
                Deny
              </Button>
              <Button
                disabled={answering}
                onClick={() => answer("allow")}
                className="h-7 rounded-full bg-white px-3 text-[12px] text-black hover:bg-white/85 focus-visible:ring-white/40"
              >
                Allow
              </Button>
            </>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-rose-300">
          {error}
        </p>
      )}
    </section>
  );
}
