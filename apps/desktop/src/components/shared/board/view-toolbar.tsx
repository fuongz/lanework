import {
  Add01Icon,
  CloudSavingDone01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
// ⚠️ `shared/` importing `features/` is legal and deliberate: the buckets
// encode how many importers a file has, not a layering. This toolbar has two
// consumers, the filter bar has one — and moving the filter bar up here to
// "fix" the edge would just relocate a file nobody else reads.
import { FilterBar } from "#/components/features/board/filter-bar";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { GROUP_BY, type GroupBy } from "#/lib/board-view";
import type { IssueSearch } from "#/lib/issue-search";
import { useBoard } from "#/stores/board";

const when = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? "an unknown time"
    : at.toLocaleTimeString();
};

/**
 * An input with no chrome of its own, and none on focus either.
 *
 * ⚠️ The ring is removed, NOT the focus indicator. A field that draws a box
 * around itself the moment you click it is exactly the chrome a borderless
 * field exists to avoid — but focus still has to be visible, so a faint ground
 * takes over the job. Dropping both would leave a keyboard user with nothing.
 */
export const BORDERLESS_INPUT =
  "h-7 rounded-md border-0 bg-transparent px-1.5 text-[13px] shadow-none transition-colors focus-visible:border-0 focus-visible:bg-foreground/[0.04] focus-visible:ring-0 md:text-[13px] dark:bg-transparent dark:focus-visible:bg-foreground/[0.06]";

const GROUP_LABEL: Record<GroupBy, string> = {
  status: "Status",
  category: "Category",
  priority: "Priority",
};

/**
 * How fresh the board is.
 *
 * ⚠️ Two states with two different glyphs and two different words, never one
 * string with a separator in it. "Nothing here" and "I could not ask" look
 * identical on screen otherwise, and somebody who trusts an empty board starts
 * typing a card that already exists.
 */
function Freshness({ stale, at }: { stale: boolean; at: string }) {
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
      {stale ? (
        <HugeiconsIcon
          icon={CloudSavingDone01Icon}
          className="text-tone-amber size-3.5"
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ) : (
        <span
          aria-hidden="true"
          className="bg-tone-emerald size-1.5 rounded-full"
        />
      )}
      <span>{stale ? "Saved copy" : "Live"}</span>
      <span className="tabular-nums opacity-70">{when(at)}</span>
    </span>
  );
}

/**
 * The bar every board view wears: what it is, how it is cut, and how fresh.
 *
 * ⚠️ `grouping` is optional because the lanes view has exactly one sensible
 * grouping — its lanes — and offering "group by priority" on a screen whose
 * columns ARE the status would be a control that contradicts the picture.
 */
export function ViewToolbar({
  title,
  search,
  onSearch,
  grouping = true,
}: {
  title: string;
  search: IssueSearch;
  onSearch: (next: IssueSearch) => void;
  grouping?: boolean;
}) {
  const view = useBoard((state) => state.view);
  const loading = useBoard((state) => state.loading);
  const busy = useBoard((state) => state.busy);
  const reload = useBoard((state) => state.reload);
  const createCard = useBoard((state) => state.createCard);
  const [draft, setDraft] = useState("");

  return (
    <div className="border-border flex shrink-0 flex-col gap-2 border-b px-6 pt-4 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-[15px] font-semibold tracking-tight">
          {title}
        </h1>

        {grouping && (
          <Select
            value={search.group ?? "status"}
            onValueChange={(value) =>
              onSearch({ ...search, group: value as GroupBy })
            }
          >
            {/* ⚠️ `size="default"` is what makes this 28px. The `sm` variant
                sets its height through a `data-[size=sm]` variant, which a
                plain `h-7` in `className` cannot override — the trigger stayed
                24px beside a 28px Filter button, and the two read as different
                kinds of control. */}
            <SelectTrigger
              size="default"
              aria-label="Group by"
              className="gap-1.5 text-xs"
            >
              <span className="text-muted-foreground">Group</span>
              {/* ⚠️ A formatter, not a bare `SelectValue`. Left to itself it
                  renders the item's VALUE — the trigger read "status" where the
                  menu it opens says "Status". */}
              <SelectValue>
                {(value: string) => GROUP_LABEL[value as GroupBy] ?? value}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {GROUP_BY.map((option) => (
                <SelectItem key={option} value={option}>
                  {GROUP_LABEL[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <FilterBar search={search} onSearch={onSearch} />

        {view && <Freshness stale={view.stale} at={view.fetchedAt} />}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Refresh board"
          disabled={loading}
          onClick={() => void reload()}
        >
          <HugeiconsIcon
            icon={Refresh01Icon}
            className="size-4"
            strokeWidth={1.5}
          />
        </Button>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const title = draft.trim();
          if (!title) return;
          setDraft("");
          // ⚠️ Title only, deliberately. This is the one-line quick-add; the
          // fields a card needs to be findable — category above all — live on
          // the New issue page, which the ⊕ button beside this field opens.
          void createCard({ title });
        }}
      >
        <HugeiconsIcon
          icon={Add01Icon}
          className="text-muted-foreground size-4 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <Input
          aria-label="New card title"
          placeholder="Add a card…"
          value={draft}
          // ⚠️ 200, the service's own `MAX_TITLE`. This said 500, so a longer
          // title typed here was refused at the far end of a round trip by a
          // guard that had already capped it at 200 on the way out.
          maxLength={200}
          disabled={view?.stale || busy === "create"}
          className={BORDERLESS_INPUT}
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>
    </div>
  );
}
