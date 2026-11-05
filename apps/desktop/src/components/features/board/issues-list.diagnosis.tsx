import { Alert02Icon, ViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { BoardCard } from "#/../shared/projects";
import { Button } from "#/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import {
  type AttentionFilter,
  DIAGNOSIS_KINDS,
  DIAGNOSIS_LABEL,
  type Diagnosis,
  type DiagnosisKind,
} from "./issues-list.diagnostics";

/**
 * A card row's warning: an amber mark whose tooltip says what is wrong and
 * what could be done about it (FE-116/D1).
 *
 * NOTE: Not a control, like the agents mark beside it. It sits inside the
 * card's link, and a button there would be two targets in one place. Its
 * words are in sr-only text for anybody who cannot hover.
 */
export function DiagnosisMark({
  diagnoses,
}: {
  diagnoses: readonly Diagnosis[];
}) {
  if (!diagnoses.length) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className="inline-grid shrink-0 place-items-center"
        data-diagnosis={diagnoses.map((entry) => entry.kind).join(" ")}
      >
        <HugeiconsIcon
          icon={Alert02Icon}
          className="text-tone-amber size-3.5"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="sr-only">
          {diagnoses
            .map((entry) => `${entry.reason} ${entry.action}`)
            .join(" ")}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 flex-col items-start gap-2">
        {diagnoses.map((entry) => (
          <span key={entry.kind} className="flex flex-col items-start gap-0.5">
            <span className="font-medium">{entry.reason}</span>
            <span className="opacity-70">{entry.action}</span>
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A card row's mark for a reviewer's send-back (BE-23): the Review lane's
 * teal eye, whose tooltip gives the reason. Nothing when there is none; the
 * service clears it once the card changes lane again.
 *
 * NOTE: Not a control, for the reason {@link DiagnosisMark} is not one. Its
 * words are in sr-only text for anybody who cannot hover.
 */
export function ChangesRequestedMark({
  request,
}: {
  request: BoardCard["changesRequested"];
}) {
  if (!request) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className="inline-grid shrink-0 place-items-center"
        data-changes-requested=""
      >
        <HugeiconsIcon
          icon={ViewIcon}
          className="text-tone-teal size-3.5"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="sr-only">Changes requested: {request.reason}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 flex-col items-start gap-0.5">
        <span className="font-medium">Changes requested</span>
        <span className="line-clamp-4 whitespace-pre-wrap opacity-70">
          {request.reason}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** "2 stale, 1 open parent": the kinds found, in words. */
function breakdown(counts: Record<DiagnosisKind, number>): string {
  return DIAGNOSIS_KINDS.filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} ${DIAGNOSIS_LABEL[kind].toLowerCase()}`)
    .join(", ");
}

/**
 * The line above the issue list that says how many cards need attention,
 * and narrows the list to them (FE-116/D1). Nothing when none do.
 *
 * Read-only (FE-116/D7): its one button is a filter, never a fix.
 */
export function DiagnosticsBanner({
  total,
  counts,
  filter,
  onFilter,
}: {
  /** Cards with at least one diagnosis. */
  total: number;
  counts: Record<DiagnosisKind, number>;
  filter: AttentionFilter | undefined;
  onFilter: (next: AttentionFilter | undefined) => void;
}) {
  if (total === 0) return null;
  return (
    // `status`, not the Alert's `alert`: it is drawn on every read of the
    // board, and an interruption each time would be noise.
    <div
      role="status"
      className="border-border bg-card mx-2 mb-1 flex items-start gap-2 rounded-lg border px-2 py-1.5 text-xs"
    >
      {/* Top-aligned with the text, and nudged onto its first line: a 14px
          icon on a 16px line sits a pixel low of its centre otherwise. */}
      <HugeiconsIcon
        icon={Alert02Icon}
        className="text-tone-amber mt-px size-3.5 shrink-0"
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">
          {total === 1
            ? "1 card needs attention"
            : `${total} cards need attention`}
        </span>
        <span className="text-muted-foreground truncate">
          {breakdown(counts)}
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 self-center px-2 text-xs"
        onClick={() => onFilter(filter ? undefined : "any")}
      >
        {filter ? "Show all" : "Show"}
      </Button>
    </div>
  );
}
