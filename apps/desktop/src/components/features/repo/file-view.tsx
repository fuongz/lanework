// The editor side of Repository › Files: tabs, the open file's header, and
// the file itself, read-only (FE-66/D1).
//
// `CodeView` with one `file` item rather than `File`: it virtualizes, so a
// two-megabyte file draws the lines on screen, not forty thousand of them,
// and it is the same renderer (theme, highlighter, font) the diffs use.
import {
  Copy01Icon,
  Folder01Icon,
  GitCompareIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CodeViewItem } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { SegmentedControl } from "#/components/shared/common/segmented-control";
import { useCopy } from "#/components/shared/common/use-copy";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { useDark } from "#/components/shared/diff/use-dark";
import { EditorTabs } from "#/components/shared/editor/editor-tabs";
import { DocumentSkeleton } from "#/components/shared/loading/skeletons";
import { RepoMessage } from "#/components/shared/repo/repo-empty";
import { Button } from "#/components/ui/button";
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

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileTabs({ changes }: { changes: WorktreeFile[] }) {
  const tabs = useFiles((state) => state.tabs);
  const active = useFiles((state) => state.active);
  const activate = useFiles((state) => state.activate);
  const close = useFiles((state) => state.close);
  const pin = useFiles((state) => state.pin);

  return (
    <EditorTabs
      tabs={tabs.map((tab) => {
        const status = changes.find((file) => file.path === tab.path)?.status;
        return {
          id: tab.path,
          label: basename(tab.path),
          path: tab.path,
          preview: tab.preview,
          labelClassName: status && STATUS_TONE[status],
        };
      })}
      active={active}
      onActivate={activate}
      onClose={close}
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
  const [copied, copy] = useCopy();
  const segments = path.split("/");

  return (
    <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-3">
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

function Code({ path, text }: { path: string; text: string }) {
  const dark = useDark();
  // NOTE: `version` has to move when the text does. CodeView compares items
  // by it, and a refresh that read new text under the same id is ignored.
  const version = useRef(0);
  const last = useRef(text);
  if (last.current !== text) {
    last.current = text;
    version.current++;
  }

  const options = useMemo(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: dark ? ("dark" as const) : ("light" as const),
      overflow: "scroll" as const,
      // The header above is this screen's own; the library's would repeat it.
      disableFileHeader: true,
      // NOTE: The JS highlighter. The window's CSP blocks the wasm one (see
      // `patch-view.tsx`).
      preferredHighlighter: "shiki-js" as const,
      // A minified bundle is one enormous line; past these it is drawn plain
      // rather than tokenised for seconds.
      tokenizeMaxLineLength: 2_000,
      tokenizeMaxLength: 400_000,
      layout: { paddingTop: 4, paddingBottom: 8, gap: 0 },
    }),
    [dark],
  );

  const items = useMemo<CodeViewItem<undefined>[]>(
    () => [
      {
        id: path,
        type: "file",
        file: { name: path, contents: text },
        version: version.current,
      },
    ],
    [path, text],
  );

  return (
    <CodeView
      items={items}
      options={options}
      // The scroller CodeView virtualizes against — see `patch-view.tsx`.
      className="min-h-0 min-w-0 flex-1 overflow-y-auto"
    />
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
      <p className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {natural ? `${natural.w} × ${natural.h} · ` : ""}
        {formatSize(size)}
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
        description={`${formatSize(view.size)} — there is no text to show.`}
      />
    );
  else if (view.kind === "too-large")
    body = (
      <RepoMessage
        title="Too large to show"
        description={`${formatSize(view.size)}. Files over 2 MB open in your editor, not here.`}
      />
    );
  else if (markdown && rendered)
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-6">
          <MarkdownBody source={view.text} empty="This file is empty." />
        </div>
      </div>
    );
  else body = <Code path={active} text={view.text} />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FileHeader
        slug={slug}
        path={active}
        status={status}
        markdown={markdown && view?.kind === "text"}
        changesLink={changesLink}
      />
      {body}
    </div>
  );
}
