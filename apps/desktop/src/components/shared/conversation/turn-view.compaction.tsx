import { Collapsible } from "@base-ui/react/collapsible";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { CompactionTurn } from "#/../shared/conversation";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { clock, compact } from "#/lib/conversation-format";
import { cn } from "#/lib/utils";

/** The fold's timing, as a tool group's (`turn-view.tool-group.tsx`). */
const EASE = "duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]";
const PANEL = `h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] ${EASE} data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-none`;

/**
 * Where Claude compacted the conversation (FE-120): a hairline across the
 * chat, "Context compacted" on it with the context's size before and after
 * and what started it. Clicking it unfolds the summary Claude kept.
 *
 * Under it, when Lanework's hook reminded the agent of a card right after,
 * a small line names that card's checkpoint.
 */
export function CompactionDivider({ turn }: { turn: CompactionTurn }) {
  const [open, setOpen] = useState(false);
  const sizes =
    turn.preTokens !== null && turn.postTokens !== null
      ? `${compact(turn.preTokens)} → ${compact(turn.postTokens)}`
      : turn.preTokens !== null
        ? `from ${compact(turn.preTokens)}`
        : null;
  const label = (
    <>
      <span className="text-foreground/80 font-medium">Context compacted</span>
      {sizes && <span className="tabular-nums">{sizes}</span>}
      {turn.trigger && <span>{turn.trigger}</span>}
    </>
  );
  const at = clock(turn.at);
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="flex min-w-0 flex-col items-center gap-1"
    >
      <div className="flex w-full min-w-0 items-center gap-3">
        <span aria-hidden="true" className="bg-border h-px flex-1" />
        {turn.summary ? (
          <Collapsible.Trigger
            title={at ? `Compacted at ${at}` : undefined}
            className="group/compact text-muted-foreground hover:text-foreground flex h-6 shrink-0 items-center gap-2 rounded-md px-1 text-xs transition-colors"
          >
            {label}
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              className={cn(
                "size-3 transition-transform motion-reduce:transition-none",
                EASE,
                open && "rotate-90",
              )}
              strokeWidth={2}
              aria-hidden="true"
            />
          </Collapsible.Trigger>
        ) : (
          <span
            title={at ? `Compacted at ${at}` : undefined}
            className="text-muted-foreground flex h-6 shrink-0 items-center gap-2 px-1 text-xs"
          >
            {label}
          </span>
        )}
        <span aria-hidden="true" className="bg-border h-px flex-1" />
      </div>
      {turn.taskId && (
        <span className="text-muted-foreground/80 text-[11px]">
          Checkpoint saved for{" "}
          <span className="text-muted-foreground font-medium">
            {turn.taskId}
          </span>
        </span>
      )}
      {turn.summary && (
        <Collapsible.Panel className={cn(PANEL, "w-full")}>
          <div className="text-muted-foreground border-border mt-2 border-l ps-4">
            <MarkdownBody source={turn.summary} empty="" />
          </div>
        </Collapsible.Panel>
      )}
    </Collapsible.Root>
  );
}
