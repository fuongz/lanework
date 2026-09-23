/**
 * The properties rail's shared parts — used by the card that exists and the one
 * being written.
 *
 * ⚠️ These lived inside `issue-detail.tsx` until the New issue page needed the
 * same four fields. Copying them would have been the worse half of the trade:
 * two rails for one set of properties drift apart a field at a time, and the
 * page where a card is CREATED disagreeing with the page where it is EDITED is
 * the drift a person notices first.
 */

/**
 * The value that means "this field is deliberately empty".
 *
 * ⚠️ A sentinel, not `""`. An empty string is how a Select says "nothing is
 * selected", so using it for the real choice "this card has no category" renders
 * the trigger blank instead of saying so.
 */
export const NONE = "__none__";

export const PRIORITY_LABEL: Record<string, string> = {
  [NONE]: "No priority",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/**
 * One row of the properties panel: what it is on the left, what it says on the
 * right.
 *
 * ⚠️ Label BESIDE the value, not above it. A panel of eight stacked label/value
 * pairs is twice as tall as the same panel read as a table, and this one has to
 * sit beside a document. The detail page kept the stacked shape — uppercase
 * label over a filled box — for a while, which is precisely the drift this file
 * exists to stop.
 */
export function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2 px-1">
      <span className="text-muted-foreground w-20 shrink-0 text-xs">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

/**
 * A rail control: no ground until you point at it.
 *
 * ⚠️ The chevron is hidden. A Select that draws one on a row whose value is
 * already a menu is chrome for its own sake; the row lights up on hover, which
 * is what says "this is a control" without a permanent arrow in every row.
 */
export const RAIL =
  // ⚠️ `dark:bg-transparent` and `dark:hover:` as well as the plain ones. The
  // base trigger carries `dark:bg-input/30` and `dark:hover:bg-input/50`, which
  // are DIFFERENT variants — class merging does not cancel them — so without
  // these the rail kept a filled box per row in dark mode only.
  "h-7 w-full justify-start rounded-md border-0 bg-transparent px-1.5 text-[13px] shadow-none transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-accent-brand dark:bg-transparent dark:hover:bg-foreground/[0.06] [&>svg:last-child]:hidden";

/**
 * A read-only fact in the rail, aligned to the text of the controls above it.
 *
 * ⚠️ `tabular-nums`. Everything that lands here is numeric — a date, a count —
 * and proportional digits make a column of them look kerned by hand.
 */
export function RailValue({ children }: { children: React.ReactNode }) {
  return <span className="px-1.5 text-[13px] tabular-nums">{children}</span>;
}
