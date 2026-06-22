import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { FolderLibraryIcon, Note01Icon } from "@hugeicons/core-free-icons";
import { getBoard, getSessionUser } from "@/server/reviews";
import { AppShell } from "@/components/app-shell";
import { BranchSwitcher } from "@/components/branch-switcher";
import type { SidebarNav } from "@/components/app-sidebar";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { ReviewList } from "@/components/kanban/review-list";
import { ReviewDialog } from "@/components/kanban/review-dialog";
import { BoardSkeleton } from "@/components/kanban/board-skeleton";
import { cn } from "@/lib/utils";

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
  component: BoardPage,
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
        <Link to="/" className="mt-4 inline-block text-sm underline">
          Back to projects
        </Link>
      </div>
    </div>
  ),
});

type View = "board" | "list" | "timeline" | "due";
const TABS: Array<{ key: View; label: string; enabled: boolean }> = [
  { key: "board", label: "Board", enabled: true },
  { key: "list", label: "List", enabled: true },
  { key: "timeline", label: "Timeline", enabled: false },
  { key: "due", label: "Due Tasks", enabled: false },
];

function PendingBoard() {
  const { owner, repo } = Route.useParams();
  return <BoardSkeleton owner={owner} repo={repo} />;
}

function BoardPage() {
  const { user } = Route.useRouteContext();
  const { board } = Route.useLoaderData();
  const { mine, tag } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [view, setView] = useState<View>("board");

  const { filtered, nav } = useMemo(() => {
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

    const nav: SidebarNav = {
      owner: board.owner,
      repo: board.repo,
      mine: !!mine,
      tag,
      totalCount: board.cards.length,
      myCount,
      tags,
    };
    return { filtered, nav };
  }, [board, mine, tag]);

  const heading = mine ? "My tasks" : tag ? `#${tag}` : board.repo;

  return (
    <AppShell user={user} active={{ owner: board.owner, repo: board.repo }} nav={nav}>
      {/* Header */}
      <div className="px-6 pt-5">
        <div className="text-sm text-muted-foreground">{board.owner}</div>
        <div className="mt-1 flex items-end justify-between gap-4">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{heading}</h1>
          <div className="flex shrink-0 items-center gap-1.5 pb-1">
            <MetaPill icon={FolderLibraryIcon}>
              <span className="font-mono">.agents/reviews</span>
            </MetaPill>
            <BranchSwitcher
              owner={board.owner}
              repo={board.repo}
              current={board.branch}
              onSelect={(branch) => navigate({ search: (prev) => ({ ...prev, branch }) })}
            />
            <MetaPill icon={Note01Icon} accent>
              <span className="font-semibold text-foreground tabular-nums">{filtered.length}</span>
              {filtered.length !== board.cards.length ? (
                <span className="tabular-nums">/{board.cards.length}</span>
              ) : null}
              <span>reviews</span>
            </MetaPill>
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-4 flex items-center gap-1 border-b">
          {TABS.map((t) => (
            <button
              key={t.key}
              disabled={!t.enabled}
              onClick={() => t.enabled && setView(t.key)}
              title={t.enabled ? undefined : "Coming soon"}
              className={cn(
                "relative -mb-px rounded-t-lg px-3.5 py-2 text-sm transition-colors",
                view === t.key
                  ? "border border-b-background bg-background font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
                !t.enabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 pt-5">
        {view === "list" ? <ReviewList cards={filtered} /> : <KanbanBoard cards={filtered} />}
      </div>

      <ReviewDialog owner={board.owner} repo={board.repo} branch={board.branch} />
    </AppShell>
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
