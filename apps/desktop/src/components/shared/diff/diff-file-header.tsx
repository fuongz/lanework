import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import { FileTypeIcon } from "./diff-icons";

/** A path split where the reader needs it: the directory, and the file. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/**
 * Copy, with the tick that says it happened.
 *
 * The confirmation is the point. `navigator.clipboard.writeText` resolves
 * silently, and a button that looks the same before and after the click is
 * one people press three times.
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
            // The clipboard was refused; the tick staying away already says so.
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

/**
 * The row that names one file in a diff.
 *
 * A CUSTOM header, replacing the library's own. `@pierre/diffs` draws a good
 * one, but with a change-type symbol rather than a file-type icon, the whole
 * path in one colour, and nowhere to put a row action. This screen wants all
 * three, and the library's slot props (prefix, filename suffix, metadata) can
 * only add to its header, never change those parts.
 *
 * NOTE: The library styles `[data-diffs-header="default"]` and NOT `"custom"`
 * (no padding, no min-height, no layout), so everything below is this file's
 * job. What survives the swap is `[data-diffs-header][data-sticky]`, which
 * keeps the row pinned and opaque while its file scrolls under it.
 */
export function DiffFileHeader({
  path,
  previousPath,
  additions,
  deletions,
  collapsed,
  onToggle,
  leading,
  actions,
}: {
  path: string;
  previousPath: string | null;
  additions: number;
  deletions: number;
  collapsed: boolean;
  onToggle: () => void;
  /** Before the icon: the stage checkbox on a local change. */
  leading?: ReactNode;
  /**
   * After the counts, and ALWAYS visible, unlike copy and fold.
   *
   * A local change's Restore is a thing somebody came to this row to do, so
   * it does not wait for hover.
   */
  actions?: ReactNode;
}) {
  const { dir, name } = splitPath(path);

  return (
    // NOTE: `focus-within`, beside `hover`, on every rule that reveals an
    // action. Actions that only appear under a pointer are actions a keyboard
    // can tab into and never see, including the control that folds the file.
    // `h-9` and a hairline, not `h-11` with a gap around it: the rows carry
    // one line each and sit flush, so the rule separates them. 44px of height
    // plus 8px of gap read as a card, and forty of them scrolled like one.
    <div className="group hover:bg-foreground/[0.04] focus-within:bg-foreground/[0.04] border-sidebar-border flex h-9 min-w-0 items-center gap-2 border-b px-4">
      {leading}
      <FileTypeIcon path={path} className="size-4 shrink-0" />

      {/* The whole name is the fold control, as in a file list; the icon
          buttons beside it are for what a click on the row cannot also mean.
          `min-w-0` so the path, not the row, is what truncates. */}
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${path}`}
        onClick={onToggle}
        className="focus-visible:ring-accent-brand flex min-w-0 items-center rounded text-[13px] outline-none focus-visible:ring-2"
      >
        {dir && (
          // `direction: rtl` puts the ellipsis at the START of the directory.
          // A path truncated from the right loses the filename, the only part
          // of it anybody was reading.
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

      {/* Pushed right only when there are actions to sit beside; the pull
          request's header keeps its counts beside the name. */}
      <span
        className={`${actions ? "ml-auto " : ""}shrink-0 font-mono text-[11px] tabular-nums`}
      >
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
          // The name's button already exposes the fold to assistive tech and
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
      {actions}
    </div>
  );
}
