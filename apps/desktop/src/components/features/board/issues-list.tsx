import {
  Add01Icon,
  CheckListIcon,
  FilterIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GitHubIssue } from "#/../shared/git";
import {
  type BoardCard,
  type BoardView,
  matchesSearch,
} from "#/../shared/workspaces";
import { CardAgentsMark } from "#/components/shared/board/card-agents";
import { PriorityIcon, StatusIcon } from "#/components/shared/board/glyphs";
import { IssueMenu } from "#/components/shared/board/issue-menu";
import { RowBadge } from "#/components/shared/board/row-badge";
import { IssuesListSkeleton } from "#/components/shared/board/skeletons";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { ScrollArea } from "#/components/ui/scroll-area";
import {
  checklistProgress,
  columnOf,
  groupIssues,
  statusKeys,
} from "#/lib/board-view";
import { type IssueSearch, parseIssueSearch } from "#/lib/issue-search";
import { relativeTime } from "#/lib/relative-time";
import { useBoard } from "#/stores/board";
import { listOf, useGitHubIssues } from "#/stores/github-issues";
import {
  GitHubIssueRow,
  GitHubIssuesProblemState,
  GitHubIssuesSkeleton,
} from "../github-issues/github-issue-row";
import { LoadMore } from "./load-more";
import { ViewToolbar } from "./view-toolbar";

/** One row j/k can land on: a card by its task id, or a GitHub issue. */
type Entry = { kind: "card"; taskId: string } | { kind: "gh"; number: number };

/**
 * What the board is read grouped by.
 *
 * The list is not grouped, but the service still reads one page per status,
 * so that is the grouping it is asked for.
 */
const GROUP_BY = "status";

/** One row of the list, with the time it is sorted by. */
type Row =
  | { kind: "card"; card: BoardCard; at: number }
  | { kind: "gh"; issue: GitHubIssue; at: number };

/** An ISO time as a number to sort by; 0 for one that is missing. */
const stamp = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
};

const entryKey = (entry: Entry) =>
  entry.kind === "card" ? `card:${entry.taskId}` : `gh:${entry.number}`;

/**
 * Whether a key press belongs to something else on screen.
 *
 * j and k are letters, so a field or an editor gets them first. A menu, a
 * listbox or a dialog gets the arrows.
 */
function ownedElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], .cm-editor, [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]',
    ) !== null
  );
}

/** One card as a two-line row: where it stands, then what it is. */
function CardRow({
  card,
  view,
  slug,
  search,
  now,
}: {
  card: BoardCard;
  view: BoardView;
  slug: string;
  search: IssueSearch;
  now: number;
}) {
  const column = columnOf(view.columns, card.columnKey);
  // How far through its checklist the card is: only while it is being
  // worked on, and only when it has a checklist. Before work starts it is 0%
  // and after it ends 100%, which the status already says.
  const progress = checklistProgress(card);
  const done =
    column?.role === "active" && progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null;
  return (
    // NOTE: The menu renders the `li` rather than wrapping it: a `ul` whose
    // children are divs reports the wrong number of items to a screen reader.
    <IssueMenu card={card} render={<li />}>
      <Link
        to="/w/$slug/issues/$taskId"
        params={{ slug, taskId: card.taskId ?? card.id }}
        // The list's filters ride along, so opening a card keeps the list.
        search={search}
        disabled={!card.taskId}
        activeOptions={{ includeSearch: false }}
        activeProps={{ className: "bg-foreground/[0.06]" }}
        className={`${RAIL_ROW} group focus-visible:ring-accent-brand relative flex flex-col gap-1 rounded-lg px-3 py-2.5 outline-none focus-visible:ring-2 aria-disabled:cursor-default`}
      >
        {/* Two lines, the shape every row in this list shares: where it
            stands, then what it is. A card in progress adds a third. */}
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <PriorityIcon priority={card.priority} />
          <RowBadge className="max-w-[60%]">
            {/* While an agent works on the card, its presence takes the
                status icon's place. */}
            <CardAgentsMark card={card}>
              <StatusIcon column={column} />
            </CardAgentsMark>
            <span className="truncate">{column?.name ?? "Issue"}</span>
          </RowBadge>
          {card.taskId && <RowBadge>{card.taskId}</RowBadge>}
          <span className="ml-auto shrink-0 pl-2 tabular-nums">
            {relativeTime(card.updatedAt ?? card.createdAt, now)}
          </span>
        </span>
        <span className="truncate text-[13px] group-data-[status=active]:font-medium">
          {card.title}
        </span>
        {done !== null && (
          // A third line only while the card is being worked on: how far
          // through its checklist it is, as one small badge.
          <span className="flex">
            <RowBadge>
              <span
                className="flex items-center gap-1 tabular-nums"
                title={`${progress?.done} of ${progress?.total} checked`}
              >
                <HugeiconsIcon
                  icon={CheckListIcon}
                  className="size-3"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                {done}%
              </span>
            </RowBadge>
          </span>
        )}
      </Link>
    </IssueMenu>
  );
}

/**
 * The issue list: the board's cards by group, then the repo's GitHub issues.
 *
 * - The board's filters (status, category, priority, tag) cut the cards
 *   only. A GitHub issue has none of those fields (FE-75/D5a).
 * - The search box cuts both.
 * - j/k and ↑/↓ move the selection down the rows as drawn: cards, then
 *   GitHub issues, skipping folded groups (FE-75/D8).
 */
export function IssuesList() {
  const { slug } = useParams({ from: "/_app/w/$slug/issues" });
  // NOTE: Parsed again, not used as read. A match's search also carries the
  // raw keys of the page beside the list (New issue's prefill, an old
  // `?view=board`), and the list's links would carry them along.
  const raw = useSearch({ from: "/_app/w/$slug/issues" });
  const search = useMemo(() => parseIssueSearch(raw), [raw]);
  const selected = useParams({ strict: false }) as {
    taskId?: string;
    number?: string;
  };
  const navigate = useNavigate();
  const view = useBoard((state) => state.view);
  const loading = useBoard((state) => state.loading);
  const setQuery = useBoard((state) => state.setQuery);
  const github = useGitHubIssues((state) => listOf(state, slug));
  const [query, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // The URL is the board's query (FE-17): the service reads one page per
  // group, under these filters, so changing either is a new read, not a new
  // filter over the cards already here.
  //
  // NOTE: Status is not sent. The board is read one page per status anyway,
  // and the status filter is a set of lanes, so it picks among the groups that
  // came back rather than asking the service for one.
  const { category, priority, tag } = search;
  useEffect(
    () =>
      setQuery(slug, {
        groupBy: GROUP_BY,
        filters: { category, priority, tag },
      }),
    [setQuery, slug, category, priority, tag],
  );

  const onSearch = (next: IssueSearch) =>
    void navigate({
      to: ".",
      search: next,
      replace: true,
    });

  // Ages are measured from when each list was read, not from now. A row that
  // says "2h" next to a badge saying the copy is from this morning would be
  // two clocks disagreeing on one screen.
  const now = view ? new Date(view.fetchedAt).getTime() : Date.now();
  const githubNow = github.view
    ? new Date(github.view.fetchedAt).getTime()
    : Date.now();

  const needle = query.trim();
  const groups = useMemo(() => {
    if (!view) return [];
    const lanes = statusKeys(view.columns, search.status);
    return groupIssues(view, GROUP_BY, {
      ...search,
      status: lanes.length ? lanes.join(",") : "none",
    }).map((group) => ({
      ...group,
      cards: needle
        ? group.cards.filter((card) => matchesSearch(card, needle))
        : group.cards,
    }));
  }, [view, search, needle]);
  const issues = useMemo(() => {
    const all = github.view?.issues ?? [];
    return needle
      ? all.filter((issue) =>
          matchesSearch(
            { title: issue.title, taskId: String(issue.number) },
            needle,
          ),
        )
      : all;
  }, [github.view, needle]);

  // NOTE: The service's counts when it sent them. A group holds one page of
  // its cards, and counting those would say "20" for 226. A search is the
  // exception: it only sees the cards that are here.
  const counts = needle ? undefined : view?.stats?.byColumn;
  // "No cards yet" is about the board, not the page of it on screen.
  const emptyBoard = view ? (view.total ?? view.cards.length) === 0 : false;

  // One list, newest activity first, cards and GitHub issues mixed. The row's
  // first line already says which is which, so a header per group would only
  // push the work further down.
  const rows = useMemo(() => {
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const group of groups)
      for (const card of group.cards) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        out.push({
          kind: "card",
          card,
          at: stamp(card.updatedAt ?? card.createdAt),
        });
      }
    for (const issue of issues)
      out.push({ kind: "gh", issue, at: stamp(issue.updatedAt) });
    return out.sort((left, right) => right.at - left.at);
  }, [groups, issues]);

  const entries: Entry[] = [];
  for (const row of rows) {
    if (row.kind === "gh")
      entries.push({ kind: "gh", number: row.issue.number });
    else if (row.card.taskId)
      entries.push({ kind: "card", taskId: row.card.taskId });
  }

  // The groups the service has more of, read together by one Load more.
  const more = groups.filter(
    (group) =>
      view?.groups?.[group.key]?.cursor &&
      statusKeys(view.columns, search.status).includes(group.key),
  );
  const left = more.reduce(
    (sum, group) =>
      sum + Math.max((counts?.[group.key] ?? 0) - group.cards.length, 0),
    0,
  );

  const current: string | null = selected.taskId
    ? `card:${selected.taskId}`
    : selected.number
      ? `gh:${selected.number}`
      : null;

  const go = (entry: Entry) =>
    void navigate(
      entry.kind === "card"
        ? {
            to: "/w/$slug/issues/$taskId",
            params: { slug, taskId: entry.taskId },
            search,
          }
        : {
            to: "/w/$slug/issues/gh/$number",
            params: { slug, number: String(entry.number) },
            search,
          },
    );

  // j/k anywhere a letter is not being typed; the arrows only while the list
  // or nothing has focus, so they still scroll the issue being read.
  const keys = useRef({ entries, current, go });
  keys.current = { entries, current, go };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const down = event.key === "j" || event.key === "ArrowDown";
      const up = event.key === "k" || event.key === "ArrowUp";
      if (!down && !up) return;
      if (ownedElsewhere(event.target)) return;
      if (event.key.startsWith("Arrow")) {
        const focus = document.activeElement;
        const inList = scrollRef.current?.contains(focus) ?? false;
        if (!inList && focus && focus !== document.body) return;
      }
      const { entries, current, go } = keys.current;
      if (!entries.length) return;
      const at = entries.findIndex((entry) => entryKey(entry) === current);
      const next =
        at === -1
          ? down
            ? 0
            : entries.length - 1
          : Math.min(entries.length - 1, Math.max(0, at + (down ? 1 : -1)));
      if (next === at) return;
      event.preventDefault();
      go(entries[next]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The selected row is kept in view as j/k walk past the edge. `nearest`
  // leaves the scroll alone whenever the row is already on screen.
  useEffect(() => {
    if (!current) return;
    const row = scrollRef.current?.querySelector("[aria-current]");
    row?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const nothing = view && rows.length === 0 && !github.loading;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ViewToolbar
        slug={slug}
        search={search}
        onSearch={onSearch}
        query={query}
        onQuery={setText}
      />
      {/* The scroller is this area, not the list: the list stays mounted
          while issues open beside it, so its scroll survives every switch.
          Its bar floats over the rows, so the rows keep their width. */}
      <ScrollArea viewportRef={scrollRef} className="flex-1">
        <RailHover backgroundClassName="rounded-lg bg-foreground/[0.03]">
          {!view && loading && <IssuesListSkeleton />}
          {nothing && (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon
                    icon={emptyBoard ? Add01Icon : FilterIcon}
                    strokeWidth={1.8}
                  />
                </EmptyMedia>
                {/* An empty board and an empty result have different ways
                  out: one wants a card, the other wants the filter
                  loosened. */}
                <EmptyTitle>
                  {emptyBoard ? "No cards yet" : "No matches"}
                </EmptyTitle>
                <EmptyDescription>
                  {emptyBoard
                    ? "Create one with New issue (⌘N)."
                    : needle
                      ? `No card matches “${needle}”.`
                      : "Try fewer filters."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {rows.length > 0 && (
            <ul className="flex flex-col gap-0.5 px-2">
              {rows.map((row) =>
                row.kind === "card" && view ? (
                  <CardRow
                    key={`card:${row.card.id}`}
                    card={row.card}
                    view={view}
                    slug={slug}
                    search={search}
                    now={now}
                  />
                ) : row.kind === "gh" ? (
                  <GitHubIssueRow
                    key={`gh:${row.issue.number}`}
                    issue={row.issue}
                    now={githubNow}
                    selected={current === `gh:${row.issue.number}`}
                    onSelect={() =>
                      go({ kind: "gh", number: row.issue.number })
                    }
                  />
                ) : null,
              )}
            </ul>
          )}
          {/* A search only looks through what is already read, so it does
              not offer to read more. */}
          {!needle && more.length > 0 && (
            <div className="px-2 py-1">
              <LoadMore groups={more.map((group) => group.key)} left={left} />
            </div>
          )}
          {!github.view && github.loading && <GitHubIssuesSkeleton rows={2} />}
          {/* A project with no folder or no GitHub remote has no GitHub
              issues to read, and saying so on every open would be noise. */}
          {!github.view &&
            !github.loading &&
            github.problem &&
            github.problem.kind !== "no-folder" &&
            github.problem.kind !== "not-github" && (
              <GitHubIssuesProblemState
                slug={slug}
                problem={github.problem}
                className="py-6"
              />
            )}
          {github.view && github.problem && (
            // A failed re-read over a list already here: said, not drawn over
            // the issues somebody is reading.
            <p className="text-destructive px-4 py-1.5 text-xs/relaxed">
              {github.problem.kind === "failed"
                ? github.problem.message
                : "Could not refresh GitHub issues."}
            </p>
          )}
        </RailHover>
      </ScrollArea>
    </div>
  );
}
