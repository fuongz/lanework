import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Copy01Icon,
  Tick02Icon,
  Folder01Icon,
  FileEditIcon,
  Rocket01Icon,
  Github01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { getSessionUser, getRepos } from "@/server/reviews";
import { AppShell } from "@/components/app-shell";
import { SiteHeader } from "@/components/marketing/site-header";
import { CtaButton } from "@/components/marketing/cta-button";
import { Card, CardContent } from "@/components/ui/card";
import { signIn } from "@/lib/auth-client";
import { AGENTS_TEMPLATE, EXAMPLE_REVIEW } from "@/content/agents-template";
import { STATUS_META } from "@/lib/review-status";
import { ClaudeAiIcon } from "@/components/ui/svgs/claudeAiIcon";
import { CodexLight } from "@/components/ui/svgs/codexLight";
import { CodexDark } from "@/components/ui/svgs/codexDark";
import { CursorLight } from "@/components/ui/svgs/cursorLight";
import { CursorDark } from "@/components/ui/svgs/cursorDark";
import { Gemini } from "@/components/ui/svgs/gemini";
import { cn } from "@/lib/utils";
import { REVIEW_COLUMNS, type Repo } from "@/lib/github";

const signInGitHub = () => signIn.social({ provider: "github", callbackURL: "/" });

export const Route = createFileRoute("/guide")({
  loader: async () => {
    const user = await getSessionUser();
    if (!user) return { user: null, repos: [] as Repo[] };
    try {
      return { user, repos: await getRepos() };
    } catch {
      return { user, repos: [] as Repo[] };
    }
  },
  component: GuidePage,
});

function GuidePage() {
  const { user, repos } = Route.useLoaderData();
  if (user) {
    return (
      <AppShell user={user} repos={repos}>
        <GuideHeader />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GuideBody />
        </div>
      </AppShell>
    );
  }
  return (
    <div className="min-h-screen overflow-y-auto">
      <SiteHeader
        actions={
          <CtaButton size="sm" onClick={signInGitHub}>
            <HugeiconsIcon icon={Github01Icon} className="size-4" />
            Continue with GitHub
          </CtaButton>
        }
      />
      <div className="pt-16">
        <GuideBody />
      </div>
    </div>
  );
}

function GuideHeader() {
  return (
    <div className="px-6 pt-5 pb-4">
      <div className="text-sm text-muted-foreground">Documentation</div>
      <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">How to use</h1>
    </div>
  );
}

function GuideBody() {
  return (
    <div className="mx-auto w-full max-w-3xl animate-in space-y-10 px-6 py-8 fade-in duration-500 motion-reduce:animate-none">
      <section className="space-y-3">
        <h2 className="font-heading text-xl font-semibold">Turn agent reviews into a board</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This app visualizes the{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">.agents/reviews</code> folder of a
          GitHub repo. Your coding agent — Claude Code, Codex, Cursor, … — writes a review checklist
          per piece of work; the board groups them into columns and reads their metadata. Set it up
          once by adding an instructions file to your repo.
        </p>
      </section>

      {/* Mapping */}
      <section className="space-y-3">
        <SectionTitle icon={Folder01Icon}>How files map to the board</SectionTitle>
        <Card>
          <CardContent className="space-y-4 pt-6 text-sm">
            <p className="font-mono text-xs text-muted-foreground">.agents/reviews/</p>
            <div className="flex flex-col gap-2">
              {REVIEW_COLUMNS.map((col) => {
                const m = STATUS_META[col];
                return (
                  <div key={col} className="flex items-center gap-3">
                    <code className="w-28 font-mono text-xs text-foreground">{col}/</code>
                    <HugeiconsIcon icon={ArrowRight01Icon} className="size-4 text-muted-foreground" />
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
                      <HugeiconsIcon icon={m.icon} className={cn("size-3.5", m.color)} />
                      {m.label}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-muted-foreground">
              Each card reads its <strong>column</strong> from the folder, and{" "}
              <strong>date · priority · assignees · tags · progress</strong> from the file's YAML
              frontmatter plus its <code className="rounded bg-muted px-1 py-0.5 text-xs">- [ ]</code>{" "}
              / <code className="rounded bg-muted px-1 py-0.5 text-xs">- [x]</code> checkboxes.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Steps */}
      <section className="space-y-4">
        <SectionTitle icon={Rocket01Icon}>Set it up</SectionTitle>

        <Step n={1} title="Add an instructions file to your repo">
          <p className="text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">AGENTS.md</code> is the
            cross-tool standard. Drop it at your repo root — most agents pick it up automatically.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <ToolRow
              index={0}
              icon={<ClaudeAiIcon className="size-5" />}
              tool="Claude Code"
              file="CLAUDE.md or AGENTS.md"
            />
            <ToolRow
              index={1}
              icon={<ThemedIcon Light={CodexLight} Dark={CodexDark} />}
              tool="OpenAI Codex"
              file="AGENTS.md"
            />
            <ToolRow
              index={2}
              icon={<ThemedIcon Light={CursorLight} Dark={CursorDark} />}
              tool="Cursor"
              file="AGENTS.md / .cursor/rules"
            />
            <ToolRow
              index={3}
              icon={<Gemini className="size-5" />}
              tool="Gemini CLI & others"
              file="AGENTS.md / GEMINI.md"
            />
          </div>
        </Step>

        <Step n={2} title="Paste this standardized template">
          <p className="mb-3 text-sm text-muted-foreground">
            Project-agnostic. Add your own Domain Rules &amp; Gotchas below the marked line, and
            swap in your own tag vocabulary.
          </p>
          <CodeBlock code={AGENTS_TEMPLATE} />
        </Step>

        <Step n={3} title="Let the agent write a review">
          <p className="text-sm text-muted-foreground">
            Ask your agent to plan a behavior-changing task. Following the rules above, it writes a
            checklist to{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              .agents/reviews/todo/YYYY-MM-DD-&lt;slug&gt;.md
            </code>
            . You approve by flipping every <code className="rounded bg-muted px-1 py-0.5 text-xs">- [ ]</code>{" "}
            to <code className="rounded bg-muted px-1 py-0.5 text-xs">- [x]</code>; it then moves the
            file to <code className="rounded bg-muted px-1 py-0.5 text-xs">processing/</code>
            <HugeiconsIcon icon={ArrowRight01Icon} className="mx-1 inline size-3.5 align-[-0.2em]" />
            <code className="rounded bg-muted px-1 py-0.5 text-xs">done/</code>.
          </p>
        </Step>

        <Step n={4} title="Open the repo here">
          <p className="text-sm text-muted-foreground">
            Use the repo switcher (top-left) or the{" "}
            <Link to="/" className="underline underline-offset-2 hover:text-foreground">
              projects page
            </Link>{" "}
            to open the board. Cards appear as the agent creates and moves review files.
          </p>
        </Step>
      </section>

      {/* Example */}
      <section className="space-y-3">
        <SectionTitle icon={FileEditIcon}>Example review file</SectionTitle>
        <CodeBlock code={EXAMPLE_REVIEW} />
      </section>
    </div>
  );
}

function SectionTitle({ icon, children }: { icon: typeof Folder01Icon; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 font-heading text-lg font-semibold">
      <HugeiconsIcon icon={icon} className="size-5 text-primary" />
      {children}
    </h2>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">{title}</h3>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}

function ToolRow({
  icon,
  tool,
  file,
  index = 0,
}: {
  icon: React.ReactNode;
  tool: string;
  file: string;
  index?: number;
}) {
  return (
    <Card
      size="sm"
      style={{ animationDelay: `${index * 60}ms` }}
      className="group relative animate-in gap-0 overflow-hidden p-4 fade-in slide-in-from-bottom-2 fill-mode-both duration-500 ease-out transition-[box-shadow,transform,--tw-ring-color] hover:-translate-y-0.5 hover:shadow-md hover:ring-foreground/20 motion-reduce:animate-none"
    >
      {/* decorative corner glow */}
      <div className="pointer-events-none absolute -right-8 -top-8 size-20 rounded-full bg-primary/10 opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100" />
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-b from-background to-muted ring-1 ring-foreground/10 transition-transform duration-200 group-hover:scale-105">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{tool}</div>
          <div className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            <HugeiconsIcon icon={FileEditIcon} className="size-3 shrink-0" />
            <span className="truncate">{file}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

type SvgIcon = (props: React.SVGProps<SVGSVGElement>) => React.ReactElement;

function ThemedIcon({ Light, Dark }: { Light: SvgIcon; Dark: SvgIcon }) {
  return (
    <>
      <Light className="size-5 dark:hidden" />
      <Dark className="hidden size-5 dark:block" />
    </>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => {
          navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground shadow-xs transition-colors hover:text-foreground"
      >
        <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} className="size-3.5" />
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="max-h-[460px] overflow-auto rounded-xl border bg-muted/40 p-4 pr-20 font-mono text-xs leading-relaxed text-foreground">
        {code}
      </pre>
    </div>
  );
}
