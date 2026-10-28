import {
  File01Icon,
  Image01Icon,
  SlashIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createContext, memo, useContext } from "react";
import type {
  AssistantTurn,
  Attachment,
  PermissionAnswer,
  Turn,
  UserTurn,
} from "#/../shared/conversation";
import type { LeadIcon } from "#/../shared/orchestration";
import {
  LinkedText,
  MarkdownBody,
} from "#/components/shared/common/markdown-body";
import {
  clock,
  downloadMarkdown,
  fileNameFor,
  firstLine,
  textLines,
  turnText,
} from "#/lib/conversation-format";
import { leadIcon } from "#/lib/orchestration-prompt";
import { cn } from "#/lib/utils";
import { AssistantActions, UserActions } from "./turn-view.actions";
import {
  LaunchedSessionCard,
  launchedSessions,
} from "./turn-view.launched-session";
import { chatLink, liveChatLink } from "./turn-view.link-chip";
import { ToolGroup } from "./turn-view.tool-group";

/**
 * Lets off-screen turns skip layout and paint.
 *
 * `content-visibility: auto` skips them, and `auto` in
 * `contain-intrinsic-size` keeps their last drawn height, so a conversation
 * of 500 turns scrolls as lightly as one of 5.
 */
const OFFSCREEN =
  "[content-visibility:auto] [contain-intrinsic-size:auto_160px]";

/** Where an envelope of the app's starts, its name with it. */
const ENVELOPE_OPEN = /<(lanework_[A-Za-z_]*)/g;
/** A close tag, for one whose open tag landed in an earlier line. */
const ENVELOPE_CLOSE = /<\/(lanework_[A-Za-z_]+)>/;
/** `<lanework_` still being typed at the very end: `<`, `<lan`, `<lanework`. */
const PARTIAL_OPEN = /<(?:l(?:a(?:n(?:e(?:w(?:o(?:r(?:k)?)?)?)?)?)?)?)?$/;

/**
 * `text` without the app's envelopes (`<lanework_proposal>` and every other
 * `<lanework_…>` block), as it is still being written (FE-91/U2).
 *
 * An envelope is hidden from its open tag on, even before its close tag
 * arrives; with `streaming`, so is a tag whose name is still coming. The
 * card below the chat draws the proposal, so its JSON never shows.
 */
function withoutEnvelopes(text: string, streaming: boolean): string {
  if (!text.includes("<")) return text;
  let out = "";
  let from = 0;
  ENVELOPE_OPEN.lastIndex = 0;
  for (;;) {
    const open = ENVELOPE_OPEN.exec(text);
    if (!open) break;
    out += text.slice(from, open.index);
    const close = `</${open[1]}>`;
    const end = text.indexOf(close, open.index);
    // Not closed yet: hidden to the end.
    if (end === -1) return out.trimEnd();
    from = end + close.length;
    ENVELOPE_OPEN.lastIndex = from;
  }
  out += text.slice(from);
  return streaming ? out.replace(PARTIAL_OPEN, "") : out;
}

/**
 * The streamed text, without what is still inside an envelope whose open tag
 * landed before it: up to its close tag, the delta is the envelope's.
 */
function deltaAfterOpen(delta: string, before: string): string {
  const close = ENVELOPE_CLOSE.exec(delta);
  if (!close || before.includes(`<${close[1]}`)) return delta;
  const head = delta.slice(0, close.index);
  if (head.includes(`<${close[1]}`)) return delta;
  return delta.slice(close.index + close[0].length);
}

function AttachmentChip({ attachment }: { attachment: Attachment }) {
  const image = attachment.mediaType.startsWith("image/");
  return (
    <span
      title={attachment.path ?? attachment.name}
      className="bg-foreground/[0.06] inline-flex max-w-60 items-center gap-1.5 rounded-md px-2 py-1 text-xs"
    >
      <HugeiconsIcon
        icon={image ? Image01Icon : File01Icon}
        className={cn(
          "size-3.5 shrink-0",
          image ? "text-tone-teal" : "text-muted-foreground",
        )}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="truncate">{attachment.name}</span>
    </span>
  );
}

/**
 * The `/command` that starts a prompt, and each `@path` or `@conductor` in
 * it, drawn as the composer drew them while it was written (FE-92, FE-93):
 * weighted, with the command's mark. The rest is linked text.
 */
const PROMPT_TOKEN = /^\/[^\s/]+(?=\s|$)|(?<=^|\s)@\S+/g;

/**
 * The conductors a page knows, by id (FE-95): an `@id` in a prompt shows as
 * the conductor's icon and name. Empty where no page provides it: the id.
 */
export const ConductorNames = createContext<
  ReadonlyMap<string, { name: string; icon: LeadIcon }>
>(new Map());

/** The commands the composer names rather than spells out. */
const COMMAND_LABELS: Record<string, string> = {
  "/orchestrate": "Orchestrate",
};

function PromptText({ text }: { text: string }) {
  const conductors = useContext(ConductorNames);
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(PROMPT_TOKEN)) {
    const at = match.index ?? 0;
    const token = match[0];
    if (at > last)
      parts.push(
        <LinkedText
          key={`t${at}`}
          source={text.slice(last, at)}
          link={chatLink}
        />,
      );
    const command = token.startsWith("/");
    const conductor = command ? undefined : conductors.get(token.slice(1));
    const path = !command && !conductor && /[./]/.test(token.slice(1));
    parts.push(
      <span
        key={`c${at}`}
        title={token}
        className={cn(
          "mx-px inline-flex items-baseline gap-1 align-baseline font-medium",
          token === "/orchestrate"
            ? "text-tone-violet"
            : conductor
              ? "text-tone-teal"
              : command
                ? "text-muted-foreground"
                : "text-primary",
        )}
      >
        {(command || path || conductor) && (
          <HugeiconsIcon
            icon={
              conductor
                ? leadIcon(conductor.icon)
                : token === "/orchestrate"
                  ? UserGroupIcon
                  : command
                    ? SlashIcon
                    : File01Icon
            }
            className="size-3.5 shrink-0 self-center"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        )}
        {conductor
          ? conductor.name
          : command
            ? (COMMAND_LABELS[token] ?? token)
            : path
              ? token.slice(1)
              : token}
      </span>,
    );
    last = at + token.length;
  }
  if (last === 0) return <LinkedText source={text} link={chatLink} />;
  if (last < text.length)
    parts.push(
      <LinkedText key="tail" source={text.slice(last)} link={chatLink} />,
    );
  return <>{parts}</>;
}

/** What the person wrote: a bubble on the right, attachments above. */
export function UserBubble({
  text,
  attachments,
  time,
  pending,
}: {
  text: string;
  attachments: Attachment[];
  time: string | null;
  /** Sent from here, not in the transcript yet: queued or starting. */
  pending?: string;
}) {
  return (
    <div className="group/turn flex flex-col items-end">
      <div
        className={cn(
          "bg-muted flex max-w-[85%] min-w-0 flex-col gap-2 rounded-2xl px-3.5 py-2.5 dark:bg-foreground/[0.07]",
          pending && "opacity-70",
        )}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {attachments.map((attachment, index) => (
              <AttachmentChip
                // biome-ignore lint/suspicious/noArrayIndexKey: attachments are positional and never reorder.
                key={index}
                attachment={attachment}
              />
            ))}
          </div>
        )}
        {text && (
          <p className="font-content text-[14px] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]">
            <PromptText text={text} />
          </p>
        )}
      </div>
      {pending ? (
        <span className="text-muted-foreground flex h-8 items-center text-xs">
          {pending}
        </span>
      ) : (
        <UserActions
          text={text}
          time={time}
          onSave={() => downloadMarkdown(text, fileNameFor(text, "prompt"))}
        />
      )}
    </div>
  );
}

export interface TurnHandlers {
  /** Who the permission cards say asks: Claude or Codex. */
  agent?: string;
  /** None for a conversation that cannot be forked (Codex's). */
  onFork?: () => void;
  /** None where there is no composer to reply into (a worker's view). */
  onReply?: (text: string) => void;
  onAnswer: (id: string, answer: PermissionAnswer) => Promise<void>;
}

function AssistantView({
  turn,
  delta,
  slug,
  conversation,
  handlers,
  forking,
}: {
  turn: AssistantTurn;
  delta: string;
  slug: string;
  conversation: string;
  handlers: TurnHandlers;
  forking: boolean;
}) {
  // Streamed text joins the turn's last text, or starts a new one. The app's
  // envelopes never show, not even half-streamed (FE-91/U2).
  const blocks = turn.blocks.map((block) =>
    block.type === "text" && block.text.includes("<lanework_")
      ? { ...block, text: withoutEnvelopes(block.text, false) }
      : block,
  );
  if (delta) {
    const last = blocks[blocks.length - 1];
    const before = last?.type === "text" ? last.text : "";
    const joined = withoutEnvelopes(
      before + deltaAfterOpen(delta, before),
      true,
    );
    if (last?.type === "text")
      blocks[blocks.length - 1] = { type: "text", text: joined };
    else blocks.push({ type: "text", text: joined });
  }
  const text = turnText({ ...turn, blocks });
  const lastIndex = blocks.length - 1;
  return (
    <div className="group/turn flex min-w-0 flex-col gap-3">
      {blocks.map((block, index) => {
        if (block.type === "text") {
          if (!block.text.trim()) return null;
          return (
            <MarkdownBody
              // biome-ignore lint/suspicious/noArrayIndexKey: a turn's blocks only grow at the end — the index is the block's identity.
              key={`text-${index}`}
              source={block.text}
              link={turn.open ? liveChatLink : chatLink}
              variant="chat"
              empty=""
            />
          );
        }
        if (block.type === "tools") {
          const key = block.calls[0]?.id ?? `tools-${index}`;
          // A conductor's sessions stay in sight under the folded commands
          // that started them.
          const launched = launchedSessions(block.calls);
          const group = (
            <ToolGroup
              key={key}
              calls={block.calls}
              running={
                turn.open &&
                index === lastIndex &&
                block.calls.some((call) => call.output === null)
              }
              lead={index === 0}
              slug={slug}
              conversation={conversation}
            />
          );
          if (!launched.length) return group;
          return (
            <div key={key} className="flex min-w-0 flex-col gap-2">
              {group}
              {launched.map((session) => (
                <LaunchedSessionCard
                  key={session.sessionId}
                  session={session}
                  slug={slug}
                />
              ))}
            </div>
          );
        }
        // A permission waiting is asked where the prompt is typed
        // (conversation-view), as a question is; an answered one is gone.
        return null;
      })}

      {!turn.open && (
        <AssistantActions
          text={text}
          time={clock(turn.endedAt ?? turn.at)}
          usage={turn.usage}
          forking={forking}
          onSave={() => downloadMarkdown(text, fileNameFor(text, "note"))}
          onFork={handlers.onFork}
          onReply={
            handlers.onReply ? () => handlers.onReply?.(text) : undefined
          }
        />
      )}
    </div>
  );
}

/**
 * One turn of the chat, memoized.
 *
 * A closed turn never changes, so a new line streaming into the last one does
 * not redraw the 499 before it.
 *
 * NOTE: Compared by what can change, not by reference: every read builds new
 * objects for the whole transcript.
 */
export const TurnView = memo(
  function TurnView({
    turn,
    delta,
    slug,
    conversation,
    handlers,
    forking,
    anchor,
  }: {
    turn: Turn;
    delta: string;
    slug: string;
    conversation: string;
    handlers: TurnHandlers;
    forking: boolean;
    /** Registers a user turn's element for the TOC. */
    anchor?: (id: string, node: HTMLElement | null) => void;
  }) {
    if (turn.role === "user")
      return (
        <div
          ref={(node) => anchor?.(turn.id, node)}
          data-turn={turn.id}
          className={cn("scroll-mt-6", OFFSCREEN)}
        >
          <UserTurnView turn={turn} />
        </div>
      );
    return (
      <div data-turn={turn.id} className={turn.open ? undefined : OFFSCREEN}>
        <AssistantView
          turn={turn}
          delta={delta}
          slug={slug}
          conversation={conversation}
          handlers={handlers}
          forking={forking}
        />
      </div>
    );
  },
  (a, b) => {
    if (
      a.slug !== b.slug ||
      a.conversation !== b.conversation ||
      a.handlers !== b.handlers ||
      a.anchor !== b.anchor ||
      a.delta !== b.delta ||
      a.forking !== b.forking
    )
      return false;
    if (a.turn === b.turn) return true;
    if (a.turn.id !== b.turn.id || a.turn.role !== b.turn.role) return false;
    if (a.turn.role === "user" && b.turn.role === "user")
      return (
        a.turn.text === b.turn.text &&
        a.turn.attachments.length === b.turn.attachments.length
      );
    if (a.turn.role === "assistant" && b.turn.role === "assistant") {
      // The turn being written changes with every read.
      if (a.turn.open || b.turn.open) return false;
      return (
        a.turn.endedAt === b.turn.endedAt &&
        a.turn.blocks.length === b.turn.blocks.length &&
        a.turn.usage?.output === b.turn.usage?.output
      );
    }
    return false;
  },
);

function UserTurnView({ turn }: { turn: UserTurn }) {
  return (
    <UserBubble
      text={turn.text}
      attachments={turn.attachments}
      time={clock(turn.at)}
    />
  );
}

/** A TOC entry: a prompt, its answer's first line, and the next. */
export interface PromptLine {
  id: string;
  prompt: string;
  reply: string;
  /** The answer's next line, quoted under the first in the hover card. */
  more: string;
}

/** The TOC's lines, one for each prompt and its answer. */
export function promptLines(turns: Turn[]): PromptLine[] {
  const out: PromptLine[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn?.role !== "user") continue;
    const said: string[] = [];
    for (let j = i + 1; j < turns.length && said.length < 2; j++) {
      const next = turns[j];
      if (!next || next.role === "user") break;
      said.push(...textLines(turnText(next), 2 - said.length));
    }
    out.push({
      id: turn.id,
      prompt: firstLine(turn.text) || "(attachment)",
      reply: said[0] ?? "",
      more: said[1] ?? "",
    });
  }
  return out;
}
