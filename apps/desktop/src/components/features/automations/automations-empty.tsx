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
import { useAutomations } from "#/stores/automations";

/** The right pane before an automation is chosen, or before there is one. */
export function AutomationsEmpty() {
  const automations = useAutomations((state) => state.automations);
  const openEditor = useAutomations((state) => state.openEditor);
  const none = automations?.length === 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <WindowTitlebar>
        <h1 className={WINDOW_TITLE}>Automations</h1>
      </WindowTitlebar>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {/* Nothing until the list is read: "No automations yet" would be a
            guess while the list beside it shows its skeleton. */}
        {automations && (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={TimeScheduleIcon} strokeWidth={1.8} />
              </EmptyMedia>
              <EmptyTitle>
                {none ? "Run an agent on a schedule" : "No automation open"}
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
                  New automation
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}
      </div>
    </div>
  );
}
