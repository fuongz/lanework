import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMatch, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { SplitSkeleton } from "#/components/shared/loading/skeletons";
import { WindowTitlebar } from "#/components/shared/navigation/window-titlebar";
import {
  HeldReadAction,
  RepoEmpty,
  RepoMessage,
} from "#/components/shared/repo/repo-empty";
import { Button } from "#/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable";
import { usePersistedLayout } from "#/hooks/use-persisted-layout";
import { cn } from "#/lib/utils";
import { type GitTab, useGitView } from "#/stores/git-view";
import { useWorktree } from "#/stores/worktree";
import { ChangesDiff } from "./changes-diff";
import { ChangesActions, ChangesList } from "./changes-list";
import { CommitBox } from "./commit-box";
import { CommitDetail } from "./commit-detail";
import {
  GIT_PANEL_ID,
  GIT_TAB_ID,
  GitTabs,
  useGitTabKeys,
  useGitTabNavigate,
} from "./git-tabs";
import { HistoryEmpty } from "./history-empty";
import { HistoryList } from "./history-list";

/** History's Refresh, at the right end of the title bar. */
function HistoryActions({ slug }: { slug: string }) {
  const refresh = useWorktree((state) => state.refresh);
  const openHistory = useWorktree((state) => state.openHistory);
  const loading = useWorktree((state) => state.historyLoading);
  return (
    <div className="ml-auto flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh history"
        title="Refresh"
        disabled={loading}
        onClick={() => void refresh().then(() => openHistory(slug))}
      >
        <HugeiconsIcon
          icon={RefreshIcon}
          strokeWidth={1.8}
          aria-hidden="true"
          className={loading ? "animate-spin" : undefined}
        />
      </Button>
    </div>
  );
}

/**
 * The History tab's column.
 *
 * The log is read each time the tab is shown, as the History screen read it
 * on entry: a commit or a sync empties the first page so it is read again
 * here rather than shown stale. A layout effect, so the read has started
 * (and the list shows its skeleton) before that emptied page is painted as
 * "No commits yet".
 */
function HistoryColumn({ slug, shown }: { slug: string; shown: boolean }) {
  const openHistory = useWorktree((state) => state.openHistory);
  useLayoutEffect(() => {
    if (shown) void openHistory(slug);
  }, [openHistory, slug, shown]);
  return <HistoryList />;
}

/**
 * One tab's half of the view, kept mounted while the other is shown
 * (FE-130/D9): its scroll, its search and what it has selected stay as they
 * were.
 */
function Shown({
  shown,
  children,
  ...props
}: {
  shown: boolean;
  children: ReactNode;
  id?: string;
  role?: "tabpanel";
  "aria-labelledby"?: string;
}) {
  return (
    <div
      {...props}
      hidden={!shown}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !shown && "hidden")}
    >
      {children}
    </div>
  );
}

/**
 * Repository › Git: Changes and History as two tabs of one view, laid out
 * like GitHub Desktop (FE-130).
 *
 * - The tab is in the path, `/changes` or `/history/$sha`, under one
 *   pathless layout route (D1): Back moves between tabs and commits, and a
 *   link from before the merge still lands.
 * - One split for both tabs (D11): the column on the left (the changed
 *   files and the commit box, or the commit list), the diff or the commit on
 *   the right.
 * - A tab is mounted on its first visit and then kept, hidden, while the
 *   other is shown (D9).
 *
 * Read on entry and on window focus, never on a timer (FE-22/D10). The
 * folder changes while somebody is in their editor, and coming back to this
 * window is when they want it read again.
 */
export function GitLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/_git" });
  const onHistory = useMatch({
    from: "/_app/w/$slug/_git/history",
    shouldThrow: false,
  });
  const onCommit = useMatch({
    from: "/_app/w/$slug/_git/history/$sha",
    shouldThrow: false,
  });
  const tab: GitTab = onHistory ? "history" : "changes";
  const urlSha = onCommit?.params.sha ?? null;

  const open = useWorktree((state) => state.open);
  const refresh = useWorktree((state) => state.refresh);
  const state = useWorktree((state) => state.state);
  const error = useWorktree((state) => state.error);
  const askAgain = useWorktree((state) => state.askAgain);
  const openHistory = useWorktree((state) => state.openHistory);

  const remember = useGitView((state) => state.remember);
  const lastSha = useGitView((state) => state.bySlug[slug]?.sha ?? null);
  // The History pane keeps the commit last open while Changes is shown.
  const historySha = tab === "history" ? urlSha : lastSha;

  const go = useGitTabNavigate(slug);
  useGitTabKeys(go);

  const [seen, setSeen] = useState<Record<GitTab, boolean>>({
    changes: tab === "changes",
    history: tab === "history",
  });
  if (!seen[tab]) setSeen({ ...seen, [tab]: true });

  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:git",
    ["list", "pane"],
  );

  useEffect(() => {
    remember(slug, tab, tab === "history" ? urlSha : undefined);
  }, [remember, slug, tab, urlSha]);

  useEffect(() => {
    void open(slug);
  }, [open, slug]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const files = state?.kind === "ready" ? state.files : [];

  // The title bar is drawn in every state, so the tabs and Refresh are there
  // while the repository is read, and when the folder is not one.
  const title = (
    <WindowTitlebar>
      <GitTabs slug={slug} tab={tab} changed={files.length} go={go} />
      {tab === "changes" ? (
        <ChangesActions files={files} />
      ) : (
        <HistoryActions slug={slug} />
      )}
    </WindowTitlebar>
  );

  if (!state)
    return (
      <>
        {title}
        {error ? (
          <RepoMessage
            title="The repository could not be read"
            description={error}
          >
            <HeldReadAction
              message={error}
              onRetry={async (refusal) => {
                if (refusal === "refused") await askAgain(slug);
                await refresh();
                if (tab === "history") await openHistory(slug);
              }}
            />
          </RepoMessage>
        ) : (
          <SplitSkeleton
            label="Reading the repository"
            lines={tab === "history" ? 2 : 1}
          />
        )}
      </>
    );
  if (state.kind !== "ready")
    return (
      <>
        {title}
        <RepoEmpty state={state} />
      </>
    );

  return (
    <>
      {title}
      <ResizablePanelGroup
        id="lanework:git"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="list"
          defaultSize="280px"
          minSize="15%"
          maxSize="45%"
          groupResizeBehavior="preserve-pixel-size"
        >
          <aside
            aria-label="Commits"
            className="bg-sidebar flex h-full min-h-0 flex-col"
          >
            {seen.changes && (
              <Shown
                shown={tab === "changes"}
                role="tabpanel"
                id={GIT_PANEL_ID("changes")}
                aria-labelledby={GIT_TAB_ID("changes")}
              >
                {files.length ? (
                  <ChangesList files={files} />
                ) : (
                  <div className="flex min-h-0 flex-1">
                    <RepoMessage
                      title="No changes"
                      description="The working tree matches the last commit."
                    />
                  </div>
                )}
                <CommitBox
                  files={files}
                  branch={state.branch}
                  head={state.head}
                  remotes={state.remotes}
                />
              </Shown>
            )}
            {seen.history && (
              <Shown
                shown={tab === "history"}
                role="tabpanel"
                id={GIT_PANEL_ID("history")}
                aria-labelledby={GIT_TAB_ID("history")}
              >
                <HistoryColumn slug={slug} shown={tab === "history"} />
              </Shown>
            )}
          </aside>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize Git column" />
        <ResizablePanel id="pane" minSize="40%">
          <div className="flex h-full min-h-0">
            {seen.changes && (
              <Shown shown={tab === "changes"}>
                {files.length ? (
                  <ChangesDiff slug={slug} files={files} />
                ) : (
                  <RepoMessage
                    title="Nothing to review"
                    description="Edit a file in this repository and its diff appears here."
                  />
                )}
              </Shown>
            )}
            {seen.history && (
              <Shown shown={tab === "history"}>
                {historySha ? (
                  <CommitDetail slug={slug} sha={historySha} />
                ) : (
                  <HistoryEmpty />
                )}
              </Shown>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}
