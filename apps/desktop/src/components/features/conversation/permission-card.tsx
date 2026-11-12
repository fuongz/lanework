import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  SquareUnlock02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import {
  ANSWER_MAX,
  type AskQuestion,
  PERMISSION_COPY,
  type PermissionAnswer,
  type PermissionRequest,
} from "#/../shared/conversation";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

/** Both cards' shell: a white card lifted by a soft, wide shadow. */
const CARD =
  "bg-card border-border/70 flex flex-col gap-3 rounded-2xl border px-4 pt-3.5 pb-3 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-6px_rgb(0_0_0/0.10)]";

/** Both cards' answers: round pills. */
const PILL = "h-8 min-w-20 rounded-full px-5 text-[13px]";

/**
 * What the stack says beside the title (its first line): how many wait, and
 * its Show all. Nothing for a lone request.
 */
function Pending({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs leading-[19.25px] font-normal whitespace-nowrap tabular-nums">
      {children}
    </span>
  );
}

/**
 * The CLI asked to use a tool and is waiting for an answer.
 *
 * Shows what it would do, its input on demand, and the answers: Allow, Allow
 * and switch the session's mode when the CLI offers it, or Deny.
 */
export function PermissionCard({
  request,
  agent = "Claude",
  onAnswer,
  inputOpen = true,
  pending,
}: {
  request: PermissionRequest;
  /** Who asks, by name: Claude, Codex or OpenCode. */
  agent?: string;
  onAnswer: (id: string, answer: PermissionAnswer) => Promise<void>;
  /** Whether a tool's Input shows until the user opens or closes it. */
  inputOpen?: boolean;
  /** The stack's count and Show all, by the title; none for one request. */
  pending?: ReactNode;
}) {
  if (request.questions)
    return (
      <QuestionCard
        id={request.id}
        agent={agent}
        questions={request.questions}
        onAnswer={onAnswer}
        pending={pending}
      />
    );
  return (
    <ToolPermissionCard
      request={request}
      agent={agent}
      onAnswer={onAnswer}
      inputOpen={inputOpen}
      pending={pending}
    />
  );
}

function ToolPermissionCard({
  request,
  agent,
  onAnswer,
  inputOpen,
  pending,
}: {
  request: PermissionRequest;
  agent: string;
  onAnswer: (id: string, answer: PermissionAnswer) => Promise<void>;
  inputOpen: boolean;
  pending: ReactNode;
}) {
  // The Input follows `inputOpen` (open alone, closed in a stack) until the
  // user opens or closes it; then it stays as they left it.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? inputOpen;
  const [busy, setBusy] = useState(false);
  const answer = (value: PermissionAnswer) => {
    setBusy(true);
    void onAnswer(request.id, value).finally(() => setBusy(false));
  };
  return (
    <section aria-label={`Permission for ${request.tool}`} className={CARD}>
      {/* The question card's shell (AskUserQuestion): a title, its detail,
          then the answers at the bottom right. */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="flex min-w-0 items-start gap-2 text-[14px] leading-snug font-medium text-pretty">
          <HugeiconsIcon
            icon={SquareUnlock02Icon}
            className="text-tone-amber mt-[0.2em] size-4 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            {agent} wants to use {request.tool}
          </span>
          <Pending>{pending}</Pending>
        </h3>
        {request.summary && (
          <p className="text-muted-foreground ps-6 text-[13px] [overflow-wrap:anywhere]">
            {request.summary}
          </p>
        )}
      </div>
      {open && (
        <pre className="bg-foreground/[0.04] max-h-64 overflow-auto rounded-lg p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
          <code>{request.input || "{}"}</code>
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setChosen(!open)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            className={cn(
              "size-3 transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
            strokeWidth={2}
            aria-hidden="true"
          />
          Input
        </button>
        <span className="ml-auto" />
        <Button
          size="sm"
          // Muted: the quiet answer beside Allow.
          variant="secondary"
          className={PILL}
          disabled={busy}
          onClick={() => answer({ behavior: "deny" })}
        >
          Deny
        </Button>
        {request.suggestMode && (
          <Button
            size="sm"
            variant="outline"
            className={PILL}
            disabled={busy}
            onClick={() =>
              answer({
                behavior: "allow",
                mode: request.suggestMode ?? undefined,
              })
            }
          >
            Allow and switch to {PERMISSION_COPY[request.suggestMode].label}
          </Button>
        )}
        <Button
          size="sm"
          className={PILL}
          disabled={busy}
          onClick={() => answer({ behavior: "allow" })}
        >
          Allow
        </Button>
      </div>
    </section>
  );
}

interface Picked {
  options: string[];
  other: string;
}

const NOTHING: Picked = { options: [], other: "" };

/** What a question's pick says back to Claude, or "" for none. */
function said(picked: Picked): string {
  const other = picked.other.trim();
  return [...picked.options, ...(other ? [other] : [])].join(", ");
}

/**
 * `AskUserQuestion`: Claude asks before acting.
 *
 * One question at a time: its options, "Something else…", and Skip or
 * Continue. The last Continue sends every answer at once; × (or skipping them
 * all) says no.
 */
function QuestionCard({
  id,
  agent,
  questions,
  onAnswer,
  pending,
}: {
  id: string;
  agent: string;
  questions: AskQuestion[];
  onAnswer: (id: string, answer: PermissionAnswer) => Promise<void>;
  pending: ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<Picked[]>(() =>
    questions.map(() => NOTHING),
  );
  const [busy, setBusy] = useState(false);
  const question = questions[index] ?? questions[0];
  const picked = picks[index] ?? NOTHING;
  const last = index === questions.length - 1;

  const set = (next: Picked) =>
    setPicks((previous) =>
      previous.map((entry, at) => (at === index ? next : entry)),
    );
  const toggle = (label: string) => {
    if (!question.multiSelect) {
      set({ options: [label], other: "" });
      return;
    }
    set({
      ...picked,
      options: picked.options.includes(label)
        ? picked.options.filter((entry) => entry !== label)
        : [...picked.options, label],
    });
  };

  const submit = (final: Picked[]) => {
    const answers: Record<string, string> = {};
    questions.forEach((entry, at) => {
      const text = said(final[at] ?? NOTHING);
      if (text) answers[entry.question] = text;
    });
    setBusy(true);
    void onAnswer(
      id,
      Object.keys(answers).length
        ? { behavior: "allow", answers }
        : { behavior: "deny", message: "The user skipped the questions." },
    ).finally(() => setBusy(false));
  };
  const next = (final: Picked[]) => {
    if (last) submit(final);
    else setIndex(index + 1);
  };

  return (
    <section
      aria-label={`${agent} asks: ${question.question}`}
      className={CARD}
    >
      <div className="flex min-w-0 items-start gap-3">
        <h3 className="min-w-0 flex-1 text-[14px] leading-snug font-medium text-pretty">
          {question.question}
        </h3>
        <Pending>{pending}</Pending>
        <button
          type="button"
          aria-label="Dismiss the questions"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onAnswer(id, {
              behavior: "deny",
              message: "The user dismissed the questions.",
            }).finally(() => setBusy(false));
          }}
          className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] -mt-0.5 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
        >
          <HugeiconsIcon
            icon={Cancel01Icon}
            className="size-3.5"
            strokeWidth={2}
          />
        </button>
      </div>

      {/* Toggle buttons in a fieldset: a pick is one press, and a question
          that takes several takes several presses. */}
      <fieldset
        aria-label={question.header || question.question}
        className="-mx-1.5 flex min-w-0 flex-col gap-0.5"
      >
        {question.options.map((option) => {
          const on = picked.options.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              aria-pressed={on}
              disabled={busy}
              onClick={() => toggle(option.label)}
              className="hover:bg-foreground/[0.05] flex min-w-0 items-start gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors",
                  question.multiSelect ? "rounded-[5px]" : "rounded-full",
                  // `primary`, like the app's own radio and checkbox fill
                  // (components/ui): a board tone reads as a second accent
                  // beside the neutral Continue.
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-foreground/25",
                )}
              >
                {on &&
                  (question.multiSelect ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      className="size-3"
                      strokeWidth={2.5}
                    />
                  ) : (
                    <span className="bg-primary-foreground size-1.5 rounded-full" />
                  ))}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px]">{option.label}</span>
                {option.description && (
                  <span className="text-muted-foreground text-xs leading-snug">
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </fieldset>

      <input
        value={picked.other}
        disabled={busy}
        onChange={(event) =>
          set({
            options: question.multiSelect ? picked.options : [],
            other: event.target.value,
          })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (said(picked)) next(picks);
          }
        }}
        maxLength={ANSWER_MAX}
        placeholder="Something else…"
        aria-label="Something else"
        className="placeholder:text-muted-foreground bg-transparent px-0 text-[13px] outline-none"
      />

      <div className="flex items-center gap-1.5">
        {questions.length > 1 && (
          <div className="text-muted-foreground flex items-center gap-0.5 text-xs tabular-nums">
            <button
              type="button"
              aria-label="Previous question"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
              className="hover:text-foreground flex size-5 items-center justify-center rounded transition-colors disabled:opacity-40"
            >
              <HugeiconsIcon
                icon={ArrowUp01Icon}
                className="size-3.5"
                strokeWidth={2}
              />
            </button>
            <span>
              {index + 1}/{questions.length}
            </span>
            <button
              type="button"
              aria-label="Next question"
              disabled={last}
              onClick={() => setIndex(index + 1)}
              className="hover:text-foreground flex size-5 items-center justify-center rounded transition-colors disabled:opacity-40"
            >
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                className="size-3.5"
                strokeWidth={2}
              />
            </button>
          </div>
        )}
        <span className="ml-auto" />
        <Button
          size="sm"
          variant="secondary"
          className={PILL}
          disabled={busy}
          onClick={() => {
            const final = picks.map((entry, at) =>
              at === index ? NOTHING : entry,
            );
            setPicks(final);
            next(final);
          }}
        >
          Skip
        </Button>
        <Button
          size="sm"
          className={PILL}
          disabled={busy || !said(picked)}
          onClick={() => next(picks)}
        >
          Continue
        </Button>
      </div>
    </section>
  );
}
