import { GitPullRequestIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { canReadPulls, usePulls } from "#/stores/pulls";

/** The right pane before a pull request is chosen. */
export function PullsEmpty() {
  const account = usePulls((state) => state.account);
  const repo = usePulls((state) => state.repo);
  const ready = usePulls((state) => state.ready);
  const connected = canReadPulls(account, repo);

  return (
    <div className="flex min-w-0 flex-1 items-center justify-center">
      {/* The screen's name in the title bar only while no pull request is
          open: the bar holds one header, and `PullDetail` puts the pull
          request's own there. */}
      <WindowTitlebar>
        <h1 className={WINDOW_TITLE}>Pull requests</h1>
      </WindowTitlebar>
      {/* Nothing until the GitHub check answers: the list beside it shows
          the skeleton, and "Not set up yet" here would be a guess. */}
      {ready && (
        <Empty className="py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={GitPullRequestIcon} strokeWidth={1.8} />
            </EmptyMedia>
            <EmptyTitle>
              {connected ? "No pull request open" : "Not set up yet"}
            </EmptyTitle>
            <EmptyDescription>
              {connected
                ? "Pick one from the list to read its diff."
                : "Pull requests show here once the GitHub CLI can read this project's repo."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
