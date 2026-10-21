import {
  Clock01Icon,
  FolderFileStorageIcon,
  GitCompareIcon,
  GitPullRequestIcon,
  ListViewIcon,
  Search01Icon,
  Settings01Icon,
  SquareArrowUp02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";
import { LocalModeRail } from "#/components/shared/auth/local-mode";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
import { BranchSwitcher } from "#/components/shared/repo/branch-switcher";
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
import { useIssueView } from "#/stores/issue-view";
import { usePulls } from "#/stores/pulls";
import { useSession } from "#/stores/session";
import { useWorktree } from "#/stores/worktree";
import { AgentSessionsNav } from "./agent-sessions-nav";
import { MiniRail } from "./mini-rail";
import { ProjectSwitcher } from "./project-switcher";

/**
 * One row of the rail's scroll area. The active language is `settings-nav`'s,
 * on purpose; the HOVER is `RailHover`'s one sliding background, not the row's.
 */
const ROW = `${RAIL_ROW} group relative flex h-[30px] items-center gap-2.5 rounded-md px-2 text-[13px] transition-[background-color,scale] duration-150 ease-out active:scale-[0.98]`;

/** A row outside the scroll area — Settings — which lights on its own. */
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
 * A rail row with Refresh on right click — reads the row's source again
 * without opening its screen. The wrapper is `contents`, so the row stays the
 * nav's own child for layout and for `RailHover`.
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
 * `mini`: the rail folded to its icons (FE-57); `onExpand` opens it again —
 * from its sidebar button, or from Agents, whose list only reads open.
 */
export function AppSidebar({
  mini = false,
  onExpand,
}: {
  mini?: boolean;
  onExpand?: () => void;
} = {}) {
  // ⚠️ Read from the URL, not from the store. The rail has to draw correctly on
  // the very first paint of a deep link, before anything has been fetched — and
  // the URL is the only thing that is already true at that moment.
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug;
  const view = useBoard((state) => state.view);
  const lastView = useIssueView((state) =>
    slug ? state.bySlug[slug] : undefined,
  );
  const open = useCommandPalette((state) => state.open);
  // Null until the pull-request screen has been opened once — a rail entry
  // that fetched to draw its own badge would read GitHub on every start.
  const pulls = usePulls((state) => state.view);
  const session = useSession((state) => state.session);
  // ⚠️ Two selectors returning numbers, not one returning `{ additions,
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
  // History's ↑ rows, counted — what the next push sends.
  const unpushed = useWorktree((state) =>
    state.slug === slug && state.state?.kind === "ready"
      ? state.state.unpushed
      : 0,
  );
  const unpushedLabel =
    unpushed === 1
      ? "1 commit not pushed yet"
      : `${unpushed} commits not pushed yet`;
  // The terminal's key for this project — the cloud id, or the slug — which
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
  // History's badge is `git status`'s, so its refresh reads both.
  const refreshHistory = (slug: string) => {
    void openHistory(slug);
    void peek(slug);
  };
  // ⚠️ Against the list on screen when it is this project's — its filter
  // included — otherwise the rail's own default, open pull requests.
  const refreshPulls = (slug: string) => {
    const pullsState = usePulls.getState();
    if (pullsState.slug === slug) void pullsState.refresh();
    else void pullsState.open(slug, "open");
  };

  // ⚠️ Read with the board, not when Changes is opened: the badge is the reason
  // to open Changes, so it cannot wait for it. `git status` only — the patch
  // stays the Changes screen's to read — on project change and on focus, never
  // on a timer.
  useEffect(() => {
    if (!slug) return;
    void peek(slug);
    const onFocus = () => void peek(slug);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [peek, slug]);

  // ⚠️ ⌘N is free on macOS: Electron's default menu binds ⌘W and ⌘Q, never ⌘N,
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

  // The orb's seed, not a label — see `AccountOrb`. Absent when the control
  // plane never told us who owns this machine, and then there is no mark to
  // draw rather than a mark standing for nobody.
  const accountSeed =
    session?.principal.kind === "machine"
      ? (session.principal.userId ?? "")
      : "";

  // ⚠️ Swapping between the open rail and the icons fades the new one in,
  // so the swap reads as part of the glide; the first paint, at launch,
  // does not fade.
  // Worked out while rendering, not in an effect: a flag set after the swap
  // would draw the new rail fully once, then start its fade from nothing.
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
            <AgentSessionsNav
              workspace={workspaceKey}
              slug={slug}
              hasFolder={hasFolder}
              row={ROW}
              active={ACTIVE.className}
              mini
            />
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
          rail holds them, open or folded (FE-58). */}
      <div className="mt-2 shrink-0">
        <ProjectSwitcher />
      </div>

      {/* Search sits where composing used to: the palette behind it reaches
          New issue too, and ⌘N still opens it straight. */}
      <div className="mt-1 mb-1 shrink-0">
        <button
          type="button"
          onClick={open}
          title="Search — ⌘K"
          // ⚠️ A size container, so the ⌘K hint steps aside before the label
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

      {/* ⚠️ `overflow-x-hidden`: nothing in the rail may scroll it sideways —
          a row too wide for it truncates instead.
          ⚠️ Pulled into the rail's right padding, so the scrollbar sits on the
          window's edge rather than 10px in from it. The gutter is kept STABLE:
          the 10px bar (app.css) then always takes exactly the padding it
          replaces, and the rows line up with Search and Settings whether
          the list overflows or not. */}
      <RailHover className="-mr-2.5 min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        {slug && (
          <nav aria-label="Project" className="flex flex-col gap-0.5">
            <SectionLabel>Project</SectionLabel>
            <Link
              to="/w/$slug/issues"
              params={{ slug }}
              // ⚠️ The filters are cleared on the way in. "Issues" has to mean
              // every issue; a rail entry that silently kept the last category
              // filter would show a board that is missing work with no visible
              // reason why. The VIEW is kept (FE-12/D5): list or lanes is how
              // you read, not what you are looking for.
              search={lastView === "board" ? { view: "board" } : {}}
              className={ROW}
              activeOptions={{ exact: true, includeSearch: false }}
              activeProps={ACTIVE}
            >
              <HugeiconsIcon
                icon={ListViewIcon}
                className="text-muted-foreground group-[[aria-current]]:text-foreground size-4 shrink-0"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">Issues</span>
              {view && (
                <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
                  {view.total ?? view.cards.length}
                </span>
              )}
            </Link>
          </nav>
        )}
        {/* The repository, not the board: its working tree, its history and its
            pull requests (FE-21). */}
        {slug && (
          <nav aria-label="Repository" className="flex flex-col gap-0.5">
            {/* ⚠️ The ROW takes the label's vertical padding, so the label and
                the branch button share one box and centre on each other —
                bottom-aligning them left the text sitting below the pill's
                middle. */}
            <div className="flex min-w-0 items-center justify-between gap-2 pt-4 pb-1 pr-1">
              <SectionLabel className="shrink-0 py-0">Repository</SectionLabel>
              <BranchSwitcher slug={slug} />
            </div>
            {/* The working tree itself, as an editor's explorer (FE-66). */}
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
            <RefreshMenu onRefresh={() => refreshPulls(slug)}>
              <Link
                to="/w/$slug/pulls"
                params={{ slug }}
                search={{ tab: "all", status: "open" }}
                className={ROW}
                activeProps={ACTIVE}
              >
                <HugeiconsIcon
                  icon={GitPullRequestIcon}
                  className="text-muted-foreground group-[[aria-current]]:text-foreground size-4 shrink-0"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate">Pull requests</span>
                {pulls && (
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
                    {pulls.pulls.length}
                  </span>
                )}
              </Link>
            </RefreshMenu>
          </nav>
        )}
        {workspaceKey && slug && (
          <AgentSessionsNav
            workspace={workspaceKey}
            slug={slug}
            // ⚠️ The group shows for a project with a folder even before its
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
