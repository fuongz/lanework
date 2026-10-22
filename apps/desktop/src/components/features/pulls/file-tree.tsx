import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FILE_TREE_ICONS,
  TREE_ICON_TINT_CSS,
} from "#/components/shared/diff/diff-icons";
import {
  COMPACT_TREE_STYLE,
  FOLDER_ICON_CSS,
  FOLDER_STATUS_CSS,
  rollUpFolders,
  treeHostStyle,
} from "#/components/shared/diff/tree-style";
import { useDark } from "#/components/shared/diff/use-dark";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "#/components/ui/input-group";
import { diffSource, usePulls } from "#/stores/pulls";
import type { PullFile, PullFileStatus } from "../../../../shared/git";

/**
 * The files in the open pull request, as a tree, in a panel of its own.
 *
 * - A resizable panel beside the diff, inside the pull request's pane. It
 *   starts below the title bar, level with the row that describes the diff.
 * - It holds the changed files, not the repository. Nothing in this app has
 *   the repo's file list, and enumerating it over the API for a sidebar would
 *   spend the rate limit. A file nobody touched is not part of a review
 *   anyway.
 * - NOTE: Rendered by `@pierre/trees`, a web component with its own shadow
 *   root. No class reaches inside it; styling arrives as a CSS variable on
 *   the host or as `unsafeCSS`.
 */

/** GitHub's word for what happened to a file, in the tree's vocabulary. */
function toGitStatus(status: PullFileStatus): GitStatus | null {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "copied":
      // Nothing in the tree means "copied", and "added" is what a copy looks
      // like from the reviewer's side: a path that was not there before.
      return "added";
    case "modified":
    case "changed":
      return "modified";
    case "unchanged":
      // No status rather than a wrong one. `ignored` would grey the row out,
      // which says "not part of this" about a file that is.
      return null;
  }
}

function Tree({ files }: { files: PullFile[] }) {
  const dark = useDark();
  const [query, setQuery] = useState("");
  const focusFile = usePulls((state) => state.focusFile);
  const paths = useMemo(() => files.map((file) => file.path), [files]);

  const gitStatus = useMemo<GitStatusEntry[]>(() => {
    const entries: GitStatusEntry[] = [];
    for (const file of files) {
      const status = toGitStatus(file.status);
      if (status !== null) entries.push({ path: file.path, status });
    }
    // Folders coloured by the strongest change inside, as in Files.
    const status = new Map<string, GitStatus>();
    for (const entry of entries) status.set(entry.path, entry.status);
    rollUpFolders(status, entries);
    return [...status].map(([path, value]) => ({ path, status: value }));
  }, [files]);

  // NOTE: `onSelectionChange` is read once, when the model is built, so the
  // tree holds the first callback it was given. The ref lets the latest
  // closure run.
  const onSelectRef = useRef(focusFile);
  onSelectRef.current = focusFile;

  const { model } = useFileTree({
    paths,
    // Open: the tree shows what a pull request touches, and a reviewer
    // should not have to click a folder open to find out.
    initialExpansion: "open",
    // Not flattened. Folding `src/components/features/pulls` into one row
    // truncates every segment at 240px, into `compo…/featu…/pu…`. One folder
    // per row costs indentation and keeps names readable.
    flattenEmptyDirectories: false,
    // Off: the filter box above drives `setSearch()` instead. `true` draws the
    // library's own search field inside the shadow root, which takes no
    // placeholder and exposes only bg/fg/font-weight overrides. The flag only
    // decides whether that field is drawn; `setSearch()` works either way.
    search: false,
    icons: FILE_TREE_ICONS,
    // Drawn as Repository › Files draws its tree: folder icons, folders
    // coloured by what changed inside, 22px rows.
    unsafeCSS: TREE_ICON_TINT_CSS + FOLDER_ICON_CSS + FOLDER_STATUS_CSS,
    density: "compact",
    itemHeight: 22,
    gitStatus,
    onSelectionChange: (selected) => {
      const [path] = selected;
      if (path !== undefined) onSelectRef.current(path);
    },
  });

  // The model outlives the props it was built from: another pull request, or
  // another commit within one, hands the same tree new paths.
  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  // The library's own filter, driven from our input rather than reimplemented.
  // The tree already matches a path, expands the folders around a hit and
  // keeps its virtualization honest; a second filter over `paths` would
  // disagree with it the first time someone typed a path separator.
  useEffect(() => {
    model.setSearch(query.trim() === "" ? null : query);
  }, [model, query]);

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
            // The count lives in the placeholder rather than a header row: it
            // costs no space, and it goes away once someone types, which is
            // when the count stops being the question.
            placeholder={`Filter ${files.length} ${files.length === 1 ? "file" : "files"}…`}
            aria-label="Filter files"
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

export function FilesPanel() {
  const filesOpen = usePulls((state) => state.filesOpen);
  const detail = usePulls((state) => state.detail);
  const commit = usePulls((state) => state.commit);
  const commitDiff = usePulls((state) => state.commitDiff);
  const source = useMemo(
    () => diffSource(commit, commitDiff, detail),
    [commit, commitDiff, detail],
  );

  // No pull request open, or the panel put away. The toggle that brings it
  // back lives in the pull request's own header.
  if (!filesOpen || !source) return null;

  return (
    <aside
      aria-label="Files changed"
      className="bg-sidebar flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {/* NOTE: Keyed by what it lists. The model is built once per mount and
          fed new paths afterwards, but its expansion and selection belong to
          the old list; carried into another commit's files they leave
          folders open that are no longer there. */}
      <Tree key={commit ?? "pull"} files={source.files} />
    </aside>
  );
}
