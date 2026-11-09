import { useEffect, useState } from "react";
import { DocumentSkeleton } from "#/components/shared/loading/skeletons";
import { RepoMessage } from "#/components/shared/repo/repo-empty";
import { Button } from "#/components/ui/button";
import { fileSize } from "#/lib/file-size";
import { ipcMessage } from "#/lib/ipc-error";
import { desktopSurface } from "#/server/desktop";
import type {
  FileView,
  WorktreeFileStatus,
  WorktreePatch,
} from "../../../../shared/worktree";

function ImageSide({
  label,
  path,
  view,
  openPreview,
}: {
  label: string;
  path: string;
  view: FileView;
  openPreview: () => Promise<void>;
}) {
  const [failed, setFailed] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  return (
    <figure className="flex min-w-0 flex-1 flex-col items-center gap-3">
      <figcaption className="text-muted-foreground font-sans text-xs">
        {label}
      </figcaption>
      {view.kind === "image" && !failed ? (
        <>
          <img
            src={view.url}
            alt={`${label}: ${path}`}
            onError={() => setFailed(true)}
            onLoad={(event) =>
              setNatural({
                w: event.currentTarget.naturalWidth,
                h: event.currentTarget.naturalHeight,
              })
            }
            className="max-h-72 max-w-full rounded-md object-contain [background:repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)_0_0/16px_16px]"
          />
          <p className="text-muted-foreground flex gap-3 font-sans text-xs tabular-nums">
            {natural && (
              <span>
                {natural.w} × {natural.h}
              </span>
            )}
            <span>{fileSize(view.size)}</span>
          </p>
        </>
      ) : (
        <RepoMessage
          title={
            view.kind === "too-large"
              ? "Image too large to preview"
              : view.kind === "missing"
                ? "Image unavailable"
                : "Cannot preview this image"
          }
          description={
            view.kind === "too-large"
              ? `${fileSize(view.size)}. Images over 20 MB cannot be previewed.`
              : "The image may be missing or its format may not be supported."
          }
        >
          {view.kind === "too-large" && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={opening}
                onClick={async () => {
                  setOpening(true);
                  setOpenError(null);
                  try {
                    await openPreview();
                  } catch (cause) {
                    setOpenError(
                      ipcMessage(cause, "The image could not be opened."),
                    );
                  } finally {
                    setOpening(false);
                  }
                }}
              >
                {opening ? "Opening…" : "Open in Preview"}
              </Button>
              {openError && (
                <p role="alert" className="text-destructive font-sans text-xs">
                  {openError}
                </p>
              )}
            </>
          )}
        </RepoMessage>
      )}
    </figure>
  );
}

/** Loaded only for visible, expanded files; a fresh patch rereads even binary-only edits. */
export function ChangesImage({
  slug,
  path,
  previousPath,
  status,
  refresh,
}: {
  slug: string;
  path: string;
  previousPath?: string;
  status?: WorktreeFileStatus;
  refresh: WorktreePatch | null;
}) {
  const [result, setResult] = useState<{
    before: FileView | null;
    after: FileView | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh patch must reread binary content even when the textual patch is unchanged.
  useEffect(() => {
    let active = true;
    setResult(null);
    setError(null);
    const api = desktopSurface("worktree");
    Promise.all([
      status === "untracked" || status === "added"
        ? Promise.resolve(null)
        : api.fileImage(slug, previousPath ?? path, {
            kind: "rev",
            rev: "HEAD",
          }),
      status === "deleted"
        ? Promise.resolve(null)
        : api.fileImage(slug, path, { kind: "worktree" }),
    ])
      .then(([before, after]) => {
        if (active) setResult({ before, after });
      })
      .catch((cause: unknown) => {
        if (active) setError(ipcMessage(cause, "The image could not be read."));
      });
    return () => {
      active = false;
    };
  }, [slug, path, previousPath, status, refresh]);

  return (
    // Reserve the preview's height before its bytes arrive, so file navigation
    // does not move its target as preceding images finish decoding.
    <div className="flex h-[26rem] flex-col overflow-auto font-sans">
      {error ? (
        <RepoMessage title="Cannot read this image" description={error} />
      ) : !result ? (
        <DocumentSkeleton label="Reading image preview" lines={3} />
      ) : (
        <div className="flex min-h-0 flex-1 gap-6 p-6">
          {result.before && (
            <ImageSide
              label="Before"
              path={previousPath ?? path}
              view={result.before}
              openPreview={() =>
                desktopSurface("worktree").openImagePreview(
                  slug,
                  previousPath ?? path,
                  { kind: "rev", rev: "HEAD" },
                )
              }
            />
          )}
          {result.after && (
            <ImageSide
              label="After"
              path={path}
              view={result.after}
              openPreview={() =>
                desktopSurface("worktree").openImagePreview(slug, path, {
                  kind: "worktree",
                })
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
