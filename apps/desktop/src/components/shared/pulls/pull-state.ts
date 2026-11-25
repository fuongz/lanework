import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { CheckState, PullRequest } from "#/../shared/git";

/**
 * What a pull request's state looks like.
 *
 * Merged and closed get different marks because they are different outcomes,
 * as GitHub draws them: a shipped change and an abandoned one.
 */
export function stateIcon(pull: Pick<PullRequest, "state" | "draft">): {
  icon: IconSvgElement;
  tone: string;
} {
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

/** A pull request's state in a word, as GitHub says it. */
export function stateLabel(pull: Pick<PullRequest, "state" | "draft">): string {
  if (pull.state === "merged") return "Merged";
  if (pull.state === "closed") return "Closed";
  return pull.draft ? "Draft" : "Open";
}

/** The checks' overall state in words, or null when there are none. */
export function checksLabel(state: CheckState | null): string | null {
  switch (state) {
    case "success":
      return "Checks passed";
    case "failure":
      return "Checks failed";
    case "pending":
      return "Checks running";
    case "neutral":
      return "Checks done";
    default:
      return null;
  }
}

/** The checks' tone, matching the state colors above. */
export function checksTone(state: CheckState | null): string {
  if (state === "success") return "text-emerald-600 dark:text-emerald-400";
  if (state === "failure") return "text-rose-600 dark:text-rose-400";
  if (state === "pending") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}
