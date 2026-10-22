import { useEffect, useState } from "react";
import { cn } from "#/lib/utils";
import type { HarnessAccount, HarnessAgent } from "../../../../shared/harness";

/**
 * Who each CLI is signed in as.
 *
 * Read on mount and again on coming back to the window, because signing in
 * happens in a terminal.
 */
export function useHarnessAccounts(): Partial<
  Record<HarnessAgent, HarnessAccount>
> {
  const [accounts, setAccounts] = useState<
    Partial<Record<HarnessAgent, HarnessAccount>>
  >({});
  useEffect(() => {
    const surface = window.desktop?.harness;
    if (!surface?.accounts) return;
    let live = true;
    const read = () =>
      void surface.accounts().then(
        (list) =>
          live &&
          setAccounts(
            Object.fromEntries(list.map((account) => [account.agent, account])),
          ),
        () => undefined,
      );
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, []);
  return accounts;
}

const titleCase = (word: string) =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/**
 * The signed-in account, as Settings › Agents draws it.
 *
 * "Default account", its organization as a badge, then its state
 * (`HarnessAccountState`). Wraps rather than truncates, so a long email never
 * pushes the name out.
 */
export function HarnessAccountRow({
  kind,
  account,
  className,
}: {
  kind: HarnessAgent;
  account: HarnessAccount;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-sm font-medium">Default account</span>
        <HarnessOrgBadge kind={kind} account={account} />
      </div>
      <HarnessAccountState
        kind={kind}
        account={account}
        className="gap-2.5 text-[13px]"
      />
    </div>
  );
}

/** The account's organization, as a small grey badge; nothing without one. */
function HarnessOrgBadge({
  kind,
  account,
}: {
  kind: HarnessAgent;
  account: HarnessAccount;
}) {
  if (!account.org) return null;
  return (
    <span
      data-testid={`harness-org-${kind}`}
      className="bg-muted text-muted-foreground truncate rounded-md px-1.5 py-0.5 text-[11px] leading-4"
    >
      {account.org}
    </span>
  );
}

/**
 * The account's state, plan and blurred email: "● Ready  Team  email".
 *
 * As Settings › Agents draws them.
 */
function HarnessAccountState({
  kind,
  account,
  className,
}: {
  kind: HarnessAgent;
  account: HarnessAccount;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex min-w-0 items-center",
        className,
      )}
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <span
          className="bg-tone-emerald size-1.5 rounded-full"
          aria-hidden="true"
        />
        Ready
      </span>
      {account.plan && (
        <span data-testid={`harness-plan-${kind}`} className="shrink-0">
          {titleCase(account.plan)}
        </span>
      )}
      {account.email && <BlurredEmail email={account.email} />}
    </div>
  );
}

/**
 * The usage popover's second line.
 *
 * A pinging dot for a signed-in account, its organization ("Personal",
 * "Acme") and its email, blurred. The plan is on the line above, beside the
 * name.
 */
export function HarnessAccountLine({
  kind,
  account,
}: {
  kind: HarnessAgent;
  account: HarnessAccount;
}) {
  return (
    <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-[11px] leading-4">
      <span
        role="img"
        aria-label="Signed in"
        title="Signed in"
        className="relative flex size-1.5 shrink-0"
      >
        <span className="bg-tone-emerald absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none" />
        <span className="bg-tone-emerald relative inline-flex size-1.5 rounded-full" />
      </span>
      {account.org && (
        <span data-testid={`${kind}-usage-org`} className="shrink-0">
          {account.org}
        </span>
      )}
      {account.email && <BlurredEmail email={account.email} />}
    </div>
  );
}

/**
 * An email drawn blurred, as a screenshot-safe settings page shows one.
 *
 * Hover or focus it to read it, click to keep it shown. The blur is for the
 * screen, not for safety: the text is in the DOM and a screen reader reads
 * it, which is fine for the user's own email.
 */
function BlurredEmail({ email }: { email: string }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={shown}
      title={shown ? "Hide email" : "Show email"}
      onClick={() => setShown((value) => !value)}
      className={cn(
        "min-w-0 truncate rounded-sm text-left transition-[filter] duration-150 outline-none select-none hover:blur-none focus-visible:blur-none",
        !shown && "blur-[5px]",
      )}
    >
      {email}
    </button>
  );
}
