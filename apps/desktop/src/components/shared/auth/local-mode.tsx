import {
  CloudUploadIcon,
  LaptopIcon,
  Login01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Workspace } from "#/../shared/workspaces";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { ipcMessage } from "#/lib/ipc-error";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import { isLocalWorkspace, useSession } from "#/stores/session";

/**
 * FE-52: everything a LOCAL board shows that a cloud one does not — the badge,
 * the one-click move to the account (D7a), and the way back to signing in (D5).
 *
 * One file so the switcher, the rail, Settings → Projects and the board itself
 * all say "Local" the same way: a quiet outline badge, the app's own, never a
 * new colour for it.
 */

/** A synced local board: read-only, pointing at the cloud board (D7a). */
export function isMovedWorkspace(
  workspace: Pick<Workspace, "origin" | "movedTo"> | null | undefined,
): boolean {
  return isLocalWorkspace(workspace) && !!workspace?.movedTo;
}

/** "Local" — saved on this machine only. */
export function LocalBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0", className)}
      title="Saved on this machine only"
    >
      Local
    </Badge>
  );
}

/**
 * Move one local board to the signed-in account (D7a).
 *
 * The list is read again afterwards: the local entry has turned read-only and
 * gained `movedTo`, and the cloud board it became is new on the account.
 */
export function useSyncToCloud() {
  const [syncing, setSyncing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sync(workspace: Workspace) {
    const api = window.desktop?.workspaces;
    if (!api || !workspace.id) return null;
    setSyncing(workspace.id);
    setError(null);
    try {
      const result = await api.syncToCloud(workspace.id);
      // The snapshot main answered with already holds both entries; reading the
      // list again keeps the store's own bookkeeping (`listLoaded`, the active
      // project) the one place that decides them.
      await useBoard.getState().hydrate();
      return result;
    } catch (failure) {
      setError(
        ipcMessage(failure, "Could not move this project to the cloud."),
      );
      return null;
    } finally {
      setSyncing(null);
    }
  }

  return { sync, syncing, error, clearError: () => setError(null) };
}

/** Where a moved board lives now, if this machine can see it. */
export function useMovedTarget(
  workspace: Pick<Workspace, "movedTo"> | null | undefined,
): Workspace | null {
  return useBoard(
    (state) =>
      (workspace?.movedTo &&
        state.workspaces.find((entry) => entry.id === workspace.movedTo)) ||
      null,
  );
}

/**
 * The one button that signs a local install in, wherever it is drawn.
 *
 * ⚠️ Signing in from inside the app never passes the gate, so the wait has to
 * be said HERE: the browser opens elsewhere and this button is the only thing
 * on screen that knows.
 */
export function SignInButton({
  label = "Sign in",
  className,
  size = "sm",
}: {
  label?: string;
  className?: string;
  size?: "sm" | "default" | "lg";
}) {
  const busy = useSession((state) => state.busy);
  const signIn = useSession((state) => state.signIn);
  const cancelSignIn = useSession((state) => state.cancelSignIn);

  if (busy)
    return (
      <Button
        variant="outline"
        size={size}
        className={className}
        onClick={() => void cancelSignIn()}
        title="Waiting for your browser. Click to cancel."
      >
        <span
          aria-hidden
          className="startup-loading-spinner border-foreground/20 border-t-foreground/75 size-3 rounded-full border-2"
        />
        Waiting for browser…
      </Button>
    );

  return (
    <Button
      variant="outline"
      size={size}
      className={className}
      onClick={() => void signIn()}
    >
      <HugeiconsIcon
        icon={Login01Icon}
        strokeWidth={1.8}
        data-icon="inline-start"
        aria-hidden="true"
      />
      {label}
    </Button>
  );
}

/**
 * A one-line bar across the top of a LOCAL board, the way "Offline" is: being
 * local is a property of the board, not of the screen looking at it.
 *
 * Three states: local and signed out (sign in to sync), local and signed in
 * (sync to cloud), and moved — read-only, with the way to the cloud board.
 */
export function LocalBoardBar({ workspace }: { workspace: Workspace }) {
  const signedIn = useSession(
    (state) => state.session?.principal.kind === "machine",
  );
  const { sync, syncing, error, clearError } = useSyncToCloud();
  const target = useMovedTarget(workspace);
  const navigate = useNavigate();

  if (!isLocalWorkspace(workspace)) return null;
  const moved = isMovedWorkspace(workspace);

  return (
    <div className="flex shrink-0 flex-col">
      <div
        role="status"
        aria-label="Local project"
        className="bg-foreground/[0.035] border-border flex min-h-9 shrink-0 items-center gap-2.5 border-b px-6 py-1 text-xs"
      >
        <HugeiconsIcon
          icon={moved ? CloudUploadIcon : LaptopIcon}
          className="text-muted-foreground size-3.5 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <LocalBadge />
        <span className="text-muted-foreground min-w-0 truncate">
          {moved
            ? "Moved to your account. This copy is read-only."
            : signedIn
              ? "Saved on this machine only."
              : "Saved on this machine only. Sign in to move it to your account."}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {moved ? (
            target && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: "/w/$slug/issues",
                    params: { slug: target.slug },
                    search: {},
                  })
                }
              >
                Open cloud project
              </Button>
            )
          ) : signedIn ? (
            <Button
              variant="outline"
              size="sm"
              disabled={syncing !== null}
              onClick={() =>
                void sync(workspace).then((result) => {
                  if (!result) return;
                  const cloud = result.snapshot.workspaces.find(
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
              {syncing ? "Moving…" : "Sync to cloud"}
            </Button>
          ) : (
            <SignInButton label="Sign in to sync" />
          )}
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="text-destructive border-border flex items-center gap-2 border-b px-6 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button variant="ghost" size="sm" onClick={clearError}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The rail's footer in local mode (D5): nobody is signed in, and this is the
 * way to change that without hunting through Settings.
 *
 * Draws nothing once signed in — a local board then says "Local" in its own
 * bar and in the project list (D6a), and the rail goes back to how it was.
 */
export function LocalModeRail() {
  const local = useSession(
    (state) => state.session?.principal.kind === "local",
  );
  const error = useSession((state) => state.error);
  if (!local) return null;
  return (
    <section
      aria-label="Local mode"
      className="bg-foreground/[0.035] mb-2 flex flex-col gap-2 rounded-md p-2.5"
    >
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={LaptopIcon}
          className="text-muted-foreground size-4 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          Local mode
        </span>
        <LocalBadge />
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Projects are saved on this machine only.
      </p>
      <SignInButton className="w-full" />
      {error && (
        <p role="alert" className="text-destructive text-xs break-words">
          {error}
        </p>
      )}
    </section>
  );
}
