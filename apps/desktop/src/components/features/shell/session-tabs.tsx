import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Reorder } from "motion/react";
import {
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { AgentSession, TerminalAgent } from "#/../shared/terminal";
import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";
import { ConductorMark } from "#/components/shared/conductors/conductor-mark";
import { useTeamLeads } from "#/components/shared/conversation/composer";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { useCloseSessionTab } from "#/hooks/use-close-session-tab";
import { useOrchestrationRuns } from "#/hooks/use-orchestration-runs";
import { useProjectKey } from "#/hooks/use-project-key";
import { cn } from "#/lib/utils";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { useSessionTabs } from "#/stores/session-tabs";

/** A chat route's conversation: `/w/<slug>/agents/chat/<id>`, not `new`. */
const CHAT_PATH = /^\/w\/[^/]+\/agents\/chat\/([^/]+)\/?$/;

/** The project a path is under: `/w/<slug>/…`. */
const PROJECT_PATH = /^\/w\/([^/]+)\//;

const NONE: string[] = [];

/**
 * The open session's chip: white on the light ground. On the dark one a
 * lifted surface, not `--background`, which sits a hair above the ground and
 * left the open tab barely told apart from the rest.
 */
const ACTIVE_CHIP =
  "bg-background border-panel-edge shadow-[0_1px_2px_rgb(0_0_0/0.04)] dark:bg-muted dark:border-foreground/10 dark:text-foreground";

/**
 * The open sessions as tabs, in the window's title bar (FE-144).
 *
 * The project's tabs: opening a chat shows it in the preview tab (italic),
 * which the next chat opened replaces; a double click on it, on its rail
 * row, or a message sent keeps it. × or a middle click closes one. Each is
 * a chip, the one on screen white; on a page that is no chat (Issues,
 * Files…) none is. `+` starts a new chat.
 */
export function SessionTabs() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // NOTE: The project from the path, not the route's params. Mid-switch the
  // location already names the next project while the params still name
  // this one (as project-layout.tsx notes), and a tab opened then was filed
  // under the project being left: another project's chat in its strip.
  const slugMatch = PROJECT_PATH.exec(pathname);
  const slug = slugMatch ? decodeURIComponent(slugMatch[1]) : undefined;
  const navigate = useNavigate();
  const tabs = useSessionTabs((state) => (slug ? state.bySlug[slug] : NONE));
  const open = useSessionTabs((state) => state.open);
  const show = useSessionTabs((state) => state.show);
  const preview = useSessionTabs((state) =>
    slug ? state.preview[slug] : undefined,
  );
  const closeTab = useCloseSessionTab(slug);
  const reorder = useSessionTabs((state) => state.reorder);
  /** A drag is on, or just ended: the tab's click must not open it. */
  const dragged = useRef(false);
  const byProject = useAgentSessions((state) => state.byProject);
  const project = useProjectKey(slug);
  const runs = useOrchestrationRuns(project);
  const leads = useTeamLeads(project);
  const leadsById = useMemo(
    () => new Map((leads?.leads ?? []).map((lead) => [lead.id, lead])),
    [leads],
  );
  const live = useAgentSessions((state) => state.live);
  const strip = useRef<HTMLDivElement>(null);

  const match = CHAT_PATH.exec(pathname);
  // A new chat, not yet started: a tab of its own, as a browser's new tab.
  const fresh = match?.[1] === "new";
  const active =
    match && match[1] !== "new" ? decodeURIComponent(match[1]) : null;

  // Opening a chat, from anywhere, shows it in the preview tab.
  useEffect(() => {
    if (slug && active) show(slug, active);
  }, [slug, active, show]);

  // A tab another project lists as its own was filed here by the bug above:
  // it goes, as its chat would open as an empty "Claude conversation" here.
  // Only once both lists are read, and never this project's own or a run's.
  useEffect(() => {
    if (!slug || !project || !byProject[project] || !tabs?.length) return;
    const own = new Set(byProject[project].map((session) => session.id));
    for (const [key, list] of Object.entries(byProject)) {
      if (key === project) continue;
      for (const session of list)
        if (tabs.includes(session.id) && !own.has(session.id))
          useSessionTabs.getState().close(slug, session.id);
    }
  }, [slug, project, byProject, tabs]);

  // The tab on screen scrolls into view when the strip overflows.
  useEffect(() => {
    const key = active ?? (fresh ? "new" : null);
    if (!key) return;
    strip.current
      ?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, fresh]);

  /**
   * The tab keys (FE-144), as a browser's: ⌘1…⌘8 a tab by place, ⌘9 the
   * last, ⌃Tab / ⌃⇧Tab and ⇧⌘] / ⇧⌘[ the next and the one before, round the
   * strip, ⌘T a new chat. A new chat's own tab counts as the last.
   */
  useEffect(() => {
    if (!slug) return;
    const strip = [
      ...(tabs ?? NONE),
      ...(preview ? [preview] : []),
      ...(fresh ? ["new"] : []),
    ];
    const at = strip.indexOf(active ?? (fresh ? "new" : ""));
    const show = (id: string | undefined) => {
      if (!id) return;
      if (id === "new")
        void navigate({ to: "/w/$slug/agents/chat/new", params: { slug } });
      else
        void navigate({
          to: "/w/$slug/agents/chat/$conversation",
          params: { slug, conversation: id },
        });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      // ⌃Tab, ⌃⇧Tab.
      if (event.ctrlKey && !event.metaKey && event.key === "Tab") {
        if (strip.length < 2) return;
        event.preventDefault();
        const step = event.shiftKey ? -1 : 1;
        show(strip[(Math.max(at, 0) + step + strip.length) % strip.length]);
        return;
      }
      if (!mod || event.altKey) return;
      // ⇧⌘] and ⇧⌘[, by `code`: with ⇧ held the key reads "}" and "{".
      if (
        event.shiftKey &&
        (event.code === "BracketRight" || event.code === "BracketLeft")
      ) {
        if (strip.length < 2) return;
        event.preventDefault();
        const step = event.code === "BracketRight" ? 1 : -1;
        show(strip[(Math.max(at, 0) + step + strip.length) % strip.length]);
        return;
      }
      if (event.shiftKey) return;
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        show("new");
        return;
      }
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (!digit || strip.length === 0) return;
      event.preventDefault();
      const n = Number(digit[1]);
      show(n === 9 ? strip[strip.length - 1] : strip[n - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slug, tabs, preview, fresh, active, navigate]);

  const sessions = useMemo(() => {
    const out = new Map<string, AgentSession>();
    for (const list of Object.values(byProject))
      for (const session of list) out.set(session.id, session);
    return out;
  }, [byProject]);

  // A run's worker is no listed session: its title and agent come from its
  // task, so its tab is named and marked like any other.
  const workers = useMemo(() => {
    const out = new Map<
      string,
      { title: string; agent: TerminalAgent; working: boolean }
    >();
    for (const run of runs)
      for (const task of run.tasks)
        if (task.conversation)
          out.set(task.conversation, {
            title: task.title,
            agent: task.agent,
            working: task.status === "running",
          });
    return out;
  }, [runs]);

  if (!slug) return null;
  const shown = tabs ?? NONE;
  /** One tab's chip: a kept one, draggable, or the preview, in italics. */
  const chip = (id: string, isPreview: boolean) => {
    const session = sessions.get(id);
    const worker = workers.get(id);
    const selected = id === active;
    const working = session
      ? (live[agentKey(session)] ?? session.working)
      : (worker?.working ?? false);
    // A conductor's own conversation is named and marked as the conductor,
    // as its rail row is, not by its first prompt.
    const lead = session?.conductor ? leadsById.get(session.conductor) : null;
    const title = lead?.name || session?.title || worker?.title || "Session";
    const agent = session?.agent ?? worker?.agent;
    return (
      <ChipShell
        preview={isPreview}
        key={id}
        value={id}
        data-tab={id}
        onDragStart={() => {
          dragged.current = true;
        }}
        onDragEnd={() => {
          // After the click the release fires, so it opens nothing.
          window.setTimeout(() => {
            dragged.current = false;
          }, 0);
        }}
        whileDrag={{ scale: 1.03, zIndex: 20 }}
        className={cn(
          // A chip each, the open one white: chips sit on the ground
          // in a row, apart from the card under them.
          "group/tab relative flex h-8 max-w-56 min-w-28 shrink-0 items-center rounded-lg border transition-colors duration-150",
          selected
            ? ACTIVE_CHIP
            : // No rim, only a faint fill: the open one is the chip.
              "text-muted-foreground hover:text-foreground border-transparent bg-foreground/[0.04] hover:bg-rail-hover",
        )}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          closeTab(id);
        }}
      >
        <Link
          to="/w/$slug/agents/chat/$conversation"
          params={{ slug, conversation: id }}
          role="tab"
          aria-selected={selected}
          draggable={false}
          onClick={(event) => {
            if (dragged.current) event.preventDefault();
          }}
          // A double click keeps it, as an editor's preview tab.
          onDoubleClick={() => open(slug, id)}
          title={title}
          // The room for the × grows in, not at once: the chip is as wide
          // as its label, so a jump in padding jolted every chip after it.
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-2.5 text-[13px] outline-none transition-[padding] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-focus-within/tab:pr-7 group-hover/tab:pr-7 motion-reduce:transition-none"
        >
          <span className="grid size-4 shrink-0 place-items-center">
            {working ? (
              <OrbitSpinner className="text-foreground size-3.5" />
            ) : lead ? (
              <ConductorMark
                lead={lead}
                className="size-3.5"
                strokeWidth={1.5}
              />
            ) : agent ? (
              <TerminalKindIcon kind={agent} className="size-3.5" />
            ) : null}
          </span>
          <span
            className={cn(
              "truncate",
              selected && "font-medium",
              isPreview && "italic",
            )}
          >
            {title}
          </span>
        </Link>
        <button
          type="button"
          aria-label={`Close ${title}`}
          title="Close tab"
          onClick={() => closeTab(id)}
          className={cn(
            // Over the chip's right end, so a chip at rest is padded the same
            // on both sides; its label makes room while it shows.
            "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-md transition-opacity duration-150",
            // Under the pointer only, as the chips in the mock show none.
            "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
          )}
        >
          <HugeiconsIcon
            icon={Cancel01Icon}
            className="size-3"
            strokeWidth={2}
            aria-hidden="true"
          />
        </button>
      </ChipShell>
    );
  };

  return (
    <div className="session-tabs flex h-full min-w-0 items-center gap-1.5 self-stretch">
      <div
        ref={strip}
        role="tablist"
        aria-label="Open sessions"
        className="flex h-full min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* Dragged sideways to reorder, as a browser's tabs. */}
        <Reorder.Group
          // One per project: switching projects swaps the strip at once,
          // rather than gliding one project's chips into the other's.
          key={slug}
          as="div"
          axis="x"
          values={shown}
          onReorder={(order) => reorder(slug, order)}
          className="flex h-full items-center gap-1.5"
        >
          {shown.map((id) => chip(id, false))}
        </Reorder.Group>
        {/* Not draggable: it is no kept tab until a double click keeps it. */}
        {preview && !shown.includes(preview) && chip(preview, true)}
        {fresh && (
          <div
            data-tab="new"
            className={`group/tab ${ACTIVE_CHIP} relative flex h-8 max-w-56 min-w-28 shrink-0 items-center rounded-lg border`}
          >
            <span
              role="tab"
              tabIndex={0}
              aria-selected="true"
              className={cn(
                "text-muted-foreground flex h-full min-w-0 flex-1 items-center gap-2 px-2.5 text-[13px] transition-[padding] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
                shown.length > 0 &&
                  "group-focus-within/tab:pr-7 group-hover/tab:pr-7",
              )}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                className="size-3.5 shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span className="truncate">New conversation</span>
            </span>
            {shown.length > 0 && (
              <button
                type="button"
                aria-label="Close new conversation"
                title="Close tab"
                onClick={() =>
                  void navigate({
                    to: "/w/$slug/agents/chat/$conversation",
                    params: { slug, conversation: shown[shown.length - 1] },
                  })
                }
                className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-md opacity-0 transition-opacity duration-150 group-hover/tab:opacity-100 focus-visible:opacity-100"
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  className="size-3"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label="New chat"
        title="New chat"
        onClick={() =>
          void navigate({ to: "/w/$slug/agents/chat/new", params: { slug } })
        }
        className="text-muted-foreground hover:text-foreground hover:bg-rail-hover grid size-7 shrink-0 place-items-center rounded-md transition-colors"
      >
        <HugeiconsIcon
          icon={Add01Icon}
          className="size-4"
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

/**
 * A tab chip's shell: a `Reorder.Item` for a kept tab, so it drags; a plain
 * one for the preview, which is in no reorder group.
 */
function ChipShell({
  preview,
  value,
  className,
  children,
  onAuxClick,
  onDragStart,
  onDragEnd,
  whileDrag,
  "data-tab": dataTab,
}: {
  preview: boolean;
  value: string;
  className: string;
  children: ReactNode;
  onAuxClick: (event: MouseEvent<HTMLElement>) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  whileDrag: ComponentProps<typeof Reorder.Item>["whileDrag"];
  "data-tab": string;
}) {
  if (preview)
    return (
      <div className={className} onAuxClick={onAuxClick} data-tab={dataTab}>
        {children}
      </div>
    );
  return (
    <Reorder.Item
      as="div"
      value={value}
      data-tab={dataTab}
      className={className}
      onAuxClick={onAuxClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      whileDrag={whileDrag}
    >
      {children}
    </Reorder.Item>
  );
}
