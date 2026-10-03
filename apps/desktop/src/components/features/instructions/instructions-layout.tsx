import { Link, Outlet, useParams } from "@tanstack/react-router";
import { InstructionsMessage } from "#/components/shared/instructions/instructions-message";
import { buttonVariants } from "#/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { useInstructions, useInstructionsWatch } from "#/stores/instructions";
import { InstructionsList } from "./instructions-list";

/**
 * Project › Instructions: the CLAUDE.md and AGENTS.md files each agent reads
 * for this project, beside the one open (FE-37). Read-only.
 *
 * ⚠️ The open file is in the URL (`instructions/$id`), like a memory is in
 * Memory's: Back returns to the previous one, and an `@import` inside a file
 * is a link to a route.
 *
 * ⚠️ Listed while the screen is open, not by the rail: finding the files
 * walks the folder and its parents, which no badge is worth.
 */
export function InstructionsLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/instructions" });
  useInstructionsWatch(slug);
  const list = useInstructions((state) =>
    state.slug === slug ? state.list : null,
  );
  const error = useInstructions((state) =>
    state.slug === slug ? state.error : null,
  );
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:instructions",
    ["list", "detail"],
  );

  if (!list)
    return error ? (
      <InstructionsMessage
        alert
        title="The instructions could not be read"
        description={error}
      />
    ) : (
      <p className="text-muted-foreground p-4 text-xs">Reading instructions…</p>
    );
  if (!list.folder)
    return (
      <InstructionsMessage
        title="No folder linked"
        description="Link this project to a folder on this machine to see what its agents are told."
      >
        <Link
          to="/settings/workspaces"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Open Settings
        </Link>
      </InstructionsMessage>
    );
  if (!list.claude.length && !list.codex.length && !list.nested.length)
    return (
      <InstructionsMessage
        title="No instructions yet"
        description="Neither Claude Code nor Codex has a CLAUDE.md or AGENTS.md to read for this project. They show up here as soon as one is written."
      />
    );

  return (
    <ResizablePanelGroup
      id="lanework:instructions"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="list"
        defaultSize="320px"
        minSize="18%"
        maxSize="45%"
        groupResizeBehavior="preserve-pixel-size"
      >
        <aside
          aria-label="Instructions"
          className="bg-sidebar flex h-full min-h-0 flex-col"
        >
          <header className="border-sidebar-border flex h-11 shrink-0 items-center gap-2 border-b ps-[max(0.875rem,var(--titlebar-clear,0px))] pe-2">
            <h2 className="text-[13px] font-medium">Instructions</h2>
          </header>
          <InstructionsList slug={slug} list={list} />
        </aside>
      </ResizablePanel>
      <ResizableHandle aria-label="Resize instructions list" />
      <ResizablePanel id="detail" minSize="40%">
        <div className="flex h-full min-h-0">
          <Outlet />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
