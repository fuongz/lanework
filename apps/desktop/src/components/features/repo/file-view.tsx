// The editor side of Repository › Files: tabs, the open file's header, and
// the file itself. A text file is editable (`file-editor.tsx`, loaded on
// demand); images, binaries and files too large stay read-only.
import {
  Alert02Icon,
  Copy01Icon,
  Folder01Icon,
  GitCompareIcon,
  Tick02Icon,
  UndoIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { SegmentedControl } from "#/components/shared/common/segmented-control";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { EditorTabs } from "#/components/shared/editor/editor-tabs";
import { DocumentSkeleton } from "#/components/shared/loading/skeletons";
import { RepoMessage } from "#/components/shared/repo/repo-empty";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { useCopy } from "#/hooks/use-copy";
import { fileSize } from "#/lib/file-size";
import { isMarkdown, useFiles } from "#/stores/files";
import { useWorktree } from "#/stores/worktree";
import type {
  WorktreeFile,
  WorktreeFileStatus,
} from "../../../../shared/worktree";

const STATUS_LETTER: Record<WorktreeFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

const STATUS_TONE: Record<WorktreeFileStatus, string> = {
  added: "text-emerald-600 dark:text-emerald-400",
  modified: "text-amber-600 dark:text-amber-400",
  deleted: "text-rose-600 dark:text-rose-400",
  renamed: "text-violet-600 dark:text-violet-400",
  untracked: "text-emerald-600 dark:text-emerald-400",
  conflicted: "text-rose-600 dark:text-rose-400",
};

/** The editor's code, fetched the first time a text file opens. */
const FileEditor = lazy(() =>
  import("./file-editor").then((module) => ({ default: module.FileEditor })),
);

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function FileTabs({ changes }: { changes: WorktreeFile[] }) {
  const tabs = useFiles((state) => state.tabs);
  const active = useFiles((state) => state.active);
  const activate = useFiles((state) => state.activate);
  const requestClose = useFiles((state) => state.requestClose);
  const pin = useFiles((state) => state.pin);
  const buffers = useFiles((state) => state.buffers);

  return (
    <EditorTabs
      surface="editor"
      tabs={tabs.map((tab) => {
        const status = changes.find((file) => file.path === tab.path)?.status;
        return {
          id: tab.path,
          label: basename(tab.path),
          path: tab.path,
          preview: tab.preview,
          dirty: buffers[tab.path]?.dirty === true,
          labelClassName: status && STATUS_TONE[status],
        };
      })}
      active={active}
      onActivate={activate}
      onClose={(path) => requestClose([path])}
      onCloseOthers={(path) =>
        requestClose(
          tabs.map((tab) => tab.path).filter((other) => other !== path),
        )
      }
      onCloseAll={() => requestClose(tabs.map((tab) => tab.path))}
      onPin={pin}
    />
  );
}

function FileHeader({
  slug,
  path,
  status,
  markdown,
  changesLink,
}: {
  slug: string;
  path: string;
  status: WorktreeFileStatus | undefined;
  markdown: boolean;
  /** False for a non-primary folder: Changes shows the primary's (FE-71/D1). */
  changesLink: boolean;
}) {
  const navigate = useNavigate();
  const focusFile = useWorktree((state) => state.focusFile);
  const rendered = useFiles((state) => state.rendered[path] === true);
  const toggleRendered = useFiles((state) => state.toggleRendered);
  const dirty = useFiles((state) => state.buffers[path]?.dirty === true);
  const revert = useFiles((state) => state.revert);
  const [copied, copy] = useCopy();
  const segments = path.split("/");

  return (
    <div className="border-editor-rule flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <nav
        aria-label="File path"
        className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1 text-xs"
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
        {status && (
          <span
            className={cn("shrink-0 font-medium", STATUS_TONE[status])}
            title={status}
          >
            {STATUS_LETTER[status]}
          </span>
        )}
      </nav>
      {dirty && (
        <Button
          variant="ghost"
          size="sm"
          title="Drop the unsaved edits"
          onClick={() => revert(path)}
        >
          <HugeiconsIcon icon={UndoIcon} strokeWidth={1.8} aria-hidden="true" />
          Revert File
        </Button>
      )}
      {markdown && (
        <SegmentedControl
          label="Markdown view"
          semantics="tabs"
          options={[
            { value: "source", label: "Source" },
            { value: "preview", label: "Preview" },
          ]}
          value={rendered ? "preview" : "source"}
          onChange={() => toggleRendered(path)}
        />
      )}
      {status && changesLink && (
        // The file's change, on the screen that shows changes (FE-66/D7).
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            focusFile(path);
            void navigate({ to: "/w/$slug/changes", params: { slug } });
          }}
        >
          <HugeiconsIcon
            icon={GitCompareIcon}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          View Changes
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy path"
        title={copied === "path" ? "Copied" : "Copy path"}
        onClick={() => copy("path", path)}
      >
        <HugeiconsIcon
          icon={copied === "path" ? Tick02Icon : Copy01Icon}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Reveal in Finder"
        title="Reveal in Finder"
        onClick={() => void window.desktop?.worktree.reveal(slug, path)}
      >
        <HugeiconsIcon
          icon={Folder01Icon}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </Button>
    </div>
  );
}

/**
 * Why the edits and the disk disagree, above the editor, with the two ways
 * out: take the disk's text, or write the edits over it.
 */
function ConflictBanner({ path }: { path: string }) {
  const conflict = useFiles((state) => state.buffers[path]?.conflict ?? null);
  const saving = useFiles((state) => state.buffers[path]?.saving === true);
  const reload = useFiles((state) => state.reload);
  const overwrite = useFiles((state) => state.overwrite);
  if (!conflict) return null;
  const copy =
    conflict.kind === "changed"
      ? {
          title: "Changed on disk",
          description:
            "Another program changed this file after it was opened. Reload takes its version and drops your edits; Overwrite saves yours over it.",
        }
      : conflict.kind === "missing"
        ? {
            title: "Deleted on disk",
            description:
              "The file was moved or deleted after it was opened. Overwrite saves your edits as a new file at this path.",
          }
        : { title: "Not saved", description: conflict.message };
  return (
    <div className="border-border shrink-0 border-b p-2">
      <Alert className="flex items-start gap-2">
        <HugeiconsIcon
          icon={Alert02Icon}
          strokeWidth={1.8}
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <div className="min-w-0 flex-1">
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>{copy.description}</AlertDescription>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 self-center">
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => void reload(path)}
          >
            Reload
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={saving}
            onClick={() => void overwrite(path)}
          >
            {saving ? "Saving…" : "Overwrite"}
          </Button>
        </div>
      </Alert>
    </div>
  );
}

/**
 * An image, whole, on a checkerboard so a transparent PNG still has edges.
 *
 * Its natural size and weight go underneath, as an editor's preview shows.
 */
function ImageBody({
  path,
  url,
  size,
}: {
  path: string;
  url: string;
  size: number;
}) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-6">
      <img
        src={url}
        alt={basename(path)}
        onLoad={(event) =>
          setNatural({
            w: event.currentTarget.naturalWidth,
            h: event.currentTarget.naturalHeight,
          })
        }
        className="max-h-full min-h-0 max-w-full rounded-md object-contain [background:repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)_0_0/16px_16px]"
      />
      <p className="text-muted-foreground flex shrink-0 gap-3 text-xs tabular-nums">
        {natural && (
          <span>
            {natural.w} × {natural.h}
          </span>
        )}
        <span>{fileSize(size)}</span>
      </p>
    </div>
  );
}

export function FileView({
  slug,
  changes,
  changesLink = true,
}: {
  slug: string;
  changes: WorktreeFile[];
  changesLink?: boolean;
}) {
  const active = useFiles((state) => state.active);
  const view = useFiles((state) => (active ? state.views[active] : undefined));
  const failed = useFiles((state) =>
    active ? state.viewErrors[active] : undefined,
  );
  const rendered = useFiles((state) =>
    active ? state.rendered[active] === true : false,
  );
  const slugNow = useFiles((state) => state.slug);
  const folder = useFiles((state) => state.folder);
  // The live buffer: Preview renders the edits, not the file on disk.
  const bufferText = useFiles((state) =>
    active ? state.buffers[active]?.text : undefined,
  );

  if (!active)
    return (
      <RepoMessage
        title="No file open"
        description="Pick a file in the tree, or press ⌘P to find one by name."
      />
    );

  const markdown = isMarkdown(active);
  const status = changes.find((file) => file.path === active)?.status;

  let body: ReactNode;
  if (failed)
    body = (
      <RepoMessage title="This file could not be read" description={failed} />
    );
  else if (!view) body = <DocumentSkeleton label="Reading the file" code />;
  else if (view.kind === "missing")
    body = (
      <RepoMessage
        title="The file is gone"
        description="It was moved or deleted since the tree was read."
      />
    );
  else if (view.kind === "image")
    body = <ImageBody path={active} url={view.url} size={view.size} />;
  else if (view.kind === "binary")
    body = (
      <RepoMessage
        title="Binary file"
        description={`${fileSize(view.size)} — there is no text to show.`}
      />
    );
  else if (view.kind === "too-large")
    body = (
      <RepoMessage
        title="Too large to show"
        description={`${fileSize(view.size)}. Files over 2 MB open in your editor, not here.`}
      />
    );
  else if (markdown && rendered)
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-6">
          <MarkdownBody
            source={bufferText ?? view.text}
            empty="This file is empty."
          />
        </div>
      </div>
    );
  else if (bufferText === undefined)
    body = <DocumentSkeleton label="Reading the file" code />;
  else {
    const editKey = `${slugNow ?? slug}#${folder}:${active}`;
    body = (
      <Suspense fallback={<DocumentSkeleton label="Opening the editor" code />}>
        <FileEditor key={editKey} editKey={editKey} path={active} />
      </Suspense>
    );
  }

  return (
    <div className="bg-editor flex min-h-0 min-w-0 flex-1 flex-col">
      <FileHeader
        slug={slug}
        path={active}
        status={status}
        markdown={markdown && view?.kind === "text"}
        changesLink={changesLink}
      />
      {view?.kind === "text" && <ConflictBanner path={active} />}
      {body}
    </div>
  );
}
