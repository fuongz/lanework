import { Add01Icon, FilterIcon, GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BoardCard,
  type BoardView,
  matchesSearch,
} from "#/../shared/projects";
import { CardAgentsMark } from "#/components/shared/board/card-agents";
import {
  PriorityIcon,
  ProgressRing,
  StatusIcon,
} from "#/components/shared/board/glyphs";
import { IssueMenu } from "#/components/shared/board/issue-menu";
import { PRIORITY_LABEL } from "#/components/shared/board/properties";
import { IssuesListSkeleton } from "#/components/shared/board/skeletons";
import { ListGroupHeader } from "#/components/shared/navigation/list-group-header";
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
import { relativeTime, shortAge } from "#/lib/relative-time";
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

/**
 * The lanes in the order the list draws them: the work under way first,
 * then what is next, then what is over.
 */
const ROLE_ORDER = ["active", "start", "intake", null, "done", "archive"];
const roleRank = (role: string | null) => {
  const at = ROLE_ORDER.indexOf(role);
  return at === -1 ? ROLE_ORDER.indexOf(null) : at;
};
/** Lanes that start folded: what is finished is rarely what is looked for. */
const FOLDED_ROLES = new Set(["done", "archive"]);

const GITHUB_GROUP = "github";

/**
 * One card as two lines: its lane's mark and what it is, then its id,
 * priority, checklist and age in quiet text under the title.
 */
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
  const progress = checklistProgress(card);
  const counted = progress && progress.total > 0 ? progress : null;
  const mark =
    column?.role === "active" && counted ? (
      <ProgressRing column={column} done={counted.done} total={counted.total} />
    ) : (
      <StatusIcon column={column} />
    );
  const pad = (n: number) => String(n).padStart(2, "0");
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
        className={`${RAIL_ROW} group focus-visible:ring-accent-brand relative flex flex-col gap-0.5 rounded-lg px-3 py-2 outline-none focus-visible:ring-2 aria-disabled:cursor-default`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {/* While an agent works on the card, its presence takes the
              mark's place. */}
          <CardAgentsMark card={card}>{mark}</CardAgentsMark>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {card.title}
          </span>
        </span>
        {/* Under the title, set apart by space rather than pills or "·". */}
        <span className="text-muted-foreground flex min-w-0 items-center gap-3 ps-[22px] text-xs">
          {card.taskId && (
            <span className="shrink-0 tabular-nums">{card.taskId}</span>
          )}
          {card.priority && (
            <span className="flex shrink-0 items-center gap-1">
              <PriorityIcon priority={card.priority} className="size-3" />
              {PRIORITY_LABEL[card.priority]}
            </span>
          )}
          {counted && (
            <span
              className="shrink-0 tabular-nums"
              title={`${counted.done} of ${counted.total} checked`}
            >
              {pad(counted.done)}/{pad(counted.total)}
            </span>
          )}
          <span
            className="ml-auto shrink-0 tabular-nums"
            title={relativeTime(card.updatedAt ?? card.createdAt, now)}
          >
            {shortAge(card.updatedAt ?? card.createdAt, now)}
          </span>
        </span>
      </Link>
    </IssueMenu>
  );
}

/**
 * The issue list: the board's cards grouped by lane, then the repo's GitHub
 * issues as a group of their own.
 *
 * - Lanes under way first (In Progress, To-Do), done and archived last and
 *   folded until opened. Newest activity first within each.
 * - The board's filters (status, category, priority, tag) cut the cards
 *   only. A GitHub issue has none of those fields (FE-75/D5a).
 * - The search box cuts both, and hides a group left empty.
 * - j/k and ↑/↓ move the selection down the rows as drawn, skipping folded
 *   groups (FE-75/D8).
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

  // Folded or open, by group key; unset follows the lane (done and archive
  // start folded).
  const [fold, setFold] = useState<Record<string, boolean>>({});
  const isOpen = (key: string, role: string | null) =>
    fold[key] ?? !FOLDED_ROLES.has(role ?? "");
  const toggle = (key: string, role: string | null) =>
    setFold((state) => ({ ...state, [key]: !isOpen(key, role) }));

  // The lanes under way first, each newest activity first. A search keeps a
  // lane only while something in it matches.
  const lanes = useMemo(() => {
    if (!view) return [];
    const shown = statusKeys(view.columns, search.status);
    return groups
      .filter((group) => shown.includes(group.key))
      .map((group) => ({
        ...group,
        cards: [...group.cards].sort(
          (left, right) =>
            stamp(right.updatedAt ?? right.createdAt) -
            stamp(left.updatedAt ?? left.createdAt),
        ),
      }))
      .filter((group) => group.cards.length > 0)
      .sort((left, right) => roleRank(left.role) - roleRank(right.role));
  }, [view, groups, search.status]);
  const ghIssues = useMemo(
    () => [...issues].sort((l, r) => stamp(r.updatedAt) - stamp(l.updatedAt)),
    [issues],
  );
  const ghOpen = fold[GITHUB_GROUP] ?? true;

  // j/k walk the rows as drawn, past folded groups (FE-75/D8).
  const entries: Entry[] = [];
  for (const lane of lanes)
    if (isOpen(lane.key, lane.role))
      for (const card of lane.cards)
        if (card.taskId) entries.push({ kind: "card", taskId: card.taskId });
  if (ghOpen)
    for (const issue of ghIssues)
      entries.push({ kind: "gh", number: issue.number });

  /** The cards a lane has on the service and not on screen, if it pages. */
  const leftIn = (key: string, shown: number) =>
    view?.groups?.[key]?.cursor
      ? Math.max((counts?.[key] ?? 0) - shown, 0)
      : null;

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

  const nothing =
    view && lanes.length === 0 && ghIssues.length === 0 && !github.loading;

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
          <div className="flex flex-col gap-3 px-2 pb-2">
            {lanes.map((lane) => {
              const open = isOpen(lane.key, lane.role);
              const left = needle ? null : leftIn(lane.key, lane.cards.length);
              return (
                <section key={lane.key} aria-label={lane.name}>
                  <ListGroupHeader
                    name={lane.name}
                    count={counts?.[lane.key] ?? lane.cards.length}
                    open={open}
                    onToggle={() => toggle(lane.key, lane.role)}
                    icon={
                      <StatusIcon
                        column={columnOf(view?.columns ?? [], lane.key)}
                        className="size-3"
                      />
                    }
                  />
                  {open && view && (
                    <ul className="flex flex-col gap-0.5">
                      {lane.cards.map((card) => (
                        <CardRow
                          key={card.id}
                          card={card}
                          view={view}
                          slug={slug}
                          search={search}
                          now={now}
                        />
                      ))}
                    </ul>
                  )}
                  {/* A search only looks through what is already read, so
                      it does not offer to read more. */}
                  {open && left !== null && (
                    <LoadMore groups={[lane.key]} left={left} />
                  )}
                </section>
              );
            })}
            {(ghIssues.length > 0 || (!github.view && github.loading)) && (
              <section aria-label="GitHub issues">
                <ListGroupHeader
                  name="GitHub"
                  count={ghIssues.length}
                  open={ghOpen}
                  onToggle={() =>
                    setFold((state) => ({ ...state, [GITHUB_GROUP]: !ghOpen }))
                  }
                  icon={
                    <HugeiconsIcon
                      icon={GithubIcon}
                      className="size-3 shrink-0"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  }
                />
                {ghOpen && ghIssues.length > 0 && (
                  <ul className="flex flex-col gap-0.5">
                    {ghIssues.map((issue) => (
                      <GitHubIssueRow
                        key={issue.number}
                        issue={issue}
                        now={githubNow}
                        selected={current === `gh:${issue.number}`}
                        onSelect={() =>
                          go({ kind: "gh", number: issue.number })
                        }
                      />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
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
