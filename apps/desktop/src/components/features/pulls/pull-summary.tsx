import {
  ArrowDown01Icon,
  Clock01Icon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { Badge } from "#/components/ui/badge";
import { Skeleton } from "#/components/ui/skeleton";
import { shortAge } from "#/lib/board-view";
import { cn } from "#/lib/utils";
import { usePulls } from "#/stores/pulls";
import type { PullDetail } from "../../../../shared/git";
import { CommentBox } from "./comment-box";
import { PullActivityList } from "./pull-activity";
import { PullChecksSection } from "./pull-checks";

/**
 * What a pull request IS, as opposed to what changed in it.
 *
 * ⚠️ The timeline and the checks are read HERE, not with the pull request. The
 * screen lands on the diff (see the `view` search param), so most opens never
 * show this tab — attaching the read to `openPull` would charge every one of
 * them for it. `loadActivity` is safe to call on each mount; it skips a read it
 * has already answered.
 */

function Row({
  icon,
  label,
  children,
}: {
  icon: IconSvgElement;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-muted-foreground flex w-32 shrink-0 items-center gap-2 text-xs">
        <HugeiconsIcon
          icon={icon}
          className="size-3.5 shrink-0 translate-y-0.5"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        {label}
      </span>
      <div className="min-w-0 flex-1 text-xs">{children}</div>
    </div>
  );
}

/**
 * One foldable section.
 *
 * ⚠️ Open by default and NOT remembered between pull requests. A remembered
 * fold is how somebody opens a new pull request, does not see its description,
 * and has no idea why.
 */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group flex items-center gap-2 self-start text-sm font-medium"
      >
        {title}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className={cn(
            "text-muted-foreground size-4 transition-transform",
            !open && "-rotate-90",
          )}
          strokeWidth={2}
          aria-hidden="true"
        />
        {count !== undefined && (
          <span className="text-muted-foreground tabular-nums">{count}</span>
        )}
      </button>
      {open && (
        <div className="border-sidebar-border border-t pt-4">{children}</div>
      )}
    </section>
  );
}

/** The pull request's state, in the same vocabulary the list uses. */
function stateMark(detail: PullDetail) {
  const { pull } = detail;
  if (pull.draft)
    return {
      icon: GitPullRequestDraftIcon,
      label: "Draft",
      tone: "text-muted-foreground",
    };
  if (pull.state === "merged")
    return {
      icon: GitMergeIcon,
      label: "Merged",
      tone: "text-violet-600 dark:text-violet-400",
    };
  if (pull.state === "closed")
    return {
      icon: GitPullRequestClosedIcon,
      label: "Closed",
      tone: "text-rose-600 dark:text-rose-400",
    };
  return {
    icon: GitPullRequestIcon,
    label: "Open",
    tone: "text-emerald-600 dark:text-emerald-400",
  };
}

export function PullSummary({ detail }: { detail: PullDetail }) {
  const { pull } = detail;
  const mark = stateMark(detail);
  const age = shortAge(pull.createdAt, Date.now());
  const activity = usePulls((state) => state.activity);
  const loading = usePulls((state) => state.activityLoading);
  const error = usePulls((state) => state.activityError);
  const loadActivity = usePulls((state) => state.loadActivity);

  useEffect(() => {
    void loadActivity(pull.number);
  }, [loadActivity, pull.number]);

  // ⚠️ Only when it is THIS pull request's. The store keeps one activity and it
  // survives a switch for as long as the next read takes; drawing it meanwhile
  // would put one pull request's history under another's title.
  const mine = activity?.number === pull.number ? activity : null;

  return (
    // ⚠️ This pane scrolls, unlike the diff beside it. The diff virtualizes and
    // owns its own viewport; a description is ordinary prose and has to be
    // given somewhere to overflow.
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-7 px-8 py-7">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">
            {pull.title}
          </h1>
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            {pull.author && <span>{pull.author.login}</span>}
            {/* The age behind a clock rather than a "·": it says what the
                number is, which a separator never did. */}
            {age && (
              <span className="flex items-center gap-1">
                <HugeiconsIcon
                  icon={Clock01Icon}
                  className="size-3.5"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="sr-only">opened</span>
                {age}
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Row icon={GitBranchIcon} label="Branch">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono">{pull.headRef}</span>
              {/* Decorative: the row is already labelled "Branch", and a screen
                  reader reading "head into base" gains nothing over reading the
                  two names in order. */}
              <span className="text-muted-foreground" aria-hidden="true">
                ›
              </span>
              <span className="font-mono">{pull.baseRef}</span>
              <span className="tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{pull.additions.toLocaleString()}
                </span>{" "}
                <span className="text-rose-600 dark:text-rose-400">
                  −{pull.deletions.toLocaleString()}
                </span>
              </span>
            </span>
          </Row>
          <Row icon={mark.icon} label="Status">
            <span className={mark.tone}>{mark.label}</span>
            {pull.reviewDecision === "APPROVED" && (
              <Badge variant="secondary" className="ml-2">
                Approved
              </Badge>
            )}
            {pull.reviewDecision === "CHANGES_REQUESTED" && (
              <Badge variant="outline" className="ml-2">
                Changes requested
              </Badge>
            )}
          </Row>
          <Row icon={GitPullRequestIcon} label="Files changed">
            <span className="tabular-nums">
              {pull.changedFiles.toLocaleString()}
            </span>
          </Row>
        </div>

        <Section title="Description">
          {/* `MarkdownBody` draws its own empty state when the body is blank —
              the same one the board's cards use. */}
          <MarkdownBody source={detail.body} />
        </Section>

        {/* ⚠️ A failed read is reported as a failure, in place of the sections
            it would have filled. "No CI checks" and "I could not ask GitHub"
            are opposite facts that look identical when both are drawn as
            nothing — the same rule `PullsView.stale` exists for. */}
        {error !== null ? (
          <p className="text-destructive text-xs/relaxed">{error}</p>
        ) : mine === null ? (
          <div className="flex flex-col gap-2" aria-busy={loading}>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <>
            <Section title="Checks">
              <PullChecksSection checks={mine.checks} />
            </Section>

            <Section title="Activity" count={mine.items.length}>
              <div className="flex flex-col gap-4">
                <PullActivityList
                  items={mine.items}
                  truncated={mine.truncated}
                />
                <CommentBox number={pull.number} />
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
