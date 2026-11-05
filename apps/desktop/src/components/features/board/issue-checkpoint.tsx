import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  RoboticIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BoardCard, CardCheckpoint } from "#/../shared/projects";
import { Button } from "#/components/ui/button";
import { useCopy } from "#/hooks/use-copy";
import { relativeTime } from "#/lib/relative-time";
import { cn } from "#/lib/utils";
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
  if (slug.startsWith("opencode")) return "OpenCode";
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
  {
    // OpenCode's TUI takes its first prompt as a flag, not an argument.
    key: "opencode",
    label: "OpenCode",
    command: (id: string) => `opencode --prompt "resume ${id}"`,
  },
] as const;

/**
 * Where the last agent on this card stopped, and how to hand it to the next
 * one: the checkpoint `get_review` gives an agent, shown to a person.
 *
 * - Compact by default: one header line, the next step as one emphasised
 *   line, the summary clamped to two. "Show more" opens both; "Details"
 *   folds the rest (files, branch, host, the resume commands). Nothing the
 *   checkpoint carries is dropped, only folded.
 * - A neutral left rule, no box: the same shape as "Changes requested" above
 *   the body, one weight lighter than the comments around it.
 * - Nothing at all when there is no checkpoint. A card nobody handed over is
 *   the normal case, and an empty "no agent stopped here" box on every card
 *   would be noise about the absence of something rare.
 * - NOTE: Polled while the card is open, not driven by the change feed. A
 *   checkpoint never bumps the card's revision (BE-17), so the feed never
 *   says one arrived.
 */
export function IssueCheckpoint({ card }: { card: BoardCard }) {
  const projectId = useBoard((state) => state.active?.id ?? null);
  const [checkpoint, setCheckpoint] = useState<CardCheckpoint | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, copy] = useCopy();
  // "Show more" only when the clamp actually cuts something off; a toggle
  // that expands nothing is a click that teaches people to ignore it.
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const nextRef = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  const summary = checkpoint?.summary;
  const nextStep = checkpoint?.nextStep;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the text changes
  useLayoutEffect(() => {
    if (expanded) return;
    const cut = (el: HTMLElement | null) =>
      !!el &&
      (el.scrollHeight > el.clientHeight + 1 ||
        el.scrollWidth > el.clientWidth + 1);
    setClipped(cut(summaryRef.current) || cut(nextRef.current));
  }, [summary, nextStep, expanded]);

  useEffect(() => {
    const surface = window.desktop?.projects;
    if (!surface || !projectId) return;
    let cancelled = false;
    const load = () =>
      surface.board
        .checkpoint(projectId, card.id)
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
  }, [projectId, card.id]);

  if (!checkpoint) return null;
  const id = card.taskId ?? card.id;
  const who = agentName(checkpoint.agent);
  const repo = checkpoint.git;
  const shortHead = repo?.head?.slice(0, 7);

  return (
    <section
      aria-label="Where the last agent stopped"
      className="border-border flex flex-col gap-1 border-l-2 pl-3"
    >
      <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
        <HugeiconsIcon
          icon={RoboticIcon}
          className="size-3.5 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="text-foreground truncate font-medium">
          {who} stopped here
        </span>
        <time
          dateTime={checkpoint.createdAt}
          title={new Date(checkpoint.createdAt).toString()}
          className="shrink-0"
        >
          {relativeTime(checkpoint.createdAt, now)}
        </time>
        <button
          type="button"
          aria-expanded={details}
          onClick={() => setDetails((open) => !open)}
          className="hover:text-foreground ml-auto flex shrink-0 items-center gap-1 transition-colors"
        >
          {/* The app's one disclosure arrow, as Sub-issues has it. */}
          <HugeiconsIcon
            icon={details ? ArrowDown01Icon : ArrowRight01Icon}
            className="size-3.5"
            strokeWidth={2}
            aria-hidden="true"
          />
          Details
        </button>
      </div>

      {nextStep && (
        <p
          ref={nextRef}
          title={expanded ? undefined : nextStep}
          className={cn(
            "text-[13px] leading-relaxed font-medium",
            expanded ? "whitespace-pre-wrap" : "truncate",
          )}
        >
          <span className="text-muted-foreground font-normal">Next: </span>
          {nextStep}
        </p>
      )}

      <p
        ref={summaryRef}
        className={cn(
          "text-muted-foreground text-[13px] leading-relaxed whitespace-pre-wrap",
          !expanded && "line-clamp-2",
        )}
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

      {details && (
        <dl className="text-muted-foreground mt-1 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-xs">
          {checkpoint.nextStepFrom && (
            <Detail term="Next step from">
              {agentName(checkpoint.nextStepFrom.agent)},{" "}
              {relativeTime(checkpoint.nextStepFrom.createdAt, now)}
            </Detail>
          )}
          {checkpoint.request && (
            <Detail term="Asked">
              <span className="whitespace-pre-wrap">{checkpoint.request}</span>
            </Detail>
          )}
          {checkpoint.host && <Detail term="Host">{checkpoint.host}</Detail>}
          {(repo?.branch || shortHead) && (
            <Detail term={repo?.branch ? "Branch" : "Commit"}>
              {repo?.branch && (
                <code className="mr-2 font-mono text-[11px]">
                  {repo.branch}
                </code>
              )}
              {shortHead && (
                <code
                  className="font-mono text-[11px]"
                  title={repo?.head ?? undefined}
                >
                  {shortHead}
                </code>
              )}
            </Detail>
          )}
          {repo?.wipRef && (
            <Detail term="Unfinished code">
              <code className="font-mono text-[11px]">{repo.wipRef}</code>
            </Detail>
          )}
          {checkpoint.files.length > 0 && (
            <Detail term="Files">
              <ul className="flex flex-col">
                {checkpoint.files.map((file) => (
                  <li
                    key={file}
                    className="truncate font-mono text-[11px]"
                    title={file}
                  >
                    {file}
                  </li>
                ))}
              </ul>
            </Detail>
          )}
          <Detail term="Resume">
            <ul className="flex flex-col">
              {RESUMERS.map((resumer) => {
                const command = resumer.command(id);
                const done = copied === resumer.key;
                return (
                  <li key={resumer.key} className="flex min-w-0 items-center">
                    <code
                      className="truncate font-mono text-[11px]"
                      title={command}
                    >
                      {command}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground ml-1 shrink-0"
                      aria-label={
                        done ? "Copied" : `Copy resume for ${resumer.label}`
                      }
                      title={done ? "Copied" : `Copy for ${resumer.label}`}
                      onClick={() => copy(resumer.key, command)}
                    >
                      <HugeiconsIcon
                        icon={done ? Tick02Icon : Copy01Icon}
                        className={cn(done && "text-tone-emerald")}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </Detail>
        </dl>
      )}
    </section>
  );
}

/** One row of the folded details: a muted term, then its value. */
function Detail({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="whitespace-nowrap">{term}</dt>
      <dd className="text-foreground/80 min-w-0">{children}</dd>
    </>
  );
}
