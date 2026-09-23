import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  CircleIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CheckState, PullChecks } from "../../../../shared/git";

/**
 * CI on a pull request's head commit.
 *
 * ⚠️ "No CI checks" is a real answer and is drawn as one. A repository without
 * CI is an ordinary repository; showing it a spinner, an error or an empty box
 * would each say something untrue about it. The caller is what reports a read
 * that actually failed — see `PullSummary`.
 */

const TONE: Record<CheckState, { icon: typeof CircleIcon; className: string }> =
  {
    success: {
      icon: CheckmarkCircle02Icon,
      className: "text-emerald-600 dark:text-emerald-400",
    },
    failure: {
      icon: Alert02Icon,
      className: "text-rose-600 dark:text-rose-400",
    },
    pending: {
      icon: Loading03Icon,
      className: "text-amber-600 dark:text-amber-400",
    },
    neutral: { icon: CircleIcon, className: "text-muted-foreground" },
  };

function summarise(checks: PullChecks): string {
  const failed = checks.checks.filter(
    (check) => check.state === "failure",
  ).length;
  const running = checks.checks.filter(
    (check) => check.state === "pending",
  ).length;
  const passed = checks.checks.filter(
    (check) => check.state === "success",
  ).length;
  const parts: string[] = [];
  if (failed) parts.push(`${failed} failing`);
  if (running) parts.push(`${running} running`);
  if (passed) parts.push(`${passed} passing`);
  // ⚠️ Counts, not "All checks passed". A rollup can be `SUCCESS` while several
  // checks were skipped, and a sentence claiming they all passed would be the
  // one thing somebody reads before approving.
  return parts.length ? parts.join(" · ") : `${checks.checks.length} checks`;
}

export function PullChecksSection({ checks }: { checks: PullChecks }) {
  if (checks.state === null)
    return <p className="text-muted-foreground text-xs">No CI checks</p>;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{summarise(checks)}</p>
      <ul className="border-sidebar-border divide-sidebar-border divide-y rounded-lg border">
        {checks.checks.map((check) => {
          const tone = TONE[check.state];
          return (
            <li
              key={check.id}
              className="flex items-center gap-2.5 px-3 py-2 text-xs"
            >
              <HugeiconsIcon
                icon={tone.icon}
                className={`size-3.5 shrink-0 ${tone.className}`}
                strokeWidth={1.8}
                aria-label={check.state}
              />
              <span className="min-w-0 flex-1 truncate">{check.name}</span>
              {/* ⚠️ Opens the OS browser, like every other GitHub link here. A
                  CI log inside an Electron window would be this app holding a
                  session on somebody's behalf. */}
              {check.url && (
                <a
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground shrink-0 underline-offset-2 hover:underline"
                >
                  Details
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {checks.truncated && (
        <p className="text-muted-foreground text-xs">
          More checks ran than this view lists. Open the pull request on GitHub
          to see the rest.
        </p>
      )}
    </div>
  );
}
