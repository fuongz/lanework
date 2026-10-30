import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { LocalBoardBar } from "#/components/shared/auth/local-mode";
import { ErrorState } from "#/components/shared/common/error-state";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { useBoard } from "#/stores/board";
import { useLastRoute } from "#/stores/last-route";

/**
 * One project, open.
 *
 * A failed write, a lost race and being offline are not drawn here: they are
 * the board notice island in the shell (FE-63), because they are a property
 * of the board, not of the screen looking at it.
 */
export function ProjectLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug" });
  const open = useBoard((state) => state.open);
  const poll = useBoard((state) => state.poll);
  const error = useBoard((state) => state.error);
  const active = useBoard((state) => state.active);
  const notFound = useBoard((state) => state.notFound);
  const navigate = useNavigate();

  // `open` refreshes the list itself. Hydrating here as well would ask a
  // control plane that is down twice per navigation, and log it twice.
  useEffect(() => {
    void open(slug);
  }, [open, slug]);

  // Where this project was left, so switching away and back returns here.
  // NOTE: Only an href UNDER this slug. Mid-switch the location already names
  // the next project while the params still name this one, and filing the
  // next project's href under this slug makes switching back a no-op.
  const href = useLocation({ select: (location) => location.href });
  const remember = useLastRoute((state) => state.remember);
  useEffect(() => {
    if (href.startsWith(`/w/${slug}/`)) remember(slug, href);
  }, [remember, slug, href]);

  // A URL naming a project this account does not have is answered with the
  // picker, not with a board that will never load.
  useEffect(() => {
    if (notFound === slug) void navigate({ to: "/", replace: true });
  }, [navigate, notFound, slug]);

  // On focus, not on a timer. A window nobody is looking at has nobody to
  // show a change to, and a poll fired anyway is a request per interval per
  // open window, forever.
  useEffect(() => {
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [poll]);

  // The offline MCP and the checkpoint hook write a LOCAL board from outside
  // this window, and nothing polls the SQLite store, so main says when it
  // changed. An empty list means "re-read everything local".
  const reload = useBoard((state) => state.reload);
  const activeId = active?.id ?? null;
  const activeIsLocal = active?.origin === "local";
  useEffect(() => {
    const api = window.desktop?.projects;
    if (!api?.onLocalChange || !activeIsLocal || !activeId) return;
    return api.onLocalChange((ids) => {
      if (ids.length === 0 || ids.includes(activeId)) void reload();
    });
  }, [reload, activeId, activeIsLocal]);

  // The list could not be read, so there is no project to draw and no picker
  // worth sending anybody to: the picker is built from the same list. One
  // screen with one Try again, rather than an empty board under a banner or a
  // bounce back to "Opening your project…" and round again.
  if (!active && error)
    return (
      <div className="grid flex-1 place-items-center p-10">
        <div className="w-full max-w-md">
          <ErrorState
            title="Could not open this project"
            message={error}
            onRetry={() => void open(slug)}
          />
        </div>
      </div>
    );

  // A project whose id the service never sent. Not a failure and not an
  // empty board: this app once refused the whole project list over it, so
  // the project stays openable and the screen says which half is missing. The
  // folder in the sidebar is the other half; the cards are on disk.
  if (active && active.id === null)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Empty className="py-16">
          <EmptyHeader>
            <EmptyMedia
              variant="icon"
              className="size-10 rounded-full bg-foreground/[0.06]"
            >
              <HugeiconsIcon
                icon={InformationCircleIcon}
                className="size-5"
                strokeWidth={1.8}
              />
            </EmptyMedia>
            {/* Not a destructive state. Nothing failed: this service is older
                than the field a board is addressed by, and the project is
                still real. */}
            <EmptyTitle>Board not available yet</EmptyTitle>
            <EmptyDescription>
              This service sent no id for {active.name}. Update it, then reopen.
              Its folder is in the sidebar.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {active && <LocalBoardBar project={active} />}
      <Outlet />
    </div>
  );
}
