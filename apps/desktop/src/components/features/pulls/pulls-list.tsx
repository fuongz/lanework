import {
  FilterIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Refresh01Icon,
  Search01Icon,
  WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import { shortAge } from "#/lib/board-view";
import { cn } from "#/lib/utils";
import { usePulls } from "#/stores/pulls";
import {
  formatRepoRef,
  PULL_STATUSES,
  type PullRequest,
  type PullStatus,
} from "../../../../shared/git";
import { ConnectPanel } from "./connect-panel";

export const PULL_TABS = ["all", "reviewing", "authored"] as const;
export type PullTab = (typeof PULL_TABS)[number];

export interface PullSearch {
  tab: PullTab;
  status: PullStatus;
}

/** Unknown values fall back rather than throw: a link from an older build must still open. */
export function parsePullSearch(raw: Record<string, unknown>): PullSearch {
  const tab = raw.tab;
  const status = raw.status;
  return {
    tab: PULL_TABS.includes(tab as PullTab) ? (tab as PullTab) : "all",
    status: PULL_STATUSES.includes(status as PullStatus)
      ? (status as PullStatus)
      : "open",
  };
}

/**
 * ⚠️ Real words, not `text-transform: capitalize` over the raw values. CSS
 * capitalisation does not reach the accessible name, so a screen reader — and
 * any test — heard "authored" while the screen said "Authored".
 */
const TAB_LABEL: Record<PullTab, string> = {
  all: "All",
  reviewing: "Reviewing",
  authored: "Authored",
};

const STATUS_LABEL: Record<PullStatus, string> = {
  all: "All states",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

/**
 * What a pull request's state looks like.
 *
 * ⚠️ Merged and closed get different marks, because they are different
 * outcomes. GitHub draws them apart for the same reason, and one icon for both
 * would say a shipped change and an abandoned one are the same thing.
 */
function stateIcon(pull: PullRequest) {
  if (pull.state === "merged")
    return { icon: GitMergeIcon, tone: "text-violet-600 dark:text-violet-400" };
  if (pull.state === "closed")
    return {
      icon: GitPullRequestClosedIcon,
      tone: "text-rose-600 dark:text-rose-400",
    };
  if (pull.draft)
    return { icon: GitPullRequestDraftIcon, tone: "text-muted-foreground" };
  return {
    icon: GitPullRequestIcon,
    tone: "text-emerald-600 dark:text-emerald-400",
  };
}

function Row({
  pull,
  slug,
  now,
  search,
}: {
  pull: PullRequest;
  slug: string;
  now: number;
  /** Carried into the link so opening one keeps the view you came from. */
  search: PullSearch;
}) {
  const mark = stateIcon(pull);
  return (
    <li>
      <Link
        to="/w/$slug/pulls/$number"
        params={{ slug, number: String(pull.number) }}
        search={search}
        className="hover:bg-foreground/[0.03] focus-visible:ring-accent-brand flex flex-col gap-1 px-4 py-2 outline-none focus-visible:ring-2 focus-visible:-ring-offset-1"
        activeProps={{ className: "bg-foreground/[0.06]" }}
      >
        <div className="flex items-start gap-2">
          <HugeiconsIcon
            icon={mark.icon}
            className={cn("mt-0.5 size-3.5 shrink-0", mark.tone)}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="line-clamp-1 flex-1 text-[13px]">{pull.title}</span>
          <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
            {shortAge(pull.updatedAt, now)}
          </span>
        </div>
        <div className="text-muted-foreground flex items-center gap-1.5 pl-5.5 text-[11px]">
          {pull.author && (
            <>
              {pull.author.avatarUrl ? (
                <img
                  src={pull.author.avatarUrl}
                  alt=""
                  className="size-3.5 rounded-full"
                />
              ) : null}
              <span className="max-w-24 truncate">{pull.author.login}</span>
            </>
          )}
          <span className="max-w-28 truncate font-mono">{pull.headRef}</span>
          <span className="ml-auto shrink-0 tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{pull.additions}
            </span>{" "}
            <span className="text-rose-600 dark:text-rose-400">
              −{pull.deletions}
            </span>
          </span>
        </div>
      </Link>
    </li>
  );
}

function Group({
  name,
  pulls,
  slug,
  now,
  search,
}: {
  name: string;
  pulls: PullRequest[];
  slug: string;
  now: number;
  search: PullSearch;
}) {
  if (!pulls.length) return null;
  return (
    <section>
      <h3 className="bg-background/95 text-muted-foreground sticky top-0 z-10 flex h-7 items-center gap-2 px-4 text-[11px] font-medium backdrop-blur">
        {name}
        <span className="tabular-nums">{pulls.length}</span>
      </h3>
      <ul>
        {pulls.map((pull) => (
          <Row
            key={pull.number}
            pull={pull}
            slug={slug}
            now={now}
            search={search}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * The middle pane: which pull requests there are, and which one is open.
 *
 * ⚠️ The three TABS are filters over one read — they all answer "where do I
 * stand on this?", and the fact that decides them (the viewer's login) arrives
 * with the list. The STATE filter is not: a closed pull request is not in the
 * open list to be filtered out of, so that one is sent to GitHub.
 */
export function PullsList() {
  const { slug } = useParams({ from: "/_app/w/$slug/pulls" });
  const search = useSearch({ from: "/_app/w/$slug/pulls" });
  const { tab, status } = search;
  const navigate = useNavigate();
  const account = usePulls((state) => state.account);
  const repo = usePulls((state) => state.repo);
  const view = usePulls((state) => state.view);
  const loading = usePulls((state) => state.loading);
  const error = usePulls((state) => state.error);
  const ready = usePulls((state) => state.ready);
  const refresh = usePulls((state) => state.refresh);
  const [query, setQuery] = useState("");

  // ⚠️ Ages are measured from when the list was READ. A row that says "2h" next
  // to a banner saying the copy is from this morning is two clocks disagreeing
  // on one screen.
  const now = view ? new Date(view.fetchedAt).getTime() : Date.now();

  const groups = useMemo(() => {
    const pulls = (view?.pulls ?? []).filter((pull) => {
      if (!query) return true;
      const needle = query.toLowerCase();
      return (
        pull.title.toLowerCase().includes(needle) ||
        pull.headRef.toLowerCase().includes(needle) ||
        (pull.author?.login.toLowerCase().includes(needle) ?? false) ||
        String(pull.number).includes(needle)
      );
    });
    const mine = pulls.filter((pull) => pull.authored);
    const review = pulls.filter(
      (pull) => pull.reviewRequested && !pull.authored,
    );
    if (tab === "authored") return [{ name: "Authored", pulls: mine }];
    if (tab === "reviewing")
      return [{ name: "Needs my review", pulls: review }];
    const rest = pulls.filter(
      (pull) => !pull.authored && !pull.reviewRequested,
    );
    return [
      { name: "Needs my review", pulls: review },
      { name: "Authored", pulls: mine },
      // ⚠️ Everything else still gets a group. Without one, a pull request that
      // is neither mine nor assigned to me would be invisible in all three tabs
      // while the header still counted it.
      { name: "Everything else", pulls: rest },
    ];
  }, [query, tab, view?.pulls]);

  const connected = account.kind === "connected" && repo?.kind === "linked";
  const empty = groups.every((group) => group.pulls.length === 0);

  /**
   * Why the list is empty, said precisely.
   *
   * ⚠️ Three situations with three different ways out: the repository has none
   * in this state, the search matched nothing, or this tab is empty while the
   * others are not. One sentence for all three would be wrong twice.
   */
  const nothing = view
    ? view.pulls.length === 0
      ? {
          title:
            status === "all"
              ? "No pull requests"
              : `No ${status} pull requests`,
          description: `${formatRepoRef(view.repo)} has none to show.`,
          filtered: false,
        }
      : query.trim()
        ? {
            title: "No matches",
            description: `Nothing here matches “${query.trim()}”.`,
            filtered: true,
          }
        : {
            title:
              tab === "authored"
                ? "None of these are yours"
                : "Nothing to review",
            description:
              tab === "authored"
                ? "You have not opened any of these. Try the All tab."
                : "Nobody has asked you to review these. Try the All tab.",
            filtered: true,
          }
    : null;

  return (
    <div className="border-sidebar-border flex w-80 shrink-0 flex-col border-r">
      {connected ? (
        <>
          <div className="flex h-9 shrink-0 items-center gap-1 px-2">
            {PULL_TABS.map((value) => (
              <button
                key={value}
                type="button"
                aria-current={tab === value ? "page" : undefined}
                onClick={() =>
                  void navigate({
                    to: "/w/$slug/pulls",
                    params: { slug },
                    search: { tab: value, status },
                    replace: true,
                  })
                }
                className={cn(
                  "h-6 rounded-md px-2 text-xs transition-colors",
                  tab === value
                    ? "bg-foreground/[0.08] text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.04]",
                )}
              >
                {TAB_LABEL[value]}
              </button>
            ))}

            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Filter by state — ${STATUS_LABEL[status]}`}
                title={`Filter by state — ${STATUS_LABEL[status]}`}
                className={cn(
                  "ml-auto flex size-6 items-center justify-center rounded-md transition-colors",
                  // ⚠️ The control says when it is doing something. A state
                  // filter is the reason a list looks short, and this button is
                  // the first place anybody will look for why.
                  status === "open"
                    ? "hover:bg-foreground/[0.06]"
                    : "bg-accent-brand/15 text-accent-brand",
                )}
              >
                <HugeiconsIcon
                  icon={FilterIcon}
                  className={cn(
                    "size-3.5",
                    status === "open" && "text-muted-foreground",
                  )}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuRadioGroup
                  value={status}
                  onValueChange={(value) =>
                    void navigate({
                      to: "/w/$slug/pulls",
                      params: { slug },
                      search: { tab, status: value as PullStatus },
                      replace: true,
                    })
                  }
                >
                  {(["all", "open", "merged", "closed"] as const).map(
                    (value) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {STATUS_LABEL[value]}
                      </DropdownMenuRadioItem>
                    ),
                  )}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              type="button"
              onClick={() => void refresh()}
              aria-label="Refresh pull requests"
              title={
                view
                  ? `Updated ${new Date(view.fetchedAt).toLocaleTimeString()}`
                  : "Refresh"
              }
              className="hover:bg-foreground/[0.06] flex size-6 items-center justify-center rounded-md transition-colors"
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                className={cn(
                  "text-muted-foreground size-3.5",
                  loading && "animate-spin",
                )}
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </button>
          </div>

          <div className="px-2 pb-2">
            <div className="relative">
              <HugeiconsIcon
                icon={Search01Icon}
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search pull requests"
                aria-label="Search pull requests"
                className="pl-7"
              />
            </div>
          </div>

          {/* ⚠️ Says which copy this is. "No open pull requests" and "I could
              not reach GitHub" are different facts that draw identically. */}
          {view?.stale && (
            <div
              role="status"
              className="bg-destructive text-destructive-foreground flex h-6 shrink-0 items-center justify-center gap-1.5 px-3 text-[11px] font-medium"
            >
              <HugeiconsIcon
                icon={WifiDisconnected01Icon}
                className="size-3"
                strokeWidth={2}
                aria-hidden="true"
              />
              Showing a saved list
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {error && (
              <p className="text-destructive px-4 py-3 text-xs/relaxed">
                {error}
              </p>
            )}
            {empty && nothing && (
              <Empty className="py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HugeiconsIcon
                      icon={nothing.filtered ? FilterIcon : GitPullRequestIcon}
                      strokeWidth={1.8}
                    />
                  </EmptyMedia>
                  <EmptyTitle>{nothing.title}</EmptyTitle>
                  <EmptyDescription>{nothing.description}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {groups.map((group) => (
              <Group
                key={group.name}
                name={group.name}
                pulls={group.pulls}
                slug={slug}
                now={now}
                search={search}
              />
            ))}
          </div>
        </>
      ) : ready ? (
        <ConnectPanel />
      ) : null}
    </div>
  );
}
