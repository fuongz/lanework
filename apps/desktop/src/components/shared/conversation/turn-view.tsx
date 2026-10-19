import { File01Icon, Image01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo } from "react";
import type {
  AssistantTurn,
  Attachment,
  PermissionAnswer,
  PermissionRequest,
  Turn,
  UserTurn,
} from "#/../shared/conversation";
import { PermissionCard } from "#/components/shared/agents/permission-card";
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
import { cn } from "#/lib/utils";
import { AssistantActions, UserActions } from "./turn-view.actions";
import { chatLink } from "./turn-view.link-chip";
import { ToolGroup } from "./turn-view.tool-group";

/**
 * ⚠️ Off-screen turns skip layout and paint (`content-visibility: auto`), and
 * keep their last drawn height (`auto` in `contain-intrinsic-size`), so a
 * conversation of 500 turns scrolls as lightly as one of 5.
 */
const OFFSCREEN =
  "[content-visibility:auto] [contain-intrinsic-size:auto_160px]";

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

/** What the person wrote (D2): a bubble on the right, attachments above. */
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
            <LinkedText source={text} link={chatLink} />
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
  onReply: (text: string) => void;
  onAnswer: (id: string, answer: PermissionAnswer) => Promise<void>;
}

function AssistantView({
  turn,
  delta,
  permissions,
  slug,
  conversation,
  handlers,
  forking,
}: {
  turn: AssistantTurn;
  delta: string;
  permissions: PermissionRequest[];
  slug: string;
  conversation: string;
  handlers: TurnHandlers;
  forking: boolean;
}) {
  // Streamed text joins the turn's last text, or starts a new one.
  const blocks = turn.blocks.slice();
  if (delta) {
    const last = blocks[blocks.length - 1];
    if (last?.type === "text")
      blocks[blocks.length - 1] = { type: "text", text: last.text + delta };
    else blocks.push({ type: "text", text: delta });
  }
  const answered = new Set(
    blocks
      .filter((block) => block.type === "permission")
      .map((block) => block.request.id),
  );
  // ⚠️ Questions are not drawn in the turn: they take the composer's place
  // (conversation-view), where the answer is typed.
  const waiting = permissions.filter(
    (request) => !answered.has(request.id) && !request.questions,
  );
  const pendingIds = new Set(permissions.map((request) => request.id));
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
              link={chatLink}
              variant="chat"
              empty=""
            />
          );
        }
        if (block.type === "tools")
          return (
            <ToolGroup
              key={block.calls[0]?.id ?? `tools-${index}`}
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
        // A permission still waiting gets its card; an answered one is gone.
        if (
          !turn.open ||
          !pendingIds.has(block.request.id) ||
          block.request.questions
        )
          return null;
        return (
          <PermissionCard
            key={block.request.id}
            request={block.request}
            agent={handlers.agent}
            onAnswer={handlers.onAnswer}
          />
        );
      })}
      {waiting.map((request) => (
        <PermissionCard
          key={request.id}
          request={request}
          agent={handlers.agent}
          onAnswer={handlers.onAnswer}
        />
      ))}
      {!turn.open && (
        <AssistantActions
          text={text}
          time={clock(turn.endedAt ?? turn.at)}
          usage={turn.usage}
          forking={forking}
          onSave={() => downloadMarkdown(text, fileNameFor(text, "note"))}
          onFork={handlers.onFork}
          onReply={() => handlers.onReply(text)}
        />
      )}
    </div>
  );
}

/**
 * One turn of the chat, memoized (perf): a closed turn never changes, so a
 * new line streaming into the last one does not redraw the 499 before it.
 *
 * ⚠️ Compared by what can change, not by reference: every read builds new
 * objects for the whole transcript.
 */
export const TurnView = memo(
  function TurnView({
    turn,
    delta,
    permissions,
    slug,
    conversation,
    handlers,
    forking,
    anchor,
  }: {
    turn: Turn;
    delta: string;
    permissions: PermissionRequest[];
    slug: string;
    conversation: string;
    handlers: TurnHandlers;
    forking: boolean;
    /** Registers a user turn's element for the TOC (D5). */
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
          permissions={permissions}
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
      a.permissions !== b.permissions ||
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

/** A TOC entry (D5): a prompt, its answer's first line, and the next. */
export interface PromptLine {
  id: string;
  prompt: string;
  reply: string;
  /** The answer's next line, quoted under the first in the hover card. */
  more: string;
}

/** The TOC's line for a prompt and its answer (D5). */
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
