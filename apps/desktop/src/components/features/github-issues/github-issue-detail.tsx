import {
  ExternalLinkIcon,
  RecordIcon,
  TaskAdd01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { UserAvatar } from "#/components/shared/common/user-avatar";
import { Skeleton } from "#/components/ui/skeleton";
import { relativeTime } from "#/lib/board-view";
import { pageOf, useGitHubIssues } from "#/stores/github-issues";
import {
  formatRepoRef,
  type GitHubIssueComment,
  type GitHubIssueDetail as IssueDetail,
  type PullAuthor,
} from "../../../../shared/git";
import { GitHubIssuesProblemState } from "./github-issue-row.problem";

/**
 * What "Create card from issue" fills the New issue form with.
 *
 * The issue's link goes first in the body, so the card still points at its
 * source after somebody rewrites the rest. The body is the issue's own
 * markdown; the comments stay on GitHub.
 */
export function cardPrefill(detail: IssueDetail): {
  title: string;
  body: string;
} {
  const source = `[${formatRepoRef(detail.repo)}#${detail.issue.number}](${detail.issue.url})`;
  const body = detail.body.trim();
  return {
    title: detail.issue.title,
    body: body
      ? `From GitHub issue ${source}\n\n${body}`
      : `From GitHub issue ${source}`,
  };
}

/** The moment, spelled out, with the exact one in the tooltip. */
function When({ at }: { at: string }) {
  const stamp = new Date(at);
  if (Number.isNaN(stamp.getTime())) return null;
  return (
    <time
      dateTime={stamp.toISOString()}
      title={stamp.toString()}
      className="text-muted-foreground shrink-0 text-xs"
    >
      {relativeTime(at, Date.now())}
    </time>
  );
}

function Person({ person }: { person: PullAuthor | null }) {
  // GitHub answers a null author for a deleted account; it shows "ghost".
  const login = person?.login ?? "ghost";
  return (
    <UserAvatar
      src={person?.avatarUrl}
      seed={login}
      title={login}
      className="size-5"
    />
  );
}

function Comment({ comment }: { comment: GitHubIssueComment }) {
  const login = comment.author?.login ?? "ghost";
  return (
    <li className="flex gap-2.5">
      <span className="flex w-5 shrink-0 justify-center self-start pt-0.5">
        <Person person={comment.author} />
      </span>
      <div className="border-border bg-foreground/[0.02] min-w-0 flex-1 rounded-lg border px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium">{login}</span>
          <When at={comment.createdAt} />
        </div>
        <div className="mt-1">
          <MarkdownBody source={comment.body} empty="No text." />
        </div>
      </div>
    </li>
  );
}

/**
 * The issue page's shape while it loads: header, body, two comments.
 *
 * Drawn under the real header's height, so the page does not jump when the
 * issue lands.
 */
function GitHubIssueDetailSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading this GitHub issue"
      className="flex min-w-0 flex-col"
    >
      <div className="border-border flex h-11 items-center gap-2 border-b px-6">
        <Skeleton className="size-3.5 shrink-0 rounded-full" />
        <Skeleton className="h-3 w-10" />
        <Skeleton className="ml-auto h-6 w-28" />
        <Skeleton className="size-6" />
      </div>
      <div className="flex flex-col gap-5 px-6 py-6">
        <Skeleton className="h-6 w-2/3" />
        <div className="flex items-center gap-2">
          <Skeleton className="size-5 rounded-full" />
          <Skeleton className="h-3 w-40" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
        </div>
        {[0, 1].map((row) => (
          <div key={row} className="flex gap-2.5">
            <Skeleton className="size-5 shrink-0 rounded-full" />
            <Skeleton className="h-16 flex-1 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * One GitHub issue, read-only (FE-75/D6a): its body, its comments, and two
 * ways out — to GitHub, or into a card on this board.
 *
 * Nothing here writes to GitHub. "Create card from issue" opens the New issue
 * form filled from the issue; the card is the board's write, made when
 * somebody saves that form.
 */
export function GitHubIssueDetail({
  slug,
  number,
}: {
  slug: string;
  number: number;
}) {
  const openIssue = useGitHubIssues((state) => state.openIssue);
  const page = useGitHubIssues((state) => pageOf(state, slug, number));

  useEffect(() => {
    void openIssue(slug, number);
  }, [openIssue, slug, number]);

  const { detail, loading, problem } = page;
  if (!detail && loading) return <GitHubIssueDetailSkeleton />;
  if (!detail)
    return problem ? (
      <GitHubIssuesProblemState slug={slug} problem={problem} />
    ) : null;

  const { issue } = detail;
  const prefill = cardPrefill(detail);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="border-border flex h-11 shrink-0 items-center gap-2 border-b px-6">
        <HugeiconsIcon
          icon={RecordIcon}
          className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="text-muted-foreground font-mono text-xs">
          {formatRepoRef(detail.repo)}#{issue.number}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Link
            to="/w/$slug/issues/new"
            params={{ slug }}
            // NOTE: The New issue route has to read `title` and `body` from
            // its search for these to reach the form.
            search={prefill}
            className="hover:bg-foreground/[0.06] flex h-6 items-center gap-1.5 rounded-md px-2 text-xs transition-colors"
          >
            <HugeiconsIcon
              icon={TaskAdd01Icon}
              className="text-muted-foreground size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Create card from issue
          </Link>
          {/* A real link: the window's navigation guard sends external origins
              to the OS browser. */}
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open on GitHub"
            title="Open on GitHub"
            className="hover:bg-foreground/[0.06] flex size-6 items-center justify-center rounded-md transition-colors"
          >
            <HugeiconsIcon
              icon={ExternalLinkIcon}
              className="text-muted-foreground size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </a>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="flex min-w-0 flex-col gap-5 px-6 py-6">
          <h1 className="text-xl font-semibold tracking-tight">
            {issue.title}
          </h1>
          <div className="text-muted-foreground -mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Person person={issue.author} />
            <span>
              <span className="text-foreground font-medium">
                {issue.author?.login ?? "ghost"}
              </span>{" "}
              opened this
            </span>
            <When at={issue.createdAt} />
            {issue.labels.map((label) => (
              <span
                key={label.name}
                className="border-border inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2"
              >
                <span
                  aria-hidden="true"
                  className="bg-tone-neutral size-1.5 shrink-0 rounded-full"
                  style={
                    /^[0-9a-f]{6}$/i.test(label.color)
                      ? { backgroundColor: `#${label.color}` }
                      : undefined
                  }
                />
                {label.name}
              </span>
            ))}
            {issue.assignees.length > 0 && (
              <span className="ml-auto flex items-center gap-1.5">
                Assigned to
                {issue.assignees.map((person) => (
                  <Person key={person.login} person={person} />
                ))}
              </span>
            )}
          </div>

          {problem && (
            // A failed re-read over an issue already on screen: said, not
            // drawn over the issue somebody is reading.
            <p className="text-destructive text-xs/relaxed">
              {problem.kind === "failed"
                ? problem.message
                : "Could not refresh this issue."}
            </p>
          )}

          <MarkdownBody source={detail.body} />

          <section className="flex flex-col gap-3 pt-2">
            <h2 className="text-[13px] font-medium">
              Comments{" "}
              <span className="text-muted-foreground tabular-nums">
                {detail.comments.length}
              </span>
            </h2>
            {detail.comments.length > 0 && (
              <ul className="flex flex-col gap-3">
                {detail.comments.map((comment) => (
                  <Comment key={comment.id} comment={comment} />
                ))}
              </ul>
            )}
          </section>
        </article>
      </div>
    </div>
  );
}
