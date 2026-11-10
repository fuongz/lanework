import {
  Cancel01Icon,
  Loading03Icon,
  MultiplicationSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Transition } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { ClaudeAiIcon } from "#/components/ui/svgs/claudeAiIcon";
import { CodexDark } from "#/components/ui/svgs/codexDark";
import { OpencodeDark } from "#/components/ui/svgs/opencodeDark";
import { cn } from "#/lib/utils";
import { useHarness, useHarnessWatch } from "#/stores/harness";
import {
  announceIsland,
  ISLAND_PRIORITY,
  type IslandTone,
  setIslandOpen,
  useIslandContent,
  useIslandFoldOutside,
  useIslandShowing,
} from "#/stores/island";
import {
  type HarnessAgent,
  type HarnessInfo,
  hasPendingUpdate,
} from "../../../../shared/harness";

export const HARNESS_NAMES: Record<HarnessAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** How long "✓ Codex 0.163.0" stands before the island goes. */
const DONE_MS = 2000;
/**
 * How long the pointer may be off the panel before it folds.
 *
 * A pointer that slips off for a moment does not fold it.
 */
export const ISLAND_LEAVE_MS = 220;
/**
 * The pill-to-panel morph: low bounce, about half a second.
 *
 * A spring on a layout animation, so it re-targets from wherever it is when
 * the pointer changes its mind halfway.
 */
export const ISLAND_MORPH: Transition = {
  type: "spring",
  bounce: 0.18,
  duration: 0.45,
};
/** The content swap, faster than the container moves so it never squeezes. */
export const ISLAND_SWAP: Transition = {
  duration: 0.16,
  ease: [0.25, 0.1, 0.25, 1],
};
export const ISLAND_PILL_RADIUS = 14;
export const ISLAND_PANEL_RADIUS = 24;
/** The fixed strip an island floats in: top centre, over the title bar. */
export const ISLAND_HOST =
  "pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-4";
export const ISLAND_HOST_TOP =
  "calc((var(--titlebar-height, 44px) - 28px) / 2)";
/** The black capsule itself, the same in both themes. */
export const ISLAND_SURFACE =
  "pointer-events-auto relative overflow-hidden bg-black text-white [app-region:no-drag] shadow-[0_8px_30px_rgb(0_0_0/0.28),0_0_0_1px_rgb(255_255_255/0.06)_inset] select-none";

/** The mark of a harness, drawn for a black surface in both themes. */
export function HarnessIcon({
  agent,
  className,
}: {
  agent: HarnessAgent;
  className?: string;
}) {
  if (agent === "claude")
    return <ClaudeAiIcon aria-hidden="true" className={className} />;
  if (agent === "opencode")
    return <OpencodeDark aria-hidden="true" className={className} />;
  return <CodexDark aria-hidden="true" className={className} />;
}

function Spinner({ className }: { className?: string }) {
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      className={cn("animate-spin motion-reduce:animate-none", className)}
      strokeWidth={2}
      aria-hidden="true"
    />
  );
}

type Row = HarnessInfo & {
  /** What this row is showing, after "done" has had its two seconds. */
  shown: "available" | "updating" | "done" | "failed";
};

/**
 * Which harnesses the island is about, and in what state.
 *
 * "Done" shows for {@link DONE_MS} from when this window first saw it, then
 * never again for that version. Main may keep reporting it, and an island
 * that came back on every launch would be noise.
 */
function useRows(): Row[] {
  const list = useHarness((state) => state.list);
  const [seen, setSeen] = useState<Record<string, true>>({});
  const doneKeys = list
    .map((info) =>
      info.update.state === "done"
        ? `${info.agent}@${info.update.version}`
        : null,
    )
    .filter((key): key is string => key !== null && !seen[key])
    .join(" ");
  useEffect(() => {
    if (!doneKeys) return;
    const timer = window.setTimeout(() => {
      setSeen((before) => {
        const next = { ...before };
        for (const key of doneKeys.split(" ")) next[key] = true;
        return next;
      });
    }, DONE_MS);
    return () => window.clearTimeout(timer);
  }, [doneKeys]);

  const rows: Row[] = [];
  for (const info of list) {
    const { update } = info;
    if (update.state === "updating") rows.push({ ...info, shown: "updating" });
    else if (
      update.state === "done" &&
      !seen[`${info.agent}@${update.version}`]
    )
      rows.push({ ...info, shown: "done" });
    else if (
      update.state === "failed" &&
      info.latest !== null &&
      info.latest !== info.dismissed
    )
      rows.push({ ...info, shown: "failed" });
    else if (hasPendingUpdate(info)) rows.push({ ...info, shown: "available" });
  }
  return rows;
}

/** The one state the folded pill speaks for: the most urgent row's. */
function lead(rows: Row[]): Row | undefined {
  for (const shown of ["updating", "failed", "done", "available"] as const) {
    const row = rows.find((item) => item.shown === shown);
    if (row) return row;
  }
  return undefined;
}

function announce(row: Row | undefined): string {
  if (!row) return "";
  const name = HARNESS_NAMES[row.agent];
  switch (row.shown) {
    case "updating":
      return `Updating ${name}.`;
    case "done":
      return `${name} updated to ${row.version ?? row.latest}.`;
    case "failed":
      return `${name} update failed.`;
    default:
      return `${name} ${row.latest} is available.`;
  }
}

const HARNESS_ISLAND_ID = "harness";

const TONE: Record<Row["shown"], IslandTone> = {
  updating: "loading",
  done: "success",
  failed: "error",
  available: "info",
};

/**
 * The harness update offer on the island: a newer Claude Code or Codex is
 * out, and updating it.
 *
 * - It shows only while an update is pending, running, or has just finished,
 *   and below everything else ({@link ISLAND_PRIORITY}): an offer waits for
 *   a microphone, a notice, a waiting agent and a sign-in.
 * - It opens on hover or a click, never by itself: an update is an offer,
 *   not something to put in front of the work. Escape anywhere, or a press
 *   outside, folds it, and it folds while something else has the island.
 *
 * Draws nothing itself: `<IslandHost/>` in the shell does.
 */
export function HarnessIsland() {
  useHarnessWatch();
  const rows = useRows();
  const top = lead(rows);
  const showing = useIslandShowing(HARNESS_ISLAND_ID);
  useIslandFoldOutside(HARNESS_ISLAND_ID, { escapeAnywhere: true });

  // Gone means folded: the next time it shows, it starts as a pill.
  useEffect(() => {
    if (!showing) setIslandOpen(HARNESS_ISLAND_ID, false);
  }, [showing]);

  const said = showing ? announce(top) : "";
  useEffect(() => {
    if (said) announceIsland(said);
  }, [said]);

  useIslandContent(
    top
      ? {
          id: HARNESS_ISLAND_ID,
          priority: ISLAND_PRIORITY.harness,
          tone: TONE[top.shown],
          label: "Harness updates",
          attributes: {
            "data-testid": "harness-island",
            "data-state": top.shown,
          },
          pill: (context) => (
            <Pill
              row={top}
              more={rows.length - 1}
              onOpen={() => context.setOpen(true, true)}
            />
          ),
          panel: (context) => (
            <Panel rows={rows} onClose={() => context.setOpen(false)} />
          ),
        }
      : null,
  );
  return null;
}

/** The folded capsule: the most urgent row, in one line. */
function Pill({
  row,
  more,
  onOpen,
}: {
  row: Row;
  more: number;
  onOpen: () => void;
}) {
  const name = HARNESS_NAMES[row.agent];
  let glyph: ReactNode;
  let text: ReactNode;
  switch (row.shown) {
    case "updating":
      glyph = <Spinner className="size-3.5 text-white/80" />;
      text = <span>{name}</span>;
      break;
    case "done":
      glyph = (
        <HugeiconsIcon
          icon={Tick02Icon}
          className="size-3.5 text-emerald-400"
          strokeWidth={2.4}
          aria-hidden="true"
        />
      );
      text = (
        <>
          <span>{name}</span>
          <Version>{row.version ?? row.latest}</Version>
        </>
      );
      break;
    case "failed":
      glyph = (
        <HugeiconsIcon
          icon={Cancel01Icon}
          className="size-3.5 text-red-400"
          strokeWidth={2.4}
          aria-hidden="true"
        />
      );
      text = <span>Update failed</span>;
      break;
    default:
      glyph = <HarnessIcon agent={row.agent} className="size-3.5" />;
      text = (
        <>
          <span>{name}</span>
          <Version>{row.latest}</Version>
        </>
      );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={false}
      aria-label={`${announce(row)} Show harness updates.`}
      className="flex h-7 items-center gap-1.5 rounded-[inherit] pr-2.5 pl-2 text-[12px] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      {glyph}
      {text}
      {more > 0 && <span className="text-white/50">+{more}</span>}
      {row.shown === "available" && (
        <span
          aria-hidden="true"
          className="ml-0.5 size-1.5 rounded-full bg-sky-400"
        />
      )}
    </button>
  );
}

function Version({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[11.5px] text-white/60 tabular-nums">
      {children}
    </span>
  );
}

/** The open island: one row per harness, and what to do about it. */
function Panel({ rows, onClose }: { rows: Row[]; onClose: () => void }) {
  const update = useHarness((state) => state.update);
  const dismiss = useHarness((state) => state.dismiss);
  const openInTerminal = useHarness((state) => state.openInTerminal);
  const anyFailed = rows.some((row) => row.shown === "failed");
  return (
    <section
      aria-label="Harness updates"
      className="flex w-[min(360px,calc(100vw-32px))] flex-col gap-3 p-4 pt-3.5"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">
          {anyFailed ? "Harness update failed" : "Harness update available"}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss these versions"
          title="Not now — ask again when a newer version is out"
          className="-mr-1.5 rounded-full text-white/60 hover:bg-white/10 hover:text-white dark:hover:bg-white/10"
          onClick={() => {
            for (const row of rows)
              if (
                row.latest &&
                (row.shown === "available" || row.shown === "failed")
              )
                void dismiss(row.agent, row.latest);
            onClose();
          }}
        >
          <HugeiconsIcon
            icon={MultiplicationSignIcon}
            className="size-3.5"
            strokeWidth={2}
            aria-hidden="true"
          />
        </Button>
      </header>
      <ul className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <li
            key={row.agent}
            data-testid={`harness-row-${row.agent}`}
            className="flex min-h-7 items-center gap-2.5"
          >
            <HarnessIcon agent={row.agent} className="size-4 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium">
                {HARNESS_NAMES[row.agent]}
              </span>
              <span className="truncate font-mono text-[11.5px] text-white/60 tabular-nums">
                {row.shown === "done"
                  ? `${row.version ?? row.latest} — up to date`
                  : `${row.version ?? "?"} → ${row.latest ?? "?"}`}
              </span>
            </div>
            <RowAction
              row={row}
              onUpdate={() => void update(row.agent)}
              onTerminal={() => void openInTerminal(row.agent)}
            />
          </li>
        ))}
      </ul>
      {rows.map((row) =>
        row.shown === "failed" && row.update.state === "failed" ? (
          <p
            key={row.agent}
            className="flex items-start gap-1.5 text-[12px] text-red-300"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              className="mt-px size-3.5 shrink-0"
              strokeWidth={2.4}
              aria-hidden="true"
            />
            <span className="line-clamp-2">
              {HARNESS_NAMES[row.agent]} update failed: {row.update.message}
            </span>
          </p>
        ) : null,
      )}
      <p className="text-[12px] text-white/50">
        New models often need the latest version.
      </p>
    </section>
  );
}

const PILL_BUTTON =
  "h-7 rounded-full px-3 text-[12px] focus-visible:ring-white/40 disabled:opacity-100";

function RowAction({
  row,
  onUpdate,
  onTerminal,
}: {
  row: Row;
  onUpdate: () => void;
  onTerminal: () => void;
}) {
  switch (row.shown) {
    case "updating":
      return (
        <Button
          disabled
          aria-busy="true"
          className={cn(PILL_BUTTON, "bg-white/10 text-white/80")}
        >
          <Spinner className="size-3.5" />
          Updating
        </Button>
      );
    case "done":
      return (
        <span className="flex h-7 items-center gap-1 px-1 text-[12px] text-emerald-400">
          <HugeiconsIcon
            icon={Tick02Icon}
            className="size-3.5"
            strokeWidth={2.4}
            aria-hidden="true"
          />
          Updated
        </span>
      );
    case "failed":
      return (
        <Button
          onClick={onTerminal}
          className={cn(
            PILL_BUTTON,
            "bg-white/[0.14] text-white hover:bg-white/[0.22]",
          )}
        >
          Open in terminal
        </Button>
      );
    default:
      return (
        <Button
          onClick={onUpdate}
          className={cn(PILL_BUTTON, "bg-white text-black hover:bg-white/85")}
        >
          Update
        </Button>
      );
  }
}
