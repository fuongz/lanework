import { Alert02Icon, AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { type ReadinessFix, readinessProblems } from "#/../shared/readiness";
import { ReadinessFixDialog } from "#/components/shared/readiness/readiness-fix-dialog";
import { ReadinessList } from "#/components/shared/readiness/readiness-list";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "#/components/ui/popover";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import { useReadiness } from "#/stores/readiness";

/**
 * Beside the project switcher: whether the open project's folder is ready for
 * an agent to work its board (FE-30/D2).
 *
 * ⚠️ Nothing at all when every blocker and warning passes. A green tick on
 * every project, all the time, is a control nobody needs to press; notes
 * (`info`) wait in Settings › Projects.
 */
export function ReadinessIndicator() {
  const slug = useBoard((state) => state.active?.slug ?? null);
  const report = useReadiness((state) => (slug ? state.reports[slug] : null));
  const [open, setOpen] = useState(false);
  const [fix, setFix] = useState<ReadinessFix | null>(null);
  const { blockers, warnings } = readinessProblems(report ?? null);
  const count = blockers + warnings;
  if (!slug) return null;

  const label = `${count} ${count === 1 ? "thing" : "things"} to set up before an agent can work this project`;

  return (
    <>
      {report && count > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={label}
                title={label}
                className={cn(
                  "hover:bg-foreground/[0.05] flex h-8 shrink-0 items-center gap-1 rounded-lg px-1.5 text-xs font-medium tabular-nums transition-colors duration-150",
                  blockers ? "text-destructive" : "text-tone-amber",
                )}
              >
                <HugeiconsIcon
                  icon={blockers ? AlertCircleIcon : Alert02Icon}
                  className="size-4"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                {count}
              </button>
            }
          />
          <PopoverContent align="start" className="w-80 gap-1 p-3">
            <PopoverHeader>
              <PopoverTitle>Set up for agents</PopoverTitle>
              <PopoverDescription className="break-all">
                {report.folder ?? "No folder on this machine"}
              </PopoverDescription>
            </PopoverHeader>
            <ReadinessList
              report={report}
              passing={false}
              onFix={(next) => {
                setOpen(false);
                setFix(next);
              }}
              onNavigate={() => setOpen(false)}
            />
          </PopoverContent>
        </Popover>
      )}
      {/* ⚠️ Outside the popover, and rendered whatever the count: the fix
          that brings it to zero must not unmount its own dialog. */}
      <ReadinessFixDialog
        slug={slug}
        fix={fix}
        onOpenChange={(next) => !next && setFix(null)}
      />
    </>
  );
}
