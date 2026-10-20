import {
  Copy01Icon,
  GithubIcon,
  Unlink02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  SETTINGS_BUTTON,
  SettingsPage,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { usePulls } from "#/stores/pulls";

/**
 * The GitHub connection. Which repository a project reads is in Projects ›
 * General, beside the project it belongs to.
 *
 * Connecting starts here as well as on the pull-request screen — the place
 * people look first for "connect GitHub" is Settings. Both run the ONE device
 * flow in the pulls store (`connect`, `progress`, `cancelConnect`), so a code
 * started on either screen is the same pending connection on the other.
 */
export function GitSection() {
  const account = usePulls((state) => state.account);
  const disconnect = usePulls((state) => state.disconnect);
  const progress = usePulls((state) => state.progress);
  const watch = usePulls((state) => state.watch);
  const [connectError, setConnectError] = useState<string | null>(null);

  // The device code arrives as an event; without this, Settings would start a
  // connection and never show the code to type in.
  useEffect(() => watch(), [watch]);
  return (
    <SettingsPage
      title="Integrations"
      description="Services Lanework connects to."
      sections={[
        {
          title: "GitHub",
          rows: [
            {
              label:
                account.kind === "connected"
                  ? `Connected as @${account.login}`
                  : account.kind === "expired"
                    ? "Connection expired"
                    : "Not connected",
              description: connectError
                ? connectError
                : progress
                  ? "Enter this code on GitHub to finish connecting."
                  : account.kind === "connected"
                    ? "Reads pull requests. Writes nothing unless you submit a review."
                    : account.kind === "expired"
                      ? "Reconnect to keep reading pull requests."
                      : "Read pull requests with your GitHub account.",
              keywords: "github connect disconnect account token oauth device",
              control:
                account.kind !== "connected" ? (
                  <ConnectControl
                    label={
                      account.kind === "expired"
                        ? "Reconnect GitHub"
                        : "Connect GitHub"
                    }
                    onError={setConnectError}
                  />
                ) : (
                  <Button
                    size="lg"
                    className={`${SETTINGS_BUTTON} border-0`}
                    variant="destructive"
                    // The tinted pill of Account → Sign out, `border-0` and all
                    // (see `account-section.tsx`).
                    onClick={() => void disconnect()}
                  >
                    <HugeiconsIcon
                      icon={Unlink02Icon}
                      className="size-4"
                      strokeWidth={2}
                    />
                    Disconnect
                  </Button>
                ),
            },
          ],
        },
      ]}
    />
  );
}

/**
 * Connect GitHub from Settings: the button, then — while the device flow waits
 * — the code to type, a way to copy it, the page to type it on, and a way out.
 */
function ConnectControl({
  label,
  onError,
}: {
  label: string;
  onError: (error: string | null) => void;
}) {
  const connecting = usePulls((state) => state.connecting);
  const progress = usePulls((state) => state.progress);
  const connect = usePulls((state) => state.connect);
  const cancelConnect = usePulls((state) => state.cancelConnect);
  const [copied, setCopied] = useState(false);

  if (!progress)
    return (
      <Button
        size="lg"
        className={SETTINGS_BUTTON}
        disabled={connecting}
        onClick={() => {
          onError(null);
          void connect().then((result) => onError(result.error ?? null));
        }}
      >
        <HugeiconsIcon icon={GithubIcon} className="size-4" strokeWidth={2} />
        {connecting ? "Connecting…" : label}
      </Button>
    );

  return (
    <div className="flex items-center gap-2">
      <code className="bg-foreground/[0.05] rounded-md px-2 py-1 font-mono text-sm tracking-[0.2em]">
        {progress.userCode}
      </code>
      <Button
        size="lg"
        className={SETTINGS_BUTTON}
        variant="ghost"
        onClick={() => {
          void navigator.clipboard
            .writeText(progress.userCode)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
      >
        <HugeiconsIcon icon={Copy01Icon} aria-hidden="true" />
        {copied ? "Copied" : "Copy"}
      </Button>
      {/* ⚠️ A real link, as on the pull-request screen: the window's navigation
          guard sends external origins to the OS browser, where a GitHub
          sign-in belongs. */}
      <Button
        size="lg"
        className={SETTINGS_BUTTON}
        variant="outline"
        render={
          <a href={progress.verificationUri} target="_blank" rel="noreferrer" />
        }
      >
        Open GitHub
      </Button>
      <Button
        size="lg"
        className={SETTINGS_BUTTON}
        variant="ghost"
        onClick={() => void cancelConnect()}
      >
        Cancel
      </Button>
    </div>
  );
}
