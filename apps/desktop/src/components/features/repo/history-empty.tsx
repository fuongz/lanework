import { GitCommitIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";

/** The right pane of the History tab before a commit is chosen. */
export function HistoryEmpty() {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center">
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={GitCommitIcon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>No commit open</EmptyTitle>
          <EmptyDescription>
            Pick one from the list to see what it changed.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
