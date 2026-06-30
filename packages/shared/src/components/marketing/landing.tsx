import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  ArrowDown01Icon,
  DashboardSquare01Icon,
  SparklesIcon,
  CheckmarkSquare02Icon,
  CheckmarkCircle02Icon,
  Flag02Icon,
  Calendar03Icon,
  ComputerTerminal01Icon,
  CloudIcon,
  Coins01Icon,
  Copy01Icon,
  Tick02Icon,
  RoboticIcon,
} from "@hugeicons/core-free-icons";
import { ClaudeAiIcon } from "@/components/ui/svgs/claudeAiIcon";
import { CodexLight } from "@/components/ui/svgs/codexLight";
import { CodexDark } from "@/components/ui/svgs/codexDark";
import { CursorLight } from "@/components/ui/svgs/cursorLight";
import { CursorDark } from "@/components/ui/svgs/cursorDark";
import { STATUS_META } from "@/lib/review-status";
import { tagPill } from "@/lib/tag-color";
import { cn } from "@/lib/utils";
import { Wordmark } from "./wordmark";
import { GitHubLoginButton } from "./github-login-button";
import { SiteHeader } from "./site-header";
import type { ReviewColumn } from "@/lib/github";

// The hosted webapp is PAUSED while we focus on the CLI + MCP. Flip this to `true`
// to re-surface the Cloud / GitHub sign-in entry points on the landing page (the
// webapp code itself is untouched — this only gates the marketing CTAs).
const SHOW_CLOUD = false;

export function MarketingLanding() {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
      <LaneLines />
      <Nav />
      <Hero />
      <Trusted />
      <RunItYourWay />
      <HowItWorks />
      <Features />
      <Mcp />
      <Convention />
      <CallToAction />
      <Footer />
    </div>
  );
}

/* ----------------------------------------------------------------- chrome -- */

function LaneLines() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-[900px] bg-[linear-gradient(90deg,var(--border)_1px,transparent_1px)] bg-[size:140px_100%] opacity-50 [mask-image:linear-gradient(to_bottom,black,transparent_85%)]" />
      <div className="absolute -top-44 left-1/2 h-[28rem] w-[46rem] -translate-x-1/2 rounded-full bg-primary/15 blur-[130px]" />
    </div>
  );
}

function Nav() {
  return (
    <SiteHeader
      center={
        <nav className="hidden items-center gap-8 font-mono text-xs tracking-wide text-muted-foreground md:flex">
          <a href="#run" className="transition-colors hover:text-foreground">
            {SHOW_CLOUD ? "local & cloud" : "local"}
          </a>
          <a href="#how" className="transition-colors hover:text-foreground">
            how it works
          </a>
          <a href="#features" className="transition-colors hover:text-foreground">
            features
          </a>
          <a href="#mcp" className="transition-colors hover:text-foreground">
            mcp
          </a>
          <Link to="/guide" className="transition-colors hover:text-foreground">
            guide
          </Link>
        </nav>
      }
      actions={
        SHOW_CLOUD ? (
          <GitHubLoginButton size="sm">Sign in</GitHubLoginButton>
        ) : (
          <a
            href="#mcp"
            className="inline-flex h-8 items-center gap-1.5 rounded-2xl bg-primary px-3.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Get started
            <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5" />
          </a>
        )
      }
    />
  );
}

/* ------------------------------------------------------------------- hero -- */

function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-10 pt-20 sm:pt-28">
      <div className="mx-auto max-w-3xl text-center">
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/40 px-3 py-1 font-mono text-xs tracking-wide text-muted-foreground"
        >
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
          </span>
          .agents/reviews
          <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5" />
          kanban
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
          className="mt-6 font-heading text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl"
        >
          Every agent review,
          <br />
          <span className="relative whitespace-nowrap">
            in its
            <span className="text-primary"> lane</span>.
            <Underline />
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.12 }}
          className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground"
        >
          Your AI coding agent writes review checklists before it ships. Lanework turns
          that <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">.agents/reviews</code> folder
          into a live Kanban board — <strong className="font-semibold text-foreground">right where you
          code</strong>. One command, no sign-in, fully offline.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.18 }}
          className="mt-9 flex flex-col items-center justify-center gap-4"
        >
          <CommandPill command="npx @phake/lanework" />
          <a
            href="#how"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            how it works
            <HugeiconsIcon icon={ArrowDown01Icon} className="size-4" />
          </a>
        </motion.div>
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.24 }}
          className="mt-4 font-mono text-xs text-muted-foreground"
        >
          local-first · no account needed · fully offline · open source
        </motion.p>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
        className="mt-16"
      >
        <BoardMock />
      </motion.div>
    </section>
  );
}

function Underline() {
  return (
    <svg
      className="absolute -bottom-2 left-0 w-full text-primary/40"
      viewBox="0 0 300 12"
      fill="none"
      preserveAspectRatio="none"
      aria-hidden
    >
      <path
        d="M2 9C60 3 120 3 180 6c40 2 80 2 118 -2"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Copyable `npx` command pill — the primary, local-first call to action. */
// `tone="onDark"` is for pills sitting on the dark emerald CTA — the default
// muted/card tokens bleed the green through on hover, so use crisp, emerald-aware
// colors there instead.
function CommandPill({
  command,
  tone = "default",
  block = false,
}: {
  command: string;
  tone?: "default" | "onDark";
  block?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onDark = tone === "onDark";
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={cn(
        "group h-12 items-center gap-3 rounded-xl border pr-2.5 pl-4 font-mono text-sm shadow-sm transition-colors",
        block ? "flex w-full" : "inline-flex",
        onDark
          ? "border-white/20 bg-white hover:bg-emerald-50"
          : "border-border bg-card hover:bg-muted/40",
      )}
      aria-label={`Copy: ${command}`}
    >
      <span className={onDark ? "text-emerald-600" : "text-primary"}>$</span>
      <span className={onDark ? "text-emerald-950" : "text-foreground"}>{command}</span>
      <span
        className={cn(
          "ml-auto grid size-7 shrink-0 place-items-center rounded-lg transition-colors",
          onDark
            ? "bg-emerald-600/10 text-emerald-700 group-hover:bg-emerald-600/20 group-hover:text-emerald-900"
            : "bg-muted text-muted-foreground group-hover:text-foreground",
        )}
      >
        <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} className="size-4" />
      </span>
    </button>
  );
}

/* --------------------------------------------------------- run it your way -- */

function RunItYourWay() {
  return (
    <section id="run" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
      <SectionHeading eyebrow="local-first" title={SHOW_CLOUD ? "Run it your way" : "Run it locally"} />
      <div className={cn("mt-12 grid gap-5", SHOW_CLOUD ? "lg:grid-cols-2" : "mx-auto max-w-xl")}>
        {/* Local — the recommended path */}
        <Reveal>
          <div className="relative h-full rounded-2xl border-2 border-primary/30 bg-card p-7 shadow-sm">
            {SHOW_CLOUD ? (
              <span className="absolute top-6 right-6 rounded-full bg-primary/10 px-2.5 py-1 font-mono text-[11px] font-medium text-primary">
                recommended
              </span>
            ) : null}
            <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
              <HugeiconsIcon icon={ComputerTerminal01Icon} className="size-6" />
            </span>
            <h3 className="mt-4 text-xl font-semibold tracking-tight">Local</h3>
            <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Board the repo you’re in — no account, no network, fully offline.
            </p>
            <div className="mt-5">
              <CommandPill command="npx @phake/lanework" />
            </div>
            <ul className="mt-6 flex flex-col gap-2.5 text-sm">
              <Bullet>
                Live-watches <code className="font-mono text-xs">.agents/reviews/</code> as your agent writes
              </Bullet>
              <Bullet>
                <strong className="font-medium text-foreground">Run a Claude Code agent</strong> on a card — pick the model, effort, and mode, right from the board
              </Bullet>
              <Bullet>
                See each run’s <strong className="font-medium text-foreground">cost</strong> on the card — tokens, runtime, and ~$ written back into the review
              </Bullet>
              <Bullet>
                Tick boxes and <strong className="font-medium text-foreground">Save changes</strong> back to disk
              </Bullet>
              <Bullet>
                <strong className="font-medium text-foreground">Cost view</strong> — estimate your Claude Code token spend
              </Bullet>
            </ul>
          </div>
        </Reveal>

        {/* Cloud — the hosted option (paused) */}
        {SHOW_CLOUD ? (
          <Reveal delay={0.08}>
            <div className="h-full rounded-2xl border border-border/70 bg-card p-7 shadow-sm">
              <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
                <HugeiconsIcon icon={CloudIcon} className="size-6" />
              </span>
              <h3 className="mt-4 text-xl font-semibold tracking-tight">Cloud</h3>
              <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
                Prefer the hosted app? Sign in with GitHub and board any repo you can access, from anywhere.
              </p>
              <div className="mt-5">
                <GitHubLoginButton size="lg">Continue with GitHub</GitHubLoginButton>
              </div>
              <ul className="mt-6 flex flex-col gap-2.5 text-sm">
                <Bullet>Any repo, any branch — nothing to install</Bullet>
                <Bullet>KV-cached fetch with a “last fetched” badge</Bullet>
                <Bullet>Read-only — never writes to your repos</Bullet>
              </ul>
            </div>
          </Reveal>
        ) : null}
      </div>
    </section>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-muted-foreground">
      <HugeiconsIcon icon={CheckmarkCircle02Icon} className="mt-0.5 size-4 shrink-0 text-primary" />
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}

/* -------------------------------------------------------------- board mock -- */

interface MockCard {
  title: string;
  summary?: string;
  priority?: "high" | "medium" | "low";
  date: string;
  done: number;
  total: number;
  tags?: string[];
  people: string[];
  /** Shows the "Claude is working" badge — a card with a live agent run. */
  running?: boolean;
}

interface MockItem {
  id: string;
  col: ReviewColumn;
  card: MockCard;
}

/** The three pipeline columns the demo card flows through. */
const BOARD_COLS: ReviewColumn[] = ["todo", "processing", "done"];

const INITIAL_ITEMS: MockItem[] = [
  {
    id: "dark-mode",
    col: "todo",
    card: {
      title: "Add dark mode toggle",
      summary: "Respect the OS preference and persist the choice across sessions.",
      priority: "medium",
      date: "21 Jun 2026",
      done: 0,
      total: 8,
      tags: ["ui", "design-system"],
      people: ["alex", "mira"],
    },
  },
  {
    id: "search-api",
    col: "todo",
    card: {
      title: "Paginate the search API",
      summary: "Cursor-based pagination for the results endpoint, 25 per page.",
      priority: "low",
      date: "20 Jun 2026",
      done: 0,
      total: 5,
      tags: ["server-fn"],
      people: ["pat"],
    },
  },
  {
    id: "auth",
    col: "processing",
    card: {
      title: "Refactor auth middleware",
      summary: "Extract token verification into a shared helper and cover the refresh path.",
      priority: "high",
      date: "19 Jun 2026",
      done: 4,
      total: 9,
      tags: ["auth", "server-fn"],
      people: ["alex", "jdoe", "mira"],
    },
  },
  {
    id: "og-images",
    col: "processing",
    card: {
      title: "Generate OG images",
      summary: "Render per-page social cards at build time via a Worker.",
      priority: "medium",
      date: "19 Jun 2026",
      done: 2,
      total: 6,
      tags: ["cloudflare"],
      people: ["jdoe"],
      running: true,
    },
  },
  {
    id: "cache",
    col: "done",
    card: {
      title: "Cache homepage queries",
      summary: "Memoize the board metadata GraphQL query (≈50 files per request).",
      priority: "medium",
      date: "18 Jun 2026",
      done: 14,
      total: 14,
      tags: ["d1", "cloudflare"],
      people: ["pat"],
    },
  },
  {
    id: "flaky",
    col: "done",
    card: {
      title: "Fix flaky checkout test",
      summary: "Stabilize the retry-prone e2e by awaiting the network-idle state.",
      priority: "low",
      date: "17 Jun 2026",
      done: 6,
      total: 6,
      tags: ["board"],
      people: ["alex", "mira"],
    },
  },
];

/** Cards that take turns "flowing" forward through the columns, in this order. */
const TRAVELERS = ["dark-mode", "auth", "search-api"];

/** Pointer coords (viewport-relative, like getBoundingClientRect) from a drag event. */
function pointerXY(e: MouseEvent | TouchEvent | PointerEvent): { x: number; y: number } {
  if ("clientX" in e) return { x: e.clientX, y: e.clientY };
  const t = e.changedTouches?.[0];
  return t ? { x: t.clientX, y: t.clientY } : { x: 0, y: 0 };
}

function BoardMock() {
  const reduceMotion = useReducedMotion();
  const [items, setItems] = useState(INITIAL_ITEMS);
  const [liftedId, setLiftedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Column drop zones for hit-testing a user drag, + a timestamp that pauses the
  // auto-demo for a bit after the user interacts (so it never fights the user).
  const colRefs = useRef<Partial<Record<ReviewColumn, HTMLDivElement | null>>>({});
  const pauseUntil = useRef(0);

  // Auto-demo: on a loop, "pick up" a card (lift) and drop it into the next
  // column — the shared `layoutId` makes it glide across and the counts reflow.
  // Paused while/just after the user drags, and skipped under reduced motion.
  useEffect(() => {
    if (reduceMotion) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push(setTimeout(resolve, ms));
      });

    void (async () => {
      let turn = 0;
      while (!cancelled) {
        await wait(2400);
        if (cancelled) break;
        if (Date.now() < pauseUntil.current) continue; // user is driving — skip this turn
        const id = TRAVELERS[turn % TRAVELERS.length];
        turn += 1;
        setLiftedId(id); // pick up
        await wait(420);
        if (cancelled) break;
        setItems((prev) =>
          prev.map((it) =>
            it.id === id
              ? { ...it, col: BOARD_COLS[(BOARD_COLS.indexOf(it.col) + 1) % BOARD_COLS.length] }
              : it,
          ),
        ); // drop into the next column
        await wait(560);
        if (cancelled) break;
        setLiftedId(null); // set down
      }
    })();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [reduceMotion]);

  const handleDragEnd = (id: string, e: MouseEvent | TouchEvent | PointerEvent) => {
    const { x, y } = pointerXY(e);
    let target: ReviewColumn | null = null;
    for (const col of BOARD_COLS) {
      const r = colRefs.current[col]?.getBoundingClientRect();
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        target = col;
        break;
      }
    }
    setDraggingId(null);
    pauseUntil.current = Date.now() + 6000; // give the user the wheel for a bit
    if (target) setItems((prev) => prev.map((it) => (it.id === id ? { ...it, col: target } : it)));
  };

  return (
    <div className="relative mx-auto max-w-5xl rounded-2xl border border-border/70 bg-card/80 p-3 shadow-2xl shadow-black/5 backdrop-blur sm:p-4">
      {/* faux window bar */}
      <div className="mb-3 flex items-center gap-1.5 px-2">
        <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        <span className="ml-3 font-mono text-[11px] text-muted-foreground">lanework — acme/web</span>
        <span className="ml-auto hidden font-mono text-[10px] text-muted-foreground/70 sm:inline">
          drag a card between columns
        </span>
      </div>

      <LayoutGroup>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {BOARD_COLS.map((col) => {
            const meta = STATUS_META[col];
            const colItems = items.filter((it) => it.col === col);
            return (
              <motion.div
                key={col}
                ref={(el) => {
                  colRefs.current[col] = el;
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.45 }}
                className="rounded-xl bg-muted/40 p-2.5"
              >
                <div className="mb-2 flex items-center gap-2 px-1">
                  <HugeiconsIcon icon={meta.icon} className={cn("size-4", meta.color)} />
                  <span className="text-sm font-medium">{meta.label}</span>
                  <motion.span layout className="text-sm text-muted-foreground">
                    {colItems.length}
                  </motion.span>
                </div>
                <div className="flex min-h-[4.5rem] flex-col gap-2">
                  {colItems.map((it) => {
                    const dragging = draggingId === it.id;
                    const lifted = liftedId === it.id || dragging;
                    return (
                      <motion.div
                        key={it.id}
                        layout
                        layoutId={it.id}
                        drag
                        dragSnapToOrigin
                        dragElastic={0.2}
                        whileDrag={{ scale: 1.05, rotate: -2 }}
                        onDragStart={() => {
                          setDraggingId(it.id);
                          pauseUntil.current = Date.now() + 6000;
                        }}
                        onDragEnd={(e) => handleDragEnd(it.id, e)}
                        animate={
                          dragging ? undefined : { scale: lifted ? 1.035 : 1, rotate: lifted ? -1.5 : 0 }
                        }
                        transition={{
                          layout: { type: "spring", stiffness: 380, damping: 32 },
                          default: { duration: 0.28 },
                        }}
                        style={{ position: "relative", zIndex: lifted ? 30 : 1 }}
                        className="cursor-grab touch-none active:cursor-grabbing"
                      >
                        <MockCardView card={it.card} lifted={lifted} />
                      </motion.div>
                    );
                  })}
                </div>
              </motion.div>
            );
          })}
        </div>
      </LayoutGroup>
    </div>
  );
}

// Priority shown as a colored flag in the card corner (mirrors KanbanCard's PRIORITY_ICON).
const PRIORITY_FLAG: Record<string, string> = {
  high: "text-rose-500 fill-rose-100",
  medium: "text-amber-500 fill-amber-100",
  low: "text-muted-foreground/50 fill-muted-foreground",
};
const AVATAR = ["bg-emerald-500", "bg-sky-500", "bg-violet-500", "bg-rose-500"];

// Mirrors the real KanbanCard: title + priority flag → summary → calendar date →
// footer (color-coded x/y progress, tag pills, stacked assignee avatars).
function MockCardView({ card, lifted = false }: { card: MockCard; lifted?: boolean }) {
  const pct = card.total ? Math.round((card.done / card.total) * 100) : 0;
  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-3.5 transition-shadow duration-300",
        lifted
          ? "border-primary/40 shadow-[0_14px_30px_rgba(0,0,0,0.18)]"
          : "border-border shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
      )}
    >
      <div className="flex items-start gap-2">
        <h3 className="line-clamp-2 flex-1 text-sm font-semibold leading-snug text-card-foreground">{card.title}</h3>
        {card.priority ? (
          <HugeiconsIcon icon={Flag02Icon} className={cn("mt-0.5 size-4 shrink-0", PRIORITY_FLAG[card.priority])} />
        ) : null}
      </div>

      {card.summary ? (
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{card.summary}</p>
      ) : null}

      {card.running ? (
        <span className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-violet-600 dark:text-violet-400">
          <HugeiconsIcon icon={RoboticIcon} className="size-3.5" />
          Claude is working
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-violet-500/70" />
            <span className="relative inline-flex size-1.5 rounded-full bg-violet-500" />
          </span>
        </span>
      ) : null}

      <div className="mt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <HugeiconsIcon icon={Calendar03Icon} className="size-3.5" />
        <span className="tabular-nums">{card.date}</span>
      </div>

      <div className="mt-3 flex items-center gap-2.5 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
        {card.total > 0 ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 tabular-nums",
              pct === 100 && "font-medium text-emerald-600 dark:text-emerald-400",
            )}
          >
            <HugeiconsIcon icon={CheckmarkSquare02Icon} className="size-3.5" />
            {card.done}/{card.total}
          </span>
        ) : null}

        {card.tags?.length ? (
          <span className="flex min-w-0 items-center gap-1">
            {card.tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className={cn("max-w-[6rem] truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium", tagPill(tag))}
              >
                {tag}
              </span>
            ))}
            {card.tags.length > 2 ? (
              <span className="text-[11px] text-muted-foreground">+{card.tags.length - 2}</span>
            ) : null}
          </span>
        ) : null}

        {card.people.length ? (
          <div className="ml-auto flex -space-x-1.5">
            {card.people.slice(0, 3).map((p, i) => (
              <span
                key={p}
                className={cn(
                  "grid size-5 place-items-center rounded-full text-[8px] font-semibold text-white ring-2 ring-card",
                  AVATAR[i % AVATAR.length],
                )}
              >
                {p[0].toUpperCase()}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- trusted -- */

function Trusted() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-14">
      <Reveal className="flex flex-col items-center gap-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Works with your coding agent
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-6 text-foreground/80">
          <Brand label="Claude Code">
            <ClaudeAiIcon className="size-6" />
          </Brand>
          <Brand label="Codex">
            <CodexLight className="size-6 dark:hidden" />
            <CodexDark className="hidden size-6 dark:block" />
          </Brand>
          <Brand label="Cursor">
            <CursorLight className="size-6 dark:hidden" />
            <CursorDark className="hidden size-6 dark:block" />
          </Brand>
        </div>
      </Reveal>
    </section>
  );
}

function Brand({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      {children}
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

/* ----------------------------------------------------------- how it works -- */

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Add an instructions file to your repo",
      body: "Drop the convention into your AGENTS.md — one file, works with Claude Code, Codex, Cursor and more. Copy the template from the guide.",
    },
    {
      n: "02",
      title: "Your agent writes reviews",
      body: "Before changing behavior, it writes a checklist to .agents/reviews/todo/ and waits for you to flip every box to [x].",
    },
    {
      n: "03",
      title: "Watch the board",
      body: "Run npx @phake/lanework in the repo. Cards flow todo → processing → done as work gets approved and ships.",
    },
  ];
  return (
    <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
      <SectionHeading eyebrow="how it works" title="From folder to flow in three steps" />
      <div className="mt-12 grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:items-center">
        <div className="flex flex-col gap-8">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.08}>
              <div className="flex gap-5">
                <span className="font-mono text-sm text-primary">{s.n}</span>
                <div>
                  <h3 className="text-lg font-semibold tracking-tight">{s.title}</h3>
                  <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.1}>
          <MappingCard />
        </Reveal>
      </div>
    </section>
  );
}

function MappingCard() {
  const rows: { folder: string; col: ReviewColumn }[] = [
    { folder: "todo/", col: "todo" },
    { folder: "processing/", col: "processing" },
    { folder: "done/", col: "done" },
    { folder: "dropped/", col: "dropped" },
  ];
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      <p className="mb-4 font-mono text-xs text-muted-foreground">.agents/reviews/</p>
      <div className="flex flex-col gap-2">
        {rows.map((r) => {
          const meta = STATUS_META[r.col];
          return (
            <div key={r.folder} className="flex items-center gap-3">
              <code className="w-28 font-mono text-sm text-foreground">{r.folder}</code>
              <HugeiconsIcon icon={ArrowRight01Icon} className="size-4 text-muted-foreground" />
              <span className="inline-flex items-center gap-2 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
                <HugeiconsIcon icon={meta.icon} className={cn("size-3.5", meta.color)} />
                {meta.label}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-4 inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t pt-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
        frontmatter
        <HugeiconsIcon icon={ArrowRight01Icon} className="size-3" />
        priority · assignees · tags
        <span className="w-full" />
        checkboxes
        <HugeiconsIcon icon={ArrowRight01Icon} className="size-3" />
        progress
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- features -- */

function Features() {
  const features = [
    { icon: ComputerTerminal01Icon, title: "Local-first CLI", body: "Run npx @phake/lanework against the repo you’re in. No auth, no network, with live folder-watch." },
    { icon: DashboardSquare01Icon, title: "Board & List", body: "Four columns from your folders, or a dense list view. Your reviews, organized the way you think." },
    { icon: CheckmarkSquare02Icon, title: "Approve in place", body: "Tick checklist items in the full-screen review — locally, Save changes writes them back to the markdown." },
    { icon: Coins01Icon, title: "Cost view", body: "See what the project cost in Claude Code tokens, with a cache-aware per-model breakdown. (Local)" },
    SHOW_CLOUD
      ? { icon: CloudIcon, title: "Cloud, when you want it", body: "Sign in with GitHub to board any repo from anywhere — KV-cached and read-only." }
      : { icon: RoboticIcon, title: "Run agents on cards", body: "Dispatch a Claude Code agent on any card — pick the model, effort & mode, then see the run's token cost written back. Or let the MCP server drive the full lifecycle." },
    { icon: SparklesIcon, title: "Built to feel good", body: "Fluid motion, dark-mode tokens, and a “/” to jump between repos. A tool you’ll want to open." },
  ];
  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
      <SectionHeading eyebrow="features" title="Everything you need to triage agent work" />
      <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border/70 bg-border/70 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f, i) => (
          <Reveal key={f.title} delay={(i % 3) * 0.06} className="bg-card">
            <div className="group h-full p-6 transition-colors hover:bg-muted/30">
              <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary transition-transform group-hover:scale-105">
                <HugeiconsIcon icon={f.icon} className="size-5" />
              </span>
              <h3 className="mt-4 font-semibold tracking-tight">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------- file/code window -- */

/**
 * A light "file window" chrome — a titled header bar (icon · filename · copy
 * affordance) over a syntax-highlighted body. Shared by the MCP terminal and the
 * convention-file mockups so both read as the same on-brand surface, not raw
 * dark terminals. The syntax accent uses the page's emerald `text-primary`.
 */
function FileWindow({
  icon,
  name,
  children,
}: {
  icon: React.ComponentProps<typeof HugeiconsIcon>["icon"];
  name: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xl">
      <div className="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-4 py-2.5">
        <HugeiconsIcon icon={icon} className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{name}</span>
      </div>
      <div className="flex-1 overflow-x-auto p-5">{children}</div>
    </div>
  );
}

/** One highlighted line of a markdown review file (headings, frontmatter, checkboxes). */
function MdLine({ line }: { line: string }) {
  if (/^#{1,6}\s/.test(line)) return <span className="font-medium text-primary">{line}</span>;
  if (line === "---") return <span className="text-muted-foreground/50">{line}</span>;
  const cb = line.match(/^(\s*-\s\[)([ xX])(\]\s)(.*)$/);
  if (cb) {
    return (
      <span className="text-foreground">
        {cb[1]}
        <span className={cb[2].trim() ? "text-primary" : "text-muted-foreground"}>{cb[2]}</span>
        {cb[3]}
        {cb[4]}
      </span>
    );
  }
  const kv = line.match(/^([a-z_]+)(:\s*)(.*)$/);
  if (kv) {
    return (
      <span className="text-foreground">
        <span className="text-muted-foreground">{kv[1]}</span>
        {kv[2]}
        {kv[3]}
      </span>
    );
  }
  return <span className="text-foreground">{line || " "}</span>;
}

/** One highlighted line of a shell/Claude Code session (prompts, ✓, comments, slash cmds). */
function ShLine({ line }: { line: string }) {
  if (line.startsWith("$ "))
    return (
      <span className="text-foreground">
        <span className="text-muted-foreground">$</span>
        {line.slice(1)}
      </span>
    );
  if (line.startsWith("✓")) return <span className="text-emerald-600 dark:text-emerald-400">{line}</span>;
  if (line.startsWith("#")) return <span className="italic text-muted-foreground/70">{line}</span>;
  const cmd = line.match(/^(\/lanework:\S+)(.*)$/);
  if (cmd)
    return (
      <span className="text-foreground">
        <span className="font-medium text-primary">{cmd[1]}</span>
        {cmd[2]}
      </span>
    );
  const arrow = line.match(/^(\s*→\s)(\S+)(\s+)(.*)$/);
  if (arrow)
    return (
      <span className="text-muted-foreground">
        {arrow[1]}
        <span className="text-foreground/80">{arrow[2]}</span>
        {arrow[3]}
        <span className="text-primary/80">{arrow[4]}</span>
      </span>
    );
  return <span className="text-foreground">{line || " "}</span>;
}

/** Syntax-highlighted code body for the FileWindow, line by line. */
function CodeBlock({ code, lang }: { code: string; lang: "md" | "sh" }) {
  const Line = lang === "md" ? MdLine : ShLine;
  return (
    <pre className="font-mono text-[12.5px] leading-relaxed">
      {code.split("\n").map((l, i) => (
        <div key={i}>
          <Line line={l} />
        </div>
      ))}
    </pre>
  );
}

/* --------------------------------------------------------------------- mcp -- */

const MCP_STEPS = [
  { icon: Flag02Icon, cmd: "create_review", label: "Inception", body: "Draft a checklist of decisions as a todo card." },
  { icon: CheckmarkSquare02Icon, cmd: "toggle_item", label: "Review", body: "Tick each decision once it's agreed." },
  { icon: ArrowRight01Icon, cmd: "set_status", label: "Ship", body: "Advance todo → processing → done." },
];

const MCP_FLOW = `$ claude plugin marketplace add fuongz/lanework
$ claude plugin install lanework@lanework
✓ lanework installed (commands + MCP server)

# then, inside Claude Code:
/lanework:create  Add rate limiting
  → create_review   .agents/reviews/2026-06-29/01-add-rate-limiting.md
/lanework:tick     rate limiting :: 1
  → toggle_item     1/3 done
/lanework:advance  rate limiting → processing
  → set_status      processing`;

function Mcp() {
  return (
    <section id="mcp" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
      <SectionHeading eyebrow="mcp · ai-dlc" title="Or let your agent run the board" />
      <p className="mx-auto mt-4 max-w-2xl text-center text-sm leading-relaxed text-muted-foreground">
        Lanework ships a Model Context Protocol server, so your agent drives an
        <strong className="text-foreground"> AI-Driven Development Lifecycle</strong> end to end —
        creating reviews, ticking decisions, and moving cards across the board as work ships.
      </p>

      <div className="mt-12 grid gap-5 lg:grid-cols-2 lg:items-stretch">
        <Reveal>
          <div className="flex h-full flex-col rounded-2xl border border-border/70 bg-card p-7 shadow-sm">
            <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
              <HugeiconsIcon icon={ComputerTerminal01Icon} className="size-6" />
            </span>
            <h3 className="mt-4 text-xl font-semibold tracking-tight">Install the plugin</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              The Claude Code plugin gives you the slash commands <strong className="text-foreground">and</strong>{" "}
              the MCP server in one step.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <CommandPill command="claude plugin marketplace add fuongz/lanework" block />
              <CommandPill command="claude plugin install lanework@lanework" block />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Runs headless by default (tools only). Set{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">LANEWORK_DASHBOARD=1</code>{" "}
              to also auto-open the board (≈ <span className="font-mono">:3662</span>) when Claude Code starts.
            </p>
            <div className="mt-6 flex flex-col gap-4">
              {MCP_STEPS.map((s) => (
                <div key={s.cmd} className="flex items-start gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-primary">
                    <HugeiconsIcon icon={s.icon} className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {s.label}{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {s.cmd}
                      </code>
                    </p>
                    <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-6 flex flex-wrap items-center gap-1.5 border-t pt-5 font-mono text-[11px] text-muted-foreground">
              slash commands:
              {["/lanework:create", "/lanework:status", "/lanework:advance", "/lanework:tick"].map((c) => (
                <span key={c} className="rounded bg-muted px-1.5 py-0.5">
                  {c}
                </span>
              ))}
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.08}>
          <FileWindow icon={ComputerTerminal01Icon} name="claude code → lanework mcp">
            <CodeBlock code={MCP_FLOW} lang="sh" />
          </FileWindow>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- convention -- */

const EXAMPLE = `---
status: processing
assignees: ["you"]
created_at: 2026-06-21
priority: high
tags: ["auth", "api"]
---

# Review: Refactor auth middleware

- [x] Extract token verification into a helper
- [ ] Add rate-limit headers to 401s
- [ ] Cover the refresh-token path with tests`;

function Convention() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
        <Reveal>
          <SectionHeading
            align="left"
            eyebrow="the convention"
            title="A markdown file your agent already knows how to write"
          />
          <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground">
            No new format to learn. A review is a checklist with a little frontmatter. Lanework reads
            the <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">status:</code> field for
            the column, the frontmatter for the metadata, and the checkboxes for progress. That’s it.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <CommandPill command="npx @phake/lanework" />
            <Link
              to="/guide"
              className="inline-flex h-12 items-center gap-1.5 rounded-xl border px-5 text-sm font-medium transition-colors hover:bg-muted"
            >
              Read the guide
              <HugeiconsIcon icon={ArrowRight01Icon} className="size-4" />
            </Link>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <FileWindow icon={Flag02Icon} name=".agents/reviews/2026-06-21/01-refactor-auth-middleware.md">
            <CodeBlock code={EXAMPLE} lang="md" />
          </FileWindow>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- cta -- */

function CallToAction() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <Reveal>
        <div className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-emerald-600 via-emerald-700 to-emerald-800 px-8 py-20 text-center shadow-2xl shadow-emerald-900/30 ring-1 ring-inset ring-white/10">
          {/* lane lines + glows */}
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.07)_1px,transparent_1px)] bg-[size:120px_100%] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
          <div className="pointer-events-none absolute -top-24 left-1/2 h-72 w-[40rem] -translate-x-1/2 rounded-full bg-emerald-300/30 blur-[120px]" />
          <div className="pointer-events-none absolute -bottom-28 -right-12 size-72 rounded-full bg-teal-300/20 blur-[110px]" />

          <div className="relative mx-auto max-w-xl">
            <img
              src="/logo.png"
              alt=""
              className="mx-auto mb-6 size-16 rounded-2xl shadow-lg shadow-emerald-950/30 ring-1 ring-white/20"
            />
            <h2 className="font-heading text-3xl font-semibold tracking-tight text-white sm:text-[2.5rem] sm:leading-tight">
              Bring your agent’s reviews to life.
            </h2>
            <p className="mx-auto mt-4 max-w-md text-emerald-50/80">
              {SHOW_CLOUD
                ? "One command in any repo — or sign in for the Cloud. Free and open source."
                : "One command in any repo. Free and open source."}
            </p>
            <div className="mt-8 flex flex-col items-center gap-3">
              <CommandPill command="npx @phake/lanework" tone="onDark" />
              {SHOW_CLOUD ? (
                <GitHubLoginButton variant="invert" size="sm">
                  or continue with GitHub
                </GitHubLoginButton>
              ) : null}
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ---------------------------------------------------------------- footer -- */

function Footer() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
          <Wordmark />
          <nav className="flex flex-wrap items-center gap-x-7 gap-y-2 font-mono text-xs text-muted-foreground">
            <Link to="/guide" className="hover:text-foreground">
              guide
            </Link>
            <a href="https://github.com/fuongz/lanework" className="hover:text-foreground">
              github
            </a>
            <a href="https://github.com/fuongz/lanework#readme" className="hover:text-foreground">
              docs
            </a>
            <span>MIT</span>
          </nav>
        </div>
        <div className="mt-8 border-t border-border/60 pt-6 text-center text-xs text-muted-foreground">
          Made with{" "}
          <span className="text-rose-500" aria-label="love">
            ♥
          </span>{" "}
          by{" "}
          <a
            href="https://phuongphung.com"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            fuongz
          </a>
        </div>
      </div>
    </footer>
  );
}

/* --------------------------------------------------------------- helpers -- */


function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  align = "center",
}: {
  eyebrow: string;
  title: string;
  align?: "center" | "left";
}) {
  return (
    <div className={cn(align === "center" && "mx-auto max-w-2xl text-center")}>
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">{eyebrow}</p>
      <h2 className="mt-3 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
    </div>
  );
}
