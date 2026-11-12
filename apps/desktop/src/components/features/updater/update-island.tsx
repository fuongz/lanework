import {
  CircleArrowUp01Icon,
  Loading03Icon,
  MultiplicationSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import { Button } from "#/components/ui/button";
import {
  liveSentence,
  useUpdateActions,
  useUpdaterState,
} from "#/hooks/use-updater";
import { cn } from "#/lib/utils";
import {
  announceIsland,
  ISLAND_PRIORITY,
  type IslandTone,
  setIslandOpen,
  useIslandContent,
  useIslandFoldOutside,
  useIslandShowing,
} from "#/stores/island";
import type { UpdaterLiveWork } from "../../../../shared/updater";

const UPDATE_ISLAND_ID = "update";

type Shown = "available" | "downloading" | "ready";

const TONE: Record<Shown, IslandTone> = {
  available: "info",
  downloading: "loading",
  ready: "success",
};

function announce(shown: Shown, version: string): string {
  switch (shown) {
    case "available":
      return `Lanework ${version} is available.`;
    case "downloading":
      return `Downloading Lanework ${version}.`;
    default:
      return `Lanework ${version} is ready to install.`;
  }
}

/**
 * A newer Lanework on the island (INF-11): offered, downloading, ready.
 *
 * Mounted in the app shell only, so it speaks everywhere but Settings, where
 * About shows the same choices in its Updates rows.
 *
 * - Available: Download or Not now. Nothing downloads before the person
 *   says so.
 * - Downloading: a pill with a progress bar.
 * - Ready: Restart now or Later. With terminals or runs live, Restart asks
 *   once more; Later installs it the next time Lanework quits.
 *
 * Like the harness offer, it arrives as a pill and opens on hover or a
 * click, never by itself, and Not now / Later hide it for this run. It ranks
 * just above the harness offer ({@link ISLAND_PRIORITY}).
 */
export function UpdateIsland() {
  const [state, setState] = useUpdaterState();
  const actions = useUpdateActions(state, setState);
  const showing = useIslandShowing(UPDATE_ISLAND_ID);
  useIslandFoldOutside(UPDATE_ISLAND_ID, { escapeAnywhere: true });

  const version = state?.version ?? "";
  const shown: Shown | null =
    !state || state.disabled || !state.version
      ? null
      : state.status === "downloading"
        ? "downloading"
        : state.postponed
          ? null
          : state.status === "available" || state.status === "ready"
            ? state.status
            : null;

  // Gone means folded: the next time it shows, it starts as a pill.
  useEffect(() => {
    if (!showing) setIslandOpen(UPDATE_ISLAND_ID, false);
  }, [showing]);

  const said = showing && shown ? announce(shown, version) : "";
  useEffect(() => {
    if (said) announceIsland(said);
  }, [said]);

  const progress =
    shown === "downloading" && state?.progress !== null
      ? (state?.progress ?? 0) / 100
      : null;

  useIslandContent(
    shown
      ? {
          id: UPDATE_ISLAND_ID,
          priority: ISLAND_PRIORITY.update,
          tone: TONE[shown],
          label: "Lanework update",
          swapKey: `${shown}:${actions.live ? "live" : ""}`,
          progress,
          attributes: {
            "data-testid": "update-island",
            "data-state": shown,
          },
          pill: (context) => (
            <Pill
              shown={shown}
              version={version}
              progress={state?.progress ?? null}
              onOpen={() => context.setOpen(true, true)}
            />
          ),
          panel:
            shown === "downloading"
              ? undefined
              : (context) => (
                  <Panel
                    shown={shown}
                    version={version}
                    live={actions.live}
                    busy={actions.busy}
                    onDownload={() => {
                      actions.download();
                      context.setOpen(false);
                    }}
                    onLater={() => {
                      actions.later();
                      context.setOpen(false);
                    }}
                    onRestart={() => void actions.restart()}
                    onCancelRestart={actions.cancelRestart}
                  />
                ),
        }
      : null,
  );
  return null;
}

function Glyph({ shown, className }: { shown: Shown; className?: string }) {
  if (shown === "downloading")
    return (
      <HugeiconsIcon
        icon={Loading03Icon}
        className={cn(
          "animate-spin text-white/80 motion-reduce:animate-none",
          className,
        )}
        strokeWidth={2}
        aria-hidden="true"
      />
    );
  return (
    <HugeiconsIcon
      icon={shown === "ready" ? Tick02Icon : CircleArrowUp01Icon}
      className={cn(
        shown === "ready" ? "text-emerald-400" : "text-sky-400",
        className,
      )}
      strokeWidth={2.2}
      aria-hidden="true"
    />
  );
}

/** The folded capsule: what the update is up to, in one line. */
function Pill({
  shown,
  version,
  progress,
  onOpen,
}: {
  shown: Shown;
  version: string;
  progress: number | null;
  onOpen: () => void;
}) {
  const text =
    shown === "available"
      ? "Update available"
      : shown === "downloading"
        ? "Downloading"
        : "Restart to update";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={false}
      aria-label={`${announce(shown, version)}${shown === "downloading" ? "" : " Show update."}`}
      className="flex h-7 items-center gap-1.5 rounded-[inherit] pr-2.5 pl-2 text-[12px] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <Glyph shown={shown} className="size-3.5" />
      <span>{text}</span>
      <span className="font-mono text-[11.5px] text-white/60 tabular-nums">
        {shown === "downloading" && progress !== null
          ? `${progress}%`
          : `v${version}`}
      </span>
    </button>
  );
}

const PILL_BUTTON =
  "h-7 rounded-full px-3 text-[12px] focus-visible:ring-white/40 disabled:opacity-100";
const PRIMARY = "bg-white text-black hover:bg-white/85";
const QUIET = "bg-white/[0.14] text-white hover:bg-white/[0.22]";

/** The open island: the question, and its two answers. */
function Panel({
  shown,
  version,
  live,
  busy,
  onDownload,
  onLater,
  onRestart,
  onCancelRestart,
}: {
  shown: Exclude<Shown, "downloading">;
  version: string;
  live: UpdaterLiveWork | null;
  busy: boolean;
  onDownload: () => void;
  onLater: () => void;
  onRestart: () => void;
  onCancelRestart: () => void;
}) {
  const title = live
    ? "Restart with work still running?"
    : shown === "available"
      ? `Lanework ${version} is available`
      : `Lanework ${version} is ready`;
  const body = live
    ? `${liveSentence(live)} Restarting stops ${live.terminals + live.runs === 1 ? "it" : "them"}.`
    : shown === "available"
      ? "Download it now? Lanework asks again before it restarts."
      : "Restart to start using it, or it installs the next time you quit.";
  return (
    <section
      aria-label="Lanework update"
      className="flex w-[min(360px,calc(100vw-32px))] flex-col gap-3 p-4 pt-3.5"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight">
          <Glyph shown={shown} className="size-4" />
          {title}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={shown === "available" ? "Not now" : "Later"}
          title={
            shown === "available"
              ? "Not now — check again from Settings → About"
              : "Later — it installs the next time you quit"
          }
          className="-mr-1.5 rounded-full text-white/60 hover:bg-white/10 hover:text-white dark:hover:bg-white/10"
          onClick={onLater}
        >
          <HugeiconsIcon
            icon={MultiplicationSignIcon}
            className="size-3.5"
            strokeWidth={2}
            aria-hidden="true"
          />
        </Button>
      </header>
      <p className="text-[12px] text-white/60">{body}</p>
      <div className="flex justify-end gap-2">
        {live ? (
          <>
            <Button
              disabled={busy}
              onClick={onCancelRestart}
              className={cn(PILL_BUTTON, QUIET)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={onRestart}
              className={cn(PILL_BUTTON, "border-0")}
            >
              {busy ? "Restarting…" : "Restart anyway"}
            </Button>
          </>
        ) : (
          <>
            <Button
              disabled={busy}
              onClick={onLater}
              className={cn(PILL_BUTTON, QUIET)}
            >
              {shown === "available" ? "Not now" : "Later"}
            </Button>
            <Button
              disabled={busy}
              onClick={shown === "available" ? onDownload : onRestart}
              className={cn(PILL_BUTTON, PRIMARY)}
            >
              {shown === "available"
                ? "Download"
                : busy
                  ? "Restarting…"
                  : "Restart now"}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
