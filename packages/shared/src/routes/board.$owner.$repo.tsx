import { createFileRoute, redirect, Link, Outlet, useLocation, useParams, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  FolderLibraryIcon,
  Clock01Icon,
  RefreshIcon,
  PlusSignIcon,
  LeftToRightListBulletIcon,
  KanbanIcon,
} from "@hugeicons/core-free-icons";
import { getBoard, getSessionUser } from "@/server/reviews";
import { AppShell } from "@/components/app-shell";
import { BranchSwitcher } from "@/components/branch-switcher";
import { Button } from "@/components/ui/button";
import type { SidebarNav } from "@/components/app-sidebar";
import { ReviewDialog } from "@/components/kanban/review-dialog";
import { CreateCardDialog } from "@/components/kanban/create-card-dialog";
import { BoardSkeleton } from "@/components/kanban/board-skeleton";
import { cn } from "@/lib/utils";
import { useLocalLiveReload } from "@/hooks/use-local-live";

interface BoardSearch {
  mine?: boolean;
  tag?: string;
  branch?: string;
}

export const Route = createFileRoute("/board/$owner/$repo")({
  validateSearch: (s: Record<string, unknown>): BoardSearch => ({
    mine: s.mine === true || s.mine === "true" ? true : undefined,
    tag: typeof s.tag === "string" && s.tag ? s.tag : undefined,
    branch: typeof s.branch === "string" && s.branch ? s.branch : undefined,
  }),
  beforeLoad: async () => {
    const user = await getSessionUser();
    if (!user) throw redirect({ to: "/" });
    return { user };
  },
  loaderDeps: ({ search: { branch } }) => ({ branch }),
  loader: async ({ params, deps }) => {
    const board = await getBoard({
      data: { owner: params.owner, repo: params.repo, branch: deps.branch },
    });
    return { board };
  },
  head: ({ params }) => ({
    meta: [{ title: `${params.owner}/${params.repo} - Lanework` }],
  }),
  component: BoardLayout,
  pendingMs: 120,
  pendingMinMs: 400,
  pendingComponent: PendingBoard,
  errorComponent: ({ error }) => (
    <div className="grid min-h-screen place-items-center p-10 text-center">
      <div>
        <h1 className="text-lg font-semibold">Couldn’t load this board</h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          {import.meta.env.PROD
            ? "Something went wrong loading this board. Check the repo exists and you have access, then try again."
            : error.message}
        </p>
        <Link to="/dashboard" className="mt-4 inline-block text-sm underline">
          Back to projects
        </Link>
      </div>
    </div>
  ),
});

export type BoardView = "board" | "list";
export const DEFAULT_VIEW: BoardView = "board";
const TABS: Array<{ key: BoardView; label: string; icon: IconSvgElement }> = [
  { key: "list", label: "List", icon: LeftToRightListBulletIcon },
  { key: "board", label: "Kanban", icon: KanbanIcon },
];

function PendingBoard() {
  const { owner, repo } = Route.useParams();
  return <BoardSkeleton owner={owner} repo={repo} />;
}

/**
 * Filtered board data + sidebar nav, derived from the layout's loader data and
 * the current search. Shared by the layout header and each view route (they all
 * read the same parent loader, so switching tabs never refetches the board).
 */
export function useBoardData() {
  const { board } = Route.useLoaderData();
  const { mine, tag } = Route.useSearch();
  return useMemo(() => {
    const tagCounts = new Map<string, number>();
    let myCount = 0;
    for (const c of board.cards) {
      if (c.assignees.includes(board.viewer)) myCount++;
      for (const t of c.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const tags = [...tagCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const filtered = board.cards.filter(
      (c) =>
        (!mine || c.assignees.includes(board.viewer)) && (!tag || c.tags.includes(tag)),
    );

    // Aggregate checklist progress across the visible cards (x/x on the board).
    const totals = filtered.reduce(
      (acc, c) => ({ done: acc.done + c.stats.done, total: acc.total + c.stats.total }),
      { done: 0, total: 0 },
    );

    const nav: SidebarNav = {
      owner: board.owner,
      repo: board.repo,
      mine: !!mine,
      tag,
      totalCount: board.cards.length,
      myCount,
      tags,
    };
    return { board, filtered, totals, nav, mine, tag };
  }, [board, mine, tag]);
}

function BoardLayout() {
  const { user } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  // The active view is the `$view` path param of the child route.
  const { view } = useParams({ strict: false }) as { view?: string };
  const activeView = (view ?? DEFAULT_VIEW) as BoardView;
  useLocalLiveReload(); // live-refresh the board as local review files change (local mode only)

  const { board, nav, mine, tag } = useBoardData();
  const [addOpen, setAddOpen] = useState(false);
  const heading = mine ? "My tasks" : tag ? `#${tag}` : "Tasks";
  // The Cost child page lives under this layout but shows its own UI — hide the
  // review header + view tabs there.
  const location = useLocation();
  const onCost = location.pathname.endsWith("/cost");

  return (
    <AppShell
      user={user}
      active={{ owner: board.owner, repo: board.repo }}
      nav={{ ...nav, cost: onCost }}
    >
      {/* Board header + view tabs (hidden on the Cost page) */}
      {!onCost ? (
      <div className="px-6 pt-5">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{heading}</h1>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* No git branches in local mode — the board is the working tree. */}
            {!__LANEWORK_LOCAL__ && (
              <BranchSwitcher
                owner={board.owner}
                repo={board.repo}
                current={board.branch}
                onSelect={(branch) => navigate({ search: (prev) => ({ ...prev, branch }) })}
              />
            )}
            <RefreshControl
              owner={board.owner}
              repo={board.repo}
              branch={board.branch}
              fetchedAt={board.fetchedAt}
            />
          </div>
        </div>

        {/* Toolbar: primary action + view switcher — one shared 36px control height. */}
        <div className="mt-4 flex items-center gap-2">
          {__LANEWORK_LOCAL__ ? (
            <Button
              size="lg"
              onClick={() => setAddOpen(true)}
              className="h-9 gap-1.5 rounded-xl px-3.5 shadow-sm"
            >
              <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
              Add task
            </Button>
          ) : null}
          <div
            role="tablist"
            aria-label="Board view"
            className="inline-flex h-9 items-center gap-1 rounded-xl border bg-muted/40 p-1"
          >
            {TABS.map((t) => {
              const active = activeView === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() =>
                    navigate({
                      to: "/board/$owner/$repo/$view",
                      params: (p) => ({ ...p, view: t.key }),
                      search: (prev) => prev,
                    })
                  }
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-sm transition-colors",
                    active
                      ? "bg-background font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                  )}
                >
                  <HugeiconsIcon icon={t.icon} className="size-4" />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      ) : null}

      {/* Active view renders here */}
      <div className="min-h-0 flex-1 pt-5">
        <Outlet />
      </div>

      {__LANEWORK_LOCAL__ ? (
        <CreateCardDialog open={addOpen} onOpenChange={setAddOpen} owner={board.owner} repo={board.repo} />
      ) : null}
      <ReviewDialog owner={board.owner} repo={board.repo} branch={board.branch} />
    </AppShell>
  );
}

function formatRelativeTime(epochMs: number): string {
  const secs = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** "Updated Xm ago" badge + a button to force-refresh the board from GitHub. */
function RefreshControl({
  owner,
  repo,
  branch,
  fetchedAt,
}: {
  owner: string;
  repo: string;
  branch: string;
  fetchedAt: number;
}) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [, setTick] = useState(0);

  // Tick every second so the "Updated Xs ago" label counts up live.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      // Re-pull the loader so the board (and its new fetchedAt) updates. Hold the
      // refreshing state for at least 1s so the spinner is clearly visible.
      await Promise.all([
        (async () => {
          await getBoard({ data: { owner, repo, branch, refresh: true } });
          await router.invalidate();
        })(),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <MetaPill icon={Clock01Icon}>
        <span className="tabular-nums">
          {refreshing ? "Refreshing…" : `Updated ${formatRelativeTime(fetchedAt)}`}
        </span>
      </MetaPill>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        title="Refresh"
        aria-label="Refresh"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-transparent bg-muted/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
      >
        <HugeiconsIcon icon={RefreshIcon} className={cn("size-3.5", refreshing && "animate-spin")} />
      </button>
    </div>
  );
}

/** A small metadata pill in the board header (path / branch / review count). */
function MetaPill({
  icon,
  accent,
  children,
}: {
  icon: typeof FolderLibraryIcon;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors",
        accent ? "border-primary/20 bg-primary/5" : "border-transparent bg-muted/60 hover:bg-muted",
      )}
    >
      <HugeiconsIcon
        icon={icon}
        className={cn("size-3.5 shrink-0", accent ? "text-primary" : "text-muted-foreground/70")}
      />
      {children}
    </span>
  );
}
