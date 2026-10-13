import {
  Clock01Icon,
  GitCompareIcon,
  GitPullRequestIcon,
  ListViewIcon,
  PencilEdit02Icon,
  Search01Icon,
  Settings01Icon,
  SquareArrowUp02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { LocalModeRail } from "#/components/shared/auth/local-mode";
import { AccountOrb } from "#/components/shared/common/account-orb";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
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
import { BranchSwitcher } from "./branch-switcher";
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

export function AppSidebar() {
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

  return (
    <aside className="app-sidebar flex min-h-0 flex-1 flex-col px-2.5">
      {/* Clears the native traffic lights and gives the window a drag handle. */}
      <div className="app-sidebar-titlebar shrink-0" aria-hidden="true" />
      <div className="mt-2 shrink-0">
        <ProjectSwitcher />
      </div>

      {/* ⚠️ Composing sits ABOVE navigating, and the two share one row. The
          rail's first control is the one thing a person came to do; search has
          the whole palette behind it and a shortcut people already know, so it
          gives up its label rather than its place. */}
      <div className="mt-1 mb-1 flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={!slug}
          title={
            slug ? undefined : "Open a project before writing an issue for it."
          }
          onClick={() =>
            slug &&
            void navigate({ to: "/w/$slug/issues/new", params: { slug } })
          }
          // ⚠️ A size container, so the ⌘N hint can step aside before the label
          // has to: at the rail's narrowest there is room for "New issue" or
          // for the hint, and the words are the one worth keeping.
          className="hover:bg-foreground/[0.06] bg-foreground/[0.035] @container flex h-[30px] min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors duration-150 disabled:opacity-50"
        >
          <HugeiconsIcon
            icon={PencilEdit02Icon}
            className="text-muted-foreground size-4 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">New issue</span>
          <Kbd className="ml-auto hidden shrink-0 @[8.5rem]:inline-flex">
            ⌘N
          </Kbd>
        </button>
        <button
          type="button"
          onClick={open}
          aria-label="Search"
          title="Search — ⌘K"
          className="hover:bg-foreground/[0.06] bg-foreground/[0.035] flex size-[30px] shrink-0 items-center justify-center rounded-md transition-colors duration-150"
        >
          <HugeiconsIcon
            icon={Search01Icon}
            className="text-muted-foreground size-4"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </button>
      </div>

      {/* ⚠️ `overflow-x-hidden`: nothing in the rail may scroll it sideways —
          a row too wide for it truncates instead.
          ⚠️ Pulled into the rail's right padding, so the scrollbar sits on the
          window's edge rather than 10px in from it. The gutter is kept STABLE:
          the 10px bar (app.css) then always takes exactly the padding it
          replaces, and the rows line up with New issue and Settings whether
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
              // reason why. The VIEW is kept (FE-13/D5): list or lanes is how
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
            pull requests (FE-22). */}
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
          </nav>
        )}
        {workspaceKey && slug && (
          <AgentSessionsNav
            workspace={workspaceKey}
            slug={slug}
            // ⚠️ The group shows for a project with a folder even before its
            // first conversation, so its + has somewhere to live (FE-26/D3).
            hasFolder={hasFolder}
            row={ROW}
            active={ACTIVE.className}
          />
        )}
      </RailHover>

      <div className="mt-2 shrink-0 pt-2 pb-2.5">
        <LocalModeRail />
        <Link to="/settings" className={LONE_ROW}>
          <HugeiconsIcon
            icon={Settings01Icon}
            className="text-muted-foreground size-4 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">Settings</span>
          {accountSeed && (
            // ⚠️ Hidden from the accessible name. A mark appended to "Settings"
            // tells a screen-reader user nothing and makes the link impossible
            // to address by the word on it.
            <AccountOrb
              seed={accountSeed}
              className="ml-auto size-5 shrink-0"
            />
          )}
        </Link>
      </div>
    </aside>
  );
}
