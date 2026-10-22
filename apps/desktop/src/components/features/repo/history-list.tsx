import {
  Clock01Icon,
  GitCommitIcon,
  Search01Icon,
  SquareArrowUp02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useParams } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { AccountOrb } from "#/components/shared/common/account-orb";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { RepoMessage } from "#/components/shared/repo/repo-empty";
import { Button } from "#/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "#/components/ui/input-group";
import { relativeTime } from "#/lib/board-view";
import { useWorktree } from "#/stores/worktree";

/**
 * Repository › History: HEAD's commits, newest first (FE-22/D11).
 *
 * - A page of 100, and the next page when the last row scrolls into view,
 *   except while searching, when loading more is an explicit action.
 * - The ↑ at a subject's end marks a commit no remote branch has yet: what
 *   the next push sends.
 *
 * NOTE: The mark beside an author is an orb seeded by their email, not a
 * Gravatar. It is drawn from nothing but the commit, so opening History sends
 * no request anywhere about who wrote this repository.
 */
export function HistoryList() {
  const { slug } = useParams({ from: "/_app/w/$slug/history" });
  const commits = useWorktree((state) => state.history);
  const more = useWorktree((state) => state.historyMore);
  const loading = useWorktree((state) => state.historyLoading);
  const read = useWorktree((state) => state.historyRead);
  const error = useWorktree((state) => state.historyError);
  const moreHistory = useWorktree((state) => state.moreHistory);
  const sentinel = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState({ slug, value: "" });
  const query = search.slug === slug ? search.value : "";
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? commits.filter((commit) =>
        [
          commit.subject,
          commit.authorName,
          commit.authorEmail,
          commit.sha,
        ].some((value) => value.toLowerCase().includes(needle)),
      )
    : commits;
  const now = Date.now();
  const dayFormatter = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  useEffect(() => {
    setSearch({ slug, value: "" });
  }, [slug]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !more || loading || needle || !commits.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void moreHistory();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, moreHistory, loading, needle, commits.length]);

  if (!commits.length) {
    if (error)
      return (
        <RepoMessage
          title="The history could not be read"
          description={error}
        />
      );
    // Not read yet is a loading state, not "No commits yet".
    return loading || !read ? (
      <ListSkeleton label="Reading the history" lines={2} rows={7} />
    ) : (
      <RepoMessage
        title="No commits yet"
        description="Make the first commit from Changes and it appears here."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1.5">
        <InputGroup>
          <InputGroupAddon>
            <HugeiconsIcon
              icon={Search01Icon}
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search commits"
            placeholder="Search commits…"
            className="text-xs"
            value={query}
            onChange={(event) => setSearch({ slug, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearch({ slug, value: "" });
            }}
          />
        </InputGroup>
        {query && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => setSearch({ slug, value: "" })}
          >
            Clear
          </Button>
        )}
      </div>
      <nav
        aria-label="Commits"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pb-1.5"
      >
        {visible.map((commit, index) => {
          const date = new Date(commit.authoredAt);
          const previous = visible[index - 1];
          const startsDay =
            !previous ||
            date.toDateString() !==
              new Date(previous.authoredAt).toDateString();

          return (
            <Fragment key={commit.sha}>
              {startsDay && (
                <h2 className="text-muted-foreground px-2.5 pt-4 pb-2 text-xs font-medium first:pt-2">
                  {dayFormatter.format(date)}
                </h2>
              )}
              <Link
                to="/w/$slug/history/$sha"
                params={{ slug, sha: commit.sha }}
                className="hover:bg-foreground/[0.04] aria-[current]:bg-foreground/[0.06] focus-visible:ring-accent-brand flex min-w-0 flex-col gap-1 rounded-md px-2.5 py-2 outline-none focus-visible:ring-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {commit.subject}
                  </span>
                  {commit.unpushed && (
                    <span
                      role="img"
                      aria-label="Not pushed yet"
                      title="Not pushed yet"
                      className="text-muted-foreground flex shrink-0"
                    >
                      <HugeiconsIcon
                        icon={SquareArrowUp02Icon}
                        className="size-3.5"
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                  <AccountOrb seed={commit.authorEmail} className="size-4" />
                  <span className="min-w-0 truncate">{commit.authorName}</span>
                  <time
                    dateTime={commit.authoredAt}
                    className="flex shrink-0 items-center gap-1"
                  >
                    <HugeiconsIcon
                      icon={Clock01Icon}
                      className="size-3"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    {relativeTime(commit.authoredAt, now)}
                  </time>
                  <span className="flex shrink-0 items-center gap-1 font-mono">
                    <HugeiconsIcon
                      icon={GitCommitIcon}
                      className="size-3"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    {commit.shortSha}
                  </span>
                </span>
              </Link>
            </Fragment>
          );
        })}
        {needle && !visible.length && (
          <p
            role="status"
            className="text-muted-foreground px-2.5 py-4 text-xs"
          >
            No matching commits in the loaded history.
          </p>
        )}
        {needle && more && (
          <Button
            variant="outline"
            className="mx-2.5 my-2 self-start"
            disabled={loading}
            onClick={() => void moreHistory()}
          >
            Load more commits
          </Button>
        )}
        <div ref={sentinel} className="h-px shrink-0" />
        {loading && (
          <ListSkeleton
            label="Loading more commits"
            lines={2}
            rows={2}
            className="px-0"
          />
        )}
        {error && (
          <p role="alert" className="text-destructive px-2.5 py-2 text-xs">
            {error}
          </p>
        )}
      </nav>
    </div>
  );
}
