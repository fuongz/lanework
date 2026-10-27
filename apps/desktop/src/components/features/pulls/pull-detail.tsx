import {
  ArrowExpand01Icon,
  CheckmarkCircle02Icon,
  Comment01Icon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  SidebarRight01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { SegmentedControl } from "#/components/shared/common/segmented-control";
import {
  DocumentSkeleton,
  SplitSkeleton,
} from "#/components/shared/loading/skeletons";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import { MergeControl } from "#/components/shared/pulls/merge-control";
import { Button } from "#/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable";
import { Textarea } from "#/components/ui/textarea";
import { usePersistedLayout } from "#/hooks/use-persisted-layout";
import type { PullView } from "#/lib/pull-search";
import { cn } from "#/lib/utils";
import { useLayout } from "#/stores/layout";
import { diffSource, usePulls } from "#/stores/pulls";
import type { ReviewVerdict } from "../../../../shared/git";
import { CommitPicker } from "./commit-picker";
import { DiffView } from "./diff-view";
import { FilesPanel } from "./file-tree";
import { PullSummary } from "./pull-summary";

/**
 * The screen's name in the window's title bar, until a pull request has a
 * title to put there. `PullsEmpty` draws the same one.
 *
 * Rendered by the pane, not by `PullsLayout`: the bar holds one header, and
 * an open pull request's replaces this rather than standing beside it.
 */
function PullsTitlebar() {
  return (
    <WindowTitlebar>
      <h1 className={WINDOW_TITLE}>Pull requests</h1>
    </WindowTitlebar>
  );
}

function Verdict({
  verdict,
  label,
  body,
  number,
  onDone,
}: {
  verdict: ReviewVerdict;
  label: string;
  body: string;
  number: number;
  onDone: (error: string | null) => void;
}) {
  const review = usePulls((state) => state.review);
  const busy = usePulls((state) => state.reviewBusy);
  const authored = usePulls((state) => state.detail?.pull.authored);
  return (
    <Button
      size="sm"
      variant={verdict === "APPROVE" ? "default" : "outline"}
      disabled={
        busy !== null ||
        (verdict !== "COMMENT" && authored) ||
        (verdict !== "APPROVE" && !body.trim())
      }
      onClick={() => {
        void review(number, verdict, body).then((result) =>
          onDone(result.error ?? null),
        );
      }}
    >
      {busy === verdict ? "Submitting…" : label}
    </Button>
  );
}

/**
 * One pull request: what it is, and what changed in it.
 *
 * The review controls are PR-level (approve, request changes, comment), and
 * nothing here writes to the branch. Line comments need a position model
 * this app does not have, so the screen does not offer them.
 */
export function PullDetail() {
  const { slug, number } = useParams({
    from: "/_app/w/$slug/issues_/pulls/$number",
  });
  const navigate = useNavigate({ from: "/w/$slug/issues/pulls/$number" });
  // Absent means `summary`; see `parsePullDetailSearch`.
  const view: PullView =
    useSearch({ from: "/_app/w/$slug/issues_/pulls/$number" }).view ??
    "summary";
  const focusMode = useLayout((state) => state.focusMode);
  const toggleFocusMode = useLayout((state) => state.toggleFocusMode);
  const parsed = Number(number);
  const detail = usePulls((state) => state.detail);
  const loading = usePulls((state) => state.detailLoading);
  const error = usePulls((state) => state.detailError);
  const openPull = usePulls((state) => state.openPull);
  const [body, setBody] = useState("");
  const [composing, setComposing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  /**
   * Whether the file tree shares the pane with the diff.
   *
   * - In the store, not this component: {@link FilesPanel} reads it too.
   * - Open by default, and closable. It makes a forty-file review navigable,
   *   but its 240px come out of the diff, so a reviewer reading one long file
   *   has to be able to put it away.
   */
  const filesOpen = usePulls((state) => state.filesOpen);
  const toggleFiles = usePulls((state) => state.toggleFiles);
  const setFilesOpen = usePulls((state) => state.setFilesOpen);
  const commit = usePulls((state) => state.commit);
  const filesRef = usePanelRef();
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:pull-detail",
    ["diff", "files"],
  );
  const commitDiff = usePulls((state) => state.commitDiff);
  const commitDiffError = usePulls((state) => state.commitDiffError);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset runs when the pull request changes.
  useEffect(() => {
    setBody("");
    setReviewError(null);
    setComposing(false);
  }, [parsed, slug]);

  // NOTE: Waits for the store to be on this project. `openPull` reads the
  // store's slug, which the list layout sets after this pane mounts on a
  // direct link; calling it earlier does nothing and leaves the pane blank.
  const storeSlug = usePulls((state) => state.slug);
  useEffect(() => {
    if (slug && storeSlug === slug && Number.isInteger(parsed) && parsed > 0)
      void openPull(parsed);
  }, [openPull, parsed, slug, storeSlug]);

  /**
   * Whether the tree is on screen right now.
   *
   * Two different conditions: `filesOpen` is what the person chose, and
   * `view === "code"` is whether a tree means anything here (beside the
   * summary it navigates nothing). Derived rather than written back, so
   * reading the summary does not erase their choice about the diff.
   */
  const showFiles = filesOpen && view === "code";

  // The store stays the source of truth for that choice, so the toggle in
  // the diff row keeps working; this only makes the panel agree with it.
  useEffect(() => {
    const panel = filesRef.current;
    if (!panel) return;
    if (showFiles && panel.isCollapsed()) panel.expand();
    if (!showFiles && !panel.isCollapsed()) panel.collapse();
  }, [showFiles, filesRef]);

  // The screen's name stays in the title bar until this pull request has a
  // title to put there, so the bar is never blank while one loads.
  if (error)
    return (
      <div className="flex flex-1 items-start justify-center p-8">
        <PullsTitlebar />
        <p className="text-destructive max-w-prose text-xs/relaxed">{error}</p>
      </div>
    );

  // Before the read starts too, not only while `loading`: the first render
  // comes before the effect that opens the pull request.
  if (!detail || (loading && detail.pull.number !== parsed))
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PullsTitlebar />
        <SplitSkeleton label="Loading the pull request" />
      </div>
    );

  const { pull } = detail;
  // NOTE: The same function the file tree calls. Two answers to "which files
  // are on screen" would be a tree listing the pull request while the diff
  // shows one commit.
  const source = diffSource(commit, commitDiff, detail);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Two rows with different jobs. The top row is about the pull
          request: its name, and which half of it is on screen. The row under
          it is about the diff (where it came from, what is shown), so it is
          drawn only when a diff is on screen. In one row, the diff's facts
          sat among the controls and read as one.

          The top row is the window's title bar (FE-58), as Codex draws a
          thread's header. The bar keeps it clear of the window controls,
          also in focus mode with the list shut. */}
      <WindowTitlebar>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <HugeiconsIcon
            icon={GitPullRequestIcon}
            className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <h1 className={WINDOW_TITLE} title={pull.title}>
            {pull.title}
          </h1>
        </div>

        {/* Tabs and merge actions keep their space; the title truncates as
            the bar narrows, so the actions stay reachable. */}
        <SegmentedControl
          label="Pull request view"
          semantics="tabs"
          className="shrink-0"
          value={view}
          options={[
            { value: "summary", label: "Summary" },
            { value: "code", label: "Code" },
          ]}
          onChange={(value) =>
            void navigate({
              to: ".",
              // NOTE: An updater, not a literal. This route's search
              // inherits the list's `tab` and `status` from the parent; a
              // plain object drops them, and switching tab would reset which
              // pull requests the list beside it shows.
              search: (prev) => ({
                ...prev,
                view: value === "code" ? "code" : undefined,
              }),
              // Not `replace`: Back should undo the switch, which is why
              // this tab is in the URL, rather than leave the pull request.
            })
          }
        />

        <div className="window-no-drag flex shrink-0 items-center justify-end gap-2">
          <MergeControl
            key={`${slug}/${pull.number}`}
            detail={detail}
            compact
          />
          <a
            href={pull.url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open on GitHub"
            title="Open on GitHub"
            className="hover:bg-foreground/[0.06] flex size-6 items-center justify-center rounded-md transition-colors"
          >
            <HugeiconsIcon
              icon={ExternalLinkIcon}
              className="text-muted-foreground size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </a>
          {/* Collapses the project rail and the pull request list, which
              sit in two panel groups (see `stores/layout.ts`). A shortcut for
              two drags, not a mode with rules of its own. */}
          <button
            type="button"
            aria-pressed={focusMode}
            aria-label={focusMode ? "Show the other panels" : "Focus the diff"}
            title={focusMode ? "Show the other panels" : "Focus the diff"}
            onClick={toggleFocusMode}
            className={cn(
              "hover:bg-foreground/[0.06] flex size-6 items-center justify-center rounded-md transition-colors",
              focusMode && "bg-foreground/[0.07]",
            )}
          >
            <HugeiconsIcon
              icon={ArrowExpand01Icon}
              className="text-muted-foreground size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </button>
        </div>
      </WindowTitlebar>

      {view === "summary" ? (
        <PullSummary detail={detail} />
      ) : (
        /* A group inside the detail pane, so the file tree starts below the
           title, level with the row that describes the diff, and the title
           bar spans the width it describes. */
        <ResizablePanelGroup
          id="lanework:pull-detail"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <ResizablePanel id="diff" minSize="45%">
            <div className="border-sidebar-border flex h-9 shrink-0 items-center gap-2 border-b px-3">
              {/* A breadcrumb rather than two badges with an arrow between
                  them: `head › base` is one fact, where this change is
                  going. */}
              <nav
                aria-label="Branches"
                className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
              >
                <span className="truncate font-mono" title={pull.headRef}>
                  {pull.headRef}
                </span>
                <span aria-hidden="true">›</span>
                <span className="truncate font-mono" title={pull.baseRef}>
                  {pull.baseRef}
                </span>
              </nav>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <CommitPicker number={pull.number} />
                <button
                  type="button"
                  aria-expanded={filesOpen}
                  aria-label={filesOpen ? "Hide file tree" : "Show file tree"}
                  title={filesOpen ? "Hide file tree" : "Show file tree"}
                  onClick={toggleFiles}
                  className={cn(
                    "hover:bg-foreground/[0.06] flex size-6 items-center justify-center rounded-md transition-colors",
                    filesOpen && "bg-foreground/[0.07]",
                  )}
                >
                  <HugeiconsIcon
                    icon={SidebarRight01Icon}
                    className="text-muted-foreground size-3.5"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>

            {/* NOTE: No `overflow-y-auto` here. The diff viewer virtualizes
                and owns its scrolling; a second scroller leaves it no
                viewport to measure, and it renders every line of every
                file. */}
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Said out loud when the file list stopped at its cap. A
                  partial diff that looks complete is how someone approves a
                  change they never saw. */}
              {detail.truncated && (
                <p className="text-muted-foreground bg-foreground/[0.04] shrink-0 px-4 py-2 text-xs/relaxed">
                  This pull request touches more files than this view loads.
                  Open it on GitHub to see the rest.
                </p>
              )}
              {commitDiffError !== null && (
                <p className="text-destructive bg-destructive/[0.08] shrink-0 px-4 py-2 text-xs/relaxed">
                  {commitDiffError}
                </p>
              )}
              {/* NOTE: Keyed by what it shows. `CodeView` keeps per-item fold
                  state; another commit's files under the same identity
                  inherit folds from a different diff. */}
              {source ? (
                <DiffView
                  key={commit ?? "pull"}
                  slug={slug}
                  files={source.files}
                  headSha={source.headSha}
                  baseSha={source.baseSha}
                />
              ) : (
                commitDiffError === null && (
                  <DocumentSkeleton label="Loading that commit" code />
                )
              )}
            </div>
          </ResizablePanel>
          <ResizableHandle
            aria-label="Resize file tree"
            disabled={!showFiles}
          />
          <ResizablePanel
            id="files"
            panelRef={filesRef}
            defaultSize="240px"
            minSize="12%"
            maxSize="35%"
            collapsible
            collapsedSize="0px"
            groupResizeBehavior="preserve-pixel-size"
            disabled={!showFiles}
            // Dragging the handle onto the edge is the same act as pressing
            // the toggle, so it reports back and the two never disagree.
            //
            // NOTE: Only while the diff is on screen. Switching to the summary
            // collapses this panel too, and reporting that back would record
            // "closed the file tree" for someone who read a description.
            onResize={(size) => {
              if (view !== "code") return;
              const collapsed = size.asPercentage <= 0.01;
              if (collapsed === filesOpen) setFilesOpen(!collapsed);
            }}
          >
            {showFiles && <FilesPanel />}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      {/* Open pull requests only. A verdict on merged or closed work cannot
          change what shipped, and a button whose outcome is nothing is worse
          than no button. A UI judgement, not an API limit: GitHub may still
          accept the call.

          Commenting stays: people ask about merged work all the time, and the
          comment box on the summary is where that goes. */}
      {pull.state === "open" && (
        <footer className="border-sidebar-border shrink-0 border-t px-4 py-2.5">
          {composing ? (
            <div className="flex flex-col gap-2">
              {pull.authored && (
                <p className="text-muted-foreground text-xs">
                  GitHub does not allow approving or requesting changes on your
                  own pull request. You can leave a comment.
                </p>
              )}
              <Textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Leave a note for the author…"
                rows={3}
                aria-label="Review note"
              />
              <div className="flex items-center gap-2">
                <Verdict
                  verdict="APPROVE"
                  label="Approve"
                  body={body}
                  number={pull.number}
                  onDone={(failure) => {
                    setReviewError(failure);
                    if (!failure) {
                      setBody("");
                      setComposing(false);
                    }
                  }}
                />
                <Verdict
                  verdict="REQUEST_CHANGES"
                  label="Request changes"
                  body={body}
                  number={pull.number}
                  onDone={(failure) => {
                    setReviewError(failure);
                    if (!failure) {
                      setBody("");
                      setComposing(false);
                    }
                  }}
                />
                <Verdict
                  verdict="COMMENT"
                  label="Comment"
                  body={body}
                  number={pull.number}
                  onDone={(failure) => {
                    setReviewError(failure);
                    if (!failure) {
                      setBody("");
                      setComposing(false);
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setComposing(false)}
                >
                  Cancel
                </Button>
              </div>
              {reviewError && (
                <p className="text-destructive text-xs/relaxed">
                  {reviewError}
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setComposing(true)}
              >
                <HugeiconsIcon icon={Comment01Icon} aria-hidden="true" />
                Review
              </Button>
              {pull.reviewDecision === "APPROVED" && (
                <span className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                  <HugeiconsIcon
                    icon={CheckmarkCircle02Icon}
                    className="size-3.5"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  Approved
                </span>
              )}
            </div>
          )}
        </footer>
      )}
    </div>
  );
}
