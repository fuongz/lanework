import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Github01Icon,
  ArrowRight01Icon,
  ArrowDown01Icon,
  DashboardSquare01Icon,
  Tag01Icon,
  FileEditIcon,
  Rocket01Icon,
  SparklesIcon,
  CheckmarkSquare02Icon,
  Flag02Icon,
} from "@hugeicons/core-free-icons";
import { ClaudeAiIcon } from "@/components/ui/svgs/claudeAiIcon";
import { CodexLight } from "@/components/ui/svgs/codexLight";
import { CodexDark } from "@/components/ui/svgs/codexDark";
import { CursorLight } from "@/components/ui/svgs/cursorLight";
import { CursorDark } from "@/components/ui/svgs/cursorDark";
import { Gemini } from "@/components/ui/svgs/gemini";
import { tagPill } from "@/lib/tag-color";
import { STATUS_META } from "@/lib/review-status";
import { cn } from "@/lib/utils";
import { Wordmark } from "./wordmark";
import { GitHubLoginButton } from "./github-login-button";
import { SiteHeader } from "./site-header";
import type { ReviewColumn } from "@/lib/github";

export function MarketingLanding() {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
      <LaneLines />
      <Nav />
      <Hero />
      <Trusted />
      <HowItWorks />
      <Features />
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
          <a href="#how" className="transition-colors hover:text-foreground">
            how it works
          </a>
          <a href="#features" className="transition-colors hover:text-foreground">
            features
          </a>
          <Link to="/guide" className="transition-colors hover:text-foreground">
            guide
          </Link>
        </nav>
      }
      actions={
        <GitHubLoginButton size="sm">Sign in</GitHubLoginButton>
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
          <span className="size-1.5 rounded-full bg-primary" />
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
          into a live Kanban board — so you can see, approve, and track every change across a repo.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.18 }}
          className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
        >
          <GitHubLoginButton size="lg">Continue with GitHub</GitHubLoginButton>
          <a
            href="#how"
            className="inline-flex h-12 items-center gap-1.5 rounded-xl px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            See how it works
            <HugeiconsIcon icon={ArrowDown01Icon} className="size-4" />
          </a>
        </motion.div>
        <p className="mt-4 font-mono text-xs text-muted-foreground">
          read-only · never writes to your repos
        </p>
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

/* -------------------------------------------------------------- board mock -- */

interface MockCard {
  title: string;
  priority?: "high" | "medium" | "low";
  tags: string[];
  done: number;
  total: number;
  people: string[];
}

const MOCK: { col: ReviewColumn; cards: MockCard[] }[] = [
  {
    col: "todo",
    cards: [
      { title: "Add dark mode toggle", priority: "medium", tags: ["ui"], done: 0, total: 8, people: ["A", "M"] },
      { title: "Paginate the search API", priority: "low", tags: ["api"], done: 0, total: 5, people: ["P"] },
    ],
  },
  {
    col: "processing",
    cards: [
      { title: "Refactor auth middleware", priority: "high", tags: ["auth", "api"], done: 4, total: 9, people: ["A", "J", "M"] },
    ],
  },
  {
    col: "done",
    cards: [
      { title: "Cache homepage queries", priority: "medium", tags: ["perf"], done: 14, total: 14, people: ["P"] },
      { title: "Fix flaky checkout test", priority: "low", tags: ["tests"], done: 6, total: 6, people: ["A", "M"] },
    ],
  },
];

function BoardMock() {
  return (
    <div className="relative mx-auto max-w-5xl rounded-2xl border border-border/70 bg-card/80 p-3 shadow-2xl shadow-black/5 backdrop-blur sm:p-4">
      {/* faux window bar */}
      <div className="mb-3 flex items-center gap-1.5 px-2">
        <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        <span className="ml-3 font-mono text-[11px] text-muted-foreground">lanework — acme/web</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {MOCK.map((column, ci) => {
          const meta = STATUS_META[column.col];
          return (
            <motion.div
              key={column.col}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.35 + ci * 0.1 }}
              className="rounded-xl bg-muted/40 p-2.5"
            >
              <div className="mb-2 flex items-center gap-2 px-1">
                <HugeiconsIcon icon={meta.icon} className={cn("size-4", meta.color)} />
                <span className="text-sm font-medium">{meta.label}</span>
                <span className="text-sm text-muted-foreground">{column.cards.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {column.cards.map((card) => (
                  <MockCardView key={card.title} card={card} />
                ))}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

const PRIORITY: Record<string, string> = {
  high: "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  low: "bg-muted text-muted-foreground",
};
const AVATAR = ["bg-emerald-500", "bg-sky-500", "bg-violet-500"];

function MockCardView({ card }: { card: MockCard }) {
  const pct = card.total ? Math.round((card.done / card.total) * 100) : 0;
  return (
    <div className="rounded-lg border bg-card p-3 shadow-xs">
      <p className="text-[13px] font-medium leading-snug">{card.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {card.tags.map((t) => (
          <span key={t} className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", tagPill(t))}>
            {t}
          </span>
        ))}
        {card.priority ? (
          <span className={cn("ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize", PRIORITY[card.priority])}>
            {card.priority}
          </span>
        ) : null}
      </div>
      <div className="mt-2.5 flex items-center gap-2 border-t pt-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <HugeiconsIcon icon={CheckmarkSquare02Icon} className="size-3" />
          {card.done}/{card.total}
        </span>
        <div className="flex -space-x-1.5">
          {card.people.map((p, i) => (
            <span
              key={i}
              className={cn(
                "grid size-4 place-items-center rounded-full text-[8px] font-semibold text-white ring-2 ring-card",
                AVATAR[i % AVATAR.length],
              )}
            >
              {p}
            </span>
          ))}
        </div>
        <span className="ml-auto font-mono">{pct}%</span>
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
          <Brand label="Gemini">
            <Gemini className="size-6" />
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
      title: "Add AGENTS.md",
      body: "Drop the convention into your repo — one file, works with Claude Code, Codex, Cursor and more. Copy the template from the guide.",
    },
    {
      n: "02",
      title: "Your agent writes reviews",
      body: "Before changing behavior, it writes a checklist to .agents/reviews/todo/ and waits for you to flip every box to [x].",
    },
    {
      n: "03",
      title: "Watch the board",
      body: "Open the repo in Lanework. Cards flow todo → processing → done as work gets approved and ships.",
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
    { icon: DashboardSquare01Icon, title: "Board & List", body: "Four columns from your folders, or a dense list view. Your reviews, organized the way you think." },
    { icon: Tag01Icon, title: "Filter by tag & owner", body: "Slice to My tasks or any tag. The top tags surface right in the sidebar." },
    { icon: FileEditIcon, title: "Full-screen review", body: "Open a card for the rendered markdown plus a clean metadata panel — status, priority, progress." },
    { icon: Github01Icon, title: "GitHub-native, read-only", body: "Sign in, pick a repo. Lanework reads your reviews and never writes back — your files stay yours." },
    { icon: Rocket01Icon, title: "Fast by design", body: "File contents batch over GraphQL with an instant skeleton, so big boards open quick." },
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

/* ------------------------------------------------------------- convention -- */

const EXAMPLE = `---
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
            the folder for the column, the frontmatter for the metadata, and the checkboxes for
            progress. That’s it.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <GitHubLoginButton size="lg">Continue with GitHub</GitHubLoginButton>
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
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-[#0c0f0d] shadow-xl">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
              <HugeiconsIcon icon={Flag02Icon} className="size-3.5 text-emerald-400" />
              <span className="font-mono text-[11px] text-white/50">
                .agents/reviews/processing/2026-06-21-refactor-auth-middleware.md
              </span>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-relaxed text-emerald-50/90">
              {EXAMPLE}
            </pre>
          </div>
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
              Sign in with GitHub and open your first board in under a minute. Free and open source.
            </p>
            <div className="mt-8 flex justify-center">
              <GitHubLoginButton variant="invert" size="lg">
                Continue with GitHub
              </GitHubLoginButton>
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
