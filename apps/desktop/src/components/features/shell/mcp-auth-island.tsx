import {
  Alert02Icon,
  Loading03Icon,
  MultiplicationSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import {
  HarnessIcon,
  ISLAND_HOST,
  ISLAND_HOST_TOP,
  ISLAND_LEAVE_MS,
  ISLAND_MORPH,
  ISLAND_PANEL_RADIUS,
  ISLAND_PILL_RADIUS,
  ISLAND_SURFACE,
  ISLAND_SWAP,
} from "#/components/shared/agents/harness-island";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import {
  cloudAgents,
  MCP_LOGIN_COMMAND,
  needsAttention,
  useMcpAuth,
} from "#/stores/mcp-auth";
import type { LaneworkMcpAgent } from "../../../../shared/auth";
import type { HarnessAgent } from "../../../../shared/harness";

const NAMES: Record<LaneworkMcpAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};
/** Each agent's mark, by the harness store's name for it. */
const HARNESS: Record<LaneworkMcpAgent, HarnessAgent> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
};
/** How long "✓ Signed in" stays before the island goes. */
const DONE_MS = 2000;

type Shown = "needs-login" | "failed" | "login" | "done";
interface Row {
  agent: LaneworkMcpAgent;
  shown: Shown;
}

/**
 * The agents the island is about.
 *
 * Those signing in, signed out or failing (and not dismissed for that same
 * answer), or signed in from here a moment ago.
 */
export function useMcpAuthRows(): Row[] {
  const status = useMcpAuth((state) => state.status);
  const view = useMcpAuth((state) => state.view);
  const settled = useMcpAuth((state) => state.settled);
  const dismissed = useMcpAuth((state) => state.dismissed);
  const signedInAt = useMcpAuth((state) => state.signedInAt);
  const [now, setNow] = useState(() => Date.now());
  const latest = Math.max(0, ...Object.values(signedInAt).map((at) => at ?? 0));
  // Tick once when a login lands, and once more as its "done" runs out.
  useEffect(() => {
    setNow(Date.now());
    if (!latest) return;
    const timer = window.setTimeout(() => setNow(Date.now()), DONE_MS + 50);
    return () => window.clearTimeout(timer);
  }, [latest]);

  const rows: Row[] = [];
  for (const agent of cloudAgents(status)) {
    const answer = settled[agent];
    const at = signedInAt[agent];
    if (view[agent] === "login") rows.push({ agent, shown: "login" });
    else if (answer && needsAttention(answer) && dismissed[agent] !== answer)
      rows.push({ agent, shown: answer as "needs-login" | "failed" });
    else if (at !== undefined && now - at < DONE_MS)
      rows.push({ agent, shown: "done" });
  }
  return rows;
}

function lead(rows: Row[]): Row | undefined {
  for (const shown of ["login", "needs-login", "failed", "done"] as const) {
    const row = rows.find((item) => item.shown === shown);
    if (row) return row;
  }
  return undefined;
}

function announce(row: Row | undefined): string {
  if (!row) return "";
  const name = NAMES[row.agent];
  switch (row.shown) {
    case "login":
      return `${name} is signing in to Lanework.`;
    case "done":
      return `${name} signed in to Lanework.`;
    case "failed":
      return `${name} could not reach Lanework.`;
    default:
      return `${name} needs to sign in to Lanework.`;
  }
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

/**
 * The Lanework MCP sign-in island, in the harness island's capsule and spot.
 *
 * It speaks when Claude Code or Codex lost, or never had, its token for the
 * cloud board, or holds one the server will not take.
 *
 * - It arrives as a pill and opens on hover or a click, like the harness
 *   island: nothing the user just did caused it, so it does not take the top
 *   of the window by itself. The pill stays until the agent signs in, or the
 *   user dismisses that answer; a later, different answer brings it back.
 * - `yieldTo`: a board notice outranks it, since that answers something the
 *   user just did. It outranks the harness update offer, which yields to it.
 */
export function McpAuthIsland({ yieldTo = false }: { yieldTo?: boolean }) {
  const rows = useMcpAuthRows();
  const top = lead(rows);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const leaveTimer = useRef<number | undefined>(undefined);
  const island = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion() ?? false;
  const visible = rows.length > 0 && !yieldTo;

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
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
      data-testid="mcp-auth-island-host"
      className={ISLAND_HOST}
      style={{ top: ISLAND_HOST_TOP }}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {visible ? announce(top) : ""}
      </p>
      <AnimatePresence initial={false} mode="popLayout">
        {visible && top && (
          <motion.div
            key={reduced ? view : "island"}
            ref={island}
            data-testid="mcp-auth-island"
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

function Glyph({ shown, className }: { shown: Shown; className?: string }) {
  if (shown === "login")
    return <Spinner className={cn("text-white/80", className)} />;
  return (
    <HugeiconsIcon
      icon={shown === "done" ? Tick02Icon : Alert02Icon}
      className={cn(
        shown === "done" ? "text-emerald-400" : "text-amber-400",
        className,
      )}
      strokeWidth={2.2}
      aria-hidden="true"
    />
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
  const text =
    row.shown === "done"
      ? "Signed in"
      : row.shown === "failed"
        ? "Lanework MCP failed"
        : row.shown === "login"
          ? "Signing in"
          : "Sign in to Lanework";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={false}
      aria-label={`${announce(row)} Show sign-in.`}
      className="flex h-7 items-center gap-1.5 rounded-[inherit] pr-2.5 pl-2 text-[12px] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <Glyph shown={row.shown} className="size-3.5" />
      <span>{text}</span>
      <span className="text-white/60">{NAMES[row.agent]}</span>
      {more > 0 && <span className="text-white/50">+{more}</span>}
    </button>
  );
}

const PILL_BUTTON =
  "h-7 rounded-full px-3 text-[12px] focus-visible:ring-white/40 disabled:opacity-100";

/** The open island: one row per agent, and what to do about it. */
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
  const login = useMcpAuth((state) => state.login);
  const cancelLogin = useMcpAuth((state) => state.cancelLogin);
  const check = useMcpAuth((state) => state.check);
  const dismiss = useMcpAuth((state) => state.dismiss);
  const view = useMcpAuth((state) => state.view);
  const [error, setError] = useState<string | null>(null);
  const self = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus) self.current?.focus({ preventScroll: true });
  }, [focus]);

  async function signIn(agent: LaneworkMcpAgent) {
    setError(null);
    const auth = await login(agent);
    if (auth === "needs-login" || auth === "unknown")
      setError(
        `${NAMES[agent]} did not finish signing in. Try again, or run ${MCP_LOGIN_COMMAND[agent]} in a terminal.`,
      );
  }

  return (
    <section
      ref={self}
      tabIndex={-1}
      aria-label="Lanework MCP sign-in"
      className="flex w-[min(360px,calc(100vw-32px))] flex-col gap-3 p-4 pt-3.5 outline-none"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">
          {rows.every((row) => row.shown === "done")
            ? "Signed in to Lanework"
            : "Sign in to Lanework"}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss"
          title="Not now — ask again if this changes"
          className="-mr-1.5 rounded-full text-white/60 hover:bg-white/10 hover:text-white dark:hover:bg-white/10"
          onClick={() => {
            for (const row of rows) dismiss(row.agent);
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
            data-testid={`mcp-auth-row-${row.agent}`}
            className="flex min-h-7 items-center gap-2.5"
          >
            <HarnessIcon
              agent={HARNESS[row.agent]}
              className="size-4 shrink-0"
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium">
                {NAMES[row.agent]}
              </span>
              <span className="truncate text-[12px] text-white/60">
                {row.shown === "done"
                  ? "Signed in"
                  : row.shown === "login"
                    ? "Finish in your browser"
                    : row.shown === "failed"
                      ? "Could not reach the server"
                      : "Signed out, or the token expired"}
              </span>
            </div>
            {row.shown === "login" ? (
              // Hovering (or tabbing to) Waiting turns it into Stop.
              <div className="group/stop grid">
                <span
                  aria-hidden="true"
                  className={cn(
                    PILL_BUTTON,
                    "flex items-center gap-1.5 bg-white/10 text-white/80 [grid-area:1/1] group-focus-within/stop:invisible group-hover/stop:invisible",
                  )}
                >
                  <Spinner className="size-3.5" />
                  Waiting
                </span>
                <Button
                  variant="destructive"
                  aria-label={`Stop signing ${NAMES[row.agent]} in`}
                  onClick={() => cancelLogin(row.agent)}
                  className={cn(
                    PILL_BUTTON,
                    "border-0 opacity-0 [grid-area:1/1] group-hover/stop:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  <HugeiconsIcon
                    icon={MultiplicationSignIcon}
                    className="size-3.5"
                    strokeWidth={2.2}
                    aria-hidden="true"
                  />
                  Stop
                </Button>
              </div>
            ) : row.shown === "done" ? (
              <span className="flex h-7 items-center gap-1 px-1 text-[12px] text-emerald-400">
                <HugeiconsIcon
                  icon={Tick02Icon}
                  className="size-3.5"
                  strokeWidth={2.4}
                  aria-hidden="true"
                />
                Done
              </span>
            ) : row.shown === "failed" ? (
              <Button
                disabled={view[row.agent] === "checking"}
                onClick={() => void check(row.agent)}
                className={cn(
                  PILL_BUTTON,
                  "bg-white/[0.14] text-white hover:bg-white/[0.22]",
                )}
              >
                {view[row.agent] === "checking" ? (
                  <Spinner className="size-3.5" />
                ) : null}
                Try again
              </Button>
            ) : (
              <Button
                onClick={() => void signIn(row.agent)}
                className={cn(
                  PILL_BUTTON,
                  "bg-white text-black hover:bg-white/85",
                )}
              >
                Log in
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p className="line-clamp-3 text-[12px] text-red-300">{error}</p>
      )}
      <p className="text-[12px] text-white/50">
        Board tools in the agent stop working until it signs in. It opens your
        browser and keeps its own token.
      </p>
    </section>
  );
}
