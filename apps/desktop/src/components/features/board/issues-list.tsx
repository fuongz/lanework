import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  FilterIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { CardAgentsMark } from "#/components/shared/board/card-agents";
import {
  CategoryDot,
  ChecklistProgress,
  Fraction,
  PriorityIcon,
  StatusIcon,
} from "#/components/shared/board/glyphs";
import { IssueMenu } from "#/components/shared/board/issue-menu";
import { LoadMore } from "#/components/shared/board/load-more";
import { IssuesListSkeleton } from "#/components/shared/board/skeletons";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  categoryOf,
  columnOf,
  groupIssues,
  shortAge,
  subIssueProgress,
} from "#/lib/board-view";
import { useBoard } from "#/stores/board";

export function IssuesList() {
  const { slug } = useParams({ from: "/_app/w/$slug/issues/" });
  const search = useSearch({ from: "/_app/w/$slug/issues/" });
  const view = useBoard((state) => state.view);
  const loading = useBoard((state) => state.loading);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // ⚠️ Ages are measured from when the board was READ, not from now. A row that
  // says "2h" next to a badge that says the copy is from this morning would be
  // two clocks disagreeing on the same screen.
  const now = view ? new Date(view.fetchedAt).getTime() : Date.now();

  const groupBy = search.group ?? "status";
  const groups = view ? groupIssues(view, groupBy, search) : [];
  // ⚠️ The SERVICE's counts when it sent them (FE-17): a group holds one page
  // of its cards, and the header counting those would say "20" for 226.
  const counts =
    groupBy === "status"
      ? view?.stats?.byColumn
      : groupBy === "priority"
        ? view?.stats?.byPriority
        : view?.stats?.byCategory;
  // "No cards yet" is about the BOARD, not the page of it on screen.
  const empty = view ? (view.total ?? view.cards.length) === 0 : false;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!view && loading && <IssuesListSkeleton />}
        {view && groups.every((group) => group.cards.length === 0) && (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon
                  icon={empty ? Add01Icon : FilterIcon}
                  strokeWidth={1.8}
                />
              </EmptyMedia>
              {/* ⚠️ An empty BOARD and an empty RESULT are different situations
                  with different ways out: one wants a card, the other wants the
                  filter loosened. One sentence for both would be advice that is
                  wrong half the time. */}
              <EmptyTitle>{empty ? "No cards yet" : "No matches"}</EmptyTitle>
              <EmptyDescription>
                {/* The quick-add field that "above" pointed at is gone; New
                    issue is the way in now. */}
                {empty
                  ? "Create one with New issue (⌘N)."
                  : "Try fewer filters."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {groups.map((group) => {
          const count = counts?.[group.key] ?? group.cards.length;
          // Finished work starts folded away: it is the largest lane on any
          // board that has been running a while, and the least often read.
          const shut =
            collapsed[group.key] ??
            (group.role === "done" || group.role === "archive");
          if (!group.cards.length) return null;
          return (
            <section key={group.key}>
              <button
                type="button"
                aria-expanded={!shut}
                onClick={() =>
                  setCollapsed((state) => ({ ...state, [group.key]: !shut }))
                }
                className="bg-background/95 hover:bg-foreground/[0.03] sticky top-0 z-10 flex h-9 w-full items-center gap-2 pr-6 pl-3 text-left backdrop-blur"
              >
                <HugeiconsIcon
                  icon={shut ? ArrowRight01Icon : ArrowDown01Icon}
                  className="text-muted-foreground size-3.5"
                  strokeWidth={2}
                  aria-hidden="true"
                />
                {search.group === undefined || search.group === "status" ? (
                  <StatusIcon
                    column={columnOf(view?.columns ?? [], group.key)}
                  />
                ) : null}
                <span className="text-[13px] font-medium">{group.name}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {count}
                </span>
              </button>
              {!shut && (
                <ul>
                  {group.cards.map((card) => {
                    const subs = view
                      ? subIssueProgress(view.cards, card.id, view.columns)
                      : null;
                    return (
                      // ⚠️ The menu RENDERS the `li` rather than wrapping it: a
                      // `ul` whose children are divs is a list that reports the
                      // wrong number of items to a screen reader.
                      <IssueMenu key={card.id} card={card} render={<li />}>
                        <Link
                          to="/w/$slug/issues/$taskId"
                          params={{ slug, taskId: card.taskId ?? card.id }}
                          disabled={!card.taskId}
                          className="hover:bg-foreground/[0.03] focus-visible:ring-accent-brand flex h-8 items-center gap-2.5 px-6 text-[13px] outline-none focus-visible:ring-2 focus-visible:-ring-offset-1 aria-disabled:cursor-default"
                        >
                          <CardAgentsMark card={card}>
                            <StatusIcon
                              column={columnOf(
                                view?.columns ?? [],
                                card.columnKey,
                              )}
                            />
                          </CardAgentsMark>
                          {card.taskId && (
                            <span className="text-muted-foreground w-14 shrink-0 font-mono text-xs">
                              {card.taskId}
                            </span>
                          )}
                          <span className="truncate">{card.title}</span>
                          <span className="ml-auto flex shrink-0 items-center gap-2.5">
                            {card.tags.slice(0, 2).map((tag) => (
                              <span
                                key={tag}
                                className="bg-foreground/[0.05] text-muted-foreground rounded px-1.5 py-0.5 text-[11px]"
                              >
                                {tag}
                              </span>
                            ))}
                            {card.categoryKey && (
                              <CategoryDot
                                category={categoryOf(
                                  view?.categories ?? [],
                                  card.categoryKey,
                                )}
                              />
                            )}
                            {subs && (
                              <Fraction
                                done={subs.done}
                                total={subs.total}
                                title={`${subs.done} of ${subs.total} sub-issues done`}
                              />
                            )}
                            <ChecklistProgress card={card} />
                            <PriorityIcon priority={card.priority} />
                            <span className="text-muted-foreground w-7 text-right text-xs tabular-nums">
                              {shortAge(card.updatedAt ?? card.createdAt, now)}
                            </span>
                          </span>
                        </Link>
                      </IssueMenu>
                    );
                  })}
                  <li className="px-3 empty:hidden">
                    <LoadMore
                      group={group.key}
                      loaded={group.cards.length}
                      count={count}
                      label={group.name}
                    />
                  </li>
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
