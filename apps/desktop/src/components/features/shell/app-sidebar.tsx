import {
  Clock01Icon,
  FolderFileStorageIcon,
  GitCompareIcon,
  ListViewIcon,
  Search01Icon,
  Settings01Icon,
  SquareArrowUp02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";
import { ConductorsNav } from "#/components/features/conductors/conductors-nav";
import { LocalModeRail } from "#/components/shared/auth/local-mode";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
import { BranchSwitcher } from "#/components/shared/repo/branch-switcher";
import { Badge } from "#/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { Kbd } from "#/components/ui/kbd";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import { useCommandPalette } from "#/stores/command-palette";
import { useGitHubIssues } from "#/stores/github-issues";
import { usePulls } from "#/stores/pulls";
import { useSession } from "#/stores/session";
import { useWorktree } from "#/stores/worktree";
import { AgentSessionsNav } from "./agent-sessions-nav";
import { MiniRail } from "./mini-rail";
import { ProjectSwitcher } from "./project-switcher";
import { useUnseenPulls } from "./use-unseen-pulls";

/**
 * One row of the rail's scroll area.
 *
 * The active look is `settings-nav`'s. The hover is `RailHover`'s one sliding
 * background, not the row's.
 */
const ROW = `${RAIL_ROW} group relative flex h-[30px] items-center gap-2.5 rounded-md px-2 text-[13px] transition-[background-color,scale] duration-150 ease-out active:scale-[0.98]`;

/** A row outside the scroll area (Settings), which lights on its own. */
const LONE_ROW = `${ROW} [&:not([aria-current])]:hover:bg-foreground/[0.04]`;

const ACTIVE = {
  className: "bg-foreground/[0.08]",
  "aria-current": "page" as const,
};

function SectionLabel({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-muted-foreground px-2 pt-4 pb-1 text-[11px] font-medium tracking-wide uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A rail row with Refresh on right click, which reads the row's source again
 * without opening its screen.
 *
 * The wrapper is `contents`, so the row stays the nav's own child for layout
 * and for {@link RailHover}.
 */
function RefreshMenu({
  children,
  onRefresh,
}: {
  children: ReactNode;
  onRefresh: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="contents" />}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent finalFocus={false}>
        <ContextMenuItem onClick={onRefresh}>Refresh</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The rail: the project, its repository, its agents, and Settings.
 *
 * @param mini The rail folded to its icons.
 * @param onExpand Opens it again, from its sidebar button or from Agents,
 *   whose list only reads open.
 */
export function AppSidebar({
  mini = false,
  onExpand,
}: {
  mini?: boolean;
  onExpand?: () => void;
} = {}) {
  // Read from the URL, not the store. The rail has to draw correctly on the
  // first paint of a deep link, before anything has been fetched, and the URL
  // is the only thing already true at that moment.
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug;
  const _view = useBoard((state) => state.view);
  const open = useCommandPalette((state) => state.open);
  const session = useSession((state) => state.session);
  // NOTE: Two selectors returning numbers, not one returning `{ additions,
  // deletions }`: a fresh object on every read is a new value to zustand, and
  // the rail would re-render on every store change.
  const added = useWorktree((state) =>
    state.slug === slug && state.state?.kind === "ready"
      ? state.state.files.reduce((sum, file) => sum + file.additions, 0)
      : 0,
  );
  const removed = useWorktree((state) =>
    state.slug === slug && state.state?.kind === "ready"
      ? state.state.files.reduce((sum, file) => sum + file.deletions, 0)
      : 0,
  );
  // History's ↑ rows, counted: what the next push sends.
  const unpushed = useWorktree((state) =>
    state.slug === slug && state.state?.kind === "ready"
      ? state.state.unpushed
      : 0,
  );
  const unpushedLabel =
    unpushed === 1
      ? "1 commit not pushed yet"
      : `${unpushed} commits not pushed yet`;
  // New pull requests nobody has looked at, beside Issues: Pull requests is
  // a tab under it (FE-76).
  const unseenPulls = useUnseenPulls(slug);
  const unseenPullsLabel =
    unseenPulls === 1
      ? "1 new pull request"
      : `${unseenPulls} new pull requests`;
  // The terminal's key for this project (the cloud id, or the slug), which
  // the Agents group resumes into.
  const workspaceKey = useWorkspaceKey(slug);
  const hasFolder = useWorktree(
    (state) =>
      state.slug === slug &&
      state.state !== null &&
      state.state.kind !== "none" &&
      state.state.kind !== "missing",
  );
  const navigate = useNavigate();
  const peek = useWorktree((state) => state.peek);
  const openChanges = useWorktree((state) => state.open);
  const openHistory = useWorktree((state) => state.openHistory);
  const reloadBoard = useBoard((state) => state.reload);
  const refreshGitHubIssues = useGitHubIssues((state) => state.refresh);
  // Issues holds the board, the repo's GitHub issues and its pull requests;
  // Refresh reads all three. The open list is read even when the Pull
  // requests screen shows another state, so the count beside Issues is
  // read again with it (FE-76).
  const refreshIssues = (slug: string) => {
    void reloadBoard();
    void refreshGitHubIssues(slug);
    const pulls = usePulls.getState();
    if (pulls.slug === slug) void pulls.refresh();
    if (pulls.slug !== slug || pulls.status !== "open")
      void window.desktop?.git.pulls(slug, "open", true).catch(() => {});
  };
  // History's badge is `git status`'s, so its refresh reads both.
  const refreshHistory = (slug: string) => {
    void openHistory(slug);
    void peek(slug);
  };

  // Read with the board, not when Changes is opened: the badge is the reason
  // to open Changes, so it cannot wait for it. `git status` only (the patch
  // stays the Changes screen's to read), on project change and on focus,
  // never on a timer.
  useEffect(() => {
    if (!slug) return;
    void peek(slug);
    const onFocus = () => void peek(slug);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [peek, slug]);

  // ⌘N is free on macOS: Electron's default menu binds ⌘W and ⌘Q, never ⌘N,
  // so nothing native swallows this before the window sees it.
  useEffect(() => {
    if (!slug) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || !(event.metaKey || event.ctrlKey))
        return;
      event.preventDefault();
      void navigate({ to: "/w/$slug/issues/new", params: { slug } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, slug]);

  // The orb's seed, not a label (see `AccountOrb`). Empty when the control
  // plane never said who owns this machine: then there is no mark to draw,
  // rather than a mark standing for nobody.
  const accountSeed =
    session?.principal.kind === "machine"
      ? (session.principal.userId ?? "")
      : "";

  // Swapping between the open rail and the icons fades the new one in, so the
  // swap reads as part of the glide; the first paint, at launch, does not
  // fade. Worked out while rendering, not in an effect: a flag set after the
  // swap would draw the new rail fully once, then start its fade from
  // nothing.
  const firstMini = useRef(mini);
  const swappedOnce = useRef(false);
  if (mini !== firstMini.current) swappedOnce.current = true;
  const swapped = swappedOnce.current;

  if (mini)
    return (
      <MiniRail
        slug={slug}
        accountSeed={accountSeed}
        projectSwitcher={<ProjectSwitcher compact />}
        agents={
          workspaceKey && slug ? (
            <>
              <ConductorsNav
                workspace={workspaceKey}
                slug={slug}
                hasFolder={hasFolder}
                row={ROW}
                active={ACTIVE.className}
                mini
              />
              <AgentSessionsNav
                workspace={workspaceKey}
                slug={slug}
                hasFolder={hasFolder}
                row={ROW}
                active={ACTIVE.className}
                mini
              />
            </>
          ) : null
        }
        onExpand={() => onExpand?.()}
        appear={swapped}
      />
    );

  return (
    <aside
      className={`app-sidebar flex min-h-0 flex-1 flex-col px-2.5 ${swapped ? "motion-safe:animate-in motion-safe:fade-in-0 duration-200" : ""}`}
    >
      {/* No spacer for the window controls: the window's title bar above the
          rail holds them, open or folded. */}
      <div className="mt-2 shrink-0">
        <ProjectSwitcher />
      </div>

      {/* Search, not a compose button: the palette behind it reaches New
          issue too, and ⌘N still opens that directly. */}
      <div className="mt-1 mb-1 shrink-0">
        <button
          type="button"
          onClick={open}
          title="Search — ⌘K"
          // A size container, so the ⌘K hint steps aside before the label
          // has to at the rail's narrowest.
          className="hover:bg-foreground/[0.06] bg-foreground/[0.035] text-muted-foreground @container flex h-[30px] w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors duration-150"
        >
          <HugeiconsIcon
            icon={Search01Icon}
            className="size-4 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">Search</span>
          <Kbd className="ml-auto hidden shrink-0 @[8.5rem]:inline-flex">
            ⌘K
          </Kbd>
        </button>
      </div>

      {/* - `overflow-x-hidden`: nothing in the rail may scroll it sideways; a
            row too wide for it truncates instead.
          - Pulled into the rail's right padding, so the scrollbar sits on the
            window's edge rather than 10px in from it. The gutter is kept
            stable: the 10px bar (app.css) always takes the padding it
            replaces, and the rows line up with Search and Settings whether
            the list overflows or not. */}
      <RailHover className="-mr-2.5 min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        {slug && (
          <nav aria-label="Project" className="flex flex-col gap-0.5">
            <SectionLabel>Project</SectionLabel>
            <RefreshMenu onRefresh={() => refreshIssues(slug)}>
              <Link
                to="/w/$slug/issues"
                params={{ slug }}
                // NOTE: The filters are cleared on the way in. "Issues" has to
                // mean every issue; a rail entry that silently kept the last
                // category filter would show a board that is missing work with
                // no visible reason why.
                search={{}}
                className={ROW}
                // Active on an open issue too, and on the Pull requests tab
                // (`/issues/pulls`): both open under this path.
                activeOptions={{ includeSearch: false }}
                activeProps={ACTIVE}
              >
                <HugeiconsIcon
                  icon={ListViewIcon}
                  className="text-muted-foreground group-[[aria-current]]:text-foreground size-4 shrink-0"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate">Issues</span>
                {unseenPulls > 0 && (
                  <Badge
                    role="img"
                    aria-label={unseenPullsLabel}
                    title={unseenPullsLabel}
                    className="ml-auto h-4 min-w-4 rounded-[4px] bg-accent-brand px-1 text-[10px] leading-none text-accent-brand-foreground tabular-nums"
                  >
                    <span aria-hidden="true">
                      {unseenPulls > 99 ? "99+" : unseenPulls}
                    </span>
                  </Badge>
                )}
              </Link>
            </RefreshMenu>
            {/* The working tree itself, as an editor's explorer. */}
            <Link
              to="/w/$slug/files"
              params={{ slug }}
              className={ROW}
              activeProps={ACTIVE}
            >
              <HugeiconsIcon
                icon={FolderFileStorageIcon}
                className="text-muted-foreground group-[[aria-current]]:text-foreground size-4 shrink-0"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">Files</span>
            </Link>
          </nav>
        )}
        {/* The repository, not the board: its changes and its history.
            Pull requests are a tab under Issues. */}
        {slug && (
          <nav aria-label="Repository" className="flex flex-col gap-0.5">
            {/* The row takes the label's vertical padding, so the label and
                the branch button share one box and centre on each other.
                Bottom-aligned, the text sits below the pill's middle. */}
            <div className="flex min-w-0 items-center justify-between gap-2 pt-4 pb-1 pr-1">
              <SectionLabel className="shrink-0 py-0">Repository</SectionLabel>
              <BranchSwitcher slug={slug} />
            </div>
            <RefreshMenu onRefresh={() => void openChanges(slug)}>
              <Link
                to="/w/$slug/changes"
                params={{ slug }}
                className={ROW}
                activeProps={ACTIVE}
              >
                <HugeiconsIcon
                  icon={GitCompareIcon}
                  className="text-muted-foreground group-[[aria-current]]:text-foreground size-4 shrink-0"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate">Changes</span>
                {(added > 0 || removed > 0) && (
                  <span className="ml-auto shrink-0 text-xs tabular-nums">
                    {added > 0 && (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        +{added}
                      </span>
                    )}
                    {added > 0 && removed > 0 && " "}
                    {removed > 0 && (
                      <span className="text-rose-600 dark:text-rose-400">
                        −{removed}
                      </span>
                    )}
                  </span>
                )}
              </Link>
            </RefreshMenu>
            <RefreshMenu onRefresh={() => refreshHistory(slug)}>
              <Link
                to="/w/$slug/history"
                params={{ slug }}
                className={ROW}
                activeProps={ACTIVE}
              >
                <HugeiconsIcon
                  icon={Clock01Icon}
                  className="text-muted-foreground group-[[aria-current]]:text-foreground size-4 shrink-0"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate">History</span>
                {unpushed > 0 && (
                  <span
                    role="img"
                    aria-label={unpushedLabel}
                    title={unpushedLabel}
                    className="ml-auto flex shrink-0 items-center gap-1 text-xs text-blue-600 tabular-nums dark:text-blue-400"
                  >
                    <HugeiconsIcon
                      icon={SquareArrowUp02Icon}
                      className="size-3.5"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    {unpushed > 1 && <span aria-hidden="true">{unpushed}</span>}
                  </span>
                )}
              </Link>
            </RefreshMenu>
          </nav>
        )}
        {/* Conductors (FE-95/D2): under Repository, above Pinned and
            Running. */}
        {workspaceKey && slug && (
          <ConductorsNav
            workspace={workspaceKey}
            slug={slug}
            hasFolder={hasFolder}
            row={ROW}
            active={ACTIVE.className}
          />
        )}
        {workspaceKey && slug && (
          <AgentSessionsNav
            workspace={workspaceKey}
            slug={slug}
            // The group shows for a project with a folder even before its
            // first conversation, so its + has somewhere to live (FE-25/D3).
            hasFolder={hasFolder}
            row={ROW}
            active={ACTIVE.className}
          />
        )}
      </RailHover>

      <div className="mt-2 shrink-0 pt-2 pb-2.5">
        <LocalModeRail />
        <Link
          to="/settings"
          aria-keyshortcuts="Meta+Comma"
          className={LONE_ROW}
        >
          <HugeiconsIcon
            icon={Settings01Icon}
            className="text-muted-foreground size-4 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">Settings</span>
          {/* The key the app menu's Settings… answers to (`menu.ts`). */}
          <Kbd className="ml-auto shrink-0">⌘,</Kbd>
        </Link>
      </div>
    </aside>
  );
}
