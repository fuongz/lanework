import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LocalBadge } from "#/components/shared/auth/local-mode";
import { ProjectListSkeleton } from "#/components/shared/board/skeletons";
import { CreateProjectDialog } from "#/components/shared/common/create-project-dialog";
import { ErrorState } from "#/components/shared/common/error-state";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { useBoard } from "#/stores/board";
import { isLocalWorkspace, useSession } from "#/stores/session";

/**
 * The app's front door, which nobody should ever see for long.
 *
 * It redirects to the remembered project rather than asking which one. Main
 * wrote the choice down, so a picker here would ask a question the app can
 * answer, on every launch.
 */
export function WorkspaceLanding() {
  const session = useSession((state) => state.session);
  const principal = session?.principal;
  // A new identity gets a fresh board, even if the auth gate never unmounted.
  const identity =
    principal?.kind === "machine"
      ? `${session?.apiUrl}:${principal.userId}:${principal.machineId}`
      : (principal?.kind ?? "anonymous");
  return <Landing key={identity} />;
}

function Landing() {
  const [creating, setCreating] = useState(false);
  const ready = useBoard((state) => state.ready);
  const workspaces = useBoard((state) => state.workspaces);
  const active = useBoard((state) => state.active);
  const error = useBoard((state) => state.error);
  const hydrate = useBoard((state) => state.hydrate);
  const navigate = useNavigate();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // NOTE: ONLY the remembered project, never `workspaces[0]`. Main clears the
  // saved selection when that project stops existing, and falling back to
  // whichever is first would drop somebody into a different project's board
  // with nothing on screen saying so. No selection is a question, not a
  // default.
  const target = active?.slug;
  useEffect(() => {
    if (!ready || !target) return;
    void navigate({
      to: "/w/$slug/issues",
      params: { slug: target },
      search: {},
      replace: true,
    });
  }, [navigate, ready, target]);

  return (
    <div className="grid flex-1 place-items-center p-10">
      <div className="w-full max-w-md">
        {!ready ? (
          <ProjectListSkeleton />
        ) : error ? (
          <ErrorState
            title="Could not load your projects"
            message={error}
            onRetry={() => void hydrate()}
          />
        ) : target ? (
          <p
            role="status"
            className="text-muted-foreground text-center text-sm"
          >
            Opening your project…
          </p>
        ) : workspaces.length > 0 ? (
          <div className="flex flex-col gap-3">
            <h1 className="text-[15px] font-semibold tracking-tight">
              Choose a project
            </h1>
            <ul aria-label="Projects" className="flex flex-col">
              {workspaces.map((workspace) => (
                <li key={workspace.slug}>
                  <Link
                    to="/w/$slug/issues"
                    params={{ slug: workspace.slug }}
                    search={{}}
                    className="hover:bg-foreground/[0.04] focus-visible:ring-accent-brand flex h-9 items-center gap-2.5 rounded-md px-2 text-[13px] outline-none focus-visible:ring-2"
                  >
                    <span className="truncate">{workspace.name}</span>
                    {isLocalWorkspace(workspace) && <LocalBadge />}
                    <span className="text-muted-foreground ml-auto font-mono text-xs">
                      {workspace.slug}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              className="self-start"
              onClick={() => void hydrate()}
            >
              Refresh list
            </Button>
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia
                variant="icon"
                className="bg-foreground/[0.06] size-10 rounded-full"
              >
                <HugeiconsIcon
                  icon={Add01Icon}
                  className="size-5"
                  strokeWidth={1.8}
                />
              </EmptyMedia>
              <EmptyTitle>No projects yet</EmptyTitle>
              {/* Not a pointer at the switcher: the control is right below,
                  and advice that sends somebody past the control that does the
                  job is worse than no advice. */}
              <EmptyDescription>
                Name your first one to get started.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {/* The create control itself, not a pointer at the switcher. On
                  an empty account, making a project is the ONLY thing to do, so
                  sending somebody to another corner of the window is a step
                  that exists for no reason. */}
              <Button size="lg" onClick={() => setCreating(true)}>
                Create your first project
              </Button>
              <Button variant="ghost" onClick={() => void hydrate()}>
                Try again
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </div>
      <CreateProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(slug) =>
          void navigate({
            to: "/w/$slug/issues",
            params: { slug },
            search: {},
            replace: true,
          })
        }
      />
    </div>
  );
}
