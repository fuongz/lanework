import {
  ArrowRight01Icon,
  GitPullRequestIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "#/lib/utils";
import { useProjectPull, usePullChecks } from "#/stores/project-pulls";
import { checksLabel, checksTone, stateIcon, stateLabel } from "./pull-state";

/** Opens pull request `number` in the app's Pull requests view. */
function useOpenPull(slug: string, number: number) {
  const navigate = useNavigate();
  return () =>
    void navigate({
      to: "/w/$slug/issues/pulls/$number",
      params: { slug, number: String(number) },
      search: { tab: "all", status: "all" },
    });
}

/**
 * One of the project's pull requests as a card (FE-174): its state, number,
 * title and checks. A click opens it in the Pull requests view.
 *
 * NOTE: Drawn from the number alone while the list is read, so the card is
 * there from the start and only fills in.
 */
export function PullCard({ slug, number }: { slug: string; number: number }) {
  const pull = useProjectPull(slug, number);
  const checks = usePullChecks(slug, number);
  const open = useOpenPull(slug, number);
  const mark = pull ? stateIcon(pull) : null;
  const status = pull ? stateLabel(pull) : null;
  const check = checksLabel(checks?.state ?? null);
  const title = pull?.title ?? `Pull request #${number}`;
  return (
    <button
      type="button"
      onClick={open}
      title={`Open #${number} in Pull requests`}
      aria-label={`Open pull request #${number}${pull ? `, ${pull.title}, ${status}` : ""}`}
      className="group/pull border-border hover:bg-foreground/[0.03] flex max-w-full min-w-0 items-start gap-2.5 self-start rounded-xl border px-3 py-2 text-left text-[13px] transition-colors"
    >
      <HugeiconsIcon
        icon={mark?.icon ?? GitPullRequestIcon}
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          mark?.tone ?? "text-muted-foreground",
        )}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-muted-foreground shrink-0 tabular-nums">
            #{number}
          </span>
          <span className="min-w-0 truncate font-medium">{title}</span>
        </span>
        {(status || check) && (
          <span className="flex items-center gap-3 text-xs">
            {status && <span className={mark?.tone}>{status}</span>}
            {check && (
              <span className={checksTone(checks?.state ?? null)}>{check}</span>
            )}
          </span>
        )}
      </span>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        className="text-muted-foreground group-hover/pull:text-foreground mt-0.5 size-3.5 shrink-0 self-center transition-colors"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </button>
  );
}

/**
 * One of the project's pull requests inside a line of text (FE-174): state
 * mark, number and title, a click away from the Pull requests view.
 */
export function PullChip({ slug, number }: { slug: string; number: number }) {
  const pull = useProjectPull(slug, number);
  const open = useOpenPull(slug, number);
  const mark = pull ? stateIcon(pull) : null;
  return (
    <button
      type="button"
      onClick={open}
      title={`Open #${number} in Pull requests`}
      className="bg-foreground/[0.04] hover:bg-foreground/[0.08] inline-flex max-w-[22rem] items-center gap-1 rounded-md px-1.5 align-baseline text-[0.92em] transition-colors"
    >
      <HugeiconsIcon
        icon={mark?.icon ?? GitPullRequestIcon}
        className={cn(
          "size-3 shrink-0 self-center",
          mark?.tone ?? "text-muted-foreground",
        )}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="text-muted-foreground shrink-0 tabular-nums">
        #{number}
      </span>
      {pull && <span className="min-w-0 truncate">{pull.title}</span>}
    </button>
  );
}
