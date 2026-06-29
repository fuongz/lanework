import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlayIcon, RoboticIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { runAgentForCard } from "@/lib/agent-client";
import { cn } from "@/lib/utils";

/**
 * "Run a Claude Code agent on this card" button — the explicit, one-click way to
 * dispatch an agent. Local mode only (callers guard on `__LANEWORK_LOCAL__`).
 * Stops propagation so it never triggers the surrounding card's drag or
 * click-to-open.
 */
export function RunAgentButton({ path, className }: { path: string; className?: string }) {
  const [starting, setStarting] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      title="Run a Claude Code agent on this card"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={async (e) => {
        e.stopPropagation();
        if (starting) return;
        setStarting(true);
        try {
          await runAgentForCard(path);
        } catch (err) {
          if (typeof window !== "undefined") {
            window.alert(`Couldn't run agent: ${err instanceof Error ? err.message : String(err)}`);
          }
        } finally {
          setStarting(false);
        }
      }}
      disabled={starting}
      className={cn("gap-1", className)}
    >
      <HugeiconsIcon icon={PlayIcon} className="size-3.5" />
      {starting ? "Starting…" : "Run"}
    </Button>
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
