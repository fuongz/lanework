import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type CodeViewItem,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
  parsePatchFiles,
} from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PullDetail, PullFile } from "../../../../shared/git";

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

/**
 * Whether the window is in dark mode, kept in step.
 *
 * ⚠️ Read from the `dark` class on `<html>`, NOT from `prefers-color-scheme`.
 * `use-theme.ts` documents why: that media query does not follow
 * `nativeTheme.themeSource` in this Electron build, so main resolves the theme
 * and the class is the only thing in the renderer that is reliably true. The
 * library's own `themeType: 'system'` would consult the broken query.
 */
function useDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document === "undefined"
      ? false
      : document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() =>
      setDark(root.classList.contains("dark")),
    );
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export function DiffView({
  detail,
  slug,
}: {
  detail: PullDetail;
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
  const patch = useMemo(() => toUnifiedPatch(detail.files), [detail.files]);

  /** Files GitHub sent no diff for; they cannot be in the patch at all. */
  const undiffable = useMemo(
    () => detail.files.filter((file) => file.patch === null),
    [detail.files],
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
        detail.baseSha
          ? api().fileText(slug, oldPath, detail.baseSha)
          : Promise.resolve(null),
        api().fileText(slug, newPath, detail.headSha),
      ]);
      if (!oldFile || !newFile)
        throw new Error("Those lines cannot be loaded for this file.");
      return {
        oldFile: { name: oldPath, contents: oldFile.text },
        newFile: { name: newPath, contents: newFile.text },
      };
    },
    [detail.baseSha, detail.headSha, slug],
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

  /**
   * The fold control, drawn into each file's header.
   *
   * ⚠️ A real `<button>` with `aria-expanded` and the file's name in its label.
   * A bare chevron is unreachable by keyboard and says nothing to a screen
   * reader — and this is the control that decides whether a reviewer can see a
   * file at all.
   */
  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem<undefined>) => {
      const shut = collapsed[item.id] === true;
      const name = item.type === "diff" ? item.fileDiff.name : item.id;
      return (
        <button
          type="button"
          aria-expanded={!shut}
          aria-label={`${shut ? "Expand" : "Collapse"} ${name}`}
          onClick={() =>
            setCollapsed((current) => ({ ...current, [item.id]: !shut }))
          }
          className="hover:bg-foreground/[0.08] focus-visible:ring-accent-brand -ml-1 flex size-5 items-center justify-center rounded transition-colors outline-none focus-visible:ring-2"
        >
          <HugeiconsIcon
            icon={shut ? ArrowRight01Icon : ArrowDown01Icon}
            className="size-3.5 opacity-70"
            strokeWidth={2}
            aria-hidden="true"
          />
        </button>
      );
    },
    [collapsed],
  );

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
        <p className="text-muted-foreground text-xs">
          No file changes in this pull request.
        </p>
      </div>
    );

  return (
    <CodeView
      items={items}
      options={options}
      renderHeaderPrefix={renderHeaderPrefix}
      // ⚠️ `overflow-y-auto` HERE, on CodeView's own root. It virtualizes
      // against this element, so it must be the scroller — but it does not set
      // `overflow` itself, and without this the root computes `visible`, the
      // content spills past it and the nearest `overflow-hidden` ancestor clips
      // it. The diff then simply cannot be scrolled. Equally, it must not be
      // nested inside a second scroller, which would leave it no viewport to
      // measure and make it render every line of every file.
      className="min-h-0 flex-1 overflow-y-auto"
      renderCodeViewHeader={
        notes ? () => <div className="p-4 pb-0">{notes}</div> : undefined
      }
    />
  );
}
