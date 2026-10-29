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
import { type MouseEvent, memo, useContext, useState } from "react";
import type {
  ConversationAgent,
  ToolCall,
  ToolKind,
} from "#/../shared/conversation";
import {
  ImageThumb,
  ImageViewerContext,
} from "#/components/shared/common/markdown-body";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
  baseName,
  groupTitle,
  isImagePath,
  mcpName,
} from "#/lib/conversation-format";
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
      className="bg-foreground/[0.05] inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[12px]"
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
  if (call.kind === "command")
    return (
      <span className="min-w-0 truncate font-mono text-[12px]">
        {call.summary || call.tool}
      </span>
    );
  const name =
    call.kind === "mcp"
      ? mcpName(call.tool)
      : call.kind === "agent"
        ? "Agent"
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
}: {
  call: ToolCall;
  slug: string;
  conversation: string;
}) {
  const running = call.output === null;
  const image = madeImage(call);
  return (
    <Collapsible.Root
      render={<li />}
      className="relative flex min-w-0 flex-col"
    >
      {/* The tree's elbow into this row. */}
      <span
        aria-hidden="true"
        className="border-foreground/15 absolute top-0 -left-3 h-3.5 w-2.5 rounded-bl-md border-b border-l"
      />
      <div className="flex min-w-0 items-center gap-1">
        <Collapsible.Trigger
          title={call.summary || call.tool}
          className={cn(
            "hover:bg-foreground/[0.04] flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-[13px] transition-colors",
            call.error ? "text-destructive" : "text-muted-foreground",
            running && "text-shimmer",
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
      <Collapsible.Panel className={PANEL}>
        {/* Wide output scrolls inside its own box; the page never scrolls sideways. */}
        <div className="bg-foreground/[0.04] my-1 ms-6 flex max-h-96 flex-col gap-2 overflow-auto rounded-lg p-3 font-mono text-[11px] leading-relaxed">
          <pre className="whitespace-pre-wrap break-all">
            <code>{call.input || "{}"}</code>
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
                <code>{call.output || "(no output)"}</code>
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
  const failed = calls.some((call) => call.error);
  // The images the group made stay in sight while it is folded; open, each
  // one sits in its own call's output instead.
  const images = calls.flatMap((call) => {
    const path = madeImage(call);
    return path ? [path] : [];
  });
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setChosen}
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
      <Collapsible.Panel className={PANEL}>
        <ul className="ms-[7px] flex min-w-0 flex-col ps-3">
          {calls.map((call) => (
            <CallRow
              key={call.id}
              call={call}
              slug={slug}
              conversation={conversation}
            />
          ))}
        </ul>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
});
