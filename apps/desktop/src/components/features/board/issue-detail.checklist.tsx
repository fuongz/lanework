import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BoardCard, BoardChecklistItem } from "#/../shared/projects";
import { InlineMarkdown } from "#/components/shared/common/markdown-body";
import { Checkbox } from "#/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import { IssueStreams, StreamKey } from "./issue-streams";

export const SECTION_NAME: Record<string, string> = {
  decisions: "Decisions",
  verify: "Verify",
};

const ROW =
  "flex items-start gap-2.5 rounded-md text-[13px] leading-relaxed transition-colors duration-500 motion-reduce:transition-none";

/** How long the rows a move was refused over stay marked (FE-119/D3). */
const FLASH_MS = 2400;

/**
 * The checklist split into its sections, in the order they were written, each
 * carrying how far through it is.
 *
 * One function for the list and the rail's counters. A rail reading `3/7`
 * beside a section headed `4/7` is the kind of disagreement nobody thinks to
 * test for.
 */
export function sections(items: BoardChecklistItem[]) {
  return [...new Set(items.map((item) => item.section))].map((section) => {
    const rows = items.filter((item) => item.section === section);
    return {
      section,
      rows,
      done: rows.filter((item) => item.checked).length,
    };
  });
}

/**
 * The rows in the order they were written, with each "pick ONE" group
 * collapsed into a single run sitting where its first row did.
 *
 * NOTE: Collected by group name, not by adjacency. Rows of one group that are
 * not next to each other are still one choice, and splitting them into two
 * radio groups would let each half hold a ticked option.
 */
function alternatives(rows: BoardChecklistItem[]) {
  const runs: { group: string | null; items: BoardChecklistItem[] }[] = [];
  const seen = new Map<string, number>();
  for (const item of rows) {
    const at = item.group ? seen.get(item.group) : undefined;
    if (at !== undefined) {
      runs[at].items.push(item);
      continue;
    }
    if (item.group) seen.set(item.group, runs.length);
    runs.push({ group: item.group, items: [item] });
  }
  return runs;
}

/**
 * The open card's checklist as the person currently has it: the server's
 * ticks with the ticks still on their way laid over them, plus which keys
 * are in flight.
 *
 * Derived on every read, never stored. A box in flight reads as the person
 * left it, ticked by "a person" with no evidence, which is what the service
 * answers for a desktop tick; its answer then replaces the guess.
 */
export function useChecklistTicks(card: BoardCard | null) {
  const pendingTicks = useBoard((state) => state.pendingTicks);
  // A local board records no tick author (BE-22 is the service's), so a
  // guessed "a person" there would flash and vanish when the write answers.
  const attributes = useBoard((state) => state.active?.origin !== "local");
  return useMemo(() => {
    const items = card?.checklist ?? [];
    const pending = new Set<string>();
    if (!card || pendingTicks?.cardId !== card.id) return { items, pending };
    const next = items.map((item) => {
      const want = pendingTicks.checked[item.key]?.checked;
      if (want === undefined) return item;
      pending.add(item.key);
      const by =
        want && attributes ? ({ kind: "user", agent: null } as const) : null;
      if (
        want === item.checked &&
        (item.checkedBy?.kind ?? null) === (by?.kind ?? null)
      )
        return item;
      return {
        ...item,
        checked: want,
        checkedAt: want ? (item.checkedAt ?? new Date().toISOString()) : null,
        checkedBy: by,
        evidence: null,
      };
    });
    return { items: next, pending };
  }, [card, pendingTicks, attributes]);
}

/**
 * Under a ticked verify row: what proved it and who ticked it (BE-22).
 *
 * - Evidence: the command in mono, a pass or fail mark, and its run when
 *   there is a link.
 * - Who: the agent by slug (its honest name; an agent has no directory row),
 *   or "a person", which is every desktop tick and any tick from before BE-22.
 * - An agent's tick with no evidence says so: it is what keeps the card out
 *   of Review and Done.
 *
 * Outside the row's label, so the link is a link and not a click on the box.
 */
function ItemProof({ item }: { item: BoardChecklistItem }) {
  if (item.section !== "verify" || !item.checked) return null;
  const evidence = item.evidence ?? null;
  const by = item.checkedBy ?? null;
  const agent = by?.kind === "agent";
  if (!evidence && !by) return null;
  const who = agent ? (by.agent ?? "an agent") : "a person";
  return (
    <div className="text-muted-foreground mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      {evidence ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <HugeiconsIcon
            icon={evidence.ok ? CheckmarkCircle02Icon : Alert02Icon}
            className={cn(
              "size-3.5 shrink-0",
              evidence.ok
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400",
            )}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="sr-only">{evidence.ok ? "Passed:" : "Failed:"}</span>
          <code
            className="text-foreground/80 max-w-[48ch] truncate font-mono text-[11px]"
            title={evidence.command}
          >
            {evidence.command}
          </code>
          {evidence.url && (
            // Opens the OS browser, like every other run link here.
            <a
              href={evidence.url}
              target="_blank"
              rel="noreferrer"
              title={evidence.url}
              className="hover:text-foreground shrink-0 underline-offset-2 hover:underline"
            >
              Open run
            </a>
          )}
        </span>
      ) : (
        agent && (
          <span className="text-amber-600 dark:text-amber-400">
            No evidence
          </span>
        )
      )}
      {by && <span className="shrink-0">Ticked by {who}</span>}
    </div>
  );
}

/** One row's text: its key, the decision, and the note under it. */
function RowLabel({
  htmlFor,
  item,
}: {
  htmlFor: string;
  item: BoardChecklistItem;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <RowText htmlFor={htmlFor} item={item} />
      <ItemProof item={item} />
    </div>
  );
}

/** The row's label: key, stream, text and note. */
function RowText({
  htmlFor,
  item,
}: {
  htmlFor: string;
  item: BoardChecklistItem;
}) {
  return (
    // NOTE: `relative` keeps any absolutely placed child (an `sr-only` span
    // in the rendered markdown) inside the scrolled pane. Without a
    // positioned ancestor it is placed against the page, below the window's
    // bottom edge, and the whole app scrolls up under a grey band.
    <label htmlFor={htmlFor} className="relative cursor-pointer">
      <span className="text-muted-foreground mr-1.5 font-mono text-xs">
        {item.key}
      </span>
      {/* The stream this row proves; untagged rows are the lead's. */}
      {item.section === "verify" && item.stream && (
        <span className="mr-1.5 inline-flex align-[1px]">
          <StreamKey value={item.stream} />
        </span>
      )}
      {/* Rendered, not printed: cards are written in markdown, and a
          decision that reads `**Tool \`create_board\`**` as literal asterisks
          and backticks is noise around the one sentence being approved. */}
      <InlineMarkdown source={item.text} />
      {item.note && (
        <span className="text-muted-foreground mt-0.5 block text-xs">
          {item.note.split("\n").map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a note's lines are positional and never reorder.
            <span key={index} className="block">
              <InlineMarkdown source={line} />
            </span>
          ))}
        </span>
      )}
    </label>
  );
}

/**
 * The card's checklist, grouped the way it was written.
 *
 * NOTE: Rows sharing a `group` are alternatives (the board's "pick ONE"), so
 * they are a `RadioGroup`, not checkboxes. Independent boxes would let a
 * reader tick two options that contradict each other and believe both were
 * approved.
 */
export function Checklist({ card }: { card: BoardCard }) {
  const tick = useBoard((state) => state.tick);
  const pick = useBoard((state) => state.pick);
  const busy = useBoard((state) => state.busy);
  const view = useBoard((state) => state.view);
  const uid = useId();
  const { items } = useChecklistTicks(card);
  const stale = view?.stale ?? false;
  const focus = useBoard((state) => state.evidenceFocus);
  const clearFocus = useBoard((state) => state.clearEvidenceFocus);
  const list = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<readonly string[]>([]);

  // A move into Review or Done was refused over these boxes (FE-119/D3):
  // bring the first into view, put the keyboard on it, and mark them all for
  // a moment. Once, then the focus is spent.
  useEffect(() => {
    if (!focus || focus.cardId !== card.id || !items.length) return;
    clearFocus();
    const first = focus.keys.find((key) =>
      items.some((item) => item.key === key),
    );
    if (!first) return;
    const row = list.current?.querySelector<HTMLElement>(
      `[data-checklist-key="${CSS.escape(first)}"]`,
    );
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    row?.scrollIntoView({
      block: "center",
      behavior: reduced ? "auto" : "smooth",
    });
    row
      ?.querySelector<HTMLElement>("button, input")
      ?.focus({ preventScroll: true });
    setFlash(focus.keys);
  }, [focus, card.id, items, clearFocus]);

  useEffect(() => {
    if (!flash.length) return;
    const timer = window.setTimeout(() => setFlash([]), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  if (!items.length) return null;
  const rowClass = (key: string) =>
    cn(ROW, flash.includes(key) && "bg-tone-amber/15");

  // NOTE: Prefixed, not the bare `item.key`. Every card's checklist starts at
  // `D1`, and the detail pane is not the only thing on the page: a duplicated
  // id points a label at whichever box the document happens to hold first.
  const rowId = (item: BoardChecklistItem) => `${uid}-${item.key}`;
  // Ticks queue behind each other in the store, so a box stays live while
  // another one saves. Only a whole-checklist write (the hand-to-agent
  // approvals) holds every box still: a tick made then would land on the
  // revision that write is about to replace.
  const rowBusy = (_item: BoardChecklistItem) =>
    stale || busy === `${card.id}:checklist`;

  return (
    <div ref={list} className="flex flex-col gap-4">
      {sections(items).map(({ section, rows, done }) => {
        return (
          <section key={section} className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {SECTION_NAME[section] ?? section}
              </h2>
              <span className="text-muted-foreground text-xs tabular-nums">
                {done}/{rows.length}
              </span>
            </div>
            <ul className="flex flex-col gap-1.5">
              {alternatives(rows).map((run) => {
                const [first] = run.items;
                if (run.group === null)
                  return (
                    <li
                      key={first.key}
                      data-checklist-key={first.key}
                      className={rowClass(first.key)}
                    >
                      <Checkbox
                        // Saved the moment it is ticked, shown at once, put
                        // back if the service refuses it. Waiting for a Save
                        // button (FE-13/D7) left the row saying who ticked
                        // it before, until somebody pressed it.
                        id={rowId(first)}
                        checked={first.checked}
                        disabled={rowBusy(first)}
                        className="mt-0.5"
                        onCheckedChange={(checked) =>
                          void tick(card.id, first.key, checked)
                        }
                      />
                      <RowLabel htmlFor={rowId(first)} item={first} />
                    </li>
                  );
                return (
                  <li key={run.group}>
                    <RadioGroup
                      aria-label={run.group}
                      // NOTE: `null` while nothing is picked, never
                      // `undefined`. Base UI reads an undefined `value` as
                      // "uncontrolled", and the group would track a selection
                      // of its own instead of the one the server confirmed.
                      value={
                        run.items.find((item) => item.checked)?.key ?? null
                      }
                      disabled={rowBusy(first)}
                      className="gap-1.5"
                      onValueChange={(value) =>
                        void pick(
                          card.id,
                          run.items.map((item) => item.key),
                          String(value),
                        )
                      }
                    >
                      {run.items.map((item) => (
                        <div
                          key={item.key}
                          data-checklist-key={item.key}
                          className={rowClass(item.key)}
                        >
                          <RadioGroupItem
                            id={rowId(item)}
                            value={item.key}
                            disabled={rowBusy(item)}
                            className="mt-0.5"
                          />
                          <RowLabel htmlFor={rowId(item)} item={item} />
                        </div>
                      ))}
                    </RadioGroup>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** The streams, counted against the checklist exactly as the page shows it. */
export function WorkBreakdown({ card }: { card: BoardCard }) {
  const { items } = useChecklistTicks(card);
  return <IssueStreams card={card} items={items} />;
}
