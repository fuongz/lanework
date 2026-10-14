import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { RepoEmpty, RepoMessage } from "#/components/shared/repo/repo-empty";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { useWorktree } from "#/stores/worktree";
import { ChangesDiff } from "./changes-diff";
import { ChangesList, ChangesTitlebar } from "./changes-list";
import { CommitBox } from "./commit-box";

/**
 * Repository › Changes: the working tree's changes, their diff, and the box
 * that commits them (FE-22).
 *
 * ⚠️ Read on entry and on window FOCUS, never on a timer (FE-22/D10) — the same
 * rule the pull request screen and the board follow. The folder changes while
 * somebody is in their editor, and coming back to this window is the moment
 * they want it read again.
 */
export function ChangesLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/changes" });
  const open = useWorktree((state) => state.open);
  const refresh = useWorktree((state) => state.refresh);
  const state = useWorktree((state) => state.state);
  const error = useWorktree((state) => state.error);

  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:changes",
    ["list", "diff"],
  );

  useEffect(() => {
    void open(slug);
  }, [open, slug]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // ⚠️ The title bar is drawn in every state (FE-58), so the screen keeps its
  // name while the repository is read, and when it is not one.
  const title = (
    <ChangesTitlebar files={state?.kind === "ready" ? state.files : []} />
  );

  if (!state)
    return (
      <>
        {title}
        {error ? (
          <RepoMessage
            title="The repository could not be read"
            description={error}
          />
        ) : (
          <p className="text-muted-foreground p-4 text-xs">
            Reading the repository…
          </p>
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
    <ResizablePanelGroup
      id="lanework:changes"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="list"
        defaultSize="340px"
        minSize="18%"
        maxSize="45%"
        groupResizeBehavior="preserve-pixel-size"
      >
        <aside
          aria-label="Changed files"
          className="bg-sidebar flex h-full min-h-0 flex-col"
        >
          {title}
          {state.files.length ? (
            <ChangesList files={state.files} />
          ) : (
            <div className="flex min-h-0 flex-1">
              <RepoMessage
                title="No changes"
                description="The working tree matches the last commit."
              />
            </div>
          )}
          <CommitBox
            files={state.files}
            branch={state.branch}
            head={state.head}
            remotes={state.remotes}
          />
        </aside>
      </ResizablePanel>
      <ResizableHandle aria-label="Resize changes list" />
      <ResizablePanel id="diff" minSize="40%">
        <div className="flex h-full min-h-0">
          {state.files.length ? (
            <ChangesDiff slug={slug} files={state.files} />
          ) : (
            <RepoMessage
              title="Nothing to review"
              description="Edit a file in this repository and its diff appears here."
            />
          )}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
