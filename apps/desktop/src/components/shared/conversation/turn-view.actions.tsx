import {
  Analytics01Icon,
  Comment01Icon,
  Copy01Icon,
  FileAddIcon,
  GitForkIcon,
  NoteAddIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import type { TurnUsage } from "#/../shared/conversation";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { compact } from "#/lib/conversation-format";
import { cn } from "#/lib/utils";

/** One icon-only action; its tooltip names it before a click. */
function Action({
  label,
  icon,
  onClick,
  disabled,
  tip,
}: {
  label: string;
  icon: IconSvgElement;
  onClick?: () => void;
  disabled?: boolean;
  /** A richer tooltip than the label — the Usage one. */
  tip?: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-40"
          />
        }
      >
        <HugeiconsIcon
          icon={icon}
          className="size-4"
          strokeWidth={1.6}
          aria-hidden="true"
        />
      </TooltipTrigger>
      <TooltipContent
        className={tip ? "flex-col items-start gap-0.5 px-3 py-2" : undefined}
      >
        {tip ?? label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Copy, with a tick for a moment once it has copied. */
function CopyAction({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <Action
      label={done ? "Copied" : label}
      icon={done ? Tick02Icon : Copy01Icon}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => setDone(true))
      }
    />
  );
}

/** The row under a message: its actions and its time, always shown. */
function Row({
  align,
  time,
  children,
}: {
  align: "start" | "end";
  time: string | null;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-8 items-center gap-0.5",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      <div className="flex items-center gap-0.5">{children}</div>
      {time && (
        <span className="text-muted-foreground flex items-center gap-1.5 px-1 text-xs tabular-nums">
          {align === "start" && <span aria-hidden="true">·</span>}
          {time}
        </span>
      )}
    </div>
  );
}

export function UserActions({
  text,
  time,
  onSave,
}: {
  text: string;
  time: string | null;
  onSave: () => void;
}) {
  return (
    <Row align="end" time={time}>
      <CopyAction text={text} label="Copy" />
      <Action label="Add as file" icon={FileAddIcon} onClick={onSave} />
    </Row>
  );
}

/** The Usage tooltip's two lines. */
function usageTip(usage: TurnUsage): ReactNode {
  const head = [
    usage.cacheHitPct !== null
      ? `Cache hit ${Math.round(usage.cacheHitPct)}%`
      : null,
    usage.tokPerSec !== null
      ? `Output ${Math.round(usage.tokPerSec)} tok/s`
      : null,
  ].filter((part) => part !== null);
  return (
    <>
      {head.length > 0 && <span>{head.join(" · ")}</span>}
      <span className="opacity-60">
        {compact(usage.input)} input · {compact(usage.output)} output ·{" "}
        {compact(usage.cached)} cached
      </span>
    </>
  );
}

export function AssistantActions({
  text,
  time,
  usage,
  onSave,
  onFork,
  onReply,
  forking,
}: {
  text: string;
  time: string | null;
  usage: TurnUsage | null;
  onSave: () => void;
  /** None for a conversation that cannot be forked (Codex's). */
  onFork?: () => void;
  onReply: () => void;
  forking: boolean;
}) {
  return (
    <Row align="start" time={time}>
      <CopyAction text={text} label="Copy" />
      <Action label="Save as note" icon={NoteAddIcon} onClick={onSave} />
      {onFork && (
        <Action
          label="Fork into a new conversation"
          icon={GitForkIcon}
          onClick={onFork}
          disabled={forking}
        />
      )}
      <Action label="Reply" icon={Comment01Icon} onClick={onReply} />
      {usage && (
        <Action label="Usage" icon={Analytics01Icon} tip={usageTip(usage)} />
      )}
    </Row>
  );
}
