import {
  FilterIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  ListViewIcon,
  PencilEdit02Icon,
  Refresh01Icon,
  UserIcon,
  ViewIcon,
  WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  FilterMenu,
  type MenuField,
} from "#/components/shared/common/filter-menu";
import { SegmentedControl } from "#/components/shared/common/segmented-control";
import { UserAvatar } from "#/components/shared/common/user-avatar";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { SourceHeader } from "#/components/shared/navigation/source-tabs";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { ScrollArea } from "#/components/ui/scroll-area";
import { shortAge } from "#/lib/board-view";
import { PULL_TABS, type PullSearch, type PullTab } from "#/lib/pull-search";
import { cn } from "#/lib/utils";
import { canReadPulls, usePulls } from "#/stores/pulls";
import {
  formatRepoRef,
  type PullRequest,
  type PullStatus,
  type RepoSide,
} from "../../../../shared/git";
import { ConnectPanel } from "./connect-panel";

/**
 * The Show filter's labels.
 *
 * Real words, not `text-transform: capitalize` over the raw values: CSS
 * capitalisation does not reach the accessible name, so a screen reader (and
 * any test) heard "authored" while the screen said "Authored".
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
 * Merged and closed get different marks because they are different outcomes,
 * as GitHub draws them: a shipped change and an abandoned one.
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

/** What the pull request list can be filtered on. */
const PULL_FILTERS = [
  {
    key: "tab",
    label: "Show",
    icon: UserIcon,
    options: PULL_TABS.map((value) => ({ value, label: TAB_LABEL[value] })),
  },
  {
    key: "status",
    label: "State",
    icon: GitPullRequestIcon,
    options: (["open", "merged", "closed", "all"] as const).map((value) => ({
      value,
      label: STATUS_LABEL[value],
    })),
  },
] satisfies MenuField[];

const FILTER_GLYPH: Record<string, { icon: IconSvgElement; tone: string }> = {
  all: { icon: ListViewIcon, tone: "text-muted-foreground" },
  reviewing: { icon: ViewIcon, tone: "text-muted-foreground" },
  authored: { icon: PencilEdit02Icon, tone: "text-muted-foreground" },
  open: {
    icon: GitPullRequestIcon,
    tone: "text-emerald-600 dark:text-emerald-400",
  },
  merged: { icon: GitMergeIcon, tone: "text-violet-600 dark:text-violet-400" },
  closed: {
    icon: GitPullRequestClosedIcon,
    tone: "text-rose-600 dark:text-rose-400",
  },
};

/** The icon a filter value carries, in the colour its state has on a row. */
function PullFilterGlyph({ value }: { value: string }) {
  const glyph = FILTER_GLYPH[value] ?? FILTER_GLYPH.all;
  return (
    <HugeiconsIcon
      icon={glyph.icon}
      className={cn("size-3.5 shrink-0", glyph.tone)}
      strokeWidth={1.6}
      aria-hidden="true"
    />
  );
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
        to="/w/$slug/issues/pulls/$number"
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
              <UserAvatar
                src={pull.author.avatarUrl}
                seed={pull.author.login}
                className="size-3.5"
              />
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
      <h3 className="bg-sidebar/95 text-muted-foreground sticky top-0 z-10 flex h-7 items-center gap-2 px-4 text-[11px] font-medium backdrop-blur">
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
 * The list's filter and Refresh, beside its search box.
 *
 * The issue list's Filter menu ({@link FilterMenu}), with two fields: Show
 * (All, Reviewing, Authored) and State. Show is not a row of tabs because
 * Issues and Pull requests are already tabs above the list (FE-75), and a
 * second row would read as a third level of navigation.
 *
 * Nothing until `gh` is signed in and the folder is a GitHub repo: there is
 * no list to filter.
 */
function PullsListControls() {
  const { slug } = useParams({ from: "/_app/w/$slug/issues_/pulls" });
  const { tab, status } = useSearch({ from: "/_app/w/$slug/issues_/pulls" });
  const navigate = useNavigate();
  const account = usePulls((state) => state.account);
  const repo = usePulls((state) => state.repo);
  const view = usePulls((state) => state.view);
  const loading = usePulls((state) => state.loading);
  const refresh = usePulls((state) => state.refresh);

  if (!canReadPulls(account, repo)) return null;
  return (
    <>
      {/* NOTE: Keyed on the applied filters, as the issue list's is: picking
          a value navigates, and a remount is the one close a re-render
          cannot race. */}
      <FilterMenu
        key={`${tab}:${status}`}
        fields={PULL_FILTERS}
        selected={(key) => (key === "tab" ? tab : status)}
        glyph={(_, option) => <PullFilterGlyph value={option.value} />}
        active={(tab !== "all" ? 1 : 0) + (status !== "open" ? 1 : 0)}
        onPick={(key, value) =>
          void navigate({
            to: "/w/$slug/issues/pulls",
            params: { slug },
            search:
              key === "tab"
                ? { tab: (value ?? "all") as PullTab, status }
                : { tab, status: (value ?? "open") as PullStatus },
            replace: true,
          })
        }
      />

      <button
        type="button"
        onClick={() => void refresh()}
        aria-label="Refresh pull requests"
        title={
          view
            ? `Updated ${new Date(view.fetchedAt).toLocaleTimeString()}`
            : "Refresh"
        }
        className="hover:bg-foreground/[0.06] flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
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
    </>
  );
}

/**
 * On a fork checkout, which repo the list reads: the fork or its parent.
 *
 * The choice lasts for the session and is never saved (FE-73). Switching
 * leaves any open pull request, because its number belongs to the other repo.
 */
function ForkSwitch() {
  const { slug } = useParams({ from: "/_app/w/$slug/issues_/pulls" });
  const { tab, status } = useSearch({ from: "/_app/w/$slug/issues_/pulls" });
  const navigate = useNavigate();
  const repo = usePulls((state) => state.repo);
  const selectRepo = usePulls((state) => state.selectRepo);

  if (repo?.kind !== "detected" || !repo.parent) return null;
  return (
    <div className="px-2 pt-2">
      <SegmentedControl
        label="Read pull requests from"
        value={repo.selected}
        options={[
          { value: "self" as RepoSide, label: formatRepoRef(repo.repo) },
          { value: "parent" as RepoSide, label: formatRepoRef(repo.parent) },
        ]}
        onChange={(side) => {
          void navigate({
            to: "/w/$slug/issues/pulls",
            params: { slug },
            search: { tab, status },
            replace: true,
          });
          void selectRepo(side);
        }}
      />
    </div>
  );
}

/**
 * The middle pane: which pull requests there are, and which one is open.
 *
 * The Show values filter one read: they answer "where do I stand on this?",
 * and what decides them (the viewer's login) arrives with the list. The State
 * filter is sent to GitHub instead: a closed pull request is not in the open
 * list to be filtered out of.
 */
export function PullsList() {
  const { slug } = useParams({ from: "/_app/w/$slug/issues_/pulls" });
  const search = useSearch({ from: "/_app/w/$slug/issues_/pulls" });
  const { tab, status } = search;
  const account = usePulls((state) => state.account);
  const repo = usePulls((state) => state.repo);
  const view = usePulls((state) => state.view);
  const error = usePulls((state) => state.error);
  const ready = usePulls((state) => state.ready);
  const [query, setQuery] = useState("");

  // Ages count from when the list was read, so a row's "2h" never disagrees
  // with a banner saying the copy is from this morning.
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
      // Everything else still gets a group. Without one, a pull request that
      // is neither mine nor assigned to me would be invisible under every Show
      // value while the header still counted it.
      { name: "Everything else", pulls: rest },
    ];
  }, [query, tab, view?.pulls]);

  const connected = canReadPulls(account, repo);
  const empty = groups.every((group) => group.pulls.length === 0);

  /**
   * Why the list is empty, said precisely.
   *
   * Three situations with three ways out: the repository has none in this
   * state, the search matched nothing, or this Show value is empty while
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SourceHeader
        slug={slug}
        value="pulls"
        search={
          connected
            ? { query, onQuery: setQuery, label: "Search pull requests" }
            : undefined
        }
        actions={<PullsListControls />}
      />
      {connected ? (
        <>
          <ForkSwitch />

          {/* Says which copy this is. "No open pull requests" and "I could
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

          <ScrollArea className="flex-1">
            {error && (
              <p className="text-destructive px-4 py-3 text-xs/relaxed">
                {error}
              </p>
            )}
            {empty && nothing && (
              <Empty>
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
            {!view && !error && (
              <ListSkeleton
                label="Reading the pull requests"
                lines={2}
                rows={6}
              />
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
          </ScrollArea>
        </>
      ) : ready ? (
        <ConnectPanel />
      ) : (
        <ListSkeleton
          label="Reading the pull requests"
          lines={2}
          rows={6}
          className="pt-12"
        />
      )}
    </div>
  );
}
