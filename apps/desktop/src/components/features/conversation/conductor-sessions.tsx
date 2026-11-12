import { LayoutListIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { AgentSession, TerminalAgent } from "#/../shared/terminal";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { awaitingKey, useAwaiting } from "#/stores/awaiting";
import {
  ConductorOverview,
  Group,
  PanelCard,
  Section,
  SessionDetails,
} from "./conductor-sessions.details";

/** The panel's block and foldable group, for blocks drawn elsewhere (Runs). */
export { Group as PanelGroup, Section as PanelSection };

import {
  type SessionActivity,
  SessionHeader,
  SessionItem,
} from "./conductor-sessions.item";

// The conductor's work and the sessions it started (FE-128), docked beside
// its chat.
//
// The sessions are the conductor's own: the Agents rail hides them, so this
// is where the user finds them. A toggle on the chat's title bar shows or
// hides a panel on the right; the chat narrows to make room, never sits
// under it. The panel opens on an overview of the conductor and every
// session together; a session's own details are one click in.

/** Stable empty list: a selector that allocates one re-renders forever. */
const NONE: AgentSession[] = [];

/** The panel's width, px: the size of the popover it replaced. */
export const SESSIONS_PANEL_PX = 320;
const PANEL_PX = SESSIONS_PANEL_PX;
/**
 * The strip left free at the window's edge, px: the chat's contents rail
 * (`right-4`, `w-7`) and its scrollbar stay there, beside the panel.
 */
export const SESSIONS_PANEL_GUTTER = 48;
/** As long as the rail's glide (`RAIL_GLIDE_MS`, app-shell.tsx). */
const GLIDE_MS = 240;

/**
 * Which chats had the panel open, and which session's details it showed,
 * by `slug:conversation`.
 *
 * For the app's session only: leaving the chat for one of its sessions and
 * coming back finds the panel as it was.
 */
const shownIn = new Map<string, boolean>();
const selectedIn = new Map<string, string | null>();

/** Whether `chat`'s Sessions panel is open, remembered while the app runs. */
export function useSessionsPanel(chat: string) {
  const [open, setOpenState] = useState(() => shownIn.get(chat) ?? false);
  const setOpen = useCallback(
    (next: boolean) => {
      shownIn.set(chat, next);
      setOpenState(next);
    },
    [chat],
  );
  return { open, setOpen };
}

/**
 * `conductor`'s sessions in `project` and where each stands: the active
 * (working or waiting for the user) first, then newest first.
 */
function useConductorSessions(project: string, conductor: string) {
  const all = useAgentSessions((state) => state.byProject[project] ?? NONE);
  const listing = useAgentSessions(
    (state) => state.byProject[project] === undefined,
  );
  const live = useAgentSessions((state) => state.live);
  const waiting = useAwaiting((state) => state.byKey);
  const sessions = useMemo(() => {
    const activity = (session: AgentSession): SessionActivity =>
      waiting[awaitingKey(project, session.id)]
        ? "awaiting"
        : (live[agentKey(session)] ?? session.working)
          ? "working"
          : "idle";
    return all
      .filter((session) => session.launchedBy?.conductor === conductor)
      .map((session) => ({ session, activity: activity(session) }))
      .sort(
        (a, b) =>
          Number(b.activity !== "idle") - Number(a.activity !== "idle") ||
          b.session.updatedAt.localeCompare(a.session.updatedAt),
      );
  }, [all, conductor, live, waiting, project]);
  return { sessions, listing };
}

/** The panel's id, for its toggle's `aria-controls`. */
const panelId = (chat: string) => `conductor-sessions:${chat}`;

/**
 * The title bar's Sessions toggle for `conductor`'s chat: an icon, with a
 * count while any of its sessions works.
 */
export function ConductorSessionsToggle({
  project,
  conductor,
  chat,
  open,
  onOpenChange,
}: {
  project: string;
  /** The conductor, by id. */
  conductor: string;
  /** The chat it is on, as `useSessionsPanel` keys it. */
  chat: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { sessions } = useConductorSessions(project, conductor);
  const working = sessions.filter(
    (entry) => entry.activity === "working",
  ).length;
  return (
    <button
      type="button"
      onClick={() => onOpenChange(!open)}
      aria-pressed={open}
      aria-controls={panelId(chat)}
      aria-label={`Sessions this conductor started: ${sessions.length}`}
      title={open ? "Hide sessions" : "Sessions this conductor started"}
      className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground aria-pressed:bg-foreground/[0.06] aria-pressed:text-foreground relative grid size-7 shrink-0 place-items-center rounded-md transition-colors"
    >
      <HugeiconsIcon
        icon={LayoutListIcon}
        className="size-4"
        strokeWidth={1.6}
        aria-hidden="true"
      />
      {working > 0 && (
        <span
          aria-hidden="true"
          className="bg-tone-blue ring-background absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full px-[3px] text-[9px] leading-none font-semibold text-white tabular-nums ring-2"
        >
          {working}
        </span>
      )}
    </button>
  );
}

/**
 * The Sessions panel, docked on the right of `conductor`'s chat.
 *
 * It glides open and shut the way the rail does: its width moves, its
 * content stays at full width and is clipped, so nothing re-wraps on the
 * way. Shut, it is unmounted once the glide is over.
 */
export function ConductorSessionsPanel({
  project,
  slug,
  conductor,
  chat,
  open,
  self,
  runs,
}: {
  project: string;
  slug: string;
  conductor: string;
  chat: string;
  open: boolean;
  /** The conductor's own conversation, counted in the overview. */
  self: ConductorSelf | null;
  /** The runs it led, drawn between the overview and the sessions. */
  runs?: ReactNode;
}) {
  // Still drawn while it glides shut.
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = window.setTimeout(() => setPresent(false), GLIDE_MS + 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <div
      id={panelId(chat)}
      inert={!open}
      style={{ width: open ? PANEL_PX : 0, right: SESSIONS_PANEL_GUTTER }}
      // NOTE: Over the chat rather than beside it: the chat keeps its width
      // and pads its content clear (`--side-panel`), so its contents rail
      // and scrollbar stay at the window's edge, in the gutter on the
      // panel's right.
      className="bg-background absolute inset-y-0 z-20 overflow-hidden transition-[width] duration-[240ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
    >
      {(open || present) && (
        <SessionsList
          project={project}
          slug={slug}
          conductor={conductor}
          chat={chat}
          self={self}
          runs={runs}
        />
      )}
    </div>
  );
}

/** The conductor's own conversation, as the overview reads it. */
export interface ConductorSelf {
  agent: TerminalAgent;
  id: string;
  /** A turn of it runs now. */
  working: boolean;
  /** As the rail lists it, once listed: its background tasks. */
  session: AgentSession | null;
}

/**
 * The panel's content: the overview with the sessions under it, or one
 * session's details.
 */
function SessionsList({
  project,
  slug,
  conductor,
  chat,
  self,
  runs,
}: {
  project: string;
  slug: string;
  conductor: string;
  chat: string;
  self: ConductorSelf | null;
  runs?: ReactNode;
}) {
  const { sessions, listing } = useConductorSessions(project, conductor);
  const [selected, setSelectedState] = useState<string | null>(
    () => selectedIn.get(chat) ?? null,
  );
  const select = (id: string | null) => {
    selectedIn.set(chat, id);
    setSelectedState(id);
  };
  const now = Date.now();
  const shown = selected
    ? sessions.find((entry) => entry.session.id === selected)
    : undefined;
  const working = sessions.filter(
    (entry) => entry.activity === "working",
  ).length;
  const overviewSessions = useMemo(
    () =>
      sessions.map(({ session, activity }) => ({
        session,
        working: activity === "working",
      })),
    [sessions],
  );

  // One session's details, until Back. A session gone from the list (reset,
  // removed) falls back to the overview.
  if (shown)
    return (
      <aside
        aria-label={`Session: ${shown.session.title || "Session"}`}
        style={{ width: PANEL_PX }}
        className="flex h-full min-h-0 flex-col"
      >
        <div className="shrink-0 px-2 pt-2 pb-1">
          <SessionHeader
            session={shown.session}
            activity={shown.activity}
            project={project}
            slug={slug}
            onBack={() => select(null)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
          <PanelCard>
            <SessionDetails
              key={shown.session.id}
              session={shown.session}
              working={shown.activity === "working"}
              project={project}
              slug={slug}
              now={now}
            />
          </PanelCard>
        </div>
      </aside>
    );

  return (
    <aside
      aria-label="The conductor's work and its sessions"
      style={{ width: PANEL_PX }}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-3">
        {/* One card: where and what (the overview), the runs, the
            sessions, a hairline between. A block with nothing to show draws
            nothing, and takes its line with it. */}
        <PanelCard>
          {listing ? (
            <Section>
              <ListSkeleton label="Reading the conductor's work" rows={4} />
            </Section>
          ) : (
            <ConductorOverview
              project={project}
              slug={slug}
              self={self}
              sessions={overviewSessions}
              now={now}
              onOpenSession={select}
            />
          )}
          {runs}
          {sessions.length > 0 && (
            <Section>
              <Group
                icon={UserGroupIcon}
                label="Sessions"
                count={working > 0 ? `${working} working` : sessions.length}
                defaultOpen
              >
                {sessions.map(({ session, activity }) => (
                  <li key={session.id}>
                    <SessionItem
                      session={session}
                      activity={activity}
                      project={project}
                      slug={slug}
                      now={now}
                      onSelect={() => select(session.id)}
                    />
                  </li>
                ))}
              </Group>
            </Section>
          )}
        </PanelCard>
      </div>
    </aside>
  );
}
