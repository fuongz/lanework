// The session details' Thread group (FE-170): the agents a conversation
// switched through, each row a session of its thread with a hover card of
// its own numbers and Open, which scrolls the chat to where it begins.
import {
  ArrowDataTransferVerticalIcon,
  ArrowUpRight01Icon,
  Coins01Icon,
  GitForkIcon,
  MessageMultiple01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import { modelName, type ThreadPart } from "#/../shared/conversation";
import type { AgentFacts } from "#/../shared/terminal";
import { contextUse } from "#/components/shared/agents/conversation-facts";
import {
  ContextRing,
  costText,
  tokenText,
} from "#/components/shared/agents/facts";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import {
  PreviewCard,
  PreviewCardContent,
  PreviewCardTrigger,
} from "#/components/ui/preview-card";
import { Skeleton } from "#/components/ui/skeleton";
import { useProjectKey } from "#/hooks/use-project-key";
import { cn } from "#/lib/utils";

/** How long a pointer rests on a row before its card opens, as the rail's. */
const OPEN_MS = 500;

const AGENT_NAMES: Record<ThreadPart["agent"], string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

/**
 * Scroll the chat to session `part`'s first turn. Only one the chat holds
 * now: an older one outside its window stays where it is.
 */
function showInChat(part: ThreadPart): boolean {
  if (!part.firstTurn) return false;
  const node = document.querySelector(
    `[data-turn="${CSS.escape(part.firstTurn)}"]`,
  );
  if (!node) return false;
  node.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

/**
 * One row of Thread: its place, CLI and model; its fork and turns are on its
 * hover card. Open shows where it begins.
 */
export function ThreadRow({
  slug,
  part,
  index,
  forkOf,
  rowClass,
}: {
  slug: string;
  part: ThreadPart;
  /** 1 for the thread's first session. */
  index: number;
  /** The place of the session it was forked from, when it was. */
  forkOf: number | null;
  rowClass: string;
}) {
  const project = useProjectKey(slug);
  const [open, setOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  const model = part.model ? (modelName(part.model) ?? part.model) : null;
  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <li className={cn(rowClass, "group/thread")}>
        <PreviewCardTrigger
          delay={OPEN_MS}
          render={<div className="flex min-w-0 flex-1 items-center gap-2.5" />}
        >
          <span className="text-muted-foreground w-4 shrink-0 text-right text-[11px] tabular-nums">
            {index}
          </span>
          <TerminalKindIcon kind={part.agent} className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {model ?? AGENT_NAMES[part.agent]}
          </span>
        </PreviewCardTrigger>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setMissing(!showInChat(part));
          }}
          onBlur={() => setMissing(false)}
          aria-label={`Show session ${index} in the chat`}
          title={
            missing
              ? "Scroll up in the chat to load it first"
              : "Show where it begins in the chat"
          }
          className="text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground grid size-6 shrink-0 place-items-center rounded-md opacity-0 transition-[opacity,colors] group-hover/thread:opacity-100 focus-visible:opacity-100"
        >
          <HugeiconsIcon
            icon={ArrowUpRight01Icon}
            className="size-3.5"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>
      </li>
      <PreviewCardContent
        side="left"
        align="start"
        sideOffset={8}
        className="ring-foreground/[0.06] shadow-[0_6px_20px_-6px_rgb(0_0_0/0.14)] dark:ring-foreground/10"
      >
        {project && (
          <ThreadPartCard
            project={project}
            part={part}
            index={index}
            forkOf={forkOf}
            model={model}
          />
        )}
      </PreviewCardContent>
    </PreviewCard>
  );
}

/** One line of the card: its mark, then its fact, muted (as the rail's). */
function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="text-muted-foreground flex min-w-0 items-start gap-2">
      <span className="flex h-4 w-3.5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-[13px] leading-4">{children}</span>
    </li>
  );
}

function Icon({ icon }: { icon: IconSvgElement }) {
  return (
    <HugeiconsIcon
      icon={icon}
      className="size-3.5"
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}

/**
 * A thread session's hover card: its CLI and model, whether it was a fork,
 * its turns, and its own context, tokens and estimated cost, read when the
 * card opens.
 */
function ThreadPartCard({
  project,
  part,
  index,
  forkOf,
  model,
}: {
  project: string;
  part: ThreadPart;
  index: number;
  forkOf: number | null;
  model: string | null;
}) {
  const [facts, setFacts] = useState<AgentFacts | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const terminal = window.desktop?.terminal;
    if (!terminal) {
      setFacts(null);
      return;
    }
    void terminal
      .agentFacts(project, part.agent, part.conversation)
      .catch(() => null)
      .then((read) => {
        if (live) setFacts(read);
      });
    return () => {
      live = false;
    };
  }, [project, part.agent, part.conversation]);
  const use = facts ? contextUse(facts) : null;
  return (
    <div className="flex w-60 flex-col gap-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground flex h-5 w-3.5 shrink-0 items-center justify-center">
          <Icon icon={MessageMultiple01Icon} />
        </span>
        <p className="min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold">
          Session {index} of the thread
        </p>
      </div>
      <ul className="flex flex-col gap-1.5">
        <Line
          icon={<TerminalKindIcon kind={part.agent} className="size-3.5" />}
        >
          {AGENT_NAMES[part.agent]}
          {model && <span className="text-muted-foreground/70"> {model}</span>}
        </Line>
        {part.forkOf && (
          <Line icon={<Icon icon={GitForkIcon} />}>
            {forkOf
              ? `Forked from session ${forkOf}: it holds that session's history`
              : "Forked from an earlier session"}
          </Line>
        )}
        <Line icon={<Icon icon={MessageMultiple01Icon} />}>
          {part.turns} {part.turns === 1 ? "turn" : "turns"} of its own
        </Line>
        {facts === undefined ? (
          <li>
            <Skeleton className="h-4 w-28" />
          </li>
        ) : facts ? (
          <>
            {facts.context && (
              <Line icon={<ContextRing share={use?.share ?? null} />}>
                {use?.share != null ? `${Math.round(use.share * 100)}%  ` : ""}
                {tokenText(facts.context.tokens)}
                {use?.window ? ` / ${tokenText(use.window)}` : ""}
              </Line>
            )}
            {facts.tokens && (
              <Line icon={<Icon icon={ArrowDataTransferVerticalIcon} />}>
                {tokenText(facts.tokens.input)} in{" "}
                {tokenText(facts.tokens.output)} out
              </Line>
            )}
            {facts.costUSD !== null && (
              <Line icon={<Icon icon={Coins01Icon} />}>
                {costText(facts.costUSD)}
              </Line>
            )}
          </>
        ) : null}
      </ul>
    </div>
  );
}
