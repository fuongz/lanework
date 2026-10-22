import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef } from "react";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

/** One open file's tab. */
interface EditorTab {
  id: string;
  /** Shown on the tab. */
  label: string;
  /** For the icon and the tooltip. */
  path: string;
  /** Edits not saved: a dot where × goes, until the tab is hovered. */
  dirty?: boolean;
  /** A preview tab, replaced by the next file opened: drawn in italics. */
  preview?: boolean;
  /** Tints the label: a file's git status on the Files screen. */
  labelClassName?: string;
}

/**
 * An editor's tab strip: the open files, one active, each closed by × or a
 * middle click.
 *
 * Used by Repository › Files and the Settings pages that browse files
 * (Skills, Config files). It scrolls sideways WITHOUT a bar (`no-scrollbar`):
 * the app's 10px classic scrollbar under a 32px strip opens a gap that reads
 * as a broken layout. So the active tab is scrolled into view here, and a
 * trackpad or Shift+wheel reaches the rest.
 */
export function EditorTabs({
  tabs,
  active,
  onActivate,
  onClose,
  onPin,
  label = "Open files",
}: {
  tabs: EditorTab[];
  active: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** A double click: keep a preview tab. */
  onPin?: (id: string) => void;
  label?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);

  // The active tab in view: there is no scrollbar to go and find it with.
  useEffect(() => {
    if (!active) return;
    const tab = strip.current?.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(active)}"]`,
    );
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  if (!tabs.length) return null;
  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={label}
      className="no-scrollbar border-border bg-sidebar flex h-8 shrink-0 items-stretch overflow-x-auto border-b"
    >
      {tabs.map((tab) => {
        const on = tab.id === active;
        // The ×: always on the active tab, on hover elsewhere. A dirty tab
        // shows its dot instead until hovered.
        const hideClose = !!tab.dirty || !on;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            className={cn(
              "group border-border flex max-w-56 shrink-0 items-center gap-1.5 border-r pr-1 pl-2.5 text-xs",
              on
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-muted/50",
            )}
            title={tab.path}
          >
            <button
              type="button"
              role="tab"
              aria-selected={on}
              className="flex min-w-0 items-center gap-1.5 self-stretch outline-none"
              onClick={() => onActivate(tab.id)}
              onDoubleClick={onPin ? () => onPin(tab.id) : undefined}
              // A middle click closes, as in a browser and an editor.
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.id);
              }}
            >
              <FileTypeIcon path={tab.path} className="size-3.5 shrink-0" />
              <span
                className={cn(
                  "truncate",
                  tab.preview && "italic",
                  tab.labelClassName,
                )}
              >
                {tab.label}
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={
                tab.dirty
                  ? `Close ${tab.label} (not saved)`
                  : `Close ${tab.label}`
              }
              className="group/close relative shrink-0"
              onClick={() => onClose(tab.id)}
            >
              {tab.dirty && (
                <span
                  aria-hidden="true"
                  className="bg-foreground/70 absolute size-2 rounded-full group-hover:opacity-0 group-focus-visible/close:opacity-0"
                />
              )}
              <HugeiconsIcon
                icon={Cancel01Icon}
                strokeWidth={2}
                aria-hidden="true"
                className={cn(
                  hideClose &&
                    "opacity-0 group-hover:opacity-100 group-focus-visible/close:opacity-100",
                )}
              />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
