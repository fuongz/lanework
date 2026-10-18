import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FILE_TREE_ICONS,
  TREE_ICON_TINT_CSS,
} from "#/components/shared/diff/diff-icons";
import { treeHostStyle } from "#/components/shared/diff/tree-style";
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
 * ⚠️ A COLUMN of the window, beside the pull request rather than inside it. It
 * used to sit within the detail pane, which put it below that pane's header and
 * above its review footer — a sidebar boxed inside the thing it navigates. As
 * its own column it runs the full height, the way the project rail and the pull
 * request list do.
 *
 * ⚠️ It holds the CHANGED files, not the repository. Nothing in this app has the
 * repo's file list — `PullDetail` carries what GitHub said changed and
 * `git.fileText` fetches one blob at a time — and a tree that enumerated a
 * repository over the API to draw a sidebar would spend a rate limit on it. It
 * is the right content anyway: this is a review, and a file nobody touched is
 * not part of one.
 *
 * ⚠️ Rendered by `@pierre/trees`, which is a WEB COMPONENT with its own shadow
 * root. Nothing here can reach inside it with a class, so everything this screen
 * wants from it arrives as a CSS variable on the host or as `unsafeCSS`.
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
    return entries;
  }, [files]);

  // ⚠️ `onSelectionChange` is a CONSTRUCTION-time option and the model is built
  // exactly once, so the callback the tree holds is the first one it was given.
  // The ref is what lets a fresh closure still be the one that runs.
  const onSelectRef = useRef(focusFile);
  onSelectRef.current = focusFile;

  const { model } = useFileTree({
    paths,
    // Open, not closed: this tree exists to show what a pull request touches,
    // and a reviewer should not have to click a folder open to find out.
    initialExpansion: "open",
    // ⚠️ NOT flattened. The library will fold `src/components/features/pulls`
    // into one row, which is what an editor does in a wide sidebar — and at
    // 240px it truncates every segment of that row at once, into
    // `compo…/featu…/pu…`. One folder per row costs indentation and gives back
    // names somebody can actually read.
    flattenEmptyDirectories: false,
    // ⚠️ FALSE, and the filter box in the header above drives `setSearch()`
    // instead. `true` renders the library's OWN search field inside the shadow
    // root — which put two search boxes on top of each other — and that field
    // takes no placeholder and exposes only bg/fg/font-weight overrides, so it
    // can neither say "Filter 8 files…" nor be shaped like the rest of the app.
    // The controller's search does not consult this flag; it only decides
    // whether the library draws a field of its own.
    search: false,
    icons: FILE_TREE_ICONS,
    unsafeCSS: TREE_ICON_TINT_CSS,
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

  // ⚠️ The library's OWN filter, driven from our input rather than reimplemented
  // beside it. `useFileTree` is constructed with `search: true`, so the tree
  // already knows how to match a path, expand the folders around a hit and keep
  // its virtualization honest; a second filter over `paths` would disagree with
  // it the first time somebody typed a path separator.
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
            // ⚠️ The count lives HERE, in the placeholder, rather than in the
            // `FILES 15` header this input replaced. It is the same fact and it
            // costs no row; but it disappears as soon as somebody types, which
            // is exactly when "how many files are in this pull request" stops
            // being the question they are asking.
            placeholder={`Filter ${files.length} ${files.length === 1 ? "file" : "files"}…`}
            aria-label="Filter files"
            className="text-xs"
          />
        </InputGroup>
      </div>
      <FileTree
        model={model}
        className="min-h-0 flex-1"
        style={treeHostStyle(dark)}
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

  // No pull request open, or the panel put away. Nothing to say about either —
  // the toggle that brings it back lives in the pull request's own header.
  if (!filesOpen || !source) return null;

  return (
    <aside
      aria-label="Files changed"
      className="bg-sidebar flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {/* ⚠️ Keyed by what it is listing. The tree model is built once per mount
          and fed new paths afterwards — but its EXPANSION and selection are
          about the old list, and carrying those into another commit's files
          leaves folders open that are no longer there. */}
      <Tree key={commit ?? "pull"} files={source.files} />
    </aside>
  );
}
