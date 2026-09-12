import {
  CheckmarkCircle02Icon,
  Comment01Icon,
  ExternalLinkIcon,
  GitPullRequestIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import { usePulls } from "#/stores/pulls";
import type { ReviewVerdict } from "../../../../shared/git";
import { DiffView } from "./diff-view";

function Verdict({
  verdict,
  label,
  body,
  number,
  onDone,
}: {
  verdict: ReviewVerdict;
  label: string;
  body: string;
  number: number;
  onDone: (error: string | null) => void;
}) {
  const review = usePulls((state) => state.review);
  const busy = usePulls((state) => state.reviewBusy);
  return (
    <Button
      size="sm"
      variant={verdict === "APPROVE" ? "default" : "outline"}
      disabled={busy !== null}
      onClick={() => {
        void review(number, verdict, body).then((result) =>
          onDone(result.error ?? null),
        );
      }}
    >
      {busy === verdict ? "Submitting…" : label}
    </Button>
  );
}

/**
 * One pull request: what it is, and what changed in it.
 *
 * ⚠️ The review controls are PR-level — approve, request changes, comment — and
 * nothing here writes to the branch. Line comments need a position model this
 * app does not have yet, so the screen does not pretend to offer them.
 */
export function PullDetail() {
  const { slug, number } = useParams({ from: "/_app/w/$slug/pulls/$number" });
  const parsed = Number(number);
  const detail = usePulls((state) => state.detail);
  const loading = usePulls((state) => state.detailLoading);
  const error = usePulls((state) => state.detailError);
  const openPull = usePulls((state) => state.openPull);
  const [body, setBody] = useState("");
  const [composing, setComposing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    if (Number.isInteger(parsed) && parsed > 0) void openPull(parsed);
  }, [openPull, parsed]);

  if (loading && !detail)
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
        Loading pull request…
      </div>
    );

  if (error)
    return (
      <div className="flex flex-1 items-start justify-center p-8">
        <p className="text-destructive max-w-prose text-xs/relaxed">{error}</p>
      </div>
    );

  if (!detail) return null;

  const { pull } = detail;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="border-sidebar-border flex shrink-0 flex-col gap-2 border-b px-5 py-3">
        <div className="flex items-start gap-2">
          <HugeiconsIcon
            icon={GitPullRequestIcon}
            className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <h1 className="flex-1 text-[15px] leading-snug font-medium">
            {pull.title}
          </h1>
          <a
            href={pull.url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open on GitHub"
            title="Open on GitHub"
            className="hover:bg-foreground/[0.06] flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
          >
            <HugeiconsIcon
              icon={ExternalLinkIcon}
              className="text-muted-foreground size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </a>
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-[11px]">
          <span className="tabular-nums">#{pull.number}</span>
          {pull.author && <span>@{pull.author.login}</span>}
          <span className="font-mono">
            {pull.headRef} → {pull.baseRef}
          </span>
          <span className="tabular-nums">
            {pull.changedFiles} file{pull.changedFiles === 1 ? "" : "s"}
          </span>
          <span className="tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{pull.additions}
            </span>{" "}
            <span className="text-rose-600 dark:text-rose-400">
              −{pull.deletions}
            </span>
          </span>
          {pull.draft && <span>Draft</span>}
        </div>
      </header>

      {/* ⚠️ No `overflow-y-auto` here. The diff viewer virtualizes and owns its
          own scrolling; wrapping it in a second scroller leaves it no viewport
          to measure, and it renders every line of every file. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* ⚠️ Said out loud when the file list stopped at its cap, rather than
            ending quietly. A partial diff that looks complete is how somebody
            approves a change they never saw. */}
        {detail.truncated && (
          <p className="text-muted-foreground bg-foreground/[0.04] shrink-0 px-4 py-2 text-xs/relaxed">
            This pull request touches more files than this view loads. Open it
            on GitHub to see the rest.
          </p>
        )}
        <DiffView detail={detail} slug={slug} />
      </div>

      <footer className="border-sidebar-border shrink-0 border-t px-4 py-2.5">
        {composing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Leave a note for the author…"
              rows={3}
              aria-label="Review note"
            />
            <div className="flex items-center gap-2">
              <Verdict
                verdict="APPROVE"
                label="Approve"
                body={body}
                number={pull.number}
                onDone={(failure) => {
                  setReviewError(failure);
                  if (!failure) {
                    setBody("");
                    setComposing(false);
                  }
                }}
              />
              <Verdict
                verdict="REQUEST_CHANGES"
                label="Request changes"
                body={body}
                number={pull.number}
                onDone={(failure) => {
                  setReviewError(failure);
                  if (!failure) {
                    setBody("");
                    setComposing(false);
                  }
                }}
              />
              <Verdict
                verdict="COMMENT"
                label="Comment"
                body={body}
                number={pull.number}
                onDone={(failure) => {
                  setReviewError(failure);
                  if (!failure) {
                    setBody("");
                    setComposing(false);
                  }
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setComposing(false)}
              >
                Cancel
              </Button>
            </div>
            {reviewError && (
              <p className="text-destructive text-xs/relaxed">{reviewError}</p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setComposing(true)}
            >
              <HugeiconsIcon icon={Comment01Icon} aria-hidden="true" />
              Review
            </Button>
            {pull.reviewDecision === "APPROVED" && (
              <span className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                <HugeiconsIcon
                  icon={CheckmarkCircle02Icon}
                  className="size-3.5"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                Approved
              </span>
            )}
          </div>
        )}
      </footer>
    </div>
  );
}
