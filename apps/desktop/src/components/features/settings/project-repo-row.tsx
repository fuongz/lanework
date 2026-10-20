import { Unlink02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  SETTINGS_BUTTON,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { ipcMessage } from "#/lib/ipc-error";
import { formatRepoRef, type RepoRef } from "../../../../shared/git";
import { Row } from "./selected-project-section";

/**
 * The GitHub repository a project reads pull requests from, in Projects ›
 * General — one project's, where Integrations used to list every one.
 *
 * ⚠️ Read straight from the surface rather than through the pulls store: the
 * store holds the OPEN project's repo, and this is the one picked here.
 */
export function ProjectRepoRow({
  slug,
  onFailed,
}: {
  slug: string;
  onFailed: (message: string | null) => void;
}) {
  // `undefined` while it is read; null when no repository is connected.
  const [repo, setRepo] = useState<RepoRef | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const surface = window.desktop?.git;
    if (!surface) return;
    setRepo(undefined);
    void surface
      .repo(slug)
      .catch(() => null)
      .then((state) => {
        if (!cancelled) setRepo(state?.kind === "linked" ? state.repo : null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function unlink() {
    const surface = window.desktop?.git;
    if (!surface) return;
    try {
      await surface.unlinkRepo(slug);
      setRepo(null);
      onFailed(null);
    } catch (failure) {
      onFailed(ipcMessage(failure, "Could not disconnect that repository."));
    }
  }

  return (
    <Row
      label="Repository"
      description={
        repo === undefined ? (
          "Reading…"
        ) : repo ? (
          <SettingsValue>{formatRepoRef(repo)}</SettingsValue>
        ) : (
          "None. Connect one from Pull requests."
        )
      }
    >
      {repo && (
        <Button
          size="lg"
          className={`${SETTINGS_BUTTON} border-0`}
          variant="destructive"
          // The tinted pill of Account → Sign out, `border-0` and all.
          onClick={() => void unlink()}
        >
          <HugeiconsIcon
            icon={Unlink02Icon}
            className="size-4"
            strokeWidth={2}
          />
          Disconnect
        </Button>
      )}
    </Row>
  );
}
