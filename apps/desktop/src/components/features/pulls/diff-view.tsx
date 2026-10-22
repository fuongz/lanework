import { useCallback, useMemo } from "react";
import { type LoadSides, PatchView } from "#/components/shared/diff/patch-view";
import { usePulls } from "#/stores/pulls";
import type { PullFile } from "../../../../shared/git";

/**
 * A pull request's diff.
 *
 * The drawing lives in {@link PatchView}, shared with the local repository's
 * Changes and History. What is left here is what only a pull request has:
 * GitHub's header-less hunks, its per-file blob reads, and the files it sent
 * no diff for.
 *
 * Unified, not split, because this is the third pane of three: two 300px
 * columns are not a readable diff.
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
 * NOTE: GitHub sends hunks only, with no `diff --git` and no `---`/`+++`, so
 * the headers are rebuilt here from the file list. `/dev/null` on the missing
 * side marks an add or a delete; without it a new file reads as a change to a
 * file that was never there.
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
   * The files on screen: the whole pull request's, or one commit's.
   *
   * A file list rather than a `PullDetail`, because the commit picker
   * can point the diff at one commit. `diffSource` in the store decides; this
   * draws what it says.
   */
  files: PullFile[];
  /** The commit the new side is read at, when unchanged lines are expanded. */
  headSha: string;
  /** The commit the old side is read at; empty when nothing can expand. */
  baseSha: string;
  slug: string;
}) {
  const patch = useMemo(() => toUnifiedPatch(files), [files]);
  const counts = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  /** Files GitHub sent no diff for; they cannot be in the patch at all. */
  const undiffable = useMemo(
    () => files.filter((file) => file.patch === null),
    [files],
  );

  const loadSides = useCallback<LoadSides>(
    async (oldPath, newPath) => {
      const [oldFile, newFile] = await Promise.all([
        baseSha
          ? api().fileText(slug, oldPath, baseSha)
          : Promise.resolve(null),
        api().fileText(slug, newPath, headSha),
      ]);
      if (!oldFile || !newFile)
        throw new Error("Those lines cannot be loaded for this file.");
      return { oldText: oldFile.text, newText: newFile.text };
    },
    [baseSha, headSha, slug],
  );

  // Driven by store state, not a callback: the file tree is a sibling panel,
  // so there is no prop between them.
  const focus = usePulls((state) => state.focus);

  const notes =
    undiffable.length > 0 ? (
      <div className="p-4 pb-0">
        <p className="text-muted-foreground bg-foreground/[0.04] rounded-md px-3 py-2 text-xs/relaxed">
          {/* Named rather than dropped. GitHub omits `patch` for binary files
              and for diffs it considers too large, and a file that silently
              vanished is one someone approves without seeing. */}
          No diff from GitHub for{" "}
          {undiffable.map((file) => file.path).join(", ")} — binary, or too
          large to show here.
        </p>
      </div>
    ) : undefined;

  return (
    <PatchView
      patch={patch}
      counts={counts}
      loadSides={loadSides}
      diffStyle="unified"
      focus={focus}
      header={notes}
    />
  );
}
