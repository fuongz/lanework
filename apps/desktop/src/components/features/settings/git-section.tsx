import { GithubIcon } from "@hugeicons/core-free-icons";
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
 * ⚠️ Connecting happens on the pull-request screen, not here. This page is
 * where a connection is REVIEWED and undone — the place people look when they
 * want to know what this app can reach and how to stop it — and a second
 * device-flow entry point would be two half-explained ways to do one thing.
 */
export function GitSection() {
  const account = usePulls((state) => state.account);
  const disconnect = usePulls((state) => state.disconnect);
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
              description:
                account.kind === "connected"
                  ? "Pull requests are read with this account. Nothing is written to your repositories unless you submit a review."
                  : account.kind === "expired"
                    ? "GitHub stopped accepting this connection. Reconnect from a project's Pull requests screen."
                    : "Connect from a project's Pull requests screen.",
              keywords: "github connect disconnect account token oauth device",
              control:
                account.kind === "none" ? (
                  <span className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
                    <HugeiconsIcon
                      icon={GithubIcon}
                      className="size-4"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                    GitHub
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void disconnect()}
                  >
                    Disconnect
                  </Button>
                ),
            },
            {
              label: "Signing out of GitHub here is local",
              description:
                "This forgets the token on this machine. To revoke the app's access entirely, remove it in your GitHub account settings.",
              keywords: "revoke access authorised applications security",
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
                      variant="ghost"
                      size="sm"
                      onClick={() => void unlink(link.slug)}
                    >
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
