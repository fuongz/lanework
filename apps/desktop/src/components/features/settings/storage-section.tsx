import {
  Delete02Icon,
  FolderLibraryIcon,
  GitBranchIcon,
  Layers01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import {
  ListSkeleton,
  TextSkeleton,
} from "#/components/shared/loading/skeletons";
import {
  SETTINGS_BUTTON,
  SettingsCard,
  SettingsPage,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { cn } from "#/lib/utils";
import {
  formatBytes,
  STORAGE_PARTS,
  type StorageFolder,
  type StoragePart,
  type StorageUsage,
} from "../../../../shared/storage";

/** How each part reads: its colour in the bar, its row in the list. */
const PARTS: Record<
  StoragePart,
  {
    label: string;
    detail: string;
    /** The bar segment, the legend dot and the row's icon tile. */
    swatch: string;
    tile: string;
    icon: typeof Layers01Icon;
  }
> = {
  cache: {
    label: "Cache",
    detail: "Temporary copies of pages, scripts and graphics",
    swatch: "bg-amber-500",
    tile: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    icon: Layers01Icon,
  },
  checkouts: {
    label: "Run workspaces",
    detail: "Copies of your repos that agents edit during a run",
    swatch: "bg-violet-500",
    tile: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    icon: GitBranchIcon,
  },
  projects: {
    label: "Projects and boards",
    detail: "Your projects, local boards and usage log",
    swatch: "bg-sky-500",
    tile: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    icon: FolderLibraryIcon,
  },
  app: {
    label: "Settings and history",
    detail: "Your preferences, sign-in and past runs",
    swatch: "bg-zinc-400 dark:bg-zinc-500",
    tile: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
    icon: Settings02Icon,
  },
};

/** The folder each part's Open folder shows, when it has one. */
const FOLDER: Partial<Record<StoragePart, StorageFolder>> = {
  projects: "projects",
  app: "app",
};

/**
 * Settings → Storage: how much disk Lanework takes, as one bar split into
 * parts and a list of the same parts by size, and clearing the cache.
 *
 * Measured each time the page opens, since a run or a dev session can grow
 * the folder by hundreds of MB between two visits.
 */
export function StorageSection() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void window.desktop?.storage
      .usage()
      .then((value) => {
        if (!disposed) setUsage(value);
      })
      .catch(() => {
        if (!disposed) setError("Couldn't measure Lanework's folders.");
      });
    return () => {
      disposed = true;
    };
  }, []);

  const clear = () => {
    const storage = window.desktop?.storage;
    if (!storage) return;
    setClearing(true);
    setError(null);
    void storage
      .clearCache()
      .then(setUsage)
      .catch(() => setError("Couldn't clear the cache. Try again."))
      .finally(() => setClearing(false));
  };

  const actionFor = (part: StoragePart): ReactNode => {
    if (part === "cache")
      return (
        <Button
          size="lg"
          variant="outline"
          className={SETTINGS_BUTTON}
          disabled={usage === null || clearing}
          onClick={clear}
        >
          <HugeiconsIcon
            icon={Delete02Icon}
            className="size-4"
            strokeWidth={2}
            aria-hidden="true"
          />
          {clearing ? "Clearing…" : "Clear cache"}
        </Button>
      );
    const folder = FOLDER[part];
    if (!folder) return null;
    return (
      <Button
        size="lg"
        variant="outline"
        className={SETTINGS_BUTTON}
        onClick={() =>
          void window.desktop?.storage.reveal(folder).catch(() => {})
        }
      >
        Open folder
      </Button>
    );
  };

  return (
    <SettingsPage
      title="Storage"
      description="The disk space Lanework uses on this Mac."
      sections={[
        {
          title: "Overview",
          hideTitle: true,
          keywords:
            "storage disk space size used total bar cache checkouts projects boards app data",
          content: <Overview usage={usage} />,
        },
        {
          title: "By size",
          keywords:
            "cache clear free space checkouts worktrees runs orchestration leftovers projects boards app data settings sign-in folder finder",
          content: usage ? (
            <div className="flex flex-col gap-2">
              <SettingsCard>
                {[...STORAGE_PARTS]
                  .sort((a, b) => usage.parts[b] - usage.parts[a])
                  .map((part) => (
                    <PartRow
                      key={part}
                      part={part}
                      bytes={usage.parts[part]}
                      action={actionFor(part)}
                    />
                  ))}
              </SettingsCard>
              <p className="text-muted-foreground px-1 text-xs leading-relaxed">
                Clearing the cache is safe: Lanework rebuilds it, and the next
                start may be a little slower. To free a run's workspace, stop
                the run, then choose Clean up leftovers in its panel.
              </p>
            </div>
          ) : (
            <ListSkeleton
              label="Measuring"
              rows={STORAGE_PARTS.length}
              lines={2}
              icon
              className="bg-card shadow-card rounded-xl"
            />
          ),
        },
        ...(error
          ? [
              {
                title: "Problem",
                content: (
                  <p
                    role="alert"
                    className="text-destructive text-[13px] break-words"
                  >
                    {error}
                  </p>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

/** The total, one bar split by part, and its legend. */
function Overview({ usage }: { usage: StorageUsage | null }) {
  return (
    <SettingsCard className="flex flex-col gap-3 divide-y-0 px-4 py-4">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium">Lanework</span>
        {usage ? (
          <span className="text-muted-foreground text-[13px] tabular-nums">
            {formatBytes(usage.total)} used
          </span>
        ) : (
          <TextSkeleton label="Measuring" className="w-24" />
        )}
      </div>

      {usage ? (
        <div
          role="img"
          aria-label={STORAGE_PARTS.map(
            (part) => `${PARTS[part].label} ${formatBytes(usage.parts[part])}`,
          ).join(", ")}
          className="bg-muted flex h-3 w-full gap-px overflow-hidden rounded-full"
        >
          {STORAGE_PARTS.filter((part) => usage.parts[part] > 0).map((part) => (
            <div
              key={part}
              className={cn("h-full min-w-1", PARTS[part].swatch)}
              style={{
                width: `${(usage.parts[part] / Math.max(1, usage.total)) * 100}%`,
              }}
            />
          ))}
        </div>
      ) : (
        <Skeleton className="h-3 w-full rounded-full" />
      )}

      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        {STORAGE_PARTS.map((part) => (
          <li
            key={part}
            className="text-muted-foreground flex items-center gap-1.5 text-[13px]"
          >
            <span
              aria-hidden="true"
              className={cn("size-2 rounded-full", PARTS[part].swatch)}
            />
            {PARTS[part].label}
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

/** One part: its icon, what it holds, its size and what can be done. */
function PartRow({
  part,
  bytes,
  action,
}: {
  part: StoragePart;
  bytes: number;
  action: ReactNode;
}) {
  const { label, detail, tile, icon } = PARTS[part];
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          tile,
        )}
      >
        <HugeiconsIcon icon={icon} className="size-[18px]" strokeWidth={1.8} />
      </span>
      {/* One line each, truncated: every row the same height. */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{label}</span>
        <span className="text-muted-foreground truncate text-[13px]">
          {detail}
        </span>
      </div>
      {/* Fixed widths, so sizes line up down the list whatever the button. */}
      <span className="text-muted-foreground w-16 shrink-0 text-right text-[13px] tabular-nums">
        {formatBytes(bytes)}
      </span>
      <div className="flex w-36 shrink-0 items-center justify-end">
        {action}
      </div>
    </div>
  );
}
