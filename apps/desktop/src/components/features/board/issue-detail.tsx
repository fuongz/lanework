import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import type { BoardCard, BoardChecklistItem } from "#/../shared/workspaces";
import {
  CategoryDot,
  PriorityIcon,
  StatusIcon,
} from "#/components/shared/board/glyphs";
import {
  NONE,
  PRIORITY_LABEL,
  RAIL,
  RailValue,
  Row,
} from "#/components/shared/board/properties";
import {
  IssueDetailSkeleton,
  PropertiesSkeleton,
} from "#/components/shared/board/skeletons";
import { TagsInput } from "#/components/shared/board/tags-input";
import { ErrorState } from "#/components/shared/common/error-state";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Separator } from "#/components/ui/separator";
import { categoryOf, columnOf, subIssues } from "#/lib/board-view";
import { useBoard } from "#/stores/board";
import { MarkdownBody } from "./markdown-body";

export function IssueDetail() {
  const { slug, taskId } = useParams({ from: "/_app/w/$slug/issues/$taskId" });
  const openIssue = useBoard((state) => state.openIssue);
  const closeIssue = useBoard((state) => state.closeIssue);
  const card = useBoard((state) => state.detail);
  const loading = useBoard((state) => state.detailLoading);
  const error = useBoard((state) => state.detailError);
  const active = useBoard((state) => state.active);

  // ⚠️ Keyed on the workspace too. Opening `FE-06` in one project and then the
  // same id in another would otherwise reuse the first project's card while the
  // second was still loading.
  useEffect(() => {
    if (active?.id) void openIssue(taskId);
    return () => closeIssue();
  }, [active?.id, closeIssue, openIssue, taskId]);

  // ⚠️ Two panes side by side, each scrolling on its own — the shape the New
  // issue page already had. A card's properties are a fixed, short list; letting
  // them scroll away with a body that can run for pages meant the rail was off
  // screen exactly when a long card was being read.
  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* ⚠️ ABOVE the scroller, not sticky inside it. A sticky header is laid
            out in the scroll container's CONTENT box, which stops where the
            scrollbar gutter starts — so its `border-b` ended 10px short of the
            divider and left a notch in the line between the two panes. Out here
            the bar owns the pane's full width, and the scroll region starts
            under it instead of running behind it.

            This is what the header's `backdrop-blur` was for and why it is
            gone: nothing passes beneath this bar any more, so there was nothing
            left for it to filter. */}
        <header className="border-border flex h-11 shrink-0 items-center gap-2 border-b px-6">
          <Link
            to="/w/$slug/issues"
            params={{ slug }}
            search={{}}
            className="hover:bg-foreground/[0.05] -ml-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors"
          >
            <HugeiconsIcon
              icon={ArrowLeft02Icon}
              className="size-4"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            Issues
          </Link>
          <span className="text-muted-foreground font-mono text-xs">
            {taskId}
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && !card && <IssueDetailSkeleton />}
          {error && !card && (
            <ErrorState
              title="Could not open this card"
              message={error}
              onRetry={() => void openIssue(taskId)}
            />
          )}
          {card && <Article card={card} slug={slug} />}
        </div>
      </section>

      {/* ⚠️ The rail's frame is drawn before the card arrives, not with it. It
          is 288px of the window; mounting it on load would shove a body that
          had already been laid out and read. */}
      <aside
        aria-label="Card properties"
        className="border-border flex w-72 shrink-0 flex-col border-l"
      >
        {/* The rail's own header band, the same height as the one beside it, so
            the divider between the panels has one unbroken line to draw. */}
        <header className="border-border flex h-11 shrink-0 items-center border-b px-4">
          <span className="text-[13px] font-medium">Details</span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {card ? <Fields card={card} /> : !error && <PropertiesSkeleton />}
        </div>
      </aside>
    </div>
  );
}

function Article({ card, slug }: { card: BoardCard; slug: string }) {
  const view = useBoard((state) => state.view);
  const update = useBoard((state) => state.update);
  const stale = view?.stale ?? false;
  const [title, setTitle] = useState(card.title);

  // The server is the source of truth for this field; a title changed on
  // another machine has to win over an untouched draft here.
  useEffect(() => setTitle(card.title), [card.title]);

  const save = (patch: Parameters<typeof update>[1]) =>
    void update(card.id, patch, card.revision);

  const children = view ? subIssues(view.cards, card.id) : [];
  const parent = view?.cards.find((entry) => entry.id === card.parentId);

  return (
    <article className="flex min-w-0 flex-1 flex-col gap-5 px-6 py-6">
      {parent && (
        <Link
          to="/w/$slug/issues/$taskId"
          params={{ slug, taskId: parent.taskId ?? parent.id }}
          className="text-muted-foreground hover:text-foreground -mb-3 flex items-center gap-1.5 text-xs transition-colors"
        >
          <StatusIcon
            column={columnOf(view?.columns ?? [], parent.columnKey)}
          />
          {parent.taskId && <span className="font-mono">{parent.taskId}</span>}
          <span className="truncate">{parent.title}</span>
        </Link>
      )}
      <Input
        aria-label="Card title"
        value={title}
        maxLength={500}
        disabled={stale}
        // ⚠️ `dark:bg-transparent` as well as `bg-transparent`. The base Input
        // carries `dark:bg-input/30`, a DIFFERENT variant that class merging
        // does not cancel — so in dark mode this field kept a filled box that
        // light mode never showed.
        className="h-auto rounded-md border-0 bg-transparent px-1.5 text-xl font-semibold tracking-tight shadow-none transition-colors focus-visible:border-0 focus-visible:bg-foreground/[0.04] focus-visible:ring-0 md:text-xl dark:bg-transparent dark:focus-visible:bg-foreground/[0.06]"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          const next = title.trim();
          if (next && next !== card.title) save({ title: next });
          else setTitle(card.title);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setTitle(card.title);
        }}
      />
      <MarkdownBody source={card.body} />
      <Checklist card={card} />
      {children.length > 0 && (
        <section className="flex flex-col gap-1">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Sub-issues
          </h2>
          <ul className="flex flex-col">
            {children.map((child) => (
              <li key={child.id}>
                <Link
                  to="/w/$slug/issues/$taskId"
                  params={{ slug, taskId: child.taskId ?? child.id }}
                  className="hover:bg-foreground/[0.03] -mx-2 flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px]"
                >
                  <StatusIcon
                    column={columnOf(view?.columns ?? [], child.columnKey)}
                  />
                  {child.taskId && (
                    <span className="text-muted-foreground w-14 shrink-0 font-mono text-xs">
                      {child.taskId}
                    </span>
                  )}
                  <span className="truncate">{child.title}</span>
                  <PriorityIcon priority={child.priority} className="ml-auto" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

/**
 * A moment in the rail — the day AND the time of day.
 *
 * ⚠️ `toLocaleDateString` was all this used to show, and on a board where a card
 * is created and worked in the same afternoon, "Updated 9/9/2026" is the one
 * fact you already knew. `dateStyle: "medium"` also drops the 9/7 vs 7/9
 * ambiguity that a numeric date carries between locales.
 */
function Stamp({ value }: { value: string | null }) {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return <RailValue>—</RailValue>;
  return (
    <RailValue>
      {/* The rail is 288px wide, so the seconds and the timezone live in the
          tooltip rather than wrapping the row. */}
      <time dateTime={at.toISOString()} title={at.toString()}>
        {at.toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </time>
    </RailValue>
  );
}

/**
 * The card's properties, in the rail's own shape.
 *
 * ⚠️ Status, Priority, Category, Tags — the order the New issue page uses. The
 * two rails are read as one panel by anyone who creates a card and then opens
 * it, and a field that moves between them is a field they look for twice.
 */
function Fields({ card }: { card: BoardCard }) {
  const view = useBoard((state) => state.view);
  const update = useBoard((state) => state.update);
  const busy = useBoard((state) => state.busy);
  const stale = view?.stale ?? false;
  const writing = stale || busy === card.id;

  const save = (patch: Parameters<typeof update>[1]) =>
    void update(card.id, patch, card.revision);

  return (
    <>
      <Row label="Status">
        <StatusIcon column={columnOf(view?.columns ?? [], card.columnKey)} />
        <Select
          value={card.columnKey}
          onValueChange={(value) =>
            void useBoard.getState().move(card.id, value)
          }
        >
          <SelectTrigger
            size="sm"
            aria-label="Status"
            disabled={writing}
            className={RAIL}
          >
            <SelectValue>
              {(value: string) =>
                columnOf(view?.columns ?? [], value)?.name ?? value
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(view?.columns ?? []).map((column) => (
              <SelectItem key={column.key} value={column.key}>
                {column.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row label="Priority">
        <PriorityIcon priority={card.priority} />
        <Select
          value={card.priority ?? NONE}
          onValueChange={(value) =>
            save({
              priority:
                value === NONE ? null : (value as BoardCard["priority"]),
            })
          }
        >
          <SelectTrigger
            size="sm"
            aria-label="Priority"
            disabled={writing}
            className={RAIL}
          >
            <SelectValue>
              {(value: string) => PRIORITY_LABEL[value] ?? value}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No priority</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      <Row label="Category">
        <CategoryDot
          category={categoryOf(view?.categories ?? [], card.categoryKey)}
        />
        <Select
          value={card.categoryKey ?? NONE}
          onValueChange={(value) =>
            save({ categoryKey: value === NONE ? null : value })
          }
        >
          <SelectTrigger
            size="sm"
            aria-label="Category"
            disabled={writing}
            className={RAIL}
          >
            <SelectValue>
              {(value: string) =>
                value === NONE
                  ? "No category"
                  : (categoryOf(view?.categories ?? [], value)?.name ?? value)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {/* ⚠️ A sentinel, not `""`. An empty string is how a Select says
                "nothing is selected", so using it for the real choice "this
                card has no category" renders the trigger blank instead of
                saying so. */}
            <SelectItem value={NONE}>No category</SelectItem>
            {(view?.categories ?? []).map((category) => (
              <SelectItem key={category.key} value={category.key}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row label="Tags">
        {/* ⚠️ Disabled by `stale` ONLY, unlike the menus above it. Binding this
            to `busy` as well made the field go dead for the length of each
            round trip — and a disabled input blurs, so adding one tag took the
            caret out of the box you were about to type the next one in. A
            second tag entered before the first write lands can still lose the
            revision race; that is what the conflict banner is for, and it is a
            better trade than a field that stops accepting text every time it is
            used. */}
        <TagsInput
          tags={card.tags}
          disabled={stale}
          onChange={(tags) => save({ tags })}
        />
      </Row>

      {/* Facts, not fields — but read as the same table, so they keep the row. */}
      <Separator className="my-1.5" />
      {/* ⚠️ In the rail rather than only above the list. The rail is a pane of
          its own now, so this is the one place a card's progress stays on screen
          while a body that runs for pages is being read — which is the whole
          reason not to hide either section behind a tab. */}
      {sections(card.checklist ?? []).map(({ section, rows, done }) => (
        <Row key={section} label={SECTION_NAME[section] ?? section}>
          <RailValue>
            {done}/{rows.length}
          </RailValue>
        </Row>
      ))}
      <Row label="Created">
        <Stamp value={card.createdAt} />
      </Row>
      <Row label="Updated">
        <Stamp value={card.updatedAt} />
      </Row>
      {card.dueAt && (
        <Row label="Due">
          <Stamp value={card.dueAt} />
        </Row>
      )}
      {card.estimate !== null && (
        <Row label="Estimate">
          <RailValue>{card.estimate}</RailValue>
        </Row>
      )}
    </>
  );
}

const SECTION_NAME: Record<string, string> = {
  decisions: "Decisions",
  verify: "Verify",
};

const ROW = "flex items-start gap-2.5 text-[13px] leading-relaxed";

/**
 * The checklist split into its sections, in the order they were written, each
 * carrying how far through it is.
 *
 * ⚠️ One function for the list AND the rail's counters. They were two passes
 * over the same array for a while, and a rail reading `3/7` beside a section
 * headed `4/7` is the kind of disagreement nobody thinks to test for.
 */
function sections(items: BoardChecklistItem[]) {
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
 * The rows in the order they were written, with each "pick ONE" group collapsed
 * into a single run sitting where its first row did.
 *
 * ⚠️ Collected by group NAME, not by adjacency. Rows of one group that are not
 * next to each other are still one choice, and splitting them into two radio
 * groups would let each half hold a ticked option.
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

/** One row's text: its key, the decision, and the note under it. */
function RowLabel({
  htmlFor,
  item,
}: {
  htmlFor: string;
  item: BoardChecklistItem;
}) {
  return (
    <label htmlFor={htmlFor} className="cursor-pointer">
      <span className="text-muted-foreground mr-1.5 font-mono text-xs">
        {item.key}
      </span>
      {item.text}
      {item.note && (
        <span className="text-muted-foreground mt-0.5 block text-xs">
          {item.note}
        </span>
      )}
    </label>
  );
}

/**
 * The card's checklist, grouped the way it was written.
 *
 * ⚠️ Rows sharing a `group` are ALTERNATIVES — the board's "pick ONE" — so they
 * are a `RadioGroup`, not checkboxes. Rendering them as independent boxes would
 * let a reader tick two options that contradict each other and believe both
 * were approved.
 */
function Checklist({ card }: { card: BoardCard }) {
  const toggle = useBoard((state) => state.toggle);
  const busy = useBoard((state) => state.busy);
  const view = useBoard((state) => state.view);
  const uid = useId();
  const stale = view?.stale ?? false;
  const items = card.checklist;
  if (!items?.length) return null;

  // ⚠️ Prefixed, not the bare `item.key`. Every card's checklist starts at `D1`,
  // and the detail pane is not the only thing on the page — a duplicated id
  // points a label at whichever box the document happens to hold first.
  const rowId = (item: BoardChecklistItem) => `${uid}-${item.key}`;
  const rowBusy = (item: BoardChecklistItem) =>
    stale || busy === `${card.id}:${item.key}`;

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
                        // ⚠️ Controlled, so it does not flip until the server
                        // has confirmed. The one optimistic write in this app is
                        // a card's position while it is being dragged; an
                        // approval is never shown as saved before it is.
                        id={rowId(first)}
                        checked={first.checked}
                        disabled={rowBusy(first)}
                        className="mt-0.5"
                        onCheckedChange={(checked) =>
                          void toggle(
                            card.id,
                            first.key,
                            checked,
                            card.revision,
                          )
                        }
                      />
                      <RowLabel htmlFor={rowId(first)} item={first} />
                    </li>
                  );
                return (
                  <li key={run.group}>
                    <RadioGroup
                      aria-label={run.group}
                      // ⚠️ `null` while nothing is picked, never `undefined` —
                      // Base UI reads an undefined `value` as "uncontrolled" and
                      // the group would start tracking a selection of its own
                      // instead of the one the server confirmed.
                      value={
                        run.items.find((item) => item.checked)?.key ?? null
                      }
                      disabled={stale}
                      className="gap-1.5"
                      onValueChange={(value) =>
                        void toggle(card.id, String(value), true, card.revision)
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
