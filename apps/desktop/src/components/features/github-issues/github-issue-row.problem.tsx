import {
  AlertCircleIcon,
  Folder01Icon,
  GithubIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { cn } from "#/lib/utils";
import {
  describeIssuesProblem,
  type GitHubIssuesProblem,
  useGitHubIssues,
} from "#/stores/github-issues";

/**
 * Why a project's GitHub issues are not on screen, and the way out.
 *
 * A satellite of the row, so the issue list and the issue page draw the same
 * state from one file. The app never installs `gh` or signs anybody in;
 * it says what to run, and "Check again" asks `gh` once more.
 */
export function GitHubIssuesProblemState({
  slug,
  problem,
  className,
}: {
  slug: string;
  problem: GitHubIssuesProblem;
  className?: string;
}) {
  const checking = useGitHubIssues((state) => state.checking);
  const check = useGitHubIssues((state) => state.check);
  const copy = describeIssuesProblem(problem);
  const icon =
    problem.kind === "failed"
      ? AlertCircleIcon
      : problem.kind === "no-folder" || problem.kind === "not-github"
        ? Folder01Icon
        : GithubIcon;

  return (
    <Empty className={cn("py-10", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon icon={icon} strokeWidth={1.8} />
        </EmptyMedia>
        <EmptyTitle>{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.description}</EmptyDescription>
      </EmptyHeader>
      {(copy.command || copy.checkable) && (
        <EmptyContent>
          {copy.command && (
            <code className="bg-foreground/[0.05] rounded-md px-2 py-1 font-mono text-xs select-all">
              {copy.command}
            </code>
          )}
          {copy.checkable && (
            <Button
              size="sm"
              variant="outline"
              disabled={checking}
              onClick={() => void check(slug)}
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                className={checking ? "animate-spin" : undefined}
                aria-hidden="true"
              />
              {checking ? "Checking…" : "Check again"}
            </Button>
          )}
        </EmptyContent>
      )}
    </Empty>
  );
}
