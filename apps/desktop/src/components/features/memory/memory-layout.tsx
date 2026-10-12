import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, Outlet } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { MemoryMessage } from "#/components/shared/memory/memory-message";
import {
  ProjectBar,
  ProjectPicker,
  useSettingsProject,
} from "#/components/shared/settings/project-picker";
import { Button, buttonVariants } from "#/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { shortPath } from "#/lib/memory";
import { memoryCount, useMemory, useMemoryWatch } from "#/stores/memory";
import { MemoryList } from "./memory-list";

/** A message under the project bar, so another project stays a click away. */
function Framed({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectBar title="Memory" slug={slug} to="/settings/memory" />
      {children}
    </div>
  );
}

/**
 * Settings › Memory: what Claude Code saved about a project, beside the one
 * memory open (FE-36, moved out of the project rail by FE-51). Read-only.
 *
 * ⚠️ The open memory is in the URL (`memory/$file`), like a commit is in
 * History's: Back returns to the previous one, and a link inside a memory is
 * a link to a route. The project rides along as `?project=`.
 *
 * ⚠️ Listed while the screen is open (`useMemoryWatch`), which keeps it
 * current while main reports writes.
 */
export function MemoryLayout() {
  const slug = useSettingsProject();
  useMemoryWatch(slug || undefined);
  const list = useMemory((state) => (state.slug === slug ? state.list : null));
  const error = useMemory((state) =>
    state.slug === slug ? state.error : null,
  );
  const reveal = useMemory((state) => state.reveal);
  const [revealError, setRevealError] = useState<string | null>(null);
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:memory",
    ["list", "detail"],
  );

  if (!slug)
    return (
      <Framed slug={slug}>
        <MemoryMessage
          title="No project picked"
          description="Pick a project above to see what Claude remembers about it."
        />
      </Framed>
    );
  if (!list)
    return error ? (
      <Framed slug={slug}>
        <MemoryMessage
          alert
          title="The memory could not be read"
          description={error}
        />
      </Framed>
    ) : (
      <p className="text-muted-foreground p-4 text-xs">Reading memory…</p>
    );
  if (!list.folder || !list.dir)
    return (
      <Framed slug={slug}>
        <MemoryMessage
          title="No folder linked"
          description="Link this project to a folder on this machine to see what Claude remembers about it."
        >
          <Link
            to="/settings/workspaces"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Open Projects
          </Link>
        </MemoryMessage>
      </Framed>
    );
  if (!list.entries.length)
    return (
      <Framed slug={slug}>
        <MemoryMessage
          title="No memory yet"
          description={`Claude Code saves what it learns about this project in ${shortPath(list.dir)}. It shows up here as soon as it does.`}
        />
      </Framed>
    );

  const count = memoryCount(list);
  return (
    <ResizablePanelGroup
      id="lanework:memory"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="list"
        defaultSize="300px"
        minSize="18%"
        maxSize="45%"
        groupResizeBehavior="preserve-pixel-size"
      >
        <aside
          aria-label="Memory"
          className="bg-sidebar flex h-full min-h-0 flex-col"
        >
          <header className="window-drag-region border-sidebar-border flex h-11 shrink-0 items-center gap-2 border-b ps-3.5 pe-2">
            <h2 className="text-[13px] font-medium">Memory</h2>
            <span className="text-muted-foreground text-xs tabular-nums">
              {count}
            </span>
            <div className="ml-auto min-w-0">
              <ProjectPicker slug={slug} to="/settings/memory" />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground shrink-0"
              aria-label="Reveal in Finder"
              title={`Reveal in Finder — ${shortPath(list.dir)}`}
              onClick={() => {
                setRevealError(null);
                reveal(slug).catch((failed: unknown) =>
                  setRevealError(
                    failed instanceof Error
                      ? failed.message
                      : "Could not open the memory folder.",
                  ),
                );
              }}
            >
              <HugeiconsIcon
                icon={Folder01Icon}
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </Button>
          </header>
          {revealError && (
            <p role="alert" className="text-destructive px-3.5 pt-2 text-xs">
              {revealError}
            </p>
          )}
          <MemoryList slug={slug} list={list} />
        </aside>
      </ResizablePanel>
      <ResizableHandle aria-label="Resize memory list" />
      <ResizablePanel id="detail" minSize="40%">
        <div className="flex h-full min-h-0">
          <Outlet />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
