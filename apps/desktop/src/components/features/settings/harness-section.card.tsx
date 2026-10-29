import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { HarnessAccountRow } from "#/components/shared/agents/harness-account";
import { HARNESS_NAMES } from "#/components/shared/agents/harness-island";
import { TextSkeleton } from "#/components/shared/loading/skeletons";
import {
  SettingsCard,
  type SettingsRowSpec,
} from "#/components/shared/settings/settings-page";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { UsageBar } from "#/components/shared/terminal/usage-bar";
import { type UsageView, updatedText } from "#/lib/agent-usage";
import { cn } from "#/lib/utils";
import {
  compareVersions,
  type HarnessAccount,
  type HarnessAgent,
  type HarnessInfo,
  type InstallMethod,
} from "../../../../shared/harness";

/** How the CLI was installed, shown after the version: "via Homebrew". */
const INSTALLED_WITH: Record<InstallMethod, string> = {
  native: "via the native installer",
  "brew-cask": "via a Homebrew cask",
  "brew-formula": "via Homebrew",
  npm: "via npm",
  unknown: "Install method unknown",
};

/**
 * One CLI's card, drawn as a provider list draws one.
 *
 * - Its mark, its name and how many accounts it has; its version on the
 *   right.
 * - The account: its organization, whether it is ready, the plan, and the
 *   email, blurred.
 * - Its usage limits.
 * - Its rows, drawn as {@link SettingsPage} draws a section's, folded under
 *   the usage by default: the version and the limits are what a glance is
 *   for, and the switches are set once.
 */
export function HarnessCard({
  kind,
  info,
  usage,
  account,
  now,
  rows,
}: {
  kind: HarnessAgent;
  /** `undefined` while the first check runs; null when it said nothing. */
  info: HarnessInfo | null | undefined;
  usage: UsageView | null;
  /** `undefined` until read. */
  account: HarnessAccount | undefined;
  now: number;
  rows: SettingsRowSpec[];
}) {
  const name = HARNESS_NAMES[kind];
  const installed = !!info && (info.version !== null || info.path !== null);
  const newer =
    !!info?.version &&
    info.latest !== null &&
    compareVersions(info.latest, info.version) > 0;
  const signedIn = !!account?.signedIn;
  const [open, setOpen] = useState(false);

  return (
    <SettingsCard>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-lg">
          <TerminalKindIcon kind={kind} className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="text-sm font-medium">{name}</h3>
          <span className="text-muted-foreground text-[13px]">
            {info === undefined ? (
              <TextSkeleton label="Checking" />
            ) : !installed ? (
              "Not installed"
            ) : account === undefined ? (
              <TextSkeleton label="Reading the account" />
            ) : signedIn ? (
              "1 account"
            ) : (
              "Not signed in"
            )}
          </span>
        </div>
        {info && installed && (
          <div
            className="text-muted-foreground flex shrink-0 items-center gap-2 text-[13px]"
            title={INSTALLED_WITH[info.installMethod]}
          >
            {info.version && info.latest && !newer && (
              <span className="flex items-center gap-1">
                <HugeiconsIcon
                  icon={Tick02Icon}
                  className="text-tone-emerald size-3.5"
                  strokeWidth={2}
                  aria-hidden="true"
                />
                Up to date
              </span>
            )}
            <span
              data-testid={`harness-version-${kind}`}
              className="bg-foreground/[0.05] text-foreground/80 rounded-md px-1.5 font-mono text-[12px] tabular-nums"
            >
              {!info.version ? (
                "Version unknown"
              ) : newer ? (
                <>
                  {info.version} →{" "}
                  <span className="text-foreground">{info.latest}</span>
                </>
              ) : (
                info.version
              )}
            </span>
          </div>
        )}
      </div>
      {info && !installed && (
        <p className="text-muted-foreground px-4 py-3 text-[13px] leading-relaxed">
          {name} is not installed, or its version could not be read.
        </p>
      )}
      {newer && !info?.updateCommand && (
        <p className="text-muted-foreground px-4 py-3 text-[13px] leading-relaxed">
          Update it the way you installed it.
        </p>
      )}
      {installed && signedIn && account && (
        // One row, aligned with the card's other rows: the account and its
        // organization on the left, its state on the right.
        <HarnessAccountRow
          kind={kind}
          account={account}
          className="px-4 py-3.5"
        />
      )}
      {usage && <UsageRow view={usage} now={now} />}
      {rows.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium transition-colors"
        >
          {/* The app's one disclosure arrow (issue detail's sub-issues). */}
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            className="size-3.5"
            strokeWidth={2}
            aria-hidden="true"
          />
          Settings
        </button>
      )}
      {open &&
        rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-8 px-4 py-3.5"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium">{row.label}</span>
              {row.description ? (
                <span className="text-muted-foreground text-[13px] leading-relaxed">
                  {row.description}
                </span>
              ) : null}
            </div>
            {row.control ? (
              <div className="flex shrink-0 items-center">{row.control}</div>
            ) : null}
          </div>
        ))}
    </SettingsCard>
  );
}

/** What each limit's bar is called to a screen reader. */
const REGION = {
  "5h": "5-hour limit",
  Weekly: "Weekly limit",
  Monthly: "Monthly limit",
} as const;

/**
 * The 5-hour and weekly limits side by side, as the terminal bar's popover
 * has them; OpenCode Go's monthly one too (FE-104/D10).
 *
 * Draws nothing when there are no numbers and no error: a row of dashes would
 * read as "0% used" to anyone skimming.
 */
function UsageRow({ view, now }: { view: UsageView; now: number }) {
  const windows = (
    [
      ["5h", view.fiveHour],
      ["Weekly", view.weekly],
      ["Monthly", view.monthly],
    ] as const
  ).flatMap(([label, window]) => (window ? [{ label, window }] : []));
  if (windows.length === 0 && !view.error) return null;
  return (
    <div
      className="flex flex-col gap-2.5 px-4 py-3.5"
      data-testid={`harness-usage-${view.agent}`}
    >
      {windows.length > 0 && (
        <div
          className={cn(
            "grid gap-6",
            windows.length > 2 ? "grid-cols-3" : "grid-cols-2",
          )}
        >
          {windows.map(({ label, window }) => (
            <UsageBar
              key={label}
              name={view.name}
              label={label}
              region={REGION[label]}
              window={window}
              now={now}
            />
          ))}
        </div>
      )}
      <p className="text-muted-foreground text-[11px] leading-4">
        {view.error ? (
          <span role="alert" className="text-tone-amber">
            {view.error}
            {windows.length ? " Showing the last known usage." : ""}
          </span>
        ) : (
          `${updatedText(view.at, now)}${view.stale ? " (last known)" : ""}`
        )}
      </p>
    </div>
  );
}
