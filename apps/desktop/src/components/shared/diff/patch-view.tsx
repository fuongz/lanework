import {
  type CodeViewItem,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
  parsePatchFiles,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDark } from "#/hooks/use-dark";
import { DiffFileHeader } from "./diff-file-header";

interface FileCounts {
  additions: number;
  deletions: number;
}

/** Both sides of one file in full, to expand the lines a patch leaves out. */
export type LoadSides = (
  oldPath: string,
  newPath: string,
) => Promise<{ oldText: string; newText: string }>;

/**
 * A unified patch, rendered by `@pierre/diffs`: the part of the pull request
 * diff that does not care where the patch came from.
 *
 * Shared by the pull request's Code tab and the local repository's Changes
 * and History. It takes a PATCH, not a pull request's file list: GitHub hands
 * over hunks that need headers first, local git prints a whole patch, and
 * both end here as the same string.
 *
 * `CodeView`, not `PatchDiff`. `PatchDiff` refuses a patch naming more than
 * one file ("Provided patch must contain exactly 1 file diff"), and
 * `CodeView` virtualizes, so a forty-file change renders what is on screen,
 * not all of it.
 */
export function PatchView({
  patch,
  counts,
  loadSides,
  diffStyle,
  focus,
  header,
  fileLeading,
  fileActions,
}: {
  patch: string;
  /**
   * Line counts by path, from whoever produced the patch.
   *
   * NOTE: The caller's numbers, not ones summed from parsed hunks: they are
   * the numbers the list beside the diff already shows, and a patch GitHub
   * truncated has hunks that add up to less than what changed.
   */
  counts: Map<string, FileCounts>;
  loadSides: LoadSides;
  diffStyle: "split" | "unified";
  /** A file to bring on screen; `at` moves on every request, even a repeat. */
  focus: { path: string; at: number } | null;
  /** Drawn above the first file, inside the scroller. */
  header?: ReactNode;
  /** Per-file controls before the name: a stage checkbox. */
  fileLeading?: (path: string) => ReactNode;
  /** Per-file controls after the counts: restore. */
  fileActions?: (path: string) => ReactNode;
}) {
  const dark = useDark();
  // Which files are folded shut, by item id. Held HERE, not by the library:
  // `collapsed` is a field on each item and `CodeView` is controlled, so the
  // host owns the state and the control that flips it.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // The handle `focus` steers. NOTE: `scrollTo` is the only way to reach a
  // file virtualization has not rendered yet. An anchor or `scrollIntoView`
  // on the header works for the files on screen and silently does nothing
  // for the rest.
  const view = useRef<CodeViewHandle<undefined, undefined>>(null);

  // Called only when somebody expands something, never to draw the diff. A
  // change touching forty files would otherwise be eighty reads for context
  // nobody asked to see.
  const loadDiffFiles = useCallback(
    async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      const newPath = fileDiff.name;
      const oldPath = fileDiff.prevName ?? fileDiff.name;
      const { oldText, newText } = await loadSides(oldPath, newPath);
      return {
        oldFile: { name: oldPath, contents: oldText },
        newFile: { name: newPath, contents: newText },
      };
    },
    [loadSides],
  );

  const options = useMemo(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: dark ? ("dark" as const) : ("light" as const),
      diffStyle,
      overflow: "scroll" as const,
      stickyHeaders: true,
      // NOTE: The JS highlighter, not the wasm one. This window's CSP is
      // `script-src 'self'` with no `wasm-unsafe-eval` (see `protocol.ts`), so
      // the wasm engine would be blocked, silently, at highlight time.
      preferredHighlighter: "shiki-js" as const,
      // `gap: 0` so the files read as one list instead of a column of loose
      // cards; the hairline on each header does the separating.
      layout: { paddingTop: 0, paddingBottom: 8, gap: 0 },
      loadDiffFiles,
    }),
    [dark, diffStyle, loadDiffFiles],
  );

  const items = useMemo<CodeViewItem<undefined>[]>(() => {
    if (!patch) return [];
    const files = parsePatchFiles(patch).flatMap((parsed) => parsed.files);
    return files.map((fileDiff, index) => {
      // The name is unique within one change; the index rides along so a
      // malformed entry cannot collide with a real one.
      const id = `${index}:${fileDiff.name}`;
      const shut = collapsed[id] === true;
      return {
        id,
        type: "diff" as const,
        fileDiff,
        collapsed: shut,
        // NOTE: `version` has to move when the item's value does. CodeView
        // diffs items by it, so it ignores a changed `collapsed` with an
        // unchanged version: the button clicks and nothing folds.
        version: shut ? 1 : 0,
      };
    });
  }, [patch, collapsed]);

  const idByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items)
      if (item.type === "diff") map.set(item.fileDiff.name, item.id);
    return map;
  }, [items]);

  const renderCustomHeader = useCallback(
    (item: CodeViewItem<undefined>) => {
      if (item.type !== "diff") return null;
      const path = item.fileDiff.name;
      const file = counts.get(path);
      return (
        <DiffFileHeader
          path={path}
          previousPath={item.fileDiff.prevName ?? null}
          additions={file?.additions ?? 0}
          deletions={file?.deletions ?? 0}
          collapsed={collapsed[item.id] === true}
          leading={fileLeading?.(path)}
          actions={fileActions?.(path)}
          onToggle={() =>
            setCollapsed((current) => ({
              ...current,
              [item.id]: current[item.id] !== true,
            }))
          }
        />
      );
    },
    [collapsed, counts, fileActions, fileLeading],
  );

  // Unfolding is part of the answer. Landing on a collapsed header would look
  // exactly like a click that did nothing.
  useEffect(() => {
    if (!focus) return;
    const id = idByPath.get(focus.path);
    if (id === undefined) return;
    setCollapsed((current) =>
      current[id] === true ? { ...current, [id]: false } : current,
    );
    view.current?.scrollTo({ type: "item", id, align: "start" });
  }, [focus, idByPath]);

  if (!items.length)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {header}
        <p className="text-muted-foreground p-4 text-xs">
          Nothing to show here.
        </p>
      </div>
    );

  return (
    <CodeView
      ref={view}
      items={items}
      options={options}
      renderCustomHeader={renderCustomHeader}
      // NOTE: `overflow-y-auto` HERE, on CodeView's own root. It virtualizes
      // against this element, so it must be the scroller, but it does not set
      // `overflow` itself: without this the root computes `visible` and the
      // nearest `overflow-hidden` ancestor clips it. Nor may it sit inside a
      // second scroller, which would leave it no viewport to measure.
      className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      renderCodeViewHeader={header ? () => header : undefined}
    />
  );
}
