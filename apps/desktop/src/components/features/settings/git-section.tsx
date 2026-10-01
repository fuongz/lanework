import {
  Copy01Icon,
  GithubIcon,
  Unlink02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  SettingsCard,
  SettingsPage,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { ipcMessage } from "#/lib/ipc-error";
import { useBoard } from "#/stores/board";
import { usePulls } from "#/stores/pulls";
import { formatRepoRef, type RepoRef } from "../../../../shared/git";

/**
 * The GitHub connection, and which repository each project reads.
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
  const workspaces = useBoard((state) => state.workspaces);
  const hydrate = useBoard((state) => state.hydrate);
  const [links, setLinks] = useState<
    { slug: string; name: string; repo: RepoRef }[]
  >([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Read straight from the surface rather than through the store: the store
  // holds ONE project's repo — the open one — and this page is about all of them.
  useEffect(() => {
    let cancelled = false;
    const surface = window.desktop?.git;
    if (!surface || !workspaces.length) return;
    void Promise.all(
      workspaces.map(async (workspace) => {
        const state = await surface.repo(workspace.slug).catch(() => null);
        return state?.kind === "linked"
          ? { slug: workspace.slug, name: workspace.name, repo: state.repo }
          : null;
      }),
    ).then((rows) => {
      if (!cancelled)
        setLinks(rows.filter((row): row is NonNullable<typeof row> => !!row));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaces]);

  async function unlink(slug: string) {
    const surface = window.desktop?.git;
    if (!surface) return;
    try {
      await surface.unlinkRepo(slug);
      setLinks((rows) => rows.filter((row) => row.slug !== slug));
      setError(null);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not disconnect that repository."));
    }
  }

  return (
    <SettingsPage
      title="GitHub"
      description="Read pull requests from the repositories your projects are built from."
      sections={[
        {
          title: "Connection",
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
                    ? "Pull requests are read with this account. Nothing is written to your repositories unless you submit a review."
                    : account.kind === "expired"
                      ? "GitHub stopped accepting this connection. Reconnect to keep reading pull requests."
                      : "Pull requests are read with your own GitHub account. Nothing is written to your repositories.",
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
                    variant="destructive"
                    size="lg"
                    // The tinted pill of Account → Sign out, `border-0` and all
                    // (see `account-section.tsx`).
                    className="h-8 gap-1.5 rounded-lg border-0 pr-3 pl-2.5 text-sm"
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
        {
          title: "Repositories",
          keywords: "repo repository project link unlink owner",
          content: (
            <SettingsCard>
              {links.length === 0 ? (
                <p className="text-muted-foreground px-4 py-3.5 text-[13px]">
                  No project is connected to a repository yet. Open a project's
                  Pull requests screen to connect one.
                </p>
              ) : (
                links.map((link) => (
                  <div
                    key={link.slug}
                    className="flex items-center justify-between gap-8 px-4 py-3.5"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-sm font-medium">{link.name}</span>
                      <SettingsValue>{formatRepoRef(link.repo)}</SettingsValue>
                    </div>
                    <Button
                      variant="destructive"
                      size="lg"
                      className="h-8 gap-1.5 rounded-lg border-0 pr-3 pl-2.5 text-sm"
                      onClick={() => void unlink(link.slug)}
                    >
                      <HugeiconsIcon
                        icon={Unlink02Icon}
                        className="size-4"
                        strokeWidth={2}
                      />
                      Disconnect
                    </Button>
                  </div>
                ))
              )}
              {error && (
                <p className="text-destructive px-4 py-3 text-[13px]">
                  {error}
                </p>
              )}
            </SettingsCard>
          ),
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
        className="h-8 gap-1.5 rounded-lg pr-3 pl-2.5 text-sm"
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
        variant="ghost"
        size="sm"
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
        variant="outline"
        size="sm"
        render={
          <a href={progress.verificationUri} target="_blank" rel="noreferrer" />
        }
      >
        Open GitHub
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void cancelConnect()}>
        Cancel
      </Button>
    </div>
  );
}
