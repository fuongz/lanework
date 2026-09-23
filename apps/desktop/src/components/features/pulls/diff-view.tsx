import {
  type CodeViewItem,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
  parsePatchFiles,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePulls } from "#/stores/pulls";
import type { PullFile } from "../../../../shared/git";
import { DiffFileHeader } from "./diff-file-header";
import { useDark } from "./diff-view.theme";

/**
 * A pull request's diff, rendered by `@pierre/diffs`.
 *
 * ⚠️ This replaced a hand-written patch parser and gap expander. The library
 * brings the two things that version could not: syntax highlighting, and
 * expansion that works in both directions from a real copy of the file rather
 * than twenty lines downwards from the top of a gap.
 *
 * ⚠️ Unified, not split, and that is decided by the width this lives in — the
 * third pane of three. Two 300px columns is not a diff anybody can read.
 *
 * ⚠️ `CodeView`, not `PatchDiff`. `PatchDiff` refuses a patch naming more than
 * one file — "Provided patch must contain exactly 1 file diff" — which a pull
 * request almost always does. `CodeView` is the library's list of diffs and it
 * virtualizes them, so a forty-file review renders what is on screen rather
 * than all of it.
 */

const api = () => {
  const surface = window.desktop?.git;
  if (!surface)
    throw new Error("This window is not connected to the desktop app.");
  return surface;
};

/**
 * GitHub's per-file `patch` as a patch the parser will accept.
 *
 * ⚠️ GitHub sends HUNKS ONLY — no `diff --git`, no `---`/`+++`. A parser handed
 * those hunks alone has no idea which file they belong to, so the headers are
 * rebuilt here from what the file list already states. `/dev/null` on the side
 * that does not exist is what marks an add or a delete; without it a new file
 * reads as a modification of a file that was never there.
 */
function toUnifiedPatch(files: PullFile[]): string {
  const parts: string[] = [];
  for (const file of files) {
    if (file.patch === null) continue;
    const from = file.previousPath ?? file.path;
    const to = file.path;
    const oldSide = file.status === "added" ? "/dev/null" : `a/${from}`;
    const newSide = file.status === "removed" ? "/dev/null" : `b/${to}`;
    parts.push(
      `diff --git a/${from} b/${to}`,
      `--- ${oldSide}`,
      `+++ ${newSide}`,
      file.patch.replace(/\n$/, ""),
    );
  }
  return parts.length ? `${parts.join("\n")}\n` : "";
}

export function DiffView({
  files,
  headSha,
  baseSha,
  slug,
}: {
  /**
   * The files on screen — the whole pull request's, or one commit's.
   *
   * ⚠️ A file list rather than the `PullDetail` this used to take. The commit
   * picker means the diff is no longer always showing the pull request, and a
   * component that read `detail.files` itself could not be pointed anywhere
   * else. `diffSource` in the store is what decides; this draws what it says.
   */
  files: PullFile[];
  /** The commit the new side is read at, when unchanged lines are expanded. */
  headSha: string;
  /** The commit the old side is read at. Empty when there is nothing to expand. */
  baseSha: string;
  slug: string;
}) {
  const dark = useDark();
  /**
   * Which files are folded shut, by item id.
   *
   * ⚠️ Held HERE, not by the library. `collapsed` is a field on each item and
   * `CodeView` is controlled, so the host owns the state and the control that
   * flips it — the library ships neither.
   */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const patch = useMemo(() => toUnifiedPatch(files), [files]);

  /**
   * The handle the tree steers.
   *
   * ⚠️ `scrollTo` is the only way to reach a file that virtualization has not
   * rendered yet. An anchor or a `scrollIntoView` on the header element works
   * for the three files on screen and silently does nothing for the other
   * thirty-seven.
   */
  const view = useRef<CodeViewHandle<undefined, undefined>>(null);

  /** Files GitHub sent no diff for; they cannot be in the patch at all. */
  const undiffable = useMemo(
    () => files.filter((file) => file.patch === null),
    [files],
  );

  /**
   * GitHub's own line counts, by path.
   *
   * ⚠️ Taken from the file list rather than summed from the parsed hunks. They
   * are the numbers the pull request header already shows, and a file whose
   * patch GitHub truncated has hunks that add up to less than what changed.
   */
  const counts = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );

  /**
   * Both sides of a file in full, so the renderer can open the lines a patch
   * leaves out.
   *
   * ⚠️ Called only when somebody expands something — never as part of drawing
   * the diff. A pull request touching forty files would otherwise be eighty
   * blob reads for context nobody asked to see.
   */
  const loadDiffFiles = useCallback(
    async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      const newPath = fileDiff.name;
      const oldPath = fileDiff.prevName ?? fileDiff.name;
      const [oldFile, newFile] = await Promise.all([
        baseSha
          ? api().fileText(slug, oldPath, baseSha)
          : Promise.resolve(null),
        api().fileText(slug, newPath, headSha),
      ]);
      if (!oldFile || !newFile)
        throw new Error("Those lines cannot be loaded for this file.");
      return {
        oldFile: { name: oldPath, contents: oldFile.text },
        newFile: { name: newPath, contents: newFile.text },
      };
    },
    [baseSha, headSha, slug],
  );

  const options = useMemo(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: dark ? ("dark" as const) : ("light" as const),
      diffStyle: "unified" as const,
      overflow: "scroll" as const,
      stickyHeaders: true,
      // ⚠️ The JS highlighter, not the wasm one. This window's CSP is
      // `script-src 'self'` with no `wasm-unsafe-eval` (see `protocol.ts`), so
      // the wasm engine would be blocked — silently, at highlight time.
      preferredHighlighter: "shiki-js" as const,
      // ⚠️ `paddingTop: 0` so the list starts directly under the pull request's
      // header rather than 8px below it, and `gap: 0` so the files read as one
      // list instead of a column of loose cards. The gap was doing nothing a
      // rule between the rows does not do better: on a 40-file pull request it
      // was 312px of nothing, which is a screenful of scrolling to see the same
      // names. Separation now comes from the hairline on each header — see
      // `DiffFileHeader`.
      layout: { paddingTop: 0, paddingBottom: 8, gap: 0 },
      loadDiffFiles,
    }),
    [dark, loadDiffFiles],
  );

  /**
   * One item per file.
   *
   * ⚠️ Parsed from the patch rather than assembled from `detail.files`: the
   * parser is what turns hunk text into the `FileDiffMetadata` the renderer
   * wants, and a second producer of that shape here would drift from it.
   */
  const items = useMemo<CodeViewItem<undefined>[]>(() => {
    if (!patch) return [];
    const files = parsePatchFiles(patch).flatMap((parsed) => parsed.files);
    return files.map((fileDiff, index) => {
      // The name is unique within one pull request; the index rides along so a
      // malformed entry cannot collide with a real one.
      const id = `${index}:${fileDiff.name}`;
      const shut = collapsed[id] === true;
      return {
        id,
        type: "diff" as const,
        fileDiff,
        collapsed: shut,
        // ⚠️ `version` has to move when the item's value does. CodeView diffs
        // items by it, so a changed `collapsed` with an unchanged version is a
        // change it ignores — the button clicks and nothing folds.
        version: shut ? 1 : 0,
      };
    });
  }, [patch, collapsed]);

  /** Every file's item id, so the tree can name one by path. */
  const idByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items)
      if (item.type === "diff") map.set(item.fileDiff.name, item.id);
    return map;
  }, [items]);

  /**
   * The whole file header, ours rather than the library's.
   *
   * ⚠️ `renderCustomHeader`, not the three slot renderers beside it. The file
   * type icon replaces the library's change symbol, the directory is a
   * different colour from the filename, and the row carries actions — none of
   * which is an addition to the default header, so there is nothing left of it
   * to keep.
   */
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
          onToggle={() =>
            setCollapsed((current) => ({
              ...current,
              [item.id]: current[item.id] !== true,
            }))
          }
        />
      );
    },
    [collapsed, counts],
  );

  /**
   * Put a file on screen when the tree asks for one.
   *
   * ⚠️ Driven by store state rather than by a callback the tree holds. The tree
   * is a sibling panel, not a child — there is no prop between them — and a
   * function parked in the store for it to call would be state that cannot be
   * serialised, compared or replayed. A path and a timestamp can.
   *
   * ⚠️ Unfolding is part of the answer. Landing on a collapsed header would
   * look exactly like a click that did nothing.
   */
  const focus = usePulls((state) => state.focus);
  useEffect(() => {
    if (!focus) return;
    const id = idByPath.get(focus.path);
    if (id === undefined) return;
    setCollapsed((current) =>
      current[id] === true ? { ...current, [id]: false } : current,
    );
    view.current?.scrollTo({ type: "item", id, align: "start" });
  }, [focus, idByPath]);

  const notes =
    undiffable.length > 0 ? (
      <p className="text-muted-foreground bg-foreground/[0.04] rounded-md px-3 py-2 text-xs/relaxed">
        {/* ⚠️ Named rather than dropped. GitHub omits `patch` for binary files
            and for diffs it considers too large, and a file that silently
            vanished from the list is one somebody approves without seeing. */}
        No diff from GitHub for {undiffable.map((file) => file.path).join(", ")}{" "}
        — binary, or too large to show here.
      </p>
    ) : null;

  if (!items.length)
    return (
      <div className="flex flex-col gap-3 p-4">
        {notes}
        <p className="text-muted-foreground text-xs">Nothing to show here.</p>
      </div>
    );

  return (
    <CodeView
      ref={view}
      items={items}
      options={options}
      renderCustomHeader={renderCustomHeader}
      // ⚠️ `overflow-y-auto` HERE, on CodeView's own root. It virtualizes
      // against this element, so it must be the scroller — but it does not set
      // `overflow` itself, and without this the root computes `visible`, the
      // content spills past it and the nearest `overflow-hidden` ancestor clips
      // it. The diff then simply cannot be scrolled. Equally, it must not be
      // nested inside a second scroller, which would leave it no viewport to
      // measure and make it render every line of every file.
      className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      renderCodeViewHeader={
        notes ? () => <div className="p-4 pb-0">{notes}</div> : undefined
      }
    />
  );
}
