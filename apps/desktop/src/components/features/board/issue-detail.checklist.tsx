import { useId, useMemo } from "react";
import type { BoardCard, BoardChecklistItem } from "#/../shared/projects";
import { InlineMarkdown } from "#/components/shared/common/markdown-body";
import { Checkbox } from "#/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import { useBoard } from "#/stores/board";
import { IssueStreams, StreamKey } from "./issue-streams";

export const SECTION_NAME: Record<string, string> = {
  decisions: "Decisions",
  verify: "Verify",
};

const ROW = "flex items-start gap-2.5 text-[13px] leading-relaxed";

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
 * ticks with the unsaved draft laid over them, plus which keys differ.
 *
 * Derived on every read, never stored. A box the draft says "on" that a poll
 * shows is already on is not a change any more, and the Save button, the
 * marker and the leave prompt all agree about that without anyone pruning.
 */
export function useChecklistDraft(card: BoardCard | null) {
  const draft = useBoard((state) => state.draft);
  return useMemo(() => {
    const items = card?.checklist ?? [];
    const dirty = new Set<string>();
    if (!card || draft?.cardId !== card.id) return { items, dirty };
    const next = items.map((item) => {
      const want = draft.checked[item.key];
      if (want === undefined || want === item.checked) return item;
      dirty.add(item.key);
      return { ...item, checked: want };
    });
    return { items: next, dirty };
  }, [card, draft]);
}

/** One row's text: its key, the decision, and the note under it. */
function RowLabel({
  htmlFor,
  item,
  unsaved = false,
}: {
  htmlFor: string;
  item: BoardChecklistItem;
  unsaved?: boolean;
}) {
  return (
    // NOTE: `relative` is load-bearing. The `sr-only` text below is
    // `position: absolute`, and with no positioned ancestor it is placed
    // against the page at its row's offset inside the scrolled pane, below the
    // window's bottom edge. That makes the document taller than the window,
    // and the whole app scrolls up under a grey band.
    <label htmlFor={htmlFor} className="relative cursor-pointer">
      {/* A mark on the row, not only the Save button's count: on a card with
          thirty boxes, "3 changes" does not say which three. */}
      {unsaved && (
        <>
          <span
            aria-hidden="true"
            className="bg-tone-amber mr-1.5 inline-block size-1.5 -translate-y-px rounded-full align-middle"
            title="Not saved yet"
          />
          <span className="sr-only">Not saved yet: </span>
        </>
      )}
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
  const stageTick = useBoard((state) => state.stageTick);
  const stagePick = useBoard((state) => state.stagePick);
  const busy = useBoard((state) => state.busy);
  const view = useBoard((state) => state.view);
  const uid = useId();
  const { items, dirty } = useChecklistDraft(card);
  const stale = view?.stale ?? false;
  if (!items.length) return null;

  // NOTE: Prefixed, not the bare `item.key`. Every card's checklist starts at
  // `D1`, and the detail pane is not the only thing on the page: a duplicated
  // id points a label at whichever box the document happens to hold first.
  const rowId = (item: BoardChecklistItem) => `${uid}-${item.key}`;
  // While a save is running every box holds still: a tick made mid-save would
  // be neither in the request being sent nor safely in the draft after it.
  const rowBusy = (_item: BoardChecklistItem) =>
    stale || busy === `${card.id}:checklist`;

  return (
    <div className="flex flex-col gap-4">
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
                    <li key={first.key} className={ROW}>
                      <Checkbox
                        // A tick goes into the draft, not to the server
                        // (FE-13/D7): decisions are made as a set and sent
                        // with Save. The row's mark says it is not saved yet,
                        // so an approval is never shown as saved before it is.
                        id={rowId(first)}
                        checked={first.checked}
                        disabled={rowBusy(first)}
                        className="mt-0.5"
                        onCheckedChange={(checked) =>
                          stageTick(card.id, first.key, checked)
                        }
                      />
                      <RowLabel
                        htmlFor={rowId(first)}
                        item={first}
                        unsaved={dirty.has(first.key)}
                      />
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
                        stagePick(
                          card.id,
                          run.items.map((item) => item.key),
                          String(value),
                        )
                      }
                    >
                      {run.items.map((item) => (
                        <div key={item.key} className={ROW}>
                          <RadioGroupItem
                            id={rowId(item)}
                            value={item.key}
                            disabled={rowBusy(item)}
                            className="mt-0.5"
                          />
                          <RowLabel
                            htmlFor={rowId(item)}
                            item={item}
                            unsaved={dirty.has(item.key)}
                          />
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
  const { items } = useChecklistDraft(card);
  return <IssueStreams card={card} items={items} />;
}
