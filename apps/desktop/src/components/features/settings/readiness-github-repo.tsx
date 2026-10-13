import { GithubIcon, RepositoryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RepoPicker } from "#/components/shared/pulls/repo-picker";
import { Button } from "#/components/ui/button";
import { ipcMessage } from "#/lib/ipc-error";
import { usePulls } from "#/stores/pulls";
import {
  formatRepoRef,
  type GitAccount,
  type RepoState,
} from "../../../../shared/git";

/**
 * The project's GitHub repo, picked under Settings › Projects › "Ready for
 * agents" (FE-55):
 * connected to GitHub, the repo it reads — or a picker for one; not connected,
 * the way to Pull requests to connect.
 *
 * ⚠️ This is the LOCAL link the Pull requests screen reads (FE-12), not the
 * board's repo on the service: picking here does not answer "Repo linked to
 * this board" — an agent's `link_repo` still does that. The section says so.
 */
export function ReadinessGithubRepo({ slug }: { slug: string }) {
  const [account, setAccount] = useState<GitAccount | null>(null);
  const [repo, setRepo] = useState<RepoState | null>(null);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    const git = window.desktop?.git;
    if (!git) return;
    let live = true;
    void Promise.all([git.account(), git.repo(slug)])
      .then(([nextAccount, nextRepo]) => {
        if (!live) return;
        setAccount(nextAccount);
        setRepo(nextRepo);
      })
      .catch(() => {});
    const off = git.onAccountChange((next) => live && setAccount(next));
    return () => {
      live = false;
      off();
    };
  }, [slug]);

  async function link(raw: string): Promise<{ error?: string }> {
    const git = window.desktop?.git;
    if (!git) return { error: "This window is not connected to the app." };
    try {
      setRepo(await git.linkRepo(slug, raw));
      setChanging(false);
      // The Pull requests screen holds its own copy; bring it along when it is
      // showing this project.
      const pulls = usePulls.getState();
      if (pulls.slug === slug) void pulls.open(slug, pulls.status);
      return {};
    } catch (error) {
      return { error: ipcMessage(error, "Could not connect that repository.") };
    }
  }

  if (!account) return null;

  return (
    <section
      aria-label="GitHub repo"
      className="border-border flex flex-col gap-2 border-t py-3"
      data-testid="readiness-github-repo"
    >
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={GithubIcon}
          className="size-4 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="text-[13px] font-medium">GitHub repo</span>
        {account.kind === "connected" && (
          <span className="text-muted-foreground ml-auto truncate text-[11px]">
            @{account.login}
          </span>
        )}
      </div>
      {account.kind !== "connected" ? (
        <p className="text-muted-foreground text-xs/relaxed">
          {account.kind === "expired"
            ? "Your GitHub connection has expired. "
            : "Connect GitHub to pick this project's repo here. "}
          <Link
            to="/w/$slug/pulls"
            params={{ slug }}
            search={{ tab: "all", status: "open" }}
            className="text-foreground underline underline-offset-2"
          >
            {account.kind === "expired" ? "Reconnect GitHub" : "Connect GitHub"}
          </Link>
        </p>
      ) : repo?.kind === "linked" && !changing ? (
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={RepositoryIcon}
            className="text-muted-foreground size-3.5 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span
            className="min-w-0 flex-1 truncate text-xs"
            data-testid="readiness-github-repo-name"
          >
            {formatRepoRef(repo.repo)}
          </span>
          <Button size="xs" variant="ghost" onClick={() => setChanging(true)}>
            Change
          </Button>
        </div>
      ) : (
        <RepoPicker
          suggestion={repo?.kind === "none" ? repo.suggestion : null}
          onLink={link}
        />
      )}
      {account.kind === "connected" && (
        <p className="text-muted-foreground text-[11px] leading-4">
          For this project's pull requests. It does not link the repo to the
          board.
        </p>
      )}
    </section>
  );
}
