import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { AgentSession } from "#/../shared/terminal";
import { StatusPing } from "#/components/shared/agents/status-ping";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { shortAge } from "#/lib/relative-time";
import { cn } from "#/lib/utils";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { awaitingKey, useAwaiting } from "#/stores/awaiting";

// The sessions a conductor started (FE-128), on its chat's title bar.
//
// They are the conductor's own: the Agents rail hides them, so this is where
// the user finds them, newest first, each with the state the rail would show
// and a click that opens it.

/** Stable empty list: a selector that allocates one re-renders forever. */
const NONE: AgentSession[] = [];

/** The title bar's Sessions control for `conductor`'s chat in `project`. */
export function ConductorSessions({
  project,
  slug,
  conductor,
}: {
  project: string;
  slug: string;
  /** The conductor, by id. */
  conductor: string;
}) {
  const all = useAgentSessions((state) => state.byProject[project] ?? NONE);
  const listing = useAgentSessions(
    (state) => state.byProject[project] === undefined,
  );
  const [open, setOpen] = useState(false);
  const sessions = useMemo(
    () =>
      all
        .filter((session) => session.launchedBy?.conductor === conductor)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [all, conductor],
  );
  const now = Date.now();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<button type="button" />}
        aria-label={`Sessions this conductor started: ${sessions.length}`}
        title="Sessions this conductor started"
        className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground aria-expanded:bg-foreground/[0.04] aria-expanded:text-foreground flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums transition-colors"
      >
        <HugeiconsIcon
          icon={UserGroupIcon}
          className="size-3.5 shrink-0"
          strokeWidth={1.6}
          aria-hidden="true"
        />
        <span>Sessions</span>
        {sessions.length > 0 && (
          <span className="text-foreground font-medium">{sessions.length}</span>
        )}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-80 gap-0 p-1"
        aria-label="Sessions this conductor started"
      >
        <div className="flex items-baseline gap-2 px-2 pt-1.5 pb-1">
          <span className="text-[13px] font-medium">Sessions</span>
          <span className="text-muted-foreground truncate text-xs">
            Started by this conductor in this project
          </span>
        </div>
        {listing ? (
          <ListSkeleton
            label="Reading the sessions"
            rows={3}
            className="px-0"
          />
        ) : sessions.length === 0 ? (
          <Empty className="gap-2 p-4">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon
                  icon={UserGroupIcon}
                  strokeWidth={1.6}
                  aria-hidden="true"
                />
              </EmptyMedia>
              <EmptyTitle>No sessions yet</EmptyTitle>
              <EmptyDescription>
                Ask the conductor to start one, on Claude, Codex or OpenCode. It
                shows here, not in the Agents list.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex max-h-80 flex-col overflow-y-auto">
            {sessions.map((session) => (
              <li key={session.id}>
                <SessionRow
                  session={session}
                  project={project}
                  slug={slug}
                  now={now}
                  onOpen={() => setOpen(false)}
                />
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One session: its agent and live state, its title, its age. */
function SessionRow({
  session,
  project,
  slug,
  now,
  onOpen,
}: {
  session: AgentSession;
  project: string;
  slug: string;
  now: number;
  onOpen: () => void;
}) {
  const navigate = useNavigate();
  const live = useAgentSessions((state) => state.live[agentKey(session)]);
  const awaiting = useAwaiting((state) =>
    Boolean(state.byKey[awaitingKey(project, session.id)]),
  );
  const working = !awaiting && (live ?? session.working);
  const title = session.title || "Session";
  return (
    <button
      type="button"
      onClick={() => {
        onOpen();
        void navigate({
          to: "/w/$slug/agents/chat/$conversation",
          params: { slug, conversation: session.id },
        });
      }}
      aria-label={`Open “${title}”${awaiting ? ", waiting for you" : working ? ", working" : ""}`}
      className="hover:bg-foreground/[0.04] flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors"
    >
      <span className="relative flex shrink-0">
        <TerminalKindIcon kind={session.agent} className="size-3.5" />
        {(awaiting || working) && (
          <StatusPing tone={awaiting ? "awaiting" : "working"} />
        )}
      </span>
      <span
        className={cn("min-w-0 flex-1 truncate", working && "text-shimmer")}
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
    </button>
  );
}
