import { UnfoldLessIcon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import type {
  PermissionAnswer,
  PermissionRequest,
} from "#/../shared/conversation";
import { PermissionCard } from "#/components/features/conversation/permission-card";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

/** How far each card behind the front one rises, in px. */
const PEEK = 8;
/** How much each card behind the front one shrinks. */
const SHRINK = 0.04;
/** Cards that peek behind the front one; older ones wait unseen. */
const PEEKING = 2;
/** Room for a card's shadow outside its clip, in px. */
const SHADOW = 48;

const MOTION =
  "duration-[220ms] ease-out motion-reduce:transition-none motion-reduce:duration-0";

/**
 * Every request the CLI is waiting on, as one stacked toast above the prompt.
 *
 * The newest card stands in front, its Input open; up to two older ones
 * peek out above it, smaller and fainter, out of reach. They are answered
 * one at a time: the stack never spreads out, and answering the front card
 * brings the next one forward, its Input open in turn. One request draws
 * exactly the card it always did.
 */
export function PermissionStack({
  requests,
  agent,
  onAnswer,
}: {
  /** Oldest first: the last one is the front card. */
  requests: PermissionRequest[];
  /** Who asks, by name: Claude, Codex or OpenCode. */
  agent: string;
  onAnswer: (id: string, answer: PermissionAnswer) => Promise<void>;
}) {
  const stack = useRef<HTMLDivElement>(null);
  /** Show all: the stack spread out, every card answerable. */
  const [all, setAll] = useState(false);
  /** Each card's own height, unclipped and untransformed. */
  const [heights, setHeights] = useState<Record<string, number>>({});

  const count = requests.length;
  const stacked = count > 1;
  const ids = requests.map((request) => request.id).join("\n");
  // Measured again on folding back: spread out, no card was observed.
  const spreadOut = all && requests.length > 1;

  // Read every card's height before paint, then again whenever one changes
  // (Input opened, the next question), so the cards behind keep their place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `spreadOut` re-observes the cards once the stack folds back.
  useLayoutEffect(() => {
    const root = stack.current;
    if (!root) return;
    const cards = ids
      .split("\n")
      .map((id) =>
        root.querySelector<HTMLElement>(
          `:scope > [data-request="${CSS.escape(id)}"]`,
        ),
      )
      .filter((card): card is HTMLElement => card !== null);
    const read = () => {
      const next: Record<string, number> = {};
      for (const card of cards)
        next[card.dataset.request ?? ""] = card.offsetHeight;
      setHeights((previous) => {
        const keys = Object.keys(next);
        const same =
          keys.length === Object.keys(previous).length &&
          keys.every((key) => previous[key] === next[key]);
        return same ? previous : next;
      });
    };
    read();
    const observer = new ResizeObserver(read);
    for (const card of cards) observer.observe(card);
    return () => observer.disconnect();
  }, [ids, spreadOut]);

  if (count === 0) return null;

  // Show all: every request at once, one under another, each answerable.
  const spread = spreadOut;
  const header = stacked ? (
    <>
      {count} pending
      <Button
        variant="secondary"
        size="sm"
        aria-expanded={spread}
        onClick={() => setAll(!spread)}
        className="h-6 rounded-full px-2.5 text-xs"
      >
        <HugeiconsIcon
          icon={spread ? UnfoldLessIcon : UnfoldMoreIcon}
          strokeWidth={1.8}
          data-icon="inline-start"
          aria-hidden="true"
        />
        {spread ? "Collapse" : "Show all"}
      </Button>
    </>
  ) : undefined;

  if (spread)
    return (
      <section
        aria-label="Permission requests"
        // Taller than the window allows, the list scrolls, its newest last.
        className="-mx-2 -mt-2 -mb-4 flex max-h-[60vh] flex-col gap-2 overflow-y-auto px-2 pt-2 pb-4"
      >
        {requests.map((request, index) => (
          <div key={request.id} className="rounded-xl shadow-xs">
            <PermissionCard
              request={request}
              agent={agent}
              onAnswer={onAnswer}
              inputOpen={false}
              pending={index === count - 1 ? header : undefined}
            />
          </div>
        ))}
      </section>
    );

  const height = (depth: number) =>
    heights[requests[count - 1 - depth]?.id ?? ""] ?? 0;
  const front = height(0);
  const reserve = PEEK * Math.min(count - 1, PEEKING);

  const place = (depth: number): CSSProperties => {
    const own = height(depth);
    if (depth === 0)
      return {
        zIndex: count,
        transform: "translateY(0px) scale(1)",
        clipPath: `inset(-${SHADOW}px)`,
        opacity: 1,
      };
    const step = Math.min(depth, PEEKING);
    return {
      zIndex: count - depth,
      // Its top edge PEEK px above the front card's, a little narrower.
      transform: `translateY(${own - front - PEEK * step}px) scale(${1 - SHRINK * step})`,
      // No taller than the front card, so only the sliver above it shows.
      clipPath: `inset(-${SHADOW}px -${SHADOW}px ${Math.max(0, own - front)}px -${SHADOW}px)`,
      opacity: depth > PEEKING ? 0 : 1,
    };
  };

  return (
    <section aria-label="Permission requests" className="flex flex-col">
      {/* NOTE: Every card is bottom-anchored and the box takes the front
          card's height, measured. Were the front card in the flow and the
          others absolute, the next one would change its positioning as it
          came forward, and jump by the height difference before sliding. */}
      <div
        ref={stack}
        className={cn("relative transition-[height]", MOTION)}
        style={stacked && front > 0 ? { height: reserve + front } : undefined}
      >
        {requests.map((request, index) => {
          const depth = count - 1 - index;
          const hidden = stacked && depth > 0;
          return (
            <div
              key={request.id}
              data-request={request.id}
              data-front={depth === 0 || undefined}
              inert={hidden}
              aria-hidden={hidden || undefined}
              // The composer's shadow: it stands where the prompt is.
              className={cn(
                "rounded-xl shadow-xs",
                stacked && [
                  "origin-top transition-[transform,opacity,clip-path]",
                  MOTION,
                  // In the flow only until the front card is measured.
                  depth === 0 && front === 0
                    ? "relative"
                    : "absolute inset-x-0 bottom-0",
                ],
              )}
              style={stacked ? place(depth) : undefined}
            >
              <PermissionCard
                request={request}
                agent={agent}
                onAnswer={onAnswer}
                // The card to answer now shows what it would run.
                inputOpen={depth === 0}
                pending={depth === 0 ? header : undefined}
              />
              {stacked && (
                // Fades a card behind toward the page, without letting the
                // ones further back show through it.
                <span
                  aria-hidden="true"
                  className={cn(
                    "bg-background pointer-events-none absolute inset-0 rounded-2xl transition-opacity",
                    MOTION,
                  )}
                  style={{
                    opacity: 0.2 * Math.min(depth, PEEKING),
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
