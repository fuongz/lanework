import {
  ArrowDataTransferHorizontalIcon,
  ArrowRight02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AGENT_LABELS,
  type HandoffCarried,
  type HandoffTurn,
  type HandoffTurnSide,
  modelName,
} from "#/../shared/conversation";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { clock } from "#/lib/conversation-format";

/** What the new session was given, for the divider's hover. */
function carriedText(carried: HandoffCarried): string {
  const { summary, turns, omitted } = carried;
  const parts = [
    summary ? "the summary" : null,
    turns ? `${turns} recent ${turns === 1 ? "turn" : "turns"}` : null,
  ].filter(Boolean);
  const said = parts.length
    ? `Carried ${parts.join(" and ")}`
    : "Carried no turns";
  return omitted
    ? `${said}; ${omitted} older ${omitted === 1 ? "turn" : "turns"} did not fit.`
    : `${said}.`;
}

/** One side of the handoff: the agent's mark and the model it ran on. */
function Side({ side }: { side: HandoffTurnSide }) {
  const harness = AGENT_LABELS[side.agent];
  // A session whose model was never named reads as its harness.
  const model = side.model ? (modelName(side.model) ?? side.model) : harness;
  return (
    <span className="flex min-w-0 items-center gap-1" title={harness}>
      <TerminalKindIcon kind={side.agent} className="size-3.5 shrink-0" />
      <span className="truncate">{model}</span>
    </span>
  );
}

/**
 * Where a thread was handed to another agent in place (`switchAgent`): a
 * hairline across the chat, "Context handoff" on it, then the models it
 * came from, an arrow, and the model it went to, each with its agent's mark.
 * The compaction divider's shape (`turn-view.compaction.tsx`).
 *
 * NOTE: The sides stand apart by gap and their marks alone, never a joining
 * character: one source is the rule, several only after a chain of quick
 * handoffs with nothing said between them.
 */
export function HandoffDivider({ turn }: { turn: HandoffTurn }) {
  const at = clock(turn.at);
  return (
    <div className="flex w-full min-w-0 items-center gap-3">
      <span aria-hidden="true" className="bg-border h-px flex-1" />
      <p
        title={`${carriedText(turn.carried)}${at ? ` Handed off at ${at}.` : ""}`}
        className="text-muted-foreground flex min-h-6 max-w-[85%] min-w-0 shrink flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-1 text-xs"
      >
        <span className="flex shrink-0 items-center gap-1.5">
          <HugeiconsIcon
            icon={ArrowDataTransferHorizontalIcon}
            className="size-3.5"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="text-foreground/80 font-medium">
            Context handoff
          </span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
          {turn.from.map((side) => (
            <Side key={side.conversation} side={side} />
          ))}
          {turn.from.length > 0 && (
            <HugeiconsIcon
              icon={ArrowRight02Icon}
              className="size-3 shrink-0"
              strokeWidth={2}
              aria-hidden="true"
            />
          )}
          <span className="text-foreground/80 flex min-w-0">
            <Side side={turn.to} />
          </span>
        </span>
      </p>
      <span aria-hidden="true" className="bg-border h-px flex-1" />
    </div>
  );
}
