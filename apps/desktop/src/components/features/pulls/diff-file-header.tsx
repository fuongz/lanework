import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { FileTypeIcon } from "./diff-view.icons";

/**
 * The row that names one file in a diff.
 *
 * ⚠️ A CUSTOM header, replacing the library's own. `@pierre/diffs` draws a good
 * one — but it draws a change-type symbol rather than a file-type icon, it
 * paints the whole path in a single colour, and it has nowhere to put a row
 * action. Each of those is a thing this screen wants, and the library's three
 * slot props (prefix, filename suffix, metadata) can add to that header without
 * ever changing the three parts themselves.
 *
 * ⚠️ The library styles `[data-diffs-header="default"]` and NOT `"custom"` — no
 * padding, no min-height, no layout — so everything below is this file's job.
 * What survives the swap is `[data-diffs-header][data-sticky]`, which keeps the
 * row pinned and opaque while its file scrolls under it.
 */

/** A path split where the reader needs it: everything above the file, and the file. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/**
 * Copy, with the tick that says it happened.
 *
 * ⚠️ The confirmation is the whole point. `navigator.clipboard.writeText`
 * resolves silently, and a button that looks identical before and after the
 * click is one people press three times.
 */
function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={copied ? `Copied ${path}` : `Copy path ${path}`}
      title="Copy file path"
      onClick={() => {
        void navigator.clipboard
          .writeText(path)
          .then(() => setCopied(true))
          .catch(() => {
            // Nothing to say: the clipboard was refused, and the tick staying
            // away is already the honest answer.
          });
      }}
      className="hover:bg-foreground/[0.08] focus-visible:ring-accent-brand flex size-5 items-center justify-center rounded outline-none focus-visible:ring-2"
    >
      <HugeiconsIcon
        icon={copied ? Tick02Icon : Copy01Icon}
        className={
          copied
            ? "size-3.5 text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground size-3.5"
        }
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </button>
  );
}

export function DiffFileHeader({
  path,
  previousPath,
  additions,
  deletions,
  collapsed,
  onToggle,
}: {
  path: string;
  previousPath: string | null;
  additions: number;
  deletions: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { dir, name } = splitPath(path);

  return (
    // ⚠️ `focus-within`, beside `hover`, on every rule that reveals an action.
    // Actions that only appear under a pointer are actions a keyboard can tab
    // into and never see — including the control that folds the file.
    // ⚠️ `h-9` and a hairline, not `h-11` with a gap around it. The rows carry
    // one line of text each and now sit flush against one another, so the rule
    // is what separates them — 44px of height plus 8px of gap was a card, and a
    // list of forty of them scrolled like one.
    <div className="group hover:bg-foreground/[0.04] focus-within:bg-foreground/[0.04] border-sidebar-border flex h-9 min-w-0 items-center gap-2 border-b px-4">
      <FileTypeIcon path={path} className="size-4 shrink-0" />

      {/* ⚠️ The whole name is the fold control, as it is in a file list — the
          icon buttons beside it are for the things a click on the row cannot
          also mean. `min-w-0` so the path, not the row, is what truncates. */}
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${path}`}
        onClick={onToggle}
        className="focus-visible:ring-accent-brand flex min-w-0 items-center rounded text-[13px] outline-none focus-visible:ring-2"
      >
        {dir && (
          // ⚠️ `direction: rtl` is what puts the ellipsis at the START of the
          // directory. A path truncated from the right loses the filename,
          // which is the only part of it anybody was reading.
          <span className="text-muted-foreground min-w-0 truncate [direction:rtl]">
            <bdi>{dir}</bdi>
          </span>
        )}
        <span className="shrink-0 font-medium">{name}</span>
      </button>

      {previousPath !== null && (
        <span className="text-muted-foreground shrink-0 text-[11px]">
          renamed from <bdi>{previousPath}</bdi>
        </span>
      )}

      <span className="shrink-0 font-mono text-[11px] tabular-nums">
        {additions > 0 && (
          <span className="text-emerald-600 dark:text-emerald-400">
            +{additions}
          </span>
        )}
        {additions > 0 && deletions > 0 && " "}
        {deletions > 0 && (
          <span className="text-rose-600 dark:text-rose-400">-{deletions}</span>
        )}
      </span>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <CopyPath path={path} />
        <button
          type="button"
          aria-hidden="true"
          // The name's button already exposes the fold to assistive tech and to
          // the keyboard; this one is the affordance a pointer looks for, and
          // announcing the same control twice on one row helps nobody.
          tabIndex={-1}
          title={collapsed ? "Expand file" : "Collapse file"}
          onClick={onToggle}
          className="hover:bg-foreground/[0.08] flex size-5 items-center justify-center rounded"
        >
          <HugeiconsIcon
            icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
            className="text-muted-foreground size-3.5"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>
      </span>
    </div>
  );
}
