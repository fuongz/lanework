import { Collapsible } from "@base-ui/react/collapsible";
import {
  ArrowRight01Icon,
  CommandLineIcon,
  File01Icon,
  Globe02Icon,
  Image01Icon,
  PencilEdit02Icon,
  Plug01Icon,
  Robot02Icon,
  Search01Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import {
  type MouseEvent,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  ConversationAgent,
  ToolCall,
  ToolKind,
} from "#/../shared/conversation";
import {
  ImageThumb,
  ImageViewerContext,
} from "#/components/shared/common/markdown-body";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { commandProgram, commandText } from "#/lib/command-label";
import {
  baseName,
  formatDuration,
  groupTitle,
  isImagePath,
  mcpName,
} from "#/lib/conversation-format";
import { type JsonTokenKind, jsonTokens, prettyJson } from "#/lib/json-tokens";
import { cn } from "#/lib/utils";

const KIND_ICONS: Record<ToolKind, IconSvgElement> = {
  edit: PencilEdit02Icon,
  command: CommandLineIcon,
  read: File01Icon,
  search: Search01Icon,
  fetch: Globe02Icon,
  agent: Robot02Icon,
  mcp: Plug01Icon,
  other: Wrench01Icon,
};

/**
 * The timing a fold's open and close share.
 *
 * The panel's height eases between 0 and what Base UI measured (`auto` once
 * open, so a call opening inside a group still grows it), the calls fading
 * with it. Short, with a strong ease-out: height costs layout every frame,
 * and the reader is waiting on the rows.
 */
const EASE = "duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]";
const PANEL = `h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] ${EASE} data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-none`;
/**
 * The same panel, opening and closing at once. Used while the turn streams:
 * a height eased then costs layout on every frame of a page that is already
 * re-rendering per token, and the stream's own scroll-to-end follows it.
 */
const PANEL_AT_ONCE = "overflow-hidden";

/**
 * The clock, re-read about once a second while `active`; idle (no timer at
 * all) otherwise. The interval is cleared on unmount or when `active` ends.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** A duration, muted and tabular, that never takes room from the label. */
function Elapsed({ ms, className }: { ms: number; className?: string }) {
  return (
    <span
      className={cn(
        "text-muted-foreground shrink-0 text-xs tabular-nums",
        className,
      )}
    >
      {formatDuration(ms)}
    </span>
  );
}

/**
 * A group's wall time: the earliest start to the latest end (now, while a
 * call still runs), else the sum of the durations known; null when unknown.
 */
function groupElapsed(
  calls: ToolCall[],
  now: number,
  live: boolean,
): number | null {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let known = false;
  for (const call of calls) {
    const start = call.startedAt ? Date.parse(call.startedAt) : Number.NaN;
    if (!Number.isNaN(start)) first = Math.min(first, start);
    if (call.output === null) {
      // Unanswered: running only while the group is live; else it never ends
      // (an aborted turn) and is left out.
      if (live && !Number.isNaN(start)) last = Math.max(last, now);
    } else if (call.durationMs !== null) {
      sum += call.durationMs;
      known = true;
      if (!Number.isNaN(start)) last = Math.max(last, start + call.durationMs);
    }
  }
  if (Number.isFinite(first) && Number.isFinite(last) && last >= first)
    return last - first;
  return known ? sum : null;
}

/** Each token kind's colour, light and dark. Punctuation stays muted. */
const JSON_TONE: Record<JsonTokenKind, string | undefined> = {
  key: "text-sky-600 dark:text-sky-300",
  string: "text-emerald-600 dark:text-emerald-300",
  number: "text-amber-600 dark:text-amber-300",
  literal: "text-violet-600 dark:text-violet-300",
  punctuation: "text-muted-foreground",
  plain: undefined,
};

/** JSON, coloured by token; any other text comes through as it is. */
function JsonCode({ text }: { text: string }) {
  const tokens = useMemo(() => jsonTokens(text), [text]);
  return (
    <code>
      {tokens.map((token, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one fixed text, never reordered.
          key={index}
          className={JSON_TONE[token.kind]}
        >
          {token.text}
        </span>
      ))}
    </code>
  );
}

/**
 * A call's output: pretty and coloured when it is JSON, as it came
 * otherwise. A failure keeps its plain red text.
 */
function OutputCode({ text, error }: { text: string; error: boolean }) {
  const pretty = useMemo(
    () => (error || !text ? null : prettyJson(text)),
    [text, error],
  );
  if (pretty) return <JsonCode text={pretty} />;
  return <code>{text || "(no output)"}</code>;
}

/**
 * The image a call made, else null: Codex's `image_gen` saves one and names
 * it in `filePath`. A read or an edit of an image is not one.
 */
function madeImage(call: ToolCall): string | null {
  return call.kind === "other" && !call.error && isImagePath(call.filePath)
    ? call.filePath
    : null;
}

/**
 * A file the call read or wrote: its icon and its path, mono.
 *
 * An image's chip opens the lightbox on Cmd/Ctrl-click, or from its context
 * menu, instead of folding the row; a plain click still folds it.
 */
function FileChip({ path }: { path: string }) {
  const view = useContext(ImageViewerContext);
  const image = isImagePath(path);
  const chip = (
    <span
      title={path}
      className="text-foreground/80 inline-flex min-w-0 items-center gap-1.5 font-mono text-[12px]"
    >
      <FileTypeIcon path={path} className="size-3.5 shrink-0" />
      <span className="truncate">{path}</span>
    </span>
  );
  if (!image || !view) return chip;
  const onClick = (event: MouseEvent) => {
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    view(path);
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<span />}
        className="inline-flex min-w-0"
        onClick={onClick}
      >
        {chip}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => view(path)}>
          <HugeiconsIcon icon={Image01Icon} strokeWidth={1.8} />
          Open image
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** What one row says after its icon: a command, `Read <file>`, a pattern. */
function CallLine({ call }: { call: ToolCall }) {
  if ((call.kind === "read" || call.kind === "edit") && call.filePath)
    return (
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0">
          {call.kind === "read" ? "Read" : "Edited"}
        </span>
        <FileChip path={call.filePath} />
      </span>
    );
  if (call.kind === "command") {
    // `Ran rg`, as t3code labels it: the program, not the whole line. The
    // line is in the row's tooltip and its panel.
    const program = commandProgram(call.summary || "");
    if (program)
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">
            {call.output === null ? "Running" : "Ran"}
          </span>
          <span className="text-foreground/80 min-w-0 truncate font-mono text-[12px]">
            {program}
          </span>
        </span>
      );
    return (
      <span className="min-w-0 truncate font-mono text-[12px]">
        {call.summary ? commandText(call.summary) : call.tool}
      </span>
    );
  }
  const name =
    call.kind === "mcp"
      ? mcpName(call.tool)
      : call.kind === "agent"
        ? "Agent"
        : call.kind === "search"
          ? "Searched"
          : call.kind === "fetch"
            ? "Fetched"
            : call.tool;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0">{name}</span>
      {call.summary && (
        <span className="text-muted-foreground min-w-0 truncate font-mono text-[12px]">
          {call.summary}
        </span>
      )}
    </span>
  );
}

/**
 * One call: a row that opens its full input and output, mono.
 *
 * A sub-agent's row also links to its transcript.
 */
function CallRow({
  call,
  slug,
  conversation,
  atOnce,
  live,
}: {
  call: ToolCall;
  slug: string;
  conversation: string;
  /** The turn streams: open and close without easing the height. */
  atOnce: boolean;
  /** The group is the one still running: only then may an unanswered call tick. */
  live: boolean;
}) {
  const running = call.output === null;
  const image = madeImage(call);
  const now = useNow(live && running && call.startedAt !== null);
  const elapsed = running
    ? live && call.startedAt
      ? now - Date.parse(call.startedAt)
      : null
    : call.durationMs;
  return (
    <Collapsible.Root
      render={<li />}
      className="relative flex min-w-0 flex-col"
    >
      {/* The tree's elbow into this row. */}
      <span
        aria-hidden="true"
        className="border-foreground/15 absolute top-0 -left-3 h-3 w-2.5 rounded-bl-md border-b border-l"
      />
      <div className="flex min-w-0 items-center gap-1">
        <Collapsible.Trigger
          title={
            call.kind === "command" && call.summary
              ? commandText(call.summary)
              : call.summary || call.tool
          }
          className={cn(
            "hover:bg-foreground/[0.04] flex h-6 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-[13px] transition-colors",
            call.error ? "text-destructive" : "text-muted-foreground",
            // Breathes, not shimmers: several calls may run at once.
            running && "text-breathe",
          )}
        >
          <HugeiconsIcon
            icon={KIND_ICONS[call.kind]}
            className="size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <CallLine call={call} />
          {call.filePath && call.kind !== "read" && call.kind !== "edit" && (
            <span className="shrink-0 text-xs">{baseName(call.filePath)}</span>
          )}
          {elapsed !== null && Number.isFinite(elapsed) && (
            <Elapsed ms={elapsed} className="ms-auto" />
          )}
        </Collapsible.Trigger>
        {call.kind === "agent" && call.subagent && (
          <Link
            to="/w/$slug/agents/sub/$conversation/$sub"
            params={{ slug, conversation, sub: call.subagent }}
            search={{ agent: "claude" }}
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] shrink-0 rounded-md px-1.5 py-0.5 text-xs transition-colors"
          >
            Open
          </Link>
        )}
      </div>
      <Collapsible.Panel className={atOnce ? PANEL_AT_ONCE : PANEL}>
        {/* Wide output scrolls inside its own box; the page never scrolls sideways. */}
        <div className="bg-foreground/[0.04] my-1 ms-6 flex max-h-96 flex-col gap-2 overflow-auto rounded-lg p-3 font-mono text-[11px] leading-relaxed">
          <pre className="whitespace-pre-wrap break-all">
            {call.kind === "command" &&
            call.input &&
            !call.input.startsWith("{") ? (
              <code>{commandText(call.input)}</code>
            ) : (
              <JsonCode text={call.input || "{}"} />
            )}
          </pre>
          {call.output !== null && (
            <>
              <div className="border-border border-t" />
              <pre
                className={cn(
                  "whitespace-pre-wrap break-all",
                  call.error && "text-destructive",
                )}
              >
                <OutputCode text={call.output} error={call.error} />
              </pre>
            </>
          )}
        </div>
        {/* Below the output's scroll box, so it is never cut by it. */}
        {image && (
          <div className="ms-6 mb-1">
            <ImageThumb
              path={image}
              alt={baseName(image)}
              fallback={null}
              className="max-h-64"
            />
          </div>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * Consecutive tool calls folded into one row.
 *
 * The row reads `Edited links.mjs, ran 3 commands, read 3 files`. Closed by
 * default; open while it is the group still running, until the person
 * decides otherwise.
 */
export const ToolGroup = memo(function ToolGroup({
  calls,
  running,
  lead,
  kind,
  slug,
  conversation,
}: {
  calls: ToolCall[];
  /** The open turn's last group, a call still without its result. */
  running: boolean;
  /** The first thing of its turn: the CLI's mark leads it. */
  lead: boolean;
  /** Which CLI's mark: the conversation's own, never always Claude's. */
  kind: ConversationAgent;
  slug: string;
  conversation: string;
}) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? running;
  // It opens by itself as its calls start and folds as they end, while the
  // turn streams: those moves, and any while it runs, are not eased. Only a
  // click of the reader's, once it is quiet, eases the height.
  const [clicked, setClicked] = useState(false);
  useEffect(() => {
    // `running` flipped: the fold that follows is the group's own.
    void running;
    setClicked(false);
  }, [running]);
  const atOnce = running || !clicked;
  const failed = calls.some((call) => call.error);
  const live = running && calls.some((call) => call.output === null);
  const now = useNow(live);
  const total = groupElapsed(calls, now, live);
  // The images the group made stay in sight while it is folded; open, each
  // one sits in its own call's output instead.
  const images = calls.flatMap((call) => {
    const path = madeImage(call);
    return path ? [path] : [];
  });
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(next) => {
        setClicked(true);
        setChosen(next);
      }}
      className="flex min-w-0 flex-col"
    >
      <Collapsible.Trigger
        className={cn(
          "group/tools text-muted-foreground hover:text-foreground flex h-7 min-w-0 items-center gap-2 self-start rounded-md text-left text-[13px] transition-colors",
          running && "text-shimmer",
        )}
      >
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            className={cn(
              "absolute size-3.5 transition-[transform,opacity] motion-reduce:transition-none",
              EASE,
              open
                ? "rotate-90 opacity-100"
                : "opacity-0 group-hover/tools:opacity-100 group-focus-visible/tools:opacity-100",
            )}
            strokeWidth={2}
            aria-hidden="true"
          />
          <span
            aria-hidden="true"
            className={cn(
              "flex transition-opacity",
              open
                ? "opacity-0"
                : "group-hover/tools:opacity-0 group-focus-visible/tools:opacity-0",
            )}
          >
            {lead ? (
              <TerminalKindIcon kind={kind} className="size-3.5" />
            ) : (
              <HugeiconsIcon
                icon={KIND_ICONS[calls[0]?.kind ?? "other"]}
                className="size-3.5"
                strokeWidth={1.8}
              />
            )}
          </span>
        </span>
        <span className="min-w-0 truncate">{groupTitle(calls)}</span>
        {total !== null && <Elapsed ms={total} />}
        {failed && (
          <span className="text-destructive shrink-0 text-xs">failed</span>
        )}
      </Collapsible.Trigger>
      {!open && images.length > 0 && (
        <div className="ms-[22px] mt-1 flex flex-wrap gap-2">
          {images.map((path) => (
            <ImageThumb
              key={path}
              path={path}
              alt={baseName(path)}
              fallback={null}
              className="max-h-48"
            />
          ))}
        </div>
      )}
      <Collapsible.Panel className={atOnce ? PANEL_AT_ONCE : PANEL}>
        <ul className="ms-[7px] flex min-w-0 flex-col ps-3">
          {calls.map((call) => (
            <CallRow
              key={call.id}
              call={call}
              slug={slug}
              conversation={conversation}
              atOnce={running}
              live={running}
            />
          ))}
        </ul>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
});
