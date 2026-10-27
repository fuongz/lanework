// The Files screen's pieces for Settings pages that browse files that are
// not a working tree (Skills, a project's skills, Config files): the title in
// the window's title bar, the tree in the sidebar beside the open files as
// tabs, each with its path above it.
//
// Drawn the way `files-layout.tsx`, `files-tree.tsx` and `FileTabs` draw
// them, but not built on them: those read the worktree store and the git
// status of one project, and these files belong to no repository.
import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  FILE_TREE_ICONS,
  FileTypeIcon,
  TREE_ICON_TINT_CSS,
} from "#/components/shared/diff/diff-icons";
import {
  COMPACT_TREE_STYLE,
  FOLDER_ICON_CSS,
  treeHostStyle,
} from "#/components/shared/diff/tree-style";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "#/components/ui/input-group";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable";
import { useDark } from "#/hooks/use-dark";
import { usePersistedLayout } from "#/hooks/use-persisted-layout";
import { cn } from "#/lib/utils";

/** One file in the tree: its id for the page, and where it sits. */
interface BrowserEntry {
  id: string;
  /** Slash-separated, no leading `/`: `.claude/skills/review/SKILL.md`. */
  path: string;
}

/** A path for the tree from one shown with `~`: `~/.claude/x` → `.claude/x`. */
export function treePath(path: string): string {
  return path.replace(/^~\//, "").replace(/^\/+/, "");
}

/** Every folder a path sits in, as the tree names folders: `a/`, `a/b/`. */
function parents(path: string): string[] {
  const out: string[] = [];
  const parts = path.split("/");
  for (let at = 1; at < parts.length; at++)
    out.push(`${parts.slice(0, at).join("/")}/`);
  return out;
}

function folder(
  item: FileTreeItemHandle | null,
): FileTreeDirectoryHandle | null {
  return item?.isDirectory() ? (item as FileTreeDirectoryHandle) : null;
}

/**
 * The page around a file browser.
 *
 * Its title (and actions) in the title bar, the tree on the left on the
 * sidebar's surface, and `children` (tabs and the open file) on the right.
 */
export function FileBrowserLayout({
  id,
  title,
  heading,
  actions,
  sidebar,
  children,
}: {
  /** Keys the panel sizes, per page. */
  id: string;
  title: string;
  /** Drawn in the title bar instead of `title`: a project picker. */
  heading?: ReactNode;
  actions?: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(id, [
    "tree",
    "file",
  ]);
  return (
    <>
      <WindowTitlebar>
        {heading ?? <h1 className={WINDOW_TITLE}>{title}</h1>}
        <span className="ml-auto" />
        {actions}
      </WindowTitlebar>
      <ResizablePanelGroup
        id={id}
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="tree"
          defaultSize="280px"
          minSize="15%"
          maxSize="45%"
          groupResizeBehavior="preserve-pixel-size"
        >
          <aside
            aria-label={title}
            className="bg-sidebar flex h-full min-h-0 flex-col"
          >
            {sidebar}
          </aside>
        </ResizablePanel>
        <ResizableHandle aria-label={`Resize ${title.toLowerCase()} tree`} />
        <ResizablePanel id="file" minSize="40%">
          <div className="flex h-full min-h-0 flex-col">{children}</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}

/**
 * The files as a tree, with the filter box above it: the Files screen's
 * explorer.
 *
 * A click opens a file. The active one is selected, and its folders opened,
 * so the tree follows the tabs.
 */
export function FileBrowserTree({
  entries,
  active,
  onOpen,
  noun = "file",
}: {
  entries: BrowserEntry[];
  /** The id of the file on screen. */
  active: string | null;
  onOpen: (id: string) => void;
  /** What the filter counts: "file", "skill". */
  noun?: string;
}) {
  const dark = useDark();
  const [query, setQuery] = useState("");
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const idOf = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.id])),
    [entries],
  );
  const activePath = entries.find((entry) => entry.id === active)?.path ?? null;

  // NOTE: Construction-time callbacks, and the model is built once. Refs let
  // a fresh closure still be the one that runs.
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const idRef = useRef(idOf);
  idRef.current = idOf;

  const { model } = useFileTree({
    paths,
    // A handful of files: all of them in view, unlike a repository.
    initialExpansion: "open",
    flattenEmptyDirectories: false,
    search: false,
    icons: FILE_TREE_ICONS,
    unsafeCSS: TREE_ICON_TINT_CSS + FOLDER_ICON_CSS,
    density: "compact",
    itemHeight: 22,
    onSelectionChange: (selected) => {
      const [path] = selected;
      if (path === undefined || path.endsWith("/")) return;
      const id = idRef.current.get(path);
      if (id) openRef.current(id);
    },
  });

  // A new list (a refresh, another project) rebuilds the tree, keeping
  // open what was open and opening what is new.
  const shown = useRef(paths.join("\n"));
  useEffect(() => {
    const key = paths.join("\n");
    if (key === shown.current) return;
    shown.current = key;
    const expanded = new Set<string>();
    for (const path of paths)
      for (const dir of parents(path)) expanded.add(dir);
    model.resetPaths(paths, { initialExpandedPaths: [...expanded] });
  }, [model, paths]);

  useEffect(() => {
    model.setSearch(query.trim() === "" ? null : query);
  }, [model, query]);

  useEffect(() => {
    if (!activePath || model.getSelectedPaths()[0] === activePath) return;
    for (const dir of parents(activePath)) {
      const item = folder(model.getItem(dir));
      if (item && !item.isExpanded()) item.expand();
    }
    const item = model.getItem(activePath);
    if (!item) return;
    item.select();
    model.scrollToPath(activePath, { offset: "nearest" });
  }, [model, activePath]);

  const count = entries.length;
  return (
    <>
      <div className="shrink-0 px-2 pt-2 pb-1.5">
        <InputGroup>
          <InputGroupAddon>
            <HugeiconsIcon
              icon={Search01Icon}
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Filter ${count.toLocaleString()} ${count === 1 ? noun : `${noun}s`}…`}
            aria-label={`Filter ${noun}s`}
            className="text-xs"
          />
        </InputGroup>
      </div>
      <FileTree
        model={model}
        className="min-h-0 flex-1"
        style={{ ...treeHostStyle(dark), ...COMPACT_TREE_STYLE }}
      />
    </>
  );
}

/**
 * The open file's path as a breadcrumb, with its actions on the right.
 *
 * The Files screen's file header.
 */
export function FileBrowserPath({
  path,
  note,
  children,
}: {
  path: string;
  /** After the path, muted: "not created yet". */
  note?: string;
  children?: ReactNode;
}) {
  const segments = path.split("/");
  return (
    <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <nav
        aria-label="File path"
        className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1 text-xs"
        title={path}
      >
        {segments.map((segment, index) => {
          const last = index === segments.length - 1;
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a path's segments are positional
              key={index}
              className={cn(
                "flex min-w-0 items-center gap-1",
                last ? "text-foreground shrink" : "shrink-[2]",
              )}
            >
              {index > 0 && <span aria-hidden="true">›</span>}
              {last && (
                <FileTypeIcon path={path} className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{segment}</span>
            </span>
          );
        })}
        {note && <span className="shrink-0">— {note}</span>}
      </nav>
      {children}
    </div>
  );
}
