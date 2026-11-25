import { PlusSignIcon, TimeScheduleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { useRoutines } from "#/stores/routines";

/** The right pane before a routine is chosen, or before there is one. */
export function RoutinesEmpty() {
  const routines = useRoutines((state) => state.routines);
  const openEditor = useRoutines((state) => state.openEditor);
  const none = routines?.length === 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <WindowTitlebar>
        <h1 className={WINDOW_TITLE}>Routines</h1>
      </WindowTitlebar>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {/* Nothing until the list is read: "No routines yet" would be a
            guess while the list beside it shows its skeleton. */}
        {routines && (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={TimeScheduleIcon} strokeWidth={1.8} />
              </EmptyMedia>
              <EmptyTitle>
                {none ? "Run an agent on a schedule" : "No routine open"}
              </EmptyTitle>
              <EmptyDescription>
                {none
                  ? "A prompt, a model and when to run it. Each run is a new conversation in Sessions."
                  : "Pick one from the list to see its runs."}
              </EmptyDescription>
            </EmptyHeader>
            {none && (
              <EmptyContent>
                <Button size="sm" onClick={() => openEditor({ kind: "new" })}>
                  <HugeiconsIcon
                    icon={PlusSignIcon}
                    strokeWidth={2}
                    data-icon="inline-start"
                  />
                  New routine
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}
      </div>
    </div>
  );
}
