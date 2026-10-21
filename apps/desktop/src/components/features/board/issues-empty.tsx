import { ListViewIcon } from "@hugeicons/core-free-icons";
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
import { useBoard } from "#/stores/board";

/**
 * The detail pane before an issue is chosen.
 *
 * The app's standard empty state, not a summary of the board (FE-75/D2): the
 * list beside it already is one.
 */
export function IssuesEmpty() {
  const active = useBoard((state) => state.active);
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center">
      {/* The screen's name in the title bar only while no issue is open: the
          bar holds one header, and an issue puts its own breadcrumb there. */}
      <WindowTitlebar>
        <h1 className={WINDOW_TITLE}>{active?.name ?? "Issues"}</h1>
      </WindowTitlebar>
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={ListViewIcon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>No issue selected</EmptyTitle>
          <EmptyDescription>
            Pick an issue from the list, or press J and K to move through it.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
