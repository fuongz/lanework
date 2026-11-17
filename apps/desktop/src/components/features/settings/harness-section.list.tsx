import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type { HarnessAgent, HarnessInfo } from "#/../shared/harness";
import { HARNESS_NAMES } from "#/components/shared/agents/harness-island";
import { SettingsCard } from "#/components/shared/settings/settings-page";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { Skeleton } from "#/components/ui/skeleton";

/**
 * Settings → Harness: a row per CLI (FE-146), its version and whether an
 * update waits, each opening the CLI's own page (card, handoff, models).
 */
export function HarnessList({
  rows,
}: {
  /** `info` undefined while the CLIs are read; null when one is missing. */
  rows: { kind: HarnessAgent; info: HarnessInfo | null | undefined }[];
}) {
  return (
    <SettingsCard className="divide-border divide-y overflow-hidden">
      {rows.map(({ kind, info }) => (
        <Link
          key={kind}
          to="/settings/harness/$cli"
          params={{ cli: kind }}
          className="hover:bg-foreground/[0.03] flex items-center gap-3 px-4 py-3 transition-colors"
        >
          <TerminalKindIcon kind={kind} className="size-5 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">
              {HARNESS_NAMES[kind]}
            </span>
            {info === undefined ? (
              <Skeleton className="h-3 w-24" />
            ) : (
              <span className="text-muted-foreground truncate text-[13px]">
                {info?.version
                  ? info.latest && info.latest !== info.version
                    ? `${info.version}, ${info.latest} available`
                    : info.version
                  : "Not installed"}
              </span>
            )}
          </span>
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            className="text-muted-foreground size-4 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </Link>
      ))}
    </SettingsCard>
  );
}
