import { LayoutListIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AgentSession, TerminalAgent } from "#/../shared/terminal";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { cn } from "#/lib/utils";
import {
  ConductorOverview,
  Group,
  PanelCard,
  Section,
  SessionDetails,
} from "./conductor-sessions.details";

/** The panel's block and foldable group, for blocks drawn elsewhere (Runs). */
export { Group as PanelGroup, Section as PanelSection };

import { SessionHeader, SessionItem } from "./conductor-sessions.item";
import { useConductorSessions } from "./conductor-sessions.list";

// The conductor's work and the sessions it started (FE-128), docked beside
// its chat.
//
// The sessions are the conductor's own: the Agents rail lists them read-only,
// and this is where the user sees them with their conductor. A toggle on the chat's title bar shows or
// hides a panel on the right; the chat narrows to make room, never sits
// under it. The panel opens on an overview of the conductor and every
// session together; a session's own details are one click in.

/** Stable empty list: a selector that allocates one re-renders forever. */
const _NONE: AgentSession[] = [];

/** The dropdown's width, px. */
const PANEL_PX = 272;
/** How long it takes to open, ms; it closes at once. */
const GLIDE_MS = 140;
/**
 * What a press may land on without closing the dropdown: a menu, dialog,
 * popover or tooltip it opened, all drawn in a portal outside it.
 */
const LAYERED =
  '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [data-slot="popover-content"], [data-slot="tooltip-content"]';

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
  /** The conductor, by id; null on a chat that is no conductor's. */
  conductor: string | null;
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
      aria-label={
        conductor
          ? `Sessions this conductor started: ${sessions.length}`
          : "This session's details"
      }
      title={
        open
          ? conductor
            ? "Hide sessions"
            : "Hide details"
          : conductor
            ? "Sessions this conductor started"
            : "This session's details"
      }
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
 * The Sessions dropdown (FE-128): a card hung under its toggle at the top
 * right of the chat, over it rather than beside it. A press anywhere else, or
 * Escape, closes it; its toggle opens and closes it.
 *
 * It grows from the toggle's corner. Shut, it is unmounted once that is over.
 */
export function ConductorSessionsPanel({
  project,
  slug,
  conductor,
  chat,
  open,
  onOpenChange,
  self,
  runs,
}: {
  project: string;
  slug: string;
  /** null on a chat that is no conductor's: its own details only. */
  conductor: string | null;
  chat: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The conductor's own conversation, counted in the overview. */
  self: ConductorSelf | null;
  /** The runs it led, drawn between the overview and the sessions. */
  runs?: ReactNode;
}) {
  // Still drawn while it closes.
  const [present, setPresent] = useState(open);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = window.setTimeout(() => setPresent(false), GLIDE_MS + 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest) return;
      if (panel.current?.contains(target)) return;
      // Its toggle flips it by itself; closing here too would reopen it.
      if (target.closest(`[aria-controls="${CSS.escape(panelId(chat))}"]`))
        return;
      if (target.closest(LAYERED)) return;
      onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A menu or dialog of its own takes Escape first.
      const active = document.activeElement;
      if (active?.closest?.(LAYERED)) return;
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, chat, onOpenChange]);

  return (
    <div
      ref={panel}
      id={panelId(chat)}
      inert={!open}
      style={{ width: PANEL_PX }}
      // Under the title bar's toggle, its right edge on the toggle's.
      className={cn(
        "bg-popover border-border absolute top-1.5 right-3 z-30 flex max-h-[min(78vh,calc(100%-1rem))] origin-top-right flex-col overflow-hidden rounded-2xl border shadow-[0_8px_24px_-8px_rgb(0_0_0/0.14)]",
        // Opens as every menu does (`.menu-pop`, app.css): out of its toggle
        // in 140ms. Shut, it goes at once, with no transition to run.
        open
          ? "translate-y-0 scale-100 opacity-100 transition-[transform,opacity] duration-[140ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
          : "pointer-events-none -translate-y-1 scale-[0.97] opacity-0",
        !open && !present && "hidden",
      )}
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
  conductor: string | null;
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
        className="flex min-h-0 flex-col"
      >
        <div className="border-border shrink-0 border-b px-2 pt-2 pb-1">
          <SessionHeader
            session={shown.session}
            activity={shown.activity}
            project={project}
            slug={slug}
            onBack={() => select(null)}
          />
        </div>
        <div className="min-h-0 overflow-y-auto">
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
      className="flex min-h-0 flex-col"
    >
      <div className="min-h-0 overflow-y-auto">
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
                live={working > 0}
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
