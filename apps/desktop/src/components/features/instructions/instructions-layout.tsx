import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { InstructionsMessage } from "#/components/shared/instructions/instructions-message";
import { SplitSkeleton } from "#/components/shared/loading/skeletons";
import {
  ProjectBar,
  ProjectPicker,
  useSettingsProject,
} from "#/components/shared/settings/project-picker";
import { buttonVariants } from "#/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { useInstructions, useInstructionsWatch } from "#/stores/instructions";
import { InstructionsList } from "./instructions-list";

/** A message under the project bar, so another project stays a click away. */
function Framed({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectBar
        title="Instructions"
        slug={slug}
        to="/settings/instructions"
      />
      {children}
    </div>
  );
}

/**
 * Settings › Instructions: the CLAUDE.md and AGENTS.md files each agent reads
 * for a project, beside the one open. Read-only.
 *
 * - The open file is in the URL (`instructions/$id`), as a memory is in
 *   Memory's: Back returns to the previous one, and an `@import` inside a
 *   file is a link to a route. The project rides along as `?project=`.
 * - Listed only while the screen is open: finding the files walks the folder
 *   and its parents, which no badge is worth.
 */
export function InstructionsLayout() {
  const slug = useSettingsProject();
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

  if (!slug)
    return (
      <Framed slug={slug}>
        <InstructionsMessage
          title="No project picked"
          description="Pick a project above to see what its agents are told."
        />
      </Framed>
    );
  if (!list)
    return error ? (
      <Framed slug={slug}>
        <InstructionsMessage
          alert
          title="The instructions could not be read"
          description={error}
        />
      </Framed>
    ) : (
      <SplitSkeleton label="Reading instructions" />
    );
  if (!list.folder)
    return (
      <Framed slug={slug}>
        <InstructionsMessage
          title="No folder linked"
          description="Link this project to a folder on this machine to see what its agents are told."
        >
          <Link
            to="/settings/workspaces"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Open Projects
          </Link>
        </InstructionsMessage>
      </Framed>
    );
  if (!list.claude.length && !list.codex.length && !list.nested.length)
    return (
      <Framed slug={slug}>
        <InstructionsMessage
          title="No instructions yet"
          description="Neither Claude Code nor Codex has a CLAUDE.md or AGENTS.md to read for this project. They show up here as soon as one is written."
        />
      </Framed>
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
          <header className="window-drag-region border-sidebar-border flex h-11 shrink-0 items-center gap-2 border-b ps-3.5 pe-2">
            <h2 className="text-[13px] font-medium">Instructions</h2>
            <div className="ml-auto min-w-0">
              <ProjectPicker slug={slug} to="/settings/instructions" />
            </div>
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
