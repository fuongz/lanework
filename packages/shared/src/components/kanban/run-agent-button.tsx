import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlayIcon, RoboticIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { runAgentForCard } from "@/lib/agent-client";
import { cn } from "@/lib/utils";
import { useRunOptions, RunOptionsRow } from "./run-options";

/**
 * "Run a Claude Code agent on this card" control — opens a small popover to pick
 * mode/model/effort, then dispatches. Local mode only (callers guard on
 * `__LANEWORK_LOCAL__`). Stops propagation so it never triggers the surrounding
 * card's drag or click-to-open.
 */
export function RunAgentButton({ path, className }: { path: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const runOpts = useRunOptions();

  const run = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await runAgentForCard(path, runOpts.options);
      setOpen(false);
    } catch (err) {
      if (typeof window !== "undefined") {
        window.alert(`Couldn't run agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="sm"
            title="Run a Claude Code agent on this card"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className={cn("gap-1", className)}
          >
            <HugeiconsIcon icon={PlayIcon} className="size-3.5" />
            Run
          </Button>
        }
      />
      <PopoverContent
        align="end"
        className="w-auto p-3"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
          <HugeiconsIcon icon={RoboticIcon} className="size-3.5 text-violet-500" />
          Run options
        </p>
        <RunOptionsRow state={runOpts} disabled={starting} />
        <Button size="sm" onClick={run} disabled={starting} className="mt-3 w-full gap-1.5">
          <HugeiconsIcon icon={PlayIcon} className="size-4" />
          {starting ? "Starting…" : "Run agent"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** Compact "an agent is working on this card" indicator (violet, pulsing dot). */
export function AgentWorkingBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium text-violet-600 dark:text-violet-400",
        className,
      )}
    >
      <HugeiconsIcon icon={RoboticIcon} className="size-3.5" />
      <span>Claude is working</span>
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-violet-500/70" />
        <span className="relative inline-flex size-1.5 rounded-full bg-violet-500" />
      </span>
    </span>
  );
}
