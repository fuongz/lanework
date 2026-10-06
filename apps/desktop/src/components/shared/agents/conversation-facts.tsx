import {
  AiChipIcon,
  ArrowDataTransferVerticalIcon,
  ArrowRight01Icon,
  Coins01Icon,
  GitCompareIcon,
  Timer02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { AgentFacts } from "#/../shared/terminal";
import { Button } from "#/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { relativeTime } from "#/lib/board-view";
import { cn } from "#/lib/utils";
import {
  ContextRing,
  claudeWindow,
  costText,
  durationText,
  type Fact,
  FactList,
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

/** The context's window and how full it is: Claude's guessed from its model. */
export function contextUse(
  facts: AgentFacts,
): { window: number | null; share: number | null; guessed: boolean } | null {
  if (!facts.context) return null;
  const known = facts.context.window;
  const window = known ?? claudeWindow(facts.model, facts.context.tokens);
  return {
    window,
    share: window ? facts.context.tokens / window : null,
    guessed: !known && window !== null,
  };
}

/** The context, short: `142k`, and its share of the window when known. */
function contextText(facts: AgentFacts): string {
  if (!facts.context) return "";
  const share = contextUse(facts)?.share;
  return `${tokenText(facts.context.tokens)}${share != null ? ` (${Math.round(share * 100)}%)` : ""}`;
}

/** Why a Claude window is a guess (FE-38/D2): the CLI writes none down. */
const WINDOW_NOTE =
  "Claude does not record its window: it is taken from the model, 1M unless it is Haiku.";

/**
 * The model's popover (FE-38/D1): which model, what it cost ≈, its tokens in
 * and out, and its context — each only when the CLI wrote it, so a number
 * never reads 0 for "not known". Cost is Claude's alone.
 */
export function modelFacts(facts: AgentFacts): Fact[] {
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
  const use = contextUse(facts);
  if (facts.context && use)
    out.push({
      key: "context",
      label: "Context",
      mark: <ContextRing share={use.share} />,
      text: contextText(facts),
      title: use.window
        ? `Context: ${exact(facts.context.tokens)} of ${exact(use.window)} tokens${use.guessed ? `\n${WINDOW_NOTE}` : ""}`
        : `Context: ${exact(facts.context.tokens)} tokens. Codex did not record its window, so no share is shown.`,
    });
  return out;
}

/** What it wrote, by Claude's own count; null when the CLI wrote none. */
export function linesFact(facts: AgentFacts): Fact | null {
  if (!facts.lines) return null;
  const stale = facts.stale ? `\n${STALE_NOTE}` : "";
  return {
    key: "lines",
    label: "Lines added and removed",
    icon: GitCompareIcon,
    text: `+${exact(facts.lines.added)} −${exact(facts.lines.removed)}`,
    title: `${exact(facts.lines.added)} lines added, ${exact(facts.lines.removed)} removed by Claude's own count, all along — committed ones too${stale}`,
  };
}

/** The header's own row: how long it ran. Claude's alone. */
function runFacts(facts: AgentFacts): Fact[] {
  const stale = facts.stale ? `\n${STALE_NOTE}` : "";
  const ran = facts.duration ? durationText(facts.duration.wall) : null;
  if (!facts.duration || !ran) return [];
  return [
    {
      key: "ran",
      label: "Run time",
      icon: Timer02Icon,
      text: ran,
      title: `Ran ${ran}: the model ${durationText(facts.duration.api)}, tools ${durationText(facts.duration.tools)}${stale}`,
    },
  ];
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
    facts.context ? `context ${contextText(facts)}` : null,
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
      // ⚠️ One line height for the three parts — the label, the text and its
      // time — so they sit level shut, and the first line stays level open.
      className="border-sidebar-border flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-foreground flex h-5 shrink-0 items-center gap-1 leading-5 font-medium"
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
          "text-muted-foreground min-w-0 flex-1 leading-5",
          open ? "max-h-40 overflow-y-auto whitespace-pre-line" : "truncate",
        )}
      >
        {recap.text}
      </p>
      {recap.at && (
        <time
          dateTime={recap.at}
          title={new Date(recap.at).toLocaleString()}
          className="text-muted-foreground shrink-0 leading-5 tabular-nums"
        >
          {relativeTime(recap.at, Date.now())}
        </time>
      )}
    </section>
  );
}

/**
 * A conversation's run time, in the agent view's header itself (FE-38):
 * nothing at all when the CLI wrote none. Its model and usage are the
 * `ModelButton`'s; Claude's recap is its own row, `ConversationRecap`.
 *
 * `extra` joins the same row — a Codex goal's (FE-41/D4) — and shows
 * even before the transcript's own numbers are read.
 */
export function ConversationFacts({
  facts,
  extra = [],
}: {
  facts: AgentFacts | null | undefined;
  extra?: Fact[];
}) {
  const list = [...(facts ? runFacts(facts) : []), ...extra];
  if (list.length === 0) return null;
  return (
    <Facts facts={list} inline data-testid="agent-facts" className="ms-1" />
  );
}

/**
 * The model, by name, with how full its context is as the ring before it —
 * opening its usage: cost ≈, tokens, context. Nothing until the CLI names
 * a model.
 */
export function ModelButton({
  facts,
}: {
  facts: AgentFacts | null | undefined;
}) {
  if (!facts?.model) return null;
  const use = contextUse(facts);
  const list = modelFacts(facts);
  const share = use?.share ?? null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="secondary"
            data-testid="agent-model"
            aria-label={`${modelLabel(facts.model)}${share !== null ? `, context ${Math.round(share * 100)}% full` : ""}. Show its usage`}
          />
        }
      >
        <ContextRing
          share={share}
          className={cn(
            "size-3.5",
            share !== null && share >= 0.8
              ? "text-tone-amber"
              : "text-muted-foreground",
          )}
        />
        {modelLabel(facts.model)}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-1 p-1.5">
        <FactList facts={list} data-testid="model-facts" />
      </PopoverContent>
    </Popover>
  );
}
