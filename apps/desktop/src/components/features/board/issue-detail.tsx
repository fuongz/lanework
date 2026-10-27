import {
  ArrowDown01Icon,
  ArrowExpand01Icon,
  ArrowRight01Icon,
  Attachment01Icon,
  File01Icon,
  GitBranchIcon,
  Link01Icon,
  MoreHorizontalIcon,
  SidebarRight01Icon,
  StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useBlocker, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { BoardAttachment, BoardCard } from "#/../shared/workspaces";
import { AssignAgentButton } from "#/components/shared/board/assign-agent";
import { CardAgentsLine } from "#/components/shared/board/card-agents";
import { PriorityIcon, StatusIcon } from "#/components/shared/board/glyphs";
import { DeleteIssueDialog } from "#/components/shared/board/issue-menu";
import { LabelChip } from "#/components/shared/board/label-chip";
import { Avatar, memberOf } from "#/components/shared/board/people";
import {
  IssueDetailSkeleton,
  PropertiesSkeleton,
} from "#/components/shared/board/skeletons";
import { ErrorState } from "#/components/shared/common/error-state";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { useCopy } from "#/hooks/use-copy";
import { columnOf, subIssueProgress, subIssues } from "#/lib/board-view";
import { fileSize } from "#/lib/file-size";
import { parseIssueSearch } from "#/lib/issue-search";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import { useIssueView } from "#/stores/issue-view";
import { useLayout } from "#/stores/layout";
import { useCloudFeatures } from "#/stores/session";
import { IssueActivity } from "./issue-activity";
import { IssueCheckpoint } from "./issue-checkpoint";
import {
  Checklist,
  useChecklistDraft,
  WorkBreakdown,
} from "./issue-detail.checklist";
import { Fields } from "./issue-detail.properties";

export function IssueDetail() {
  const { slug, taskId } = useParams({ from: "/_app/w/$slug/issues/$taskId" });
  const openIssue = useBoard((state) => state.openIssue);
  const closeIssue = useBoard((state) => state.closeIssue);
  const card = useBoard((state) => state.detail);
  const loading = useBoard((state) => state.detailLoading);
  const error = useBoard((state) => state.detailError);
  const active = useBoard((state) => state.active);
  // Just the list's filters: the URL can carry keys of other pages too.
  const filters = parseIssueSearch(useSearch({ from: "/_app/w/$slug/issues" }));
  const propertiesOpen = useIssueView((state) => state.propertiesOpen);

  // NOTE: Keyed on the workspace too. Opening `FE-06` in one project and then
  // the same id in another would otherwise reuse the first project's card
  // while the second was still loading.
  useEffect(() => {
    if (active?.id) void openIssue(taskId);
    return () => closeIssue();
  }, [active?.id, closeIssue, openIssue, taskId]);

  // Leaving with unsaved ticks asks first (FE-13/D7). The draft is only in
  // this window's memory; a click on the breadcrumb or a ⌘K jump would drop
  // decisions somebody had just made without a word.
  const dirty = useChecklistDraft(card).dirty.size > 0;
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  // Two panes side by side, each scrolling on its own, as on the New issue
  // page. A card's properties are a fixed, short list; scrolling them away
  // with a body that can run for pages puts the rail off screen exactly when a
  // long card is being read.
  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The breadcrumb and the card's actions live in the window's title
            bar, the way Codex has it, so the pane is the card's body from its
            first line. Portalled out of this tree, but React still delivers
            its events through it. */}
        <WindowTitlebar className="gap-1">
          <Link
            to="/w/$slug/issues"
            params={{ slug }}
            search={filters}
            className="hover:bg-foreground/[0.05] -ml-2 flex h-7 min-w-0 items-center rounded-md px-2 transition-colors"
          >
            <span className={WINDOW_TITLE}>{active?.name ?? "Issues"}</span>
          </Link>
          <span className="text-muted-foreground shrink-0 text-[13px]">›</span>
          <span className="text-muted-foreground shrink-0 px-1 font-mono text-xs">
            {taskId}
          </span>
          {card && <CardAgentsLine card={card} />}
          <div className="ml-auto flex items-center gap-1">
            {card && <HeaderActions card={card} />}
            <PaneToggles />
          </div>
        </WindowTitlebar>
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

        {/* Keyed on the card: the pane stays mounted while j/k move through
            the list, and the next card must open at its top. */}
        <div key={taskId} className="min-h-0 flex-1 overflow-y-auto">
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

      {/* The rail's frame is drawn before the card arrives, not with it. It
          is 288px of the pane; mounting it on load would shove a body that
          had already been laid out and read. It is a panel somebody can put
          away (FE-75/D3), and the choice is remembered app-wide. */}
      {propertiesOpen && (
        <aside
          id={PROPERTIES_ID}
          aria-label="Card properties"
          className="border-border flex w-72 shrink-0 flex-col border-l"
        >
          {/* The rail's own header band: its id and actions belong to this
            rail, not to the page. Not a drag region, since it does not sit
            at the window's top edge. */}
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
      )}
    </div>
  );
}

/** The Properties panel's id, which its toggle names in `aria-controls`. */
const PROPERTIES_ID = "issue-properties";

/**
 * The header's two layout buttons: Properties, and focus.
 *
 * - Properties shows or hides the card's properties panel (FE-75/D3).
 * - Focus hides the rail and the issue list, as it does for a pull request.
 */
function PaneToggles() {
  const propertiesOpen = useIssueView((state) => state.propertiesOpen);
  const toggleProperties = useIssueView((state) => state.toggleProperties);
  const focusMode = useLayout((state) => state.focusMode);
  const toggleFocusMode = useLayout((state) => state.toggleFocusMode);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-7", propertiesOpen && "bg-foreground/[0.07]")}
        aria-pressed={propertiesOpen}
        aria-controls={propertiesOpen ? PROPERTIES_ID : undefined}
        aria-label="Properties"
        title={propertiesOpen ? "Hide properties" : "Show properties"}
        onClick={toggleProperties}
      >
        <HugeiconsIcon
          icon={SidebarRight01Icon}
          className="text-muted-foreground size-4"
          strokeWidth={1.8}
        />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-7", focusMode && "bg-foreground/[0.07]")}
        aria-pressed={focusMode}
        aria-label={focusMode ? "Show the other panels" : "Focus the issue"}
        title={focusMode ? "Show the other panels" : "Focus the issue"}
        onClick={toggleFocusMode}
      >
        <HugeiconsIcon
          icon={ArrowExpand01Icon}
          className="text-muted-foreground size-4"
          strokeWidth={1.8}
        />
      </Button>
    </>
  );
}

/**
 * The branch name a card would be worked on.
 *
 * Derived from the task id and the title, not from the card's uuid: a branch a
 * human reads, like `be-06-issue-detail-activity`. One carrying a uuid tells
 * nobody what it is for.
 */
function branchName(card: BoardCard): string {
  const words = card.title
    .toLowerCase()
    .normalize("NFD")
    // Marks only: this strips the accents off a Vietnamese title rather than
    // the letters, so "Kết nối git" becomes `ket-noi-git`, not `k-t-n-i-git`.
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

/** The card's actions beside the breadcrumb: star, assign, save, and `…`. */
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
      {/* `favorite === null` means nobody asked (a list read). It draws
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
      {/* Save and Discard only while there is something to save (FE-13/D7).
          A Save button that is always there, greyed out, reads as "this page
          has unsaved state somewhere", the one thing it must never say when
          it is false. */}
      <div className="flex items-center gap-1">
        <AssignAgentButton card={card} unsaved={changes > 0} />
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
 * Neither copies a URL. This app registers no deep-link scheme, so a "copy
 * link" would hand somebody a string that opens nothing. The issue id is what
 * people say to each other and what every agent tool takes; the branch name is
 * what the id is for next.
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
  // A local board keeps no attachments (FE-52/D10).
  const { attachments } = useCloudFeatures(useBoard((state) => state.active));
  const update = useBoard((state) => state.update);
  const stale = view?.stale ?? false;
  const [title, setTitle] = useState(card.title);

  // The server is the source of truth for this field; a title changed on
  // another machine has to win over an untouched draft here.
  useEffect(() => setTitle(card.title), [card.title]);

  const save = (patch: Parameters<typeof update>[1]) =>
    void update(card.id, patch, card.revision);

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
      {/* Stuck to the top of the pane once the page scrolls, right under the
          window's title bar: the title stays in view over frosted glass (the
          page showing through, blurred, as the app's popovers do). It is its
          own row rather than part of the title bar, so the bar keeps one
          height on every screen.

          One size, scrolled or not. A title that shrinks once it sticks
          moves the page under the pointer the moment it starts to scroll. */}
      <div className="bg-background/70 sticky top-0 z-10 -mx-6 px-6 py-1.5 backdrop-blur-xl backdrop-saturate-150">
        <Input
          aria-label="Card title"
          value={title}
          maxLength={500}
          disabled={stale}
          // NOTE: `dark:bg-transparent` as well as `bg-transparent`. The base
          // Input carries `dark:bg-input/30`, a different variant that class
          // merging does not cancel, so without it this field keeps a filled
          // box in dark mode only.
          className={cn(
            "h-auto rounded-md border-0 bg-transparent px-1.5 text-[15px] font-semibold tracking-tight shadow-none transition-[color,background-color] duration-150 focus-visible:border-0 focus-visible:bg-foreground/[0.04] focus-visible:ring-0 md:text-[15px] dark:bg-transparent dark:focus-visible:bg-foreground/[0.06]",
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
      {attachments && <Attachments card={card} />}
      <Checklist card={card} />
      <WorkBreakdown card={card} />
      <SubIssues card={card} slug={slug} />
      <IssueCheckpoint card={card} />
      <IssueActivity card={card} />
    </article>
  );
}

/**
 * The files a card refers to.
 *
 * Metadata and a reference only: the service stores no bytes and serves none,
 * so there is nothing here to download. A row states what was recorded and
 * copies the reference.
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
  const bytes = file.sizeBytes;
  const size =
    bytes === null || !Number.isFinite(bytes) || bytes < 0
      ? null
      : fileSize(bytes);
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
 * Collapsible, per card, for as long as the card is open. A card with fourteen
 * sub-issues pushes its own activity off the screen; a card with two does
 * not, and one preference applied to both would be wrong for one of them
 * every time.
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
          {/* The app's one disclosure arrow: a second shape for "this
              collapses" is a second thing to learn. */}
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
                  {/* `assignees` is null on a board read, and every card here
                      came from one, so this can draw the unassigned outline
                      for a card somebody is on. */}
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
