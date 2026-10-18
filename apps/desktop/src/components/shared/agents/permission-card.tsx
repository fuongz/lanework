import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Shield01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
  ANSWER_MAX,
  type AskQuestion,
  PERMISSION_COPY,
  type PermissionAnswer,
  type PermissionRequest,
} from "#/../shared/conversation";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

/**
 * The CLI asked to use a tool and is waiting (D1): what it would do, its
 * input on demand, and the answer — Allow, Allow and switch the session's
 * mode when the CLI offers it, or Deny.
 */
export function PermissionCard({
  request,
  onAnswer,
}: {
  request: PermissionRequest;
  onAnswer: (id: string, answer: PermissionAnswer) => Promise<void>;
}) {
  if (request.questions)
    return (
      <QuestionCard
        id={request.id}
        questions={request.questions}
        onAnswer={onAnswer}
      />
    );
  return <ToolPermissionCard request={request} onAnswer={onAnswer} />;
}

function ToolPermissionCard({
  request,
  onAnswer,
}: {
  request: PermissionRequest;
  onAnswer: (id: string, answer: PermissionAnswer) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const answer = (value: PermissionAnswer) => {
    setBusy(true);
    void onAnswer(request.id, value).finally(() => setBusy(false));
  };
  return (
    <section
      aria-label={`Permission for ${request.tool}`}
      className="border-tone-amber/40 bg-tone-amber/[0.06] flex flex-col gap-2.5 rounded-xl border p-3"
    >
      <div className="flex min-w-0 items-start gap-2">
        <HugeiconsIcon
          icon={Shield01Icon}
          className="text-tone-amber mt-0.5 size-4 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium">
            Claude wants to use {request.tool}
          </span>
          <span className="text-muted-foreground text-[13px] [overflow-wrap:anywhere]">
            {request.summary}
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 self-start text-xs transition-colors"
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
      {open && (
        <pre className="bg-foreground/[0.04] max-h-64 overflow-auto rounded-lg p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
          <code>{request.input || "{}"}</code>
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => answer({ behavior: "allow" })}
        >
          Allow
        </Button>
        {request.suggestMode && (
          <Button
            size="sm"
            variant="outline"
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
          variant="ghost"
          disabled={busy}
          onClick={() => answer({ behavior: "deny" })}
        >
          Deny
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
 * `AskUserQuestion` (ảnh 8): Claude asks before acting. One question at a
 * time — its options, "Something else…", and Skip or Continue; the last
 * Continue sends every answer at once. × (or skipping them all) says no.
 */
function QuestionCard({
  id,
  questions,
  onAnswer,
}: {
  id: string;
  questions: AskQuestion[];
  onAnswer: (id: string, answer: PermissionAnswer) => Promise<void>;
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
      aria-label={`Claude asks: ${question.question}`}
      className="bg-card border-border flex flex-col gap-3 rounded-xl border px-3.5 pt-3 pb-2.5 shadow-xs"
    >
      <div className="flex min-w-0 items-start gap-3">
        <h3 className="min-w-0 flex-1 text-[14px] leading-snug font-medium text-pretty">
          {question.question}
        </h3>
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

      {/* Toggle buttons in a fieldset: a pick is one press, and several are
          when the question takes more than one. */}
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
                  on
                    ? "border-tone-sky bg-tone-sky text-background"
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
                    <span className="bg-background size-1.5 rounded-full" />
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
          disabled={busy || !said(picked)}
          onClick={() => next(picks)}
        >
          Continue
        </Button>
      </div>
    </section>
  );
}
