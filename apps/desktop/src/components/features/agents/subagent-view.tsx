import {
  AiChipIcon,
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  GitForkIcon,
  Robot02Icon,
  StopCircleIcon,
  Timer02Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type {
  SubagentStep,
  SubagentTranscript,
  TerminalAgent,
} from "#/../shared/terminal";
import {
  durationText,
  type Fact,
  Facts,
  modelLabel,
} from "#/components/shared/agents/facts";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import { WorkingMark } from "#/components/shared/terminal/working-mark";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useSubagentTranscript } from "./use-subagent-transcript";

const ROUTE = "/_app/w/$slug/agents/sub/$conversation/$sub" as const;
/** Tool calls before "Show more", as the rail folds its rows. */
const STEPS_FOLDED = 5;

/** How long it ran, as a person reads it: `68s`, `4m 12s`, `1h 3m`. */
function elapsed(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  return durationText(Date.parse(to) - Date.parse(from));
}

/** A section that folds behind its label: the prompt, the report. */
function Fold({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="text-foreground flex items-center gap-1.5 self-start text-[13px] font-medium"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className={cn(
            "text-muted-foreground size-3.5 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
          strokeWidth={2}
          aria-hidden="true"
        />
        {label}
      </button>
      {open && <div className="ps-5">{children}</div>}
    </section>
  );
}

/**
 * One tool call: its name and what it was called on, and its input JSON once
 * opened.
 *
 * Its result is never shown, only that it failed (FE-35/D3).
 */
function Step({ step }: { step: SubagentStep }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={step.summary || step.tool}
        className="hover:bg-foreground/[0.04] flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs transition-colors"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className={cn(
            "text-muted-foreground size-3 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium">{step.tool}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]">
          {step.summary}
        </span>
        {step.error && (
          <Badge variant="destructive" className="shrink-0">
            error
          </Badge>
        )}
      </button>
      {open && (
        // Wide input scrolls inside its own box; the page never scrolls
        // sideways.
        <pre className="bg-foreground/[0.04] my-1 ms-6 max-h-80 overflow-auto rounded-lg p-3 font-mono text-[11px] leading-relaxed">
          <code>{step.input || "{}"}</code>
        </pre>
      )}
    </li>
  );
}

function Steps({ transcript }: { transcript: SubagentTranscript }) {
  const [all, setAll] = useState(false);
  const { steps } = transcript;
  const shown = all ? steps : steps.slice(0, STEPS_FOLDED);
  return (
    <section aria-label="Tool calls" className="flex flex-col gap-1">
      <h2 className="text-foreground flex items-center gap-2 text-[13px] font-medium">
        Tool calls
        <span className="text-muted-foreground text-xs font-normal tabular-nums">
          {steps.length}
        </span>
      </h2>
      {steps.length === 0 ? (
        <Empty className="items-start p-0 py-2 text-left">
          <EmptyHeader className="items-start">
            <EmptyDescription className="text-xs">
              {transcript.working
                ? "No tool calls yet."
                : "It called no tools."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol className="-mx-1.5 flex flex-col">
          {shown.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a transcript's steps only ever grow at the end — the index is the step's identity.
            <Step key={index} step={step} />
          ))}
        </ol>
      )}
      {steps.length > STEPS_FOLDED && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((value) => !value)}
          className="text-muted-foreground hover:text-foreground self-start ps-5 text-xs transition-colors"
        >
          {all ? "Show less" : `Show ${steps.length - STEPS_FOLDED} more`}
        </button>
      )}
    </section>
  );
}

/**
 * A sub-agent's transcript, read-only, full size in the main view (FE-35/D1):
 * what it was asked, the tools it called, and what it reported back.
 *
 * Nothing here resumes or stops it: a sub-agent has nothing of its own to
 * resume. The way back to the agent is its conversation, which the header's
 * link opens as the rail's row does (FE-35/D9): the tab running it, or else
 * its chat.
 */
export function SubagentView() {
  const { slug, conversation, sub } = useParams({ from: ROUTE });
  const { agent } = useSearch({ from: ROUTE });
  // NOTE: Keyed by which sub-agent: the route stays mounted from one to the
  // next, and the last one's folds (its prompt opened, its calls shown) are
  // not this one's.
  return (
    <SubagentPage
      key={`${agent}:${conversation}/${sub}`}
      slug={slug}
      agent={agent}
      conversation={conversation}
      sub={sub}
    />
  );
}

function SubagentPage({
  slug,
  agent,
  conversation,
  sub,
}: {
  slug: string;
  agent: TerminalAgent;
  conversation: string;
  sub: string;
}) {
  const workspace = useWorkspaceKey(slug);
  const navigate = useNavigate();
  const { transcript, error } = useSubagentTranscript(
    workspace,
    agent,
    conversation,
    sub,
  );
  const parent = useAgentSessions((state) =>
    workspace
      ? state.byWorkspace[workspace]?.find(
          (entry) => entry.agent === agent && entry.id === conversation,
        )
      : undefined,
  );
  const liveTab = useAgentTerminals((state) => state.liveTab);
  const [promptOpen, setPromptOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(true);

  const listed = parent?.subagents.find((entry) => entry.id === sub);
  const title = transcript?.title ?? listed?.title ?? "Sub-agent";
  const working = transcript?.working ?? false;
  const label = TERMINAL_KIND_LABELS[agent];

  const openParent = () => {
    if (!workspace || !parent) return;
    void liveTab(workspace, parent).then((tab) => {
      if (tab)
        void navigate({
          to: "/w/$slug/agents/$terminalId",
          params: { slug, terminalId: tab.id },
        });
      else
        void navigate({
          to: "/w/$slug/agents/chat/$conversation",
          params: { slug, conversation: parent.id },
        });
    });
  };

  // Its kind, model, time, tools and state, as far as they are known.
  const facts: Fact[] = [];
  if (transcript) {
    const { type, model, startedAt, endedAt, steps, truncated, report } =
      transcript;
    if (type)
      facts.push({
        key: "type",
        label: "Agent type",
        icon: type === "fork" ? GitForkIcon : Robot02Icon,
        text: type,
      });
    if (model)
      facts.push({
        key: "model",
        label: "Model",
        icon: AiChipIcon,
        text: modelLabel(model),
        title: `Model: ${model}`,
      });
    const took = elapsed(startedAt, endedAt);
    if (took)
      facts.push({
        key: "took",
        label: working ? "Running for" : "Ran for",
        icon: Timer02Icon,
        text: took,
      });
    facts.push({
      key: "tools",
      label: "Tool calls",
      icon: Wrench01Icon,
      text: `${steps.length}${truncated ? "+" : ""} tool${steps.length === 1 ? "" : "s"}`,
    });
    facts.push(
      working
        ? {
            key: "status",
            label: "Status",
            // The rail's dot for one still going: the spinner is the header's.
            mark: (
              <span
                aria-hidden="true"
                className="bg-tone-emerald mx-1 size-1.5 shrink-0 rounded-full"
              />
            ),
            text: "working",
            className: "text-foreground",
          }
        : report
          ? {
              key: "status",
              label: "Status",
              icon: CheckmarkCircle02Icon,
              text: "done",
              className: "text-tone-emerald",
            }
          : {
              key: "status",
              label: "Status",
              icon: StopCircleIcon,
              text: "ended",
            },
    );
  }

  return (
    <section
      aria-label={`Sub-agent — ${title}`}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    >
      {/* In the window's title bar, as the agent's own view is: the bar
          drags the window and clears its controls. */}
      <WindowTitlebar>
        {working ? (
          <span role="img" aria-label="Working" className="flex shrink-0">
            <WorkingMark />
          </span>
        ) : (
          <TerminalKindIcon kind={agent} className="size-[13px] shrink-0" />
        )}
        {parent && (
          <>
            <button
              type="button"
              onClick={openParent}
              aria-label={`Open its conversation, “${parent.title}”, in ${label}`}
              title={parent.title}
              className="text-muted-foreground hover:text-foreground flex min-w-0 max-w-[40%] shrink items-center gap-1 text-[13px] transition-colors"
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                className="size-3.5 shrink-0"
                strokeWidth={2}
                aria-hidden="true"
              />
              <span className="truncate">{parent.title}</span>
            </button>
            <span aria-hidden="true" className="text-muted-foreground/60">
              /
            </span>
          </>
        )}
        <h1
          className={`${WINDOW_TITLE} ${working ? "text-shimmer" : ""}`}
          title={title}
        >
          {title}
        </h1>
      </WindowTitlebar>
      {transcript && <Facts facts={facts} data-testid="subagent-meta" />}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!transcript ? (
          error && (
            <Empty className="py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
                </EmptyMedia>
                <EmptyTitle>Could not open this sub-agent</EmptyTitle>
                <EmptyDescription>{error}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )
        ) : (
          // Full width, as the issue page's body is.
          <div className="flex w-full min-w-0 flex-col gap-6 px-6 py-5">
            {transcript.truncated && (
              <Alert>
                <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
                <AlertDescription>
                  Transcript cut: it is longer than one read takes, so the tool
                  calls in the middle of it are missing.
                </AlertDescription>
              </Alert>
            )}

            <Fold
              label="Prompt"
              open={promptOpen}
              onToggle={() => setPromptOpen((value) => !value)}
            >
              {transcript.prompt ? (
                <MarkdownBody source={transcript.prompt} />
              ) : (
                <Empty className="items-start p-0 text-left">
                  <EmptyHeader className="items-start">
                    <EmptyDescription className="text-xs">
                      {agent === "codex"
                        ? "Codex keeps the task it gave this thread encrypted."
                        : "Its prompt is not in its transcript."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </Fold>

            <Steps transcript={transcript} />

            <Fold
              label="Report"
              open={reportOpen}
              onToggle={() => setReportOpen((value) => !value)}
            >
              {transcript.report ? (
                <MarkdownBody source={transcript.report} />
              ) : (
                <Empty className="items-start p-0 text-left">
                  <EmptyHeader className="items-start">
                    <EmptyDescription className="text-xs">
                      {working
                        ? "Still working. Its report shows here once it hands it back."
                        : "It ended without a report."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </Fold>
          </div>
        )}
      </div>
    </section>
  );
}
