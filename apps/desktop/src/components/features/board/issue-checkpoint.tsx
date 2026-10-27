import {
  Clock01Icon,
  Copy01Icon,
  RoboticIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BoardCard, CardCheckpoint } from "#/../shared/workspaces";
import { Button } from "#/components/ui/button";
import { useCopy } from "#/hooks/use-copy";
import { relativeTime } from "#/lib/relative-time";
import { useBoard } from "#/stores/board";

/** How often an open card re-asks where its agent stopped. */
const REFRESH_MS = 30_000;

/**
 * An agent's display name from its OAuth client slug, which varies:
 * `claude-code-lanework` → Claude Code.
 */
function agentName(slug: string): string {
  if (slug.startsWith("claude")) return "Claude Code";
  if (slug.startsWith("codex")) return "Codex";
  return slug;
}

const RESUMERS = [
  {
    key: "codex",
    label: "Codex",
    command: (id: string) => `codex "resume ${id}"`,
  },
  {
    key: "claude",
    label: "Claude Code",
    command: (id: string) => `claude "resume ${id}"`,
  },
] as const;

/**
 * Where the last agent on this card stopped, and how to hand it to the next
 * one: the checkpoint `get_review` gives an agent, shown to a person.
 *
 * - Nothing at all when there is no checkpoint. A card nobody handed over is
 *   the normal case, and an empty "no agent stopped here" box on every card
 *   would be noise about the absence of something rare.
 * - NOTE: Polled while the card is open, not driven by the change feed. A
 *   checkpoint never bumps the card's revision (BE-17), so the feed never
 *   says one arrived.
 */
export function IssueCheckpoint({ card }: { card: BoardCard }) {
  const workspaceId = useBoard((state) => state.active?.id ?? null);
  const [checkpoint, setCheckpoint] = useState<CardCheckpoint | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, copy] = useCopy();
  // "Show more" only when four lines actually cut the summary off; a toggle
  // that expands nothing is a click that teaches people to ignore it.
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  const summary = checkpoint?.summary;
  useLayoutEffect(() => {
    const el = summaryRef.current;
    if (!el || expanded || !summary) return;
    setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [summary, expanded]);

  useEffect(() => {
    const surface = window.desktop?.workspaces;
    if (!surface || !workspaceId) return;
    let cancelled = false;
    const load = () =>
      surface.board
        .checkpoint(workspaceId, card.id)
        // A hint beside the card: a failed read shows nothing, not an error.
        .catch(() => null)
        .then((next) => {
          if (cancelled) return;
          setCheckpoint(next);
          setNow(Date.now());
        });
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspaceId, card.id]);

  if (!checkpoint) return null;
  const id = card.taskId ?? card.id;
  const who = agentName(checkpoint.agent);

  return (
    <section
      aria-label="Where the last agent stopped"
      className="border-border flex flex-col gap-3 rounded-lg border p-3"
    >
      <div className="flex items-center gap-2 text-[13px]">
        <HugeiconsIcon
          icon={RoboticIcon}
          className="text-muted-foreground size-4 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <span className="font-medium">{who} stopped here</span>
        {/* The age behind a clock rather than a "·", as Summary has it. */}
        <span className="text-muted-foreground flex min-w-0 items-center gap-2">
          {checkpoint.host && (
            <span className="truncate">{checkpoint.host}</span>
          )}
          <span className="flex shrink-0 items-center gap-1">
            <HugeiconsIcon
              icon={Clock01Icon}
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            {relativeTime(checkpoint.createdAt, now)}
          </span>
        </span>
      </div>

      {checkpoint.nextStep && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs font-medium">
            Next step
            {checkpoint.nextStepFrom &&
              ` (from ${agentName(checkpoint.nextStepFrom.agent)}, ${relativeTime(checkpoint.nextStepFrom.createdAt, now)})`}
          </span>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {checkpoint.nextStep}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs font-medium">
          Summary
        </span>
        <p
          ref={summaryRef}
          className={
            expanded
              ? "text-muted-foreground text-[13px] leading-relaxed whitespace-pre-wrap"
              : "text-muted-foreground line-clamp-4 text-[13px] leading-relaxed whitespace-pre-wrap"
          }
        >
          {checkpoint.summary}
        </p>
        {(clipped || expanded) && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground self-start text-xs transition-colors"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>

      {checkpoint.git?.wipRef && (
        <p className="text-muted-foreground text-xs">
          Unfinished code is on{" "}
          <code className="font-mono">{checkpoint.git.wipRef}</code>.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {RESUMERS.map((resumer) => (
          <Button
            key={resumer.key}
            variant="outline"
            size="sm"
            onClick={() => copy(resumer.key, resumer.command(id))}
          >
            <HugeiconsIcon
              icon={copied === resumer.key ? Tick02Icon : Copy01Icon}
              className="size-3.5"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            {copied === resumer.key
              ? "Copied"
              : `Copy resume for ${resumer.label}`}
          </Button>
        ))}
      </div>
    </section>
  );
}
