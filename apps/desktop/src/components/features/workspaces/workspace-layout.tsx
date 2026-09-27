import {
  InformationCircleIcon,
  WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { ErrorState } from "#/components/shared/common/error-state";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { useBoard } from "#/stores/board";
import { useReadinessWatch } from "#/stores/readiness";

/**
 * One project, open.
 *
 * ⚠️ The banners live HERE rather than in each view, because what they report is
 * a property of the board and not of the screen looking at it: a lost race is
 * still a lost race after you switch from the list to the lanes, and a banner
 * that unmounted with the view would take the only record of it with it.
 */
export function WorkspaceLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug" });
  const open = useBoard((state) => state.open);
  const poll = useBoard((state) => state.poll);
  const error = useBoard((state) => state.error);
  const conflict = useBoard((state) => state.conflict);
  const dismiss = useBoard((state) => state.dismiss);
  const view = useBoard((state) => state.view);
  const active = useBoard((state) => state.active);
  const notFound = useBoard((state) => state.notFound);
  const navigate = useNavigate();

  // ⚠️ `open` refreshes the list itself. This used to be
  // `hydrate().then(() => open(slug))` while `open` ALSO hydrated when the slug
  // was unknown, so a control plane that was down was asked twice per
  // navigation and logged twice.
  useEffect(() => {
    void open(slug);
  }, [open, slug]);

  // FE-30: whether this project's folder is ready for an agent. In the
  // background — the board never waits for it — and shown beside the switcher.
  useReadinessWatch(slug);

  // A URL naming a project this account does not have is answered with the
  // picker, not with a board that will never load.
  useEffect(() => {
    if (notFound === slug) void navigate({ to: "/", replace: true });
  }, [navigate, notFound, slug]);

  // ⚠️ On focus, not on a timer. A desktop window that is not being looked at
  // has nobody to show a change to, and a poll it fires anyway is a request per
  // interval per open window, forever.
  useEffect(() => {
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [poll]);

  // ⚠️ A workspace whose id the service never sent. Not a failure and not an
  // empty board: this app shipped a version that refused the whole workspace
  // list over it, and the fix was to keep the project openable and say exactly
  // which half is missing. The rail's folder item is the other half — the cards
  // are on disk the whole time.
  // ⚠️ The list could not be read, so there is no project to draw and no
  // picker worth sending anybody to — the picker is built from the same list.
  // One screen with one Try again, rather than an empty board under a banner
  // or, as it was, a bounce back to "Opening your project…" and round again.
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
            {/* ⚠️ Not a destructive state. Nothing failed — this service is
                simply older than the field a board is addressed by, and the
                project is still perfectly real. */}
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
      {/* ⚠️ A bar across the whole pane, not a card in the banner stack. Being
          offline is a condition of the WINDOW — it colours everything below it
          and it does not go away when you navigate — so it reads as chrome,
          one line, always at the top. A boxed alert competing for width with
          the board underneath said the same thing in four times the space. */}
      {view?.stale && (
        <div
          role="status"
          className="bg-destructive text-destructive-foreground flex h-7 shrink-0 items-center justify-center gap-2 px-6 text-xs font-medium"
        >
          <HugeiconsIcon
            icon={WifiDisconnected01Icon}
            className="size-3.5"
            strokeWidth={2}
            aria-hidden="true"
          />
          Offline — showing a saved board. Changes will not save.
        </div>
      )}
      {(error || conflict) && (
        <div className="flex flex-col gap-2 px-6 pt-4">
          {conflict && (
            <Alert>
              <AlertTitle>Someone else changed this card</AlertTitle>
              <AlertDescription>
                {conflict.message} The board now shows “{conflict.current.title}
                ”. Your change was not applied.
              </AlertDescription>
              <Button
                variant="ghost"
                className="mt-1 self-start"
                onClick={dismiss}
              >
                Dismiss
              </Button>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              {/* ⚠️ A read failure and a write failure are different sentences.
                  "That did not save" about a board that could not be READ sends
                  somebody looking for the edit they lost, and there wasn't one. */}
              <AlertTitle>
                {view ? "That did not save" : "Could not load this board"}
              </AlertTitle>
              <AlertDescription>{error}</AlertDescription>
              <Button
                variant="ghost"
                className="mt-1 self-start"
                onClick={dismiss}
              >
                Dismiss
              </Button>
            </Alert>
          )}
        </div>
      )}
      <Outlet />
    </div>
  );
}
