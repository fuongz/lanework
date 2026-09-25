import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Attachment01Icon,
  File01Icon,
  GitBranchIcon,
  Link01Icon,
  MoreHorizontalIcon,
  StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useBlocker, useParams } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  BoardAttachment,
  BoardCard,
  BoardChecklistItem,
  BoardMember,
} from "#/../shared/workspaces";
import {
  CategoryDot,
  PriorityIcon,
  StatusIcon,
} from "#/components/shared/board/glyphs";
import { DeleteIssueDialog } from "#/components/shared/board/issue-menu";
import { LabelChip } from "#/components/shared/board/label-chip";
import { LabelPicker } from "#/components/shared/board/label-picker";
import { Avatar, memberOf } from "#/components/shared/board/people";
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
import { ErrorState } from "#/components/shared/common/error-state";
import {
  InlineMarkdown,
  MarkdownBody,
} from "#/components/shared/common/markdown-body";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
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
import {
  categoryOf,
  columnOf,
  subIssueProgress,
  subIssues,
} from "#/lib/board-view";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import { IssueActivity } from "./issue-activity";

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

  // ⚠️ Leaving with unsaved ticks asks first (FE-13/D7). The draft is only in
  // this window's memory; a click on the breadcrumb or a ⌘K jump would drop
  // decisions somebody had just made without a word.
  const dirty = useChecklistDraft(card).dirty.size > 0;
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

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
            under it instead of running behind it. */}
        <header className="border-border flex h-11 shrink-0 items-center gap-1 border-b pe-6 ps-[max(1.5rem,var(--titlebar-clear,0px))]">
          <Link
            to="/w/$slug/issues"
            params={{ slug }}
            search={{}}
            className="hover:bg-foreground/[0.05] -ml-2 flex h-7 min-w-0 items-center rounded-md px-2 text-[13px] transition-colors"
          >
            <span className="truncate">{active?.name ?? "Issues"}</span>
          </Link>
          <span className="text-muted-foreground shrink-0 text-[13px]">›</span>
          <span className="text-muted-foreground shrink-0 px-1 font-mono text-xs">
            {taskId}
          </span>
          {card && <HeaderActions card={card} />}
        </header>
        <AlertDialog
          open={blocker.status === "blocked"}
          onOpenChange={(open) => {
            if (!open) blocker.reset?.();
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard changes?</AlertDialogTitle>
              <AlertDialogDescription>
                The ticks you made on {taskId} have not been saved. Leaving now
                drops them.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                className="border-0"
                onClick={() => blocker.proceed?.()}
              >
                Discard
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

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
        <header className="border-border flex h-11 shrink-0 items-center gap-1 border-b px-4">
          <span className="text-muted-foreground font-mono text-xs">
            {card?.taskId ?? taskId}
          </span>
          {card && <RailActions card={card} />}
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {card ? <Fields card={card} /> : !error && <PropertiesSkeleton />}
        </div>
      </aside>
    </div>
  );
}

/**
 * Put something on the clipboard and say so, briefly.
 *
 * ⚠️ The confirmation is the whole feature. A copy button that looks identical
 * before and after being pressed is one people press twice, and then paste
 * whatever was there before.
 */
function useCopy(): [string | null, (key: string, value: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return [
    copied,
    (key, value) => {
      void navigator.clipboard.writeText(value).then(
        () => setCopied(key),
        // A clipboard that refuses is not worth an error banner over a card;
        // the button simply does not confirm, which is the honest signal.
        () => setCopied(null),
      );
    },
  ];
}

/**
 * The branch name a card would be worked on.
 *
 * ⚠️ Derived from the task id and the title, not from the card's uuid. The point
 * is a branch a human reads — `be-06-issue-detail-activity` — and one carrying a
 * uuid tells nobody what it is for.
 */
function branchName(card: BoardCard): string {
  const words = card.title
    .toLowerCase()
    .normalize("NFD")
    // Marks only: this strips the accents off a Vietnamese title rather than
    // the letters, so "Kết nối git" becomes `ket-noi-git` and not `k-t-n-i-git`.
    .replace(/\p{M}+/gu, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  const prefix = card.taskId?.toLowerCase();
  return [prefix, words].filter(Boolean).join("-") || card.id;
}

/** The star and the `…` beside the breadcrumb. */
function HeaderActions({ card }: { card: BoardCard }) {
  const setFavorite = useBoard((state) => state.setFavorite);
  const stale = useBoard((state) => state.view?.stale ?? false);
  const busy = useBoard((state) => state.busy);
  const saveDraft = useBoard((state) => state.saveDraft);
  const discardDraft = useBoard((state) => state.discardDraft);
  const [confirming, setConfirming] = useState(false);
  const changes = useChecklistDraft(card).dirty.size;
  const saving = busy === `${card.id}:checklist`;

  // ⌘S saves, the way every editor this sits beside does.
  useEffect(() => {
    if (!changes) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!stale && !saving) void saveDraft();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changes, saveDraft, saving, stale]);

  return (
    <>
      {/* ⚠️ `favorite === null` means nobody asked — a list read. It draws
          nothing rather than an empty star, which would invite a click that
          silently means the opposite of what it looks like. */}
      {card.favorite !== null && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={
            card.favorite ? "Remove from favorites" : "Add to favorites"
          }
          aria-pressed={card.favorite}
          onClick={() => void setFavorite(card.id, !card.favorite)}
        >
          <HugeiconsIcon
            icon={StarIcon}
            className={
              card.favorite
                ? "text-tone-amber size-4"
                : "text-muted-foreground size-4"
            }
            // A filled star and an outline of one are the same glyph at two
            // weights; colour alone would not survive being read without it.
            strokeWidth={card.favorite ? 2.5 : 1.8}
          />
        </Button>
      )}
      {/* ⚠️ Only while there IS something to save (FE-13/D7). A Save button
          that is always there, greyed out, reads as "this page has unsaved
          state somewhere" — the one thing it must never say when it is false. */}
      <div className="ml-auto flex items-center gap-1">
        {changes > 0 && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={discardDraft}
            >
              Discard
            </Button>
            <Button
              size="sm"
              disabled={stale || saving}
              onClick={() => void saveDraft()}
            >
              {saving
                ? "Saving…"
                : `Save ${changes === 1 ? "change" : `${changes} changes`}`}
            </Button>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Issue actions"
                className="size-7"
              />
            }
          >
            <HugeiconsIcon
              icon={MoreHorizontalIcon}
              className="text-muted-foreground size-4"
              strokeWidth={1.8}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              variant="destructive"
              // Off while the board is a saved copy, like every other write: a
              // delete that appeared to work offline would be a card gone from
              // this screen and still on everybody else's.
              disabled={stale || busy === card.id}
              onClick={() => setConfirming(true)}
            >
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <DeleteIssueDialog
        card={card}
        open={confirming}
        onOpenChange={setConfirming}
      />
    </>
  );
}

/**
 * The two copy buttons at the top of the rail.
 *
 * ⚠️ Neither of them copies a URL, and that is deliberate. This app registers no
 * deep-link scheme, so a "copy link" would hand somebody a string that opens
 * nothing. The issue id is what people actually say to each other and what every
 * agent tool takes; the branch name is what the id is for next.
 */
function RailActions({ card }: { card: BoardCard }) {
  const [copied, copy] = useCopy();
  const id = card.taskId;
  return (
    <div className="ml-auto flex items-center gap-0.5">
      {id && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Copy issue id ${id}`}
          title={copied === "id" ? "Copied" : `Copy ${id}`}
          onClick={() => copy("id", id)}
        >
          <HugeiconsIcon
            icon={Link01Icon}
            className={
              copied === "id"
                ? "text-tone-emerald size-4"
                : "text-muted-foreground size-4"
            }
            strokeWidth={1.8}
          />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Copy branch name"
        title={copied === "branch" ? "Copied" : branchName(card)}
        onClick={() => copy("branch", branchName(card))}
      >
        <HugeiconsIcon
          icon={GitBranchIcon}
          className={
            copied === "branch"
              ? "text-tone-emerald size-4"
              : "text-muted-foreground size-4"
          }
          strokeWidth={1.8}
        />
      </Button>
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

  const parent = view?.cards.find((entry) => entry.id === card.parentId);

  // Whether the title has scrolled up to the header and is sitting under it.
  // A marker where the title starts in the page: once it is out of view, the
  // title is stuck. The marker sits ABOVE the title, so the title growing or
  // shrinking cannot move it and flip the answer back.
  const titleMark = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const mark = titleMark.current;
    if (!mark) return;
    const watch = new IntersectionObserver(([entry]) =>
      setStuck(entry ? !entry.isIntersecting : false),
    );
    watch.observe(mark);
    return () => watch.disconnect();
  }, []);

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
      {/* `-mb-5` cancels the article's gap: the marker takes no room. */}
      <div ref={titleMark} aria-hidden="true" className="-mb-5 h-0" />
      {/* ⚠️ Row two under the header once the page scrolls: the title stays
          in view, smaller, over frosted glass — the page showing through,
          blurred, as the app's popovers do. It is its own row rather than
          part of the header, so the header keeps one height on every
          screen. */}
      <div
        data-stuck={stuck || undefined}
        className="bg-background/70 sticky top-0 z-10 -mx-6 px-6 py-1.5 backdrop-blur-xl backdrop-saturate-150"
      >
        <Input
          aria-label="Card title"
          value={title}
          maxLength={500}
          disabled={stale}
          // ⚠️ `dark:bg-transparent` as well as `bg-transparent`. The base Input
          // carries `dark:bg-input/30`, a DIFFERENT variant that class merging
          // does not cancel — so in dark mode this field kept a filled box that
          // light mode never showed.
          className={cn(
            "h-auto rounded-md border-0 bg-transparent px-1.5 font-semibold tracking-tight shadow-none transition-[color,background-color,font-size] duration-150 focus-visible:border-0 focus-visible:bg-foreground/[0.04] focus-visible:ring-0 dark:bg-transparent dark:focus-visible:bg-foreground/[0.06]",
            stuck ? "text-[15px] md:text-[15px]" : "text-xl md:text-xl",
          )}
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
      </div>
      <MarkdownBody source={card.body} />
      <Attachments card={card} />
      <Checklist card={card} />
      <SubIssues card={card} slug={slug} />
      <IssueActivity card={card} />
    </article>
  );
}

/** `5.11 MB` — a file size as a person reads one. */
function fileSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

/**
 * The files a card refers to.
 *
 * ⚠️ METADATA and a reference — the service stores no bytes and serves none, so
 * there is nothing here to download. A row states what was recorded and copies
 * the reference, which is the most this can honestly offer until content
 * hosting is its own feature.
 */
function Attachments({ card }: { card: BoardCard }) {
  const [copied, copy] = useCopy();
  const files = card.attachments;
  if (!files?.length) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      {files.map((file) => (
        <AttachmentRow
          key={file.id}
          file={file}
          copied={copied === file.id}
          onCopy={() => copy(file.id, file.reference)}
        />
      ))}
    </ul>
  );
}

function AttachmentRow({
  file,
  copied,
  onCopy,
}: {
  file: BoardAttachment;
  copied: boolean;
  onCopy: () => void;
}) {
  const size = fileSize(file.sizeBytes);
  return (
    <li>
      <button
        type="button"
        onClick={onCopy}
        title={file.reference}
        className="border-border hover:bg-foreground/[0.03] flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors"
      >
        <HugeiconsIcon
          icon={File01Icon}
          className="text-muted-foreground size-5 shrink-0"
          strokeWidth={1.5}
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px]">{file.name}</span>
          <span className="text-muted-foreground truncate text-xs">
            {copied
              ? "Reference copied"
              : [size, file.mimeType].filter(Boolean).join(", ") ||
                file.reference}
          </span>
        </span>
        <HugeiconsIcon
          icon={Attachment01Icon}
          className="text-muted-foreground ml-auto size-4 shrink-0"
          strokeWidth={1.5}
        />
      </button>
    </li>
  );
}

/**
 * The cards filed under this one.
 *
 * ⚠️ Collapsible, and collapsed state is remembered PER CARD in this session
 * only. A card with fourteen sub-issues pushes its own activity off the screen;
 * a card with two does not, and one preference applied to both would be wrong
 * for one of them every time.
 */
function SubIssues({ card, slug }: { card: BoardCard; slug: string }) {
  const view = useBoard((state) => state.view);
  const [collapsed, setCollapsed] = useState(false);
  const children = view ? subIssues(view.cards, card.id) : [];
  const progress = view
    ? subIssueProgress(view.cards, card.id, view.columns)
    : null;
  if (!children.length) return null;

  const members = view?.members ?? [];
  const labels = view?.labels ?? [];

  return (
    <section className="border-border flex flex-col gap-1 rounded-lg border p-2">
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs font-medium transition-colors"
        >
          {/* The same disclosure arrow the issue list folds its groups with.
              One gesture, one glyph — a second shape for "this collapses" is a
              second thing to learn. */}
          <HugeiconsIcon
            icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
            className="size-3.5"
            strokeWidth={2}
            aria-hidden="true"
          />
          Sub-issues
        </button>
        {progress && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {progress.done}/{progress.total}
          </span>
        )}
      </div>
      {!collapsed && (
        <ul className="flex flex-col">
          {children.map((child) => (
            <li key={child.id}>
              <Link
                to="/w/$slug/issues/$taskId"
                params={{ slug, taskId: child.taskId ?? child.id }}
                className="hover:bg-foreground/[0.03] flex h-9 items-center gap-2.5 rounded-md px-2 text-[13px]"
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
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {/* Two at most: a row is not a place to read six labels, and
                      the card's own page is one click away. */}
                  {child.tags.slice(0, 2).map((tag) => (
                    <LabelChip key={tag} tag={tag} labels={labels} />
                  ))}
                  <PriorityIcon priority={child.priority} />
                  {/* ⚠️ `assignees` is null on a board read — every card here
                      came from one — so this draws the unassigned outline
                      rather than claiming nobody is on it. */}
                  <Avatar
                    member={memberOf(members, child.assignees?.users[0])}
                    size="sm"
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
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
 * Who the card is on.
 *
 * ⚠️ Writes BOTH lists every time, because the service replaces the whole set.
 * Sending only `users` would clear every agent assignment as a side effect of
 * naming a person — and the agents on a card are how work is dispatched.
 */
function AssigneeRow({
  card,
  members,
  disabled,
  onChange,
}: {
  card: BoardCard;
  members: BoardMember[];
  disabled: boolean;
  onChange: (users: string[]) => void;
}) {
  const users = card.assignees?.users ?? [];
  const on = new Set(users);
  const first = memberOf(members, users[0]);
  const label =
    users.length === 0
      ? "Unassigned"
      : users.length === 1
        ? (first?.name ?? users[0])
        : `${first?.name ?? users[0]} +${users.length - 1}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="hover:bg-foreground/[0.06] focus-visible:ring-accent-brand flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors focus-visible:ring-2 disabled:opacity-50"
      >
        <Avatar member={first} size="sm" />
        <span className="truncate">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem closeOnClick={false} onClick={() => onChange([])}>
          <Avatar size="sm" />
          Unassigned
        </DropdownMenuItem>
        {members.map((member) => (
          <DropdownMenuItem
            key={member.userId}
            // Three people on one card is one task; a menu that shut after each
            // would make it three.
            closeOnClick={false}
            onClick={() =>
              onChange(
                on.has(member.userId)
                  ? users.filter((id) => id !== member.userId)
                  : [...users, member.userId],
              )
            }
          >
            <Avatar member={member} size="sm" />
            <span className="truncate">{member.name}</span>
            {on.has(member.userId) && (
              <span className="text-muted-foreground ml-auto text-xs">✓</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The card's properties, in the rail's own shape.
 *
 * ⚠️ Status, Priority, Assignee, Labels — the order the design draws, and the
 * order the New issue page follows. The two rails are read as one panel by
 * anyone who creates a card and then opens it, and a field that moves between
 * them is a field they look for twice.
 *
 * ⚠️ Category stays, though the design has no such row: it is what MINTS a
 * card's task id. Dropping it to match a screenshot would take `BE-06` with it.
 */
function Fields({ card }: { card: BoardCard }) {
  const checklist = useChecklistDraft(card).items;
  const view = useBoard((state) => state.view);
  const update = useBoard((state) => state.update);
  const busy = useBoard((state) => state.busy);
  const stale = view?.stale ?? false;
  const writing = stale || busy === card.id;
  const members = view?.members ?? [];
  const labels = view?.labels ?? [];

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

      <Row label="Assignee">
        <AssigneeRow
          card={card}
          members={members}
          disabled={writing}
          onChange={(users) =>
            save({
              assignees: { users, agents: card.assignees?.agents ?? [] },
            })
          }
        />
      </Row>

      <Row label="Labels">
        {/* ⚠️ Disabled by `stale` ONLY, unlike the menus above it. Binding this
            to `busy` as well made the control go dead for the length of each
            round trip, which on a board being edited is most of the time. A
            second label chosen before the first write lands can still lose the
            revision race; that is what the conflict banner is for. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {card.tags.map((tag) => (
            <LabelChip
              key={tag}
              tag={tag}
              labels={labels}
              onRemove={
                stale
                  ? undefined
                  : () => save({ tags: card.tags.filter((t) => t !== tag) })
              }
            />
          ))}
          <LabelPicker
            tags={card.tags}
            labels={labels}
            disabled={stale}
            onChange={(tags) => save({ tags })}
          />
        </div>
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

      {/* Facts, not fields — but read as the same table, so they keep the row. */}
      <Separator className="my-1.5" />
      {/* ⚠️ In the rail rather than only above the list. The rail is a pane of
          its own now, so this is the one place a card's progress stays on screen
          while a body that runs for pages is being read — which is the whole
          reason not to hide either section behind a tab. */}
      {sections(checklist).map(({ section, rows, done }) => (
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

/**
 * The open card's checklist as the person currently has it: the server's ticks
 * with the unsaved draft laid over them, plus which keys differ.
 *
 * ⚠️ Derived on every read, never stored. A box the draft says "on" that a poll
 * shows is already on is simply not a change any more — the Save button, the
 * marker and the leave prompt all agree about that without anyone pruning.
 */
function useChecklistDraft(card: BoardCard | null) {
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
    // ⚠️ `relative`, and it is load-bearing: the `sr-only` text below is
    // `position: absolute`, and with no positioned ancestor it was placed
    // against the PAGE at its row's offset inside the scrolled pane — below the
    // window's bottom edge. That made the document itself taller than the
    // window, and the whole app scrolled up under a grey band.
    <label htmlFor={htmlFor} className="relative cursor-pointer">
      {/* ⚠️ A mark on the ROW, not only the Save button's count: on a card with
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
      {/* ⚠️ Rendered, not printed: cards are written in markdown, and a
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
 * ⚠️ Rows sharing a `group` are ALTERNATIVES — the board's "pick ONE" — so they
 * are a `RadioGroup`, not checkboxes. Rendering them as independent boxes would
 * let a reader tick two options that contradict each other and believe both
 * were approved.
 */
function Checklist({ card }: { card: BoardCard }) {
  const stageTick = useBoard((state) => state.stageTick);
  const stagePick = useBoard((state) => state.stagePick);
  const busy = useBoard((state) => state.busy);
  const view = useBoard((state) => state.view);
  const uid = useId();
  const { items, dirty } = useChecklistDraft(card);
  const stale = view?.stale ?? false;
  if (!items.length) return null;

  // ⚠️ Prefixed, not the bare `item.key`. Every card's checklist starts at `D1`,
  // and the detail pane is not the only thing on the page — a duplicated id
  // points a label at whichever box the document happens to hold first.
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
                        // ⚠️ A tick goes into the DRAFT, not to the server
                        // (FE-13/D7): decisions are made as a set and sent with
                        // Save. The row's mark says it is not saved yet — an
                        // approval is still never shown as saved before it is.
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
                      // ⚠️ `null` while nothing is picked, never `undefined` —
                      // Base UI reads an undefined `value` as "uncontrolled" and
                      // the group would start tracking a selection of its own
                      // instead of the one the server confirmed.
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
