import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { AgentSession } from "#/../shared/terminal";
import { StatusPing } from "#/components/shared/agents/status-ping";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { shortAge } from "#/lib/relative-time";
import { cn } from "#/lib/utils";
import { useChatEngines } from "#/stores/chat-engines";
import { notify } from "#/stores/notify";

/** Where a session stands, for its dot and its place in the list. */
export type SessionActivity = "awaiting" | "working" | "idle";

/** The small square buttons at the end of a session's row. */
const ROW_ACTION =
  "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground grid size-7 shrink-0 place-items-center rounded-md transition-colors";

/** Its agent's mark, with the dot a session's rail row would carry. */
function SessionMark({
  session,
  activity,
}: {
  session: AgentSession;
  activity: SessionActivity;
}) {
  return (
    <span className="relative flex shrink-0">
      <TerminalKindIcon kind={session.agent} className="size-4" />
      {activity !== "idle" && (
        <StatusPing tone={activity === "awaiting" ? "awaiting" : "working"} />
      )}
    </span>
  );
}

/**
 * Open and, while its agent runs, Stop: the actions a session has in the
 * panel, on its row and on its details alike.
 *
 * The Agents rail hides these sessions, so their Stop lives here. A second
 * press confirms while it works: a turn is cut off by Stop.
 */
function SessionActions({
  session,
  working,
  project,
  slug,
  openable = true,
}: {
  session: AgentSession;
  working: boolean;
  project: string;
  slug: string;
  /** Offer Open: on its details only, the row itself opens those. */
  openable?: boolean;
}) {
  const navigate = useNavigate();
  const title = session.title || "Session";
  const alive = useChatEngines(
    (state) => state.alive[project]?.includes(session.id) ?? false,
  );
  const refreshChats = useChatEngines((state) => state.refresh);
  const [confirming, setConfirming] = useState(false);
  const stop = () => {
    if (working && !confirming) return setConfirming(true);
    setConfirming(false);
    void window.desktop?.conversation
      .close(project, session.id)
      .then(() => notify("success", `Stopped ${title}`))
      .catch(() => {})
      .finally(() => void refreshChats(project));
  };
  return (
    <>
      {openable && (
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/w/$slug/agents/chat/$conversation",
              params: { slug, conversation: session.id },
            })
          }
          aria-label={`Open “${title}”`}
          title="Open this session"
          className={ROW_ACTION}
        >
          <HugeiconsIcon
            icon={ArrowUpRight01Icon}
            className="size-3.5"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>
      )}
      {alive && (
        <button
          type="button"
          onClick={stop}
          onBlur={() => setConfirming(false)}
          aria-label={
            confirming ? `Confirm stopping “${title}”` : `Stop “${title}”`
          }
          title="Ends its agent. A turn in progress is cut off; the conversation is kept."
          // The button's destructive variant: it ends the agent.
          className={cn(
            "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 grid size-7 shrink-0 place-items-center rounded-md transition-colors outline-none focus-visible:ring-2",
            confirming && "w-auto px-2 text-xs font-medium",
          )}
        >
          {confirming ? (
            "Stop now?"
          ) : (
            <HugeiconsIcon
              icon={StopIcon}
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          )}
        </button>
      )}
    </>
  );
}

/**
 * One session in the Sessions panel's list: a row that opens its details in
 * the panel, with Open and, while its agent runs, Stop.
 */
export function SessionItem({
  session,
  activity,
  project,
  slug,
  now,
  onSelect,
}: {
  session: AgentSession;
  activity: SessionActivity;
  project: string;
  slug: string;
  now: number;
  /** Show its details in the panel. */
  onSelect: () => void;
}) {
  const awaiting = activity === "awaiting";
  const working = activity === "working";
  const title = session.title || "Session";
  return (
    <div className="flex min-w-0 items-center gap-0.5 pe-1.5">
      <button
        type="button"
        onClick={onSelect}
        aria-label={`“${title}”${awaiting ? ", waiting for you" : working ? ", working" : ""}: show its details`}
        className="hover:bg-foreground/[0.03] focus-visible:ring-accent-brand flex h-8 min-w-0 flex-1 items-center gap-2.5 ps-3 pe-1.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <SessionMark session={session} activity={activity} />
        <span
          className={cn("min-w-0 flex-1 truncate", working && "text-shimmer")}
          title={title}
        >
          {title}
        </span>
        {awaiting ? (
          <span className="text-destructive shrink-0 text-xs">
            Waiting for you
          </span>
        ) : (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {shortAge(session.updatedAt, now)}
          </span>
        )}
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className="text-muted-foreground size-3 shrink-0"
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      <SessionActions
        session={session}
        working={working}
        project={project}
        slug={slug}
        openable={false}
      />
    </div>
  );
}

/**
 * The head of a session's details in the panel: back to the overview, the
 * session's mark and title, then Open and Stop.
 */
export function SessionHeader({
  session,
  activity,
  project,
  slug,
  onBack,
}: {
  session: AgentSession;
  activity: SessionActivity;
  project: string;
  slug: string;
  onBack: () => void;
}) {
  const working = activity === "working";
  const title = session.title || "Session";
  return (
    <div className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to the overview"
        title="Back"
        className={ROW_ACTION}
      >
        <HugeiconsIcon
          icon={ArrowLeft01Icon}
          className="size-3.5"
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </button>
      <SessionMark session={session} activity={activity} />
      <h2
        className={cn(
          "min-w-0 flex-1 truncate ps-1 text-[13px] font-medium",
          working && "text-shimmer",
        )}
        title={title}
      >
        {title}
      </h2>
      <SessionActions
        session={session}
        working={working}
        project={project}
        slug={slug}
      />
    </div>
  );
}
