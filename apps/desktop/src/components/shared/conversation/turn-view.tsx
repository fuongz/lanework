import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  CommandLineIcon,
  CubeIcon,
  Folder01Icon,
  QuoteDownIcon,
  SlashIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  createContext,
  memo,
  useContext,
  useId,
  useMemo,
  useState,
} from "react";
import type {
  AssistantTurn,
  Attachment,
  ConversationAgent,
  PermissionAnswer,
  Turn,
  UserTurn,
} from "#/../shared/conversation";
import {
  type PeerTurn,
  readCrossSession,
  splitHandoffText,
  splitSummary,
} from "#/../shared/conversation";
import type { LeadIcon } from "#/../shared/orchestration";
import {
  FileOpenerContext,
  ImageViewerContext,
  LinkedText,
  MarkdownBody,
} from "#/components/shared/common/markdown-body";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { sentAttachment } from "#/lib/attachment-previews";
import {
  clock,
  downloadMarkdown,
  fileNameFor,
  firstLine,
  textLines,
  turnText,
} from "#/lib/conversation-format";
import { fileSize } from "#/lib/file-size";
import { leadIcon } from "#/lib/orchestration-prompt";
import { splitQuotes } from "#/lib/quote";
import { cn } from "#/lib/utils";
import { answerSources } from "#/lib/web-sources";
import { AttachmentPreview } from "./composer.attachments";
import { useKnown } from "./composer.known";
import { AssistantActions, UserActions } from "./turn-view.actions";
import { CompactionDivider } from "./turn-view.compaction";
import { HandoffDivider } from "./turn-view.handoff";
import {
  LaunchedSessionCard,
  launchedSessions,
} from "./turn-view.launched-session";
import { chatLink, liveChatLink } from "./turn-view.link-chip";
import { PeerTurnView } from "./turn-view.peer";
import { pullsInCalls, ToolPullCard } from "./turn-view.pull-cards";
import { SourcesButton, SourcesList } from "./turn-view.sources";
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

/**
 * Where an envelope of the app's starts, its name with it. One right after a
 * backtick is quoted in inline code, not an envelope: it stays in the text.
 */
const ENVELOPE_OPEN = /(?<!`)<(lanework_[A-Za-z_]*)/g;
/** A close tag, for one whose open tag landed in an earlier line. */
const ENVELOPE_CLOSE = /(?<!`)<\/(lanework_[A-Za-z_]+)>/;
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
  return (
    <span
      title={attachment.path ?? attachment.name}
      className="bg-foreground/[0.06] inline-flex max-w-60 items-center gap-1.5 rounded-md px-2 py-1 text-xs"
    >
      <FileTypeIcon
        path={attachment.path ?? attachment.name}
        className="size-3.5 shrink-0"
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
const PROMPT_TOKEN = /^\/[^\s/]+(?=\s|$)|(?<=^|\s)@(?:"(?:[^"\\]|\\.)*"|\S+)/g;

/** A path's last part, its file name; the full path stays in the title. */
function fileName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/**
 * What an `@` mention names: the path as written, without the quotes main
 * puts around one with a space in it (`@"/a b/c.csv"`, as the CLI reads it).
 */
function mentionOf(token: string): string {
  const rest = token.slice(1);
  return rest.length > 1 && rest.startsWith('"') && rest.endsWith('"')
    ? rest.slice(1, -1).replace(/\\(.)/g, "$1")
    : rest;
}

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

/**
 * One `/command` or `@mention` of a prompt. A command a list has named shows
 * as the composer's chip did: a skill its cube and name, in the accent.
 */
function PromptToken({ token }: { token: string }) {
  const conductors = useContext(ConductorNames);
  const command = token.startsWith("/");
  const listed = useKnown(command ? token : "");
  const named = command ? "" : mentionOf(token);
  const conductor = command ? undefined : conductors.get(named);
  const path = !command && !conductor && /[./]/.test(named);
  const skill = listed?.kind === "skill";
  return (
    <span
      title={
        command
          ? listed?.detail
            ? `${token}\n${listed.detail}`
            : token
          : `@${named}`
      }
      className={cn(
        "mx-px inline-flex items-baseline gap-1 align-baseline font-medium",
        token === "/orchestrate"
          ? "text-tone-violet"
          : conductor
            ? "text-tone-teal"
            : command && !skill
              ? "text-muted-foreground"
              : "text-primary",
      )}
    >
      {(command || path || conductor) &&
        (path && !/\/$/.test(named) ? (
          <FileTypeIcon
            path={named}
            inherit
            // The first line's middle, not the badge's: a long name wraps.
            className="mt-[0.3em] size-3.5 shrink-0 self-start"
          />
        ) : (
          <HugeiconsIcon
            icon={
              conductor
                ? leadIcon(conductor.icon)
                : token === "/orchestrate"
                  ? UserGroupIcon
                  : skill
                    ? CubeIcon
                    : listed?.kind === "builtin"
                      ? CommandLineIcon
                      : command
                        ? SlashIcon
                        : Folder01Icon
            }
            // The first line's middle, not the badge's: a long name wraps.
            className="mt-[0.3em] size-3.5 shrink-0 self-start"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        ))}
      {conductor
        ? conductor.name
        : command
          ? (COMMAND_LABELS[token] ?? listed?.label ?? token)
          : path
            ? fileName(named)
            : token}
    </span>
  );
}

/**
 * Where a prompt's code is: its fenced blocks (to the end when a fence never
 * closes) and inline code spans. A `@` or `/` in there is code, not a token.
 */
const PROMPT_CODE =
  /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))|`[^`\n]+`/gm;

/** `pattern`'s matches in a prompt, without the ones inside its code. */
function outsideCode(text: string, pattern: RegExp): RegExpExecArray[] {
  const code = [...text.matchAll(PROMPT_CODE)].map(
    (m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const,
  );
  return [...text.matchAll(pattern)].filter((m) => {
    const at = m.index ?? 0;
    return !code.some(([from, to]) => at >= from && at < to);
  });
}

/** The composer's tokens of a prompt, without the ones inside its code. */
function promptTokens(text: string): RegExpExecArray[] {
  return outsideCode(text, PROMPT_TOKEN);
}

/** An attachment drawn where the composer's chip for it was. */
interface Placed {
  name: string;
  path: string | null;
  image: boolean;
  folder: boolean;
  size?: number;
}

/** Where a prompt's attachments are, by the offset of each `[name]`. */
interface Placement {
  at: Map<number, { length: number; file: Placed }>;
  /** The offsets of the `@path` mentions an inline chip already shows. */
  skip: Set<number>;
  /** The attachments shown inline, by index: not shown above again. */
  used: Set<number>;
}

/** `[name]`, never a markdown link's text. */
const PLACED_NAME = /\[([^\]\n]{1,200})\](?!\()/g;
const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp)$/i;
const NO_PLACEMENT: Placement = {
  at: new Map(),
  skip: new Set(),
  used: new Set(),
};

/**
 * Where a prompt names its attachments: the composer sends each one's chip
 * as `[name]`, and its files and images in the order of those chips.
 *
 * - With an `@…/name` mention (main adds one after the text for each file):
 *   that file, and the mention is not drawn again.
 * - With an attachment of that name (a message still being sent): that one.
 * - The name of an image: the next image the message carries.
 *
 * Any other `[…]` stays as written.
 */
function placeAttachments(
  text: string,
  attachments: readonly Attachment[],
): Placement {
  const names = outsideCode(text, PLACED_NAME);
  if (!names.length) return NO_PLACEMENT;
  const placement: Placement = {
    at: new Map(),
    skip: new Set(),
    used: new Set(),
  };
  const mentions = promptTokens(text)
    .filter((match) => match[0].startsWith("@"))
    .map((match) => ({ at: match.index ?? 0, path: mentionOf(match[0]) }));
  const unused = (test: (file: Attachment) => boolean) =>
    attachments.findIndex(
      (file, index) => !placement.used.has(index) && test(file),
    );
  for (const match of names) {
    const name = match[1] ?? "";
    const at = match.index ?? 0;
    const length = match[0].length;
    const mention = mentions.find(
      (entry) => !placement.skip.has(entry.at) && fileName(entry.path) === name,
    );
    if (mention) {
      placement.skip.add(mention.at);
      const named = unused((file) => file.path === mention.path);
      if (named !== -1) placement.used.add(named);
      placement.at.set(at, {
        length,
        file: {
          name,
          path: mention.path,
          image: IMAGE_NAME.test(name),
          folder: mention.path.endsWith("/"),
          size: attachments[named]?.size,
        },
      });
      continue;
    }
    let index = unused((file) => file.name === name);
    if (index === -1 && IMAGE_NAME.test(name))
      index = unused((file) => file.mediaType.startsWith("image/"));
    const file = attachments[index];
    if (!file) continue;
    placement.used.add(index);
    placement.at.set(at, {
      length,
      file: {
        name,
        path: file.path,
        image: file.mediaType.startsWith("image/"),
        folder: false,
        size: file.size,
      },
    });
  }
  return placement;
}

/**
 * An attachment in a prompt, as the composer's chip drew it: the image's
 * thumbnail (when this app sent it) or its type's icon, its name, its size.
 *
 * A click shows an image large: the one sent from here, else the file at
 * its path. A file with a path opens in Repository › Files.
 */
function PlacedChip({ file }: { file: Placed }) {
  const sent = sentAttachment(file.name, file.size);
  const size = file.size ?? sent?.size;
  const preview = file.image ? sent?.preview : undefined;
  const openFile = useContext(FileOpenerContext);
  const viewImage = useContext(ImageViewerContext);
  const [showing, setShowing] = useState(false);
  const path = file.path;
  const click = preview
    ? () => setShowing(true)
    : path && file.image && viewImage
      ? () => viewImage(path)
      : path && !file.folder && openFile
        ? () => openFile(path)
        : null;
  const className =
    "text-primary mx-px inline-flex items-baseline gap-1 align-baseline font-medium";
  const body = (
    <>
      {preview ? (
        <img
          src={preview}
          alt=""
          draggable={false}
          className="ring-border mt-[0.3em] size-3.5 shrink-0 self-start rounded-[3px] object-cover ring-1"
        />
      ) : file.folder ? (
        <HugeiconsIcon
          icon={Folder01Icon}
          className="mt-[0.3em] size-3.5 shrink-0 self-start"
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ) : (
        <FileTypeIcon
          path={file.name}
          inherit
          className="mt-[0.3em] size-3.5 shrink-0 self-start"
        />
      )}
      {file.name}
      {size !== undefined && (
        <span className="text-muted-foreground text-[11px] font-normal tabular-nums">
          {fileSize(size)}
        </span>
      )}
    </>
  );
  if (!click)
    return (
      <span title={path ?? file.name} className={className}>
        {body}
      </span>
    );
  return (
    <>
      <button
        type="button"
        title={
          file.image ? `Preview ${file.name}` : `Open ${path ?? file.name}`
        }
        onClick={click}
        className={cn(
          className,
          "focus-visible:ring-ring/40 cursor-pointer rounded-sm text-left outline-none hover:underline focus-visible:ring-2",
        )}
      >
        {body}
      </button>
      {preview && (
        <AttachmentPreview
          name={file.name}
          src={preview}
          open={showing}
          onOpenChange={setShowing}
        />
      )}
    </>
  );
}

function PromptText({
  text,
  placement = NO_PLACEMENT,
}: {
  text: string;
  placement?: Placement;
}) {
  const found = [
    ...promptTokens(text).map((match) => ({
      at: match.index ?? 0,
      length: match[0].length,
      node: placement.skip.has(match.index ?? 0) ? null : (
        <PromptToken key={`c${match.index}`} token={match[0]} />
      ),
    })),
    ...[...placement.at].map(([at, { length, file }]) => ({
      at,
      length,
      node: <PlacedChip key={`a${at}`} file={file} />,
    })),
  ].sort((a, b) => a.at - b.at);
  const parts: { text?: string; node?: React.ReactNode }[] = [];
  let last = 0;
  for (const { at, length, node } of found) {
    if (at < last) continue;
    if (at > last) parts.push({ text: text.slice(last, at) });
    if (node) parts.push({ node });
    last = at + length;
  }
  if (last === 0) return <LinkedText source={text} link={chatLink} />;
  if (last < text.length) parts.push({ text: text.slice(last) });
  // The mentions not drawn again closed the text: the space before them goes.
  while (parts.length && parts[parts.length - 1]?.text?.trim() === "")
    parts.pop();
  const tail = parts[parts.length - 1];
  if (tail?.text !== undefined) tail.text = tail.text.trimEnd();
  return (
    <>
      {parts.map((part, index) =>
        part.text === undefined ? (
          part.node
        ) : (
          <LinkedText
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text, in order.
            key={`t${index}`}
            source={part.text}
            link={chatLink}
          />
        ),
      )}
    </>
  );
}

/**
 * Whether a prompt is written in markdown worth drawing: a fence, a list, a
 * heading, emphasis or inline code. A prompt with the composer's tokens
 * (`@file`, `/command`, a conductor) outside its code keeps its chips and
 * stays plain text,
 * and so does plain prose, whose line breaks are kept as typed.
 */
function looksLikeMarkdown(text: string): boolean {
  if (promptTokens(text).length) return false;
  return (
    /^\s*(```|~~~)/m.test(text) ||
    /^\s{0,3}([-*+]|\d+[.)])\s+\S/m.test(text) ||
    /^\s{0,3}#{1,6}\s+\S/m.test(text) ||
    /\*\*[^*\n]+\*\*|__[^_\n]+__/.test(text) ||
    /`[^`\n]+`/.test(text)
  );
}

/** What the person wrote: a bubble on the right, attachments above. */
export function UserBubble({
  text,
  attachments,
  time,
  pending,
  summary,
}: {
  text: string;
  attachments: Attachment[];
  time: string | null;
  /** Sent from here, not in the transcript yet: queued or starting. */
  pending?: string;
  /**
   * The few words a conductor or run lead gave it (BE-06): shown as the
   * bubble's title, its text folded under it until opened.
   */
  summary?: string;
}) {
  const [open, setOpen] = useState(false);
  const folded = !!summary && !open;
  const { quotes, rest } = splitQuotes(text);
  const body = rest.trim();
  const placement = useMemo(
    () => placeAttachments(body, attachments),
    [body, attachments],
  );
  const above = attachments.filter((_, index) => !placement.used.has(index));
  return (
    <div className="group/turn flex flex-col items-end">
      {/* The bubble and, on its top edge, a tab with what it replies to or
          mentions (the composer's quotes tab). The tab takes the bubble's
          width, never sets it: `contain` keeps its text from widening it. */}
      <div
        className={cn(
          "flex max-w-[85%] min-w-0 flex-col",
          pending && "opacity-70",
        )}
      >
        {quotes.length > 0 && (
          <div className="bg-muted/50 text-muted-foreground mx-3 flex min-w-40 flex-col rounded-t-xl px-3 py-1 text-xs [contain:inline-size] dark:bg-foreground/[0.04]">
            {quotes.map((lines, index) => (
              // One line each; the whole quote on hover.
              <Tooltip
                // biome-ignore lint/suspicious/noArrayIndexKey: quotes are positional and never reorder.
                key={index}
              >
                <TooltipTrigger
                  render={
                    <p className="flex h-6 min-w-0 items-center gap-1.5" />
                  }
                >
                  <HugeiconsIcon
                    icon={QuoteDownIcon}
                    className="size-3.5 shrink-0"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  <span className="truncate">{lines.join(" ")}</span>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {lines.join("\n")}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
        <div className="bg-muted flex min-w-0 flex-col gap-2 rounded-2xl px-3.5 py-2.5 dark:bg-foreground/[0.07]">
          {summary && (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              className="flex min-w-0 items-start gap-1.5 text-left text-[14px] font-medium"
            >
              <HugeiconsIcon
                icon={open ? ArrowDown01Icon : ArrowRight01Icon}
                className="text-muted-foreground mt-[3px] size-3.5 shrink-0"
                strokeWidth={2}
                aria-hidden="true"
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {summary}
              </span>
            </button>
          )}
          {!folded && above.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {above.map((attachment, index) => (
                <AttachmentChip
                  // biome-ignore lint/suspicious/noArrayIndexKey: attachments are positional and never reorder.
                  key={index}
                  attachment={attachment}
                />
              ))}
            </div>
          )}
          {!folded &&
            body &&
            (placement.at.size === 0 && looksLikeMarkdown(body) ? (
              // Code blocks, lists, headings, emphasis: drawn as a reply is.
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <MarkdownBody
                  source={body}
                  link={chatLink}
                  variant="chat"
                  empty=""
                />
              </div>
            ) : (
              <p className="font-content text-[14px] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]">
                <PromptText text={body} placement={placement} />
              </p>
            ))}
        </div>
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
  /** Who the permission cards say asks: Claude, Codex or OpenCode. */
  agent?: string;
  /** The CLI the turns are of, for its mark; Claude's when not said. */
  kind?: ConversationAgent;
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
  // The pages it stands on, once it is written: its searches and fetches,
  // and the links in its text.
  const sources = useMemo(
    () => (turn.open ? [] : answerSources(turn, text)),
    [turn, text],
  );
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sourcesId = useId();
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
          // FE-174: a pull request a command printed, as a card.
          const pulls = pullsInCalls(block.calls);
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
              kind={handlers.kind ?? "claude"}
              slug={slug}
              conversation={conversation}
            />
          );
          if (!launched.length && !pulls.length) return group;
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
              {pulls.map((pull) => (
                <ToolPullCard
                  key={`${pull.owner}/${pull.repo}#${pull.number}`}
                  slug={slug}
                  pull={pull}
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
          sources={
            sources.length > 0 ? (
              <SourcesButton
                sources={sources}
                open={sourcesOpen}
                onToggle={() => setSourcesOpen(!sourcesOpen)}
                controls={sourcesId}
              />
            ) : null
          }
        />
      )}
      {!turn.open && sourcesOpen && sources.length > 0 && (
        <SourcesList id={sourcesId} sources={sources} />
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
    compacted = false,
  }: {
    turn: Turn;
    delta: string;
    slug: string;
    conversation: string;
    handlers: TurnHandlers;
    forking: boolean;
    /** Registers a user turn's element for the TOC. */
    anchor?: (id: string, node: HTMLElement | null) => void;
    /**
     * Before the latest compaction (FE-120): out of the model's context, so
     * drawn dimmer. Hovered or focused, it reads at full strength.
     */
    compacted?: boolean;
  }) {
    const dim = compacted
      ? "opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none"
      : undefined;
    if (turn.role === "compaction")
      return (
        <div data-turn={turn.id} className={dim}>
          <CompactionDivider turn={turn} />
        </div>
      );
    // A thread's marker between two of its sessions (`switchAgent`).
    if (turn.role === "handoff")
      return (
        <div data-turn={turn.id} className={dim}>
          <HandoffDivider turn={turn} />
        </div>
      );
    // FE-169: a message another Claude session sent here.
    // PD-06: a Codex or OpenCode transcript keeps a message from another
    // conversation as a plain user turn; it reads as one all the same.
    if (turn.role === "peer")
      return (
        <div data-turn={turn.id} className={cn(OFFSCREEN, dim)}>
          <PeerTurnView turn={turn} slug={slug} />
        </div>
      );
    const peer = peerOfUserTurn(turn);
    if (peer)
      return (
        <div data-turn={turn.id} className={cn(OFFSCREEN, dim)}>
          <PeerTurnView turn={peer} slug={slug} />
        </div>
      );
    if (turn.role === "user")
      return (
        <div
          ref={(node) => anchor?.(turn.id, node)}
          data-turn={turn.id}
          className={cn("group/turn scroll-mt-6", OFFSCREEN, dim)}
        >
          <UserTurnView turn={turn} />
        </div>
      );
    return (
      <div
        data-turn={turn.id}
        className={cn("group/turn", !turn.open && OFFSCREEN, dim)}
      >
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
      a.forking !== b.forking ||
      a.compacted !== b.compacted
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
    if (a.turn.role === "compaction" && b.turn.role === "compaction")
      return (
        a.turn.summary === b.turn.summary && a.turn.taskId === b.turn.taskId
      );
    // NOTE: Its id names the session it opened, but a model is only learnt
    // once that session answers, and a read may join more sources to it.
    if (a.turn.role === "handoff" && b.turn.role === "handoff") {
      const after = b.turn.from;
      return (
        a.turn.to.model === b.turn.to.model &&
        a.turn.from.length === after.length &&
        a.turn.from.every((side, at) => side.model === after[at]?.model)
      );
    }
    return false;
  },
);

function UserTurnView({ turn }: { turn: UserTurn }) {
  // A handoff's first message: the person's words, not the context block
  // carried ahead of them (the Context handoff divider stands above it).
  const text = splitHandoffText(turn.text)?.message ?? turn.text;
  // BE-06: a conductor's or run lead's few words, its text folded under.
  const titled = splitSummary(text);
  return (
    <UserBubble
      text={titled?.text ?? text}
      attachments={turn.attachments}
      time={clock(turn.at)}
      summary={titled?.summary}
    />
  );
}

/**
 * A user turn that is a message from another conversation (PD-06), read as
 * the peer turn Claude's transcript gives one; null for anything else.
 */
function peerOfUserTurn(turn: Turn): PeerTurn | null {
  if (turn.role !== "user" || !turn.text.includes("<cross-session-message"))
    return null;
  const read = readCrossSession(turn.text);
  if (!read) return null;
  return {
    role: "peer",
    id: turn.id,
    from: read.from,
    name: read.name,
    mode: read.mode,
    pid: null,
    sender: read.from.startsWith("lanework:")
      ? { conversation: read.from.slice(9), title: null }
      : null,
    text: read.text,
    at: turn.at,
  };
}

/** A TOC entry: a prompt, its answer's first line, and the next. */
export interface PromptLine {
  id: string;
  prompt: string;
  reply: string;
  /** The answer's next line, quoted under the first in the hover card. */
  more: string;
  /** Before the latest compaction: out of the model's context. */
  compacted?: boolean;
  /** Folded away in the chat now: a jump unfolds it first. */
  folded?: boolean;
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
      prompt: (() => {
        const text = splitHandoffText(turn.text)?.message ?? turn.text;
        // BE-06: a titled follow-up reads as its title.
        const titled = splitSummary(text);
        return firstLine(titled?.summary ?? text) || "(attachment)";
      })(),
      reply: said[0] ?? "",
      more: said[1] ?? "",
    });
  }
  return out;
}
