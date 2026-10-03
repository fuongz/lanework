import {
  AiChipIcon,
  ArrowDataTransferVerticalIcon,
  ArrowRight01Icon,
  Coins01Icon,
  DashboardSpeed01Icon,
  GitCompareIcon,
  Timer02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { AgentFacts } from "#/../shared/terminal";
import { relativeTime } from "#/lib/board-view";
import { cn } from "#/lib/utils";
import {
  costText,
  durationText,
  type Fact,
  Facts,
  modelLabel,
  tokenText,
} from "./facts";

const exact = (value: number) => value.toLocaleString("en-US");

/**
 * What the cost is, wherever it is shown (FE-38/V5): Claude's `cost-state`
 * is the whole CLI's spend on the conversation — its sub-agents' calls, its
 * titles and recaps included — priced as the API would be.
 */
export const COST_NOTE =
  "An estimate at API prices — not what a subscription is billed. It includes this conversation's sub-agents.";

/** Why a Claude total lags its transcript: it is saved now and then. */
const STALE_NOTE =
  "As Claude last saved it: it saves when it is left or quit, so the turns since are not counted yet.";

/** The context, short: `142k`, and its share of the window when known. */
function contextText(context: NonNullable<AgentFacts["context"]>): string {
  const share = context.window
    ? ` (${Math.round((context.tokens / context.window) * 100)}%)`
    : "";
  return `${tokenText(context.tokens)}${share}`;
}

/**
 * A conversation's facts row (FE-38/D1): model · cost ≈ · tokens in and out
 * · context · lines · run time — each only when the CLI wrote it, so a
 * number never reads 0 for "not known". Cost, lines and run time are
 * Claude's alone; Codex writes none of them.
 */
export function conversationFacts(facts: AgentFacts): Fact[] {
  const out: Fact[] = [];
  const stale = facts.stale ? `\n${STALE_NOTE}` : "";
  if (facts.model)
    out.push({
      key: "model",
      label: "Model",
      icon: AiChipIcon,
      text: `${modelLabel(facts.model)}${facts.effort ? ` (${facts.effort})` : ""}`,
      title: `Model: ${facts.model}${facts.effort ? `, ${facts.effort} effort` : ""}`,
    });
  if (facts.costUSD !== null)
    out.push({
      key: "cost",
      label: "Cost",
      icon: Coins01Icon,
      text: `${costText(facts.costUSD)}${facts.stale ? "+" : ""}`,
      title: `${COST_NOTE}${stale}`,
    });
  if (facts.tokens)
    out.push({
      key: "tokens",
      label: "Tokens in and out",
      icon: ArrowDataTransferVerticalIcon,
      text: `${tokenText(facts.tokens.input)} in, ${tokenText(facts.tokens.output)} out`,
      title: `Tokens: ${exact(facts.tokens.input)} in (${exact(facts.tokens.cached)} from cache), ${exact(facts.tokens.output)} out`,
    });
  if (facts.context)
    out.push({
      key: "context",
      label: "Context",
      icon: DashboardSpeed01Icon,
      text: contextText(facts.context),
      title: facts.context.window
        ? `Context: ${exact(facts.context.tokens)} of ${exact(facts.context.window)} tokens`
        : `Context: ${exact(facts.context.tokens)} tokens. ${facts.agent === "claude" ? "Claude" : "Codex"} does not record its window, so no share is shown.`,
    });
  if (facts.lines)
    out.push({
      key: "lines",
      label: "Lines added and removed",
      icon: GitCompareIcon,
      text: `+${exact(facts.lines.added)} −${exact(facts.lines.removed)}`,
      title: `${exact(facts.lines.added)} lines added, ${exact(facts.lines.removed)} removed${stale}`,
    });
  const ran = facts.duration ? durationText(facts.duration.wall) : null;
  if (facts.duration && ran)
    out.push({
      key: "ran",
      label: "Run time",
      icon: Timer02Icon,
      text: ran,
      title: `Ran ${ran}: the model ${durationText(facts.duration.api)}, tools ${durationText(facts.duration.tools)}${stale}`,
    });
  return out;
}

/**
 * Cost and context in one line, for a rail row's tooltip (FE-38/D5); null
 * when neither is known.
 */
export function factsSummary(facts: AgentFacts): string | null {
  const parts = [
    facts.costUSD !== null
      ? `${costText(facts.costUSD)}${facts.stale ? "+" : ""} (API price)`
      : null,
    facts.context ? `context ${contextText(facts.context)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Claude's newest recap of the conversation, under its facts (FE-38/D4):
 * one line until opened, and when Claude wrote it.
 */
export function ConversationRecap({
  recap,
}: {
  recap: NonNullable<AgentFacts["recap"]>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label="Recap"
      className="border-sidebar-border flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-foreground flex shrink-0 items-center gap-1 font-medium"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className={cn(
            "text-muted-foreground size-3.5 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
          strokeWidth={2}
          aria-hidden="true"
        />
        Recap
      </button>
      <p
        className={cn(
          "text-muted-foreground min-w-0 flex-1 leading-relaxed",
          open ? "max-h-40 overflow-y-auto whitespace-pre-line" : "truncate",
        )}
      >
        {recap.text}
      </p>
      {recap.at && (
        <time
          dateTime={recap.at}
          title={new Date(recap.at).toLocaleString()}
          className="text-muted-foreground shrink-0 tabular-nums"
        >
          {relativeTime(recap.at, Date.now())}
        </time>
      )}
    </section>
  );
}

/**
 * A conversation's numbers, in the agent view's header itself (FE-38):
 * nothing at all when the CLI wrote none. Claude's recap is its own row,
 * `ConversationRecap`, under the header.
 *
 * `extra` joins the same facts — a Codex goal's (FE-41/D4) — and shows
 * even before the transcript's own numbers are read.
 */
export function ConversationFacts({
  facts,
  extra = [],
}: {
  facts: AgentFacts | null | undefined;
  extra?: Fact[];
}) {
  const list = [...(facts ? conversationFacts(facts) : []), ...extra];
  if (list.length === 0) return null;
  return (
    <Facts facts={list} inline data-testid="agent-facts" className="ms-1" />
  );
}
