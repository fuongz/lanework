import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Copy01Icon,
  Tick02Icon,
  FileDownloadIcon,
  Folder01Icon,
  FileEditIcon,
  Rocket01Icon,
  ArrowRight01Icon,
  ArrowLeft01Icon,
  ComputerTerminal01Icon,
} from "@hugeicons/core-free-icons";
import { getSessionUser } from "@/server/reviews";
import { AppShell } from "@/components/app-shell";
import { SiteHeader } from "@/components/marketing/site-header";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { AGENTS_TEMPLATE, EXAMPLE_REVIEW } from "@/content/agents-template";
import { STATUS_META } from "@/lib/review-status";
import { ClaudeAiIcon } from "@/components/ui/svgs/claudeAiIcon";
import { CodexLight } from "@/components/ui/svgs/codexLight";
import { CodexDark } from "@/components/ui/svgs/codexDark";
import { CursorLight } from "@/components/ui/svgs/cursorLight";
import { CursorDark } from "@/components/ui/svgs/cursorDark";
import { Gemini } from "@/components/ui/svgs/gemini";
import { cn } from "@/lib/utils";
import { REVIEW_COLUMNS } from "@/lib/github";

export const Route = createFileRoute("/guide")({
  loader: async () => ({ user: await getSessionUser() }),
  head: () => ({ meta: [{ title: "How to use - Lanework" }] }),
  component: GuidePage,
});

/** Frontmatter fields the board reads, for the reference table. */
const FRONTMATTER_FIELDS: { key: string; values: string; note: React.ReactNode }[] = [
  {
    key: "status",
    values: "todo · processing · done · dropped",
    note: "Sets the board column. Omit it if you let folders carry the status instead.",
  },
  {
    key: "priority",
    values: "low · medium · high",
    note: "Colours the card's priority indicator.",
  },
  {
    key: "assignees",
    values: "GitHub logins",
    note: (
      <>
        Rendered as avatars, e.g. <code className="rounded bg-muted px-1 py-0.5 text-xs">{`["octocat"]`}</code>.
      </>
    ),
  },
  {
    key: "tags",
    values: "any strings",
    note: "Your own vocabulary — each value renders as a coloured pill you can filter by.",
  },
  {
    key: "created_at",
    values: "a YYYY-MM-DD date",
    note: "The card's date. Falls back to the YYYY-MM-DD/ folder or the filename.",
  },
];

function GuidePage() {
  const { user } = Route.useLoaderData();
  if (user) {
    return (
      <AppShell user={user}>
        <GuideHeader />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GuideBody />
        </div>
      </AppShell>
    );
  }
  return (
    <div className="min-h-screen overflow-y-auto">
      <SiteHeader />
      <div className="pt-16">
        <GuideBody />
      </div>
    </div>
  );
}

function GuideHeader() {
  return (
    <div className="px-6 pt-5 pb-4">
      <Link
        to="/dashboard"
        className="mb-3 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
        Back to projects
      </Link>
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
            <p className="font-mono text-xs text-muted-foreground">
              .agents/reviews/YYYY-MM-DD/NN-&lt;slug&gt;.md
            </p>
            <div className="flex flex-col gap-2">
              {REVIEW_COLUMNS.map((col) => {
                const m = STATUS_META[col];
                return (
                  <div key={col} className="flex items-center gap-3">
                    <code className="w-32 font-mono text-xs text-foreground">status: {col}</code>
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
              Each card reads its <strong>column</strong> from the{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">status:</code> field, its{" "}
              <strong>date</strong> from the <code className="rounded bg-muted px-1 py-0.5 text-xs">YYYY-MM-DD/</code>{" "}
              folder (the leading <code className="rounded bg-muted px-1 py-0.5 text-xs">NN-</code> orders cards
              within the day), and <strong>priority · assignees · tags · progress</strong> from the rest of the
              YAML frontmatter plus its <code className="rounded bg-muted px-1 py-0.5 text-xs">- [ ]</code> /{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">- [x]</code> checkboxes.
            </p>

            <div className="border-t pt-4 text-muted-foreground">
              <p>
                <strong className="text-foreground">Prefer folders?</strong> You can instead drop the{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">status:</code> field and put files in{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">todo/ processing/ done/ dropped/</code>{" "}
                folders — the folder then sets the column. To make folders authoritative, add{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">.agents/reviews/config.json</code> with{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  {`{"status":{"from":"folder"}}`}
                </code>
                .
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Frontmatter reference */}
      <section className="space-y-3">
        <SectionTitle icon={FileEditIcon}>Frontmatter fields</SectionTitle>
        <Card>
          <CardContent className="space-y-4 pt-6 text-sm">
            <p className="text-muted-foreground">
              Start each file with a YAML block between{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">---</code> lines. Every field is
              optional, and lists accept either a JSON array (
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{`["a","b"]`}</code>) or a
              comma-separated string (<code className="rounded bg-muted px-1 py-0.5 text-xs">a, b</code>).
              Any field the board doesn't recognise is left untouched — so you can keep your own custom
              keys alongside these.
            </p>
            <div className="divide-y overflow-hidden rounded-lg border">
              {FRONTMATTER_FIELDS.map((f) => (
                <div
                  key={f.key}
                  className="grid grid-cols-1 gap-1 p-3 sm:grid-cols-[8rem_1fr] sm:gap-3"
                >
                  <code className="font-mono text-xs text-foreground">{f.key}</code>
                  <div className="min-w-0 space-y-0.5">
                    <div className="font-mono text-xs text-muted-foreground">{f.values}</div>
                    <div className="text-muted-foreground">{f.note}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t pt-4 text-muted-foreground">
              <p>
                <strong className="text-foreground">Use your own key names.</strong> Already have a
                convention like <code className="rounded bg-muted px-1 py-0.5 text-xs">owner:</code> or{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">labels:</code>? Map them in{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">.agents/reviews/config.json</code>{" "}
                — the canonical key keeps working too:
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                {`{
  "fields": {
    "assignees": ["owner"],
    "tags": ["labels"],
    "priority": ["prio"],
    "created_at": ["due", "date"],
    "status": ["state"]
  }
}`}
              </pre>
              <p className="mt-2">
                Each value is the list of frontmatter keys to accept for that card field; the first one
                present in a file wins.
              </p>
            </div>
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
          <CodeBlock
            code={AGENTS_TEMPLATE}
            filename="AGENTS.md"
            icon={<ClaudeAiIcon className="size-5" />}
          />
        </Step>

        <Step n={3} title="Let the agent write a review">
          <p className="text-sm text-muted-foreground">
            Ask your agent to plan a behavior-changing task. Following the rules above, it writes a
            checklist to{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              .agents/reviews/YYYY-MM-DD/NN-&lt;slug&gt;.md
            </code>{" "}
            with <code className="rounded bg-muted px-1 py-0.5 text-xs">status: todo</code>. You approve by
            flipping every <code className="rounded bg-muted px-1 py-0.5 text-xs">- [ ]</code> to{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">- [x]</code>; it then bumps{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">status:</code> to{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">processing</code>
            <HugeiconsIcon icon={ArrowRight01Icon} className="mx-1 inline size-3.5 align-[-0.2em]" />
            <code className="rounded bg-muted px-1 py-0.5 text-xs">done</code>.
          </p>
        </Step>

        <Step n={4} title="Open the repo here">
          <p className="text-sm text-muted-foreground">
            Use the repo switcher (top-left) or the{" "}
            <Link to="/dashboard" className="underline underline-offset-2 hover:text-foreground">
              projects page
            </Link>{" "}
            to open the board. Cards appear as the agent creates and moves review files.
          </p>
        </Step>
      </section>

      {/* Example */}
      <section className="space-y-3">
        <SectionTitle icon={FileEditIcon}>Example review file</SectionTitle>
        <CodeBlock code={EXAMPLE_REVIEW} filename="2026-06-21/01-rate-limiting.md" />
      </section>

      {/* MCP / agent */}
      <section className="space-y-3">
        <SectionTitle icon={ComputerTerminal01Icon}>Let your agent drive the board (MCP)</SectionTitle>
        <Card>
          <CardContent className="space-y-4 pt-6 text-sm">
            <p className="text-muted-foreground">
              lanework ships a Model Context Protocol server, so your agent can run the whole review
              lifecycle — an <strong className="text-foreground">AI-Driven Development Lifecycle</strong>:
              create a checklist, tick decisions, and advance the column as work ships. Install the
              Claude Code plugin — it adds the <code className="rounded bg-muted px-1 py-0.5 text-xs">/lanework:*</code>{" "}
              slash commands <strong className="text-foreground">and</strong> the MCP server:
            </p>
            <CodeBlock
              code={"claude plugin marketplace add fuongz/lanework\nclaude plugin install lanework@lanework"}
              filename="Claude Code"
              lang="bash"
              icon={<HugeiconsIcon icon={ComputerTerminal01Icon} className="size-4 text-primary" />}
            />
            <p className="text-muted-foreground">
              Restart Claude Code, then type{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">/lanework:</code> —{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">create</code>,{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">status</code>,{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">advance</code>, and more. The server
              runs headless by default; set{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">LANEWORK_DASHBOARD=1</code>{" "}
              to also auto-open the board (≈{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">127.0.0.1:3662</code>) on startup.
            </p>
            <p className="text-muted-foreground">
              Just want the MCP tools (no slash commands)? Register the server on its own:{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">npx @phake/lanework setup claude-code</code>.
            </p>
            <div className="divide-y overflow-hidden rounded-lg border text-muted-foreground">
              {[
                ["create_review", "Inception — write a new todo checklist of decisions"],
                ["toggle_item", "Tick/untick a decision (by index or text), with a note"],
                ["set_status", "Advance todo → processing → done (or dropped)"],
                ["lifecycle_status", "Phase view + suggested next actions"],
                ["list_reviews / get_review", "Read the board and a card's full markdown"],
              ].map(([tool, desc]) => (
                <div key={tool} className="grid grid-cols-1 gap-1 p-3 sm:grid-cols-[12rem_1fr] sm:gap-3">
                  <code className="font-mono text-xs text-foreground">{tool}</code>
                  <span>{desc}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
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

function CodeBlock({
  code,
  filename,
  lang = "markdown",
  icon,
}: {
  code: string;
  filename: string;
  lang?: string;
  /** Replaces the extension badge (e.g. a tool logo). */
  icon?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null>(null);

  // Highlight with Shiki, lazy-imported so the bundle stays out of the route chunk.
  useEffect(() => {
    let active = true;
    import("shiki")
      .then(({ codeToHtml }) =>
        codeToHtml(code, { lang, themes: { light: "github-light", dark: "github-dark" } }),
      )
      .then((out) => active && setHtml(out))
      .catch(() => active && setHtml(null));
    return () => {
      active = false;
    };
  }, [code, lang]);

  const ext = filename.split(".").pop()?.toUpperCase() ?? "TXT";

  function copy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function download() {
    const url = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {/* Header: file badge + name on the left, actions on the right */}
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? (
            <span className="grid size-5 shrink-0 place-items-center">{icon}</span>
          ) : (
            <span className="grid size-5 shrink-0 place-items-center rounded bg-foreground/85 font-mono text-[9px] font-bold text-background">
              {ext}
            </span>
          )}
          <span className="truncate font-mono text-xs text-muted-foreground">{filename}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <CodeAction onClick={download} icon={FileDownloadIcon} label="Download" />
          <CodeAction
            onClick={copy}
            icon={copied ? Tick02Icon : Copy01Icon}
            label={copied ? "Copied" : "Copy"}
          />
        </div>
      </div>
      {/* Body */}
      <div className="shiki-block max-h-[460px] overflow-auto">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="m-0 p-4 font-mono text-xs leading-relaxed text-foreground">{code}</pre>
        )}
      </div>
    </div>
  );
}

function CodeAction({
  onClick,
  icon,
  label,
}: {
  onClick: () => void;
  icon: typeof Copy01Icon;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <HugeiconsIcon icon={icon} className="size-4" />
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
