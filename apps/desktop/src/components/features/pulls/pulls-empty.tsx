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
import { usePulls } from "#/stores/pulls";

/** The right pane before a pull request is chosen. */
export function PullsEmpty() {
  const account = usePulls((state) => state.account);
  const repo = usePulls((state) => state.repo);
  const connected = account.kind === "connected" && repo?.kind === "linked";

  return (
    <div className="flex min-w-0 flex-1 items-center justify-center">
      {/* ⚠️ The screen's name in the title bar (FE-58) only while no pull
          request is open: the bar holds one header, and `PullDetail` puts the
          pull request's own there. */}
      <WindowTitlebar>
        <h1 className={WINDOW_TITLE}>Pull requests</h1>
      </WindowTitlebar>
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={GitPullRequestIcon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>
            {connected ? "No pull request open" : "Not connected yet"}
          </EmptyTitle>
          <EmptyDescription>
            {connected
              ? "Pick one from the list to read its diff."
              : "Connect GitHub and a repository to see pull requests here."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
