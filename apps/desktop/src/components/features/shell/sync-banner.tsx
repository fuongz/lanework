import { Cancel01Icon, CloudUploadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import art from "#/components/features/shell/sync-banner-art.jpg";
import {
  isMovedProject,
  SignInButton,
  useSyncToCloud,
} from "#/components/shared/auth/local-mode";
import { Button } from "#/components/ui/button";
import { useBoard } from "#/stores/board";
import { isLocalProject, useSession } from "#/stores/session";
import { useSyncBanner } from "#/stores/sync-banner";

/**
 * The rail's invitation to move a local board to the cloud (FE-122, FE-121/D10).
 *
 * - A card at the foot of the rail, above Settings, on every local project
 *   that has not moved yet. It invites; being local loses nothing, so it
 *   never reads as a warning.
 * - Signed in, its button is the move Settings → Projects makes
 *   (`useSyncToCloud`); the board itself has no bar for it any more. Signed out, it signs in first.
 * - The close button puts it off for THIS project on THIS machine
 *   (`useSyncBanner`). Settings still offers the move.
 */
export function SyncBanner({ slug }: { slug: string | undefined }) {
  const project = useBoard(
    (state) =>
      (slug && state.projects.find((entry) => entry.slug === slug)) || null,
  );
  const signedIn = useSession(
    (state) => state.session?.principal.kind === "machine",
  );
  const hidden = useSyncBanner((state) =>
    project?.id ? state.hidden.includes(project.id) : false,
  );
  const hide = useSyncBanner((state) => state.hide);
  const { sync, syncing, error } = useSyncToCloud();
  const navigate = useNavigate();

  if (
    !project?.id ||
    !isLocalProject(project) ||
    isMovedProject(project) ||
    hidden
  )
    return null;
  const id = project.id;

  return (
    <section
      aria-label="Sync this project to the cloud"
      className="bg-background border-border relative mx-1 mb-1 shrink-0 overflow-hidden rounded-xl border shadow-xs"
    >
      {/* The art is drawn on white, so its panel stays white in dark mode
          too: a light inset, like a sticker on the card. */}
      <div className="relative bg-white">
        <img
          src={art}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="block aspect-[3/1] w-full object-cover select-none"
        />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Hide for this project"
          title="Hide for this project"
          onClick={() => hide(id)}
          className="absolute top-1.5 right-1.5 rounded-full bg-black/35 text-white hover:bg-black/50 hover:text-white"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </div>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[13px] font-medium">Continue anywhere</h2>
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
            This board lives on this machine. Sync it to pick up your work on
            any other.
          </p>
        </div>
        {signedIn ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={syncing !== null}
            onClick={() =>
              void sync(project).then((result) => {
                if (!result) return;
                const cloud = result.snapshot.projects.find(
                  (entry) => entry.id === result.cloudId,
                );
                if (cloud)
                  void navigate({
                    to: "/w/$slug/issues",
                    params: { slug: cloud.slug },
                    search: {},
                  });
              })
            }
          >
            <HugeiconsIcon
              icon={CloudUploadIcon}
              strokeWidth={1.8}
              data-icon="inline-start"
              aria-hidden="true"
            />
            {syncing ? "Syncing…" : "Sync to cloud"}
          </Button>
        ) : (
          <SignInButton label="Sign in to sync" className="w-full" />
        )}
        {error && (
          <p role="alert" className="text-destructive text-xs break-words">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
