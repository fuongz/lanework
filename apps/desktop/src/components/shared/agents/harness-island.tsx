import {
  Cancel01Icon,
  Loading03Icon,
  MultiplicationSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AnimatePresence,
  motion,
  type Transition,
  useReducedMotion,
} from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { ClaudeAiIcon } from "#/components/ui/svgs/claudeAiIcon";
import { CodexDark } from "#/components/ui/svgs/codexDark";
import { cn } from "#/lib/utils";
import { useHarness, useHarnessWatch } from "#/stores/harness";
import {
  type HarnessAgent,
  type HarnessInfo,
  hasPendingUpdate,
} from "../../../../shared/harness";

export const HARNESS_NAMES: Record<HarnessAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** How long "✓ Codex 0.163.0" stands before the island goes (FE-61). */
const DONE_MS = 2000;
/** A pointer that slips off the panel for a moment does not fold it. */
export const ISLAND_LEAVE_MS = 220;
/**
 * The morph: low bounce, about half a second, and — being a spring on a
 * layout animation — re-targeted from wherever it is when the pointer changes
 * its mind halfway.
 */
export const ISLAND_MORPH: Transition = {
  type: "spring",
  bounce: 0.18,
  duration: 0.45,
};
/** Content swaps faster than the container moves, so it never reads squeezed. */
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
  return agent === "claude" ? (
    <ClaudeAiIcon aria-hidden="true" className={className} />
  ) : (
    <CodexDark aria-hidden="true" className={className} />
  );
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
 * ⚠️ "Done" is shown for `DONE_MS` from the moment this window first saw it,
 * then never again for that version — main may keep reporting it, and an
 * island that came back on every launch would be noise.
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

/**
 * The harness update island (FE-61): a black capsule at the top centre of the
 * window that says a newer Claude Code or Codex is out, and updates it.
 *
 * ⚠️ It FLOATS — fixed, over the title bar's edge and the page — and takes no
 * layout space, so nothing under it moves when it comes and goes. It is there
 * only while an update is pending, running, or has just finished.
 *
 * ⚠️ It opens on hover or a click, never by itself: an update is something to
 * offer, not something to put in front of the work.
 *
 * ⚠️ Only the capsule is `no-drag`. The wrapper across the window has no
 * region at all, so the title bar either side of it still drags the window;
 * and it is mounted LAST in the shell, because a later region wins over the
 * title bar's drag strip.
 *
 * ⚠️ `yieldTo`: a board notice has the island (FE-63). An update is an offer
 * and a failed write is not, so the pill steps aside while the notice is up
 * and comes back once it is dismissed.
 */
export function HarnessIsland({ yieldTo = false }: { yieldTo?: boolean }) {
  useHarnessWatch();
  const rows = useRows();
  const top = lead(rows);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const leaveTimer = useRef<number | undefined>(undefined);
  const island = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion() ?? false;
  const visible = rows.length > 0 && !yieldTo;

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  // Gone means folded: the next one starts as a pill.
  useEffect(() => {
    if (visible) return;
    setOpen(false);
    setPinned(false);
  }, [visible]);

  // A click opened it: Escape or a click anywhere else folds it.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setPinned(false);
    };
    const onDown = (event: PointerEvent) => {
      if (island.current?.contains(event.target as Node)) return;
      setOpen(false);
      setPinned(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const enter = () => {
    window.clearTimeout(leaveTimer.current);
    setOpen(true);
  };
  const leave = () => {
    if (pinned) return;
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(
      () => setOpen(false),
      ISLAND_LEAVE_MS,
    );
  };

  const view = open ? "panel" : "pill";
  return (
    <div
      data-testid="harness-island-host"
      className={ISLAND_HOST}
      style={{ top: ISLAND_HOST_TOP }}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {visible ? announce(top) : ""}
      </p>
      <AnimatePresence initial={false} mode="popLayout">
        {visible && top && (
          <motion.div
            // ⚠️ Reduced motion: one surface per view, crossfaded — no
            // morph, no scale. Otherwise ONE surface whose box springs from
            // pill to panel and back.
            key={reduced ? view : "island"}
            ref={island}
            data-testid="harness-island"
            data-state={top.shown}
            data-view={view}
            layout={!reduced}
            transition={reduced ? { duration: 0.2 } : ISLAND_MORPH}
            initial={{ opacity: 0, scale: reduced ? 1 : 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reduced ? 1 : 0.7 }}
            style={{
              borderRadius: open ? ISLAND_PANEL_RADIUS : ISLAND_PILL_RADIUS,
            }}
            onPointerEnter={enter}
            onPointerLeave={leave}
            className={ISLAND_SURFACE}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={view}
                layout={reduced ? false : "position"}
                initial={{ opacity: 0, filter: "blur(4px)" }}
                animate={{ opacity: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, filter: "blur(4px)" }}
                transition={ISLAND_SWAP}
              >
                {open ? (
                  <Panel
                    rows={rows}
                    focus={pinned}
                    onClose={() => {
                      setOpen(false);
                      setPinned(false);
                    }}
                  />
                ) : (
                  <Pill
                    row={top}
                    more={rows.length - 1}
                    onOpen={() => {
                      setPinned(true);
                      setOpen(true);
                    }}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
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
function Panel({
  rows,
  focus,
  onClose,
}: {
  rows: Row[];
  /** Opened by a click or the keyboard: take focus, since the pill is gone. */
  focus: boolean;
  onClose: () => void;
}) {
  const update = useHarness((state) => state.update);
  const dismiss = useHarness((state) => state.dismiss);
  const openInTerminal = useHarness((state) => state.openInTerminal);
  const anyFailed = rows.some((row) => row.shown === "failed");
  const self = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus) self.current?.focus({ preventScroll: true });
  }, [focus]);
  return (
    <section
      ref={self}
      tabIndex={-1}
      aria-label="Harness updates"
      className="flex w-[min(360px,calc(100vw-32px))] flex-col gap-3 p-4 pt-3.5 outline-none"
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
