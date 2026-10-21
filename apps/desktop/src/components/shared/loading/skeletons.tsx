import { Skeleton } from "#/components/ui/skeleton";
import { cn } from "#/lib/utils";

/**
 * The app's loading placeholders, shaped like what is coming
 * (docs/standards/loading-states.md).
 *
 * ⚠️ Every one is a `role="status"` with a real label: a screen reader gets
 * nothing from grey bars, and the label is what replaced the old text.
 *
 * ⚠️ Widths come from fixed tables, never `Math.random`: a placeholder that
 * reshuffles on every render flickers.
 */

const LINE_WIDTHS = ["72%", "54%", "86%", "63%", "45%", "78%", "58%", "68%"];

/** A list's rows, one or two lines each, the height of the real rows. */
export function ListSkeleton({
  label,
  rows = 8,
  lines = 1,
  icon = true,
  className,
}: {
  label: string;
  rows?: number;
  /** 1 for a file or setting row, 2 for a commit or pull request row. */
  lines?: 1 | 2;
  icon?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("flex flex-col px-1.5 py-1", className)}
    >
      {Array.from({ length: rows }, (_, row) =>
        lines === 1 ? (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder has no identity — the index is all it is.
            key={row}
            className="flex h-7 items-center gap-2 px-2.5"
          >
            {icon && <Skeleton className="size-3.5 shrink-0 rounded-sm" />}
            <Skeleton
              className="h-3"
              style={{ width: LINE_WIDTHS[row % LINE_WIDTHS.length] }}
            />
          </div>
        ) : (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder has no identity — the index is all it is.
            key={row}
            className="flex flex-col gap-2 px-2.5 py-2.5"
          >
            <div className="flex items-center gap-2">
              {icon && <Skeleton className="size-3.5 shrink-0 rounded-full" />}
              <Skeleton
                className="h-3"
                style={{ width: LINE_WIDTHS[row % LINE_WIDTHS.length] }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 shrink-0 rounded-full" />
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-2.5 w-12" />
              <Skeleton className="ml-auto h-2.5 w-10" />
            </div>
          </div>
        ),
      )}
    </div>
  );
}

/**
 * A file, a diff or a document: a header row, then text lines. `code` draws
 * the lines indented like source, in a gutter.
 */
export function DocumentSkeleton({
  label,
  lines = 14,
  code = false,
  className,
}: {
  label: string;
  lines?: number;
  code?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("flex min-w-0 flex-1 flex-col gap-4 p-4", className)}
    >
      <div className="flex items-center gap-2">
        <Skeleton className="size-4 shrink-0 rounded-sm" />
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="ml-auto h-3 w-14" />
      </div>
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: lines }, (_, line) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder has no identity — the index is all it is.
            key={line}
            className="flex items-center gap-3"
          >
            {code && <Skeleton className="h-3 w-5 shrink-0 opacity-60" />}
            <Skeleton
              className="h-3"
              style={{
                width: LINE_WIDTHS[line % LINE_WIDTHS.length],
                marginLeft: code ? `${(line % 4) * 12}px` : undefined,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A Repository screen before its repository is read: the side list, its
 * search field and the pane beside it, at the widths Files draws them.
 */
export function SplitSkeleton({
  label,
  lines = 1,
}: {
  label: string;
  lines?: 1 | 2;
}) {
  return (
    <div role="status" aria-label={label} className="flex min-h-0 flex-1">
      <div className="bg-sidebar flex w-[280px] shrink-0 flex-col border-r">
        <div className="px-2 pt-2 pb-1.5">
          <Skeleton className="h-8 w-full rounded-lg" />
        </div>
        <ListSkeleton
          label={label}
          rows={lines === 1 ? 14 : 7}
          lines={lines}
          className="px-0"
        />
      </div>
      <DocumentSkeleton label={label} code />
    </div>
  );
}

/** A conversation's turns: a short message of the user's, a longer reply. */
export function ConversationSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-8 py-8">
      {[0, 1].map((turn) => (
        <div key={turn} className="flex flex-col gap-4">
          <Skeleton className="ml-auto h-9 w-2/5 rounded-2xl" />
          <div className="flex flex-col gap-2.5">
            {LINE_WIDTHS.slice(turn * 2, turn * 2 + 4).map((width) => (
              <Skeleton key={width} className="h-3" style={{ width }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One word or value inside a row, still being read. */
export function TextSkeleton({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <Skeleton
      role="status"
      aria-label={label}
      className={cn("inline-block h-3 w-20 align-middle", className)}
    />
  );
}
