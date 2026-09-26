import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { AccountOrb } from "#/components/shared/common/account-orb";
import { RepoMessage } from "#/components/shared/repo/repo-empty";
import { relativeTime } from "#/lib/board-view";
import { useWorktree } from "#/stores/worktree";

/**
 * Repository › History: HEAD's commits, newest first (FE-22/D11).
 *
 * ⚠️ A page of 100, and the next page when the last row scrolls into view —
 * not a "load more" button. History is read by scrolling, and a button every
 * hundred commits interrupts exactly the motion it exists to serve.
 *
 * ⚠️ The mark beside an author is an ORB seeded by their email, not a
 * Gravatar. It is drawn from nothing but the commit, so opening History sends
 * no request anywhere about who wrote this repository.
 */
export function HistoryList() {
  const { slug } = useParams({ from: "/_app/w/$slug/history" });
  const commits = useWorktree((state) => state.history);
  const more = useWorktree((state) => state.historyMore);
  const loading = useWorktree((state) => state.historyLoading);
  const error = useWorktree((state) => state.historyError);
  const moreHistory = useWorktree((state) => state.moreHistory);
  const sentinel = useRef<HTMLDivElement>(null);
  const now = Date.now();

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !more) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void moreHistory();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, moreHistory]);

  if (!commits.length) {
    if (error)
      return (
        <RepoMessage
          title="The history could not be read"
          description={error}
        />
      );
    return loading ? (
      <p className="text-muted-foreground p-4 text-xs">Reading the history…</p>
    ) : (
      <RepoMessage
        title="No commits yet"
        description="Make the first commit from Changes and it appears here."
      />
    );
  }

  return (
    <nav
      aria-label="Commits"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 py-1.5"
    >
      {commits.map((commit) => (
        <Link
          key={commit.sha}
          to="/w/$slug/history/$sha"
          params={{ slug, sha: commit.sha }}
          className="hover:bg-foreground/[0.04] aria-[current]:bg-foreground/[0.06] focus-visible:ring-accent-brand flex min-w-0 flex-col gap-1 rounded-md px-2.5 py-2 outline-none focus-visible:ring-2"
        >
          <span className="min-w-0 truncate text-[13px]">{commit.subject}</span>
          <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            <AccountOrb seed={commit.authorEmail} className="size-4" />
            <span className="min-w-0 truncate">{commit.authorName}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={commit.authoredAt} className="shrink-0">
              {relativeTime(commit.authoredAt, now)}
            </time>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 font-mono">{commit.shortSha}</span>
          </span>
        </Link>
      ))}
      <div ref={sentinel} className="h-px shrink-0" />
      {loading && (
        <p className="text-muted-foreground px-2.5 py-2 text-xs">Loading…</p>
      )}
      {error && (
        <p role="alert" className="text-destructive px-2.5 py-2 text-xs">
          {error}
        </p>
      )}
    </nav>
  );
}
