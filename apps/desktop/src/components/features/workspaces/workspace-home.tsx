import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { Separator } from "#/components/ui/separator";
import { useSession } from "#/stores/session";
import type { WorkspaceSnapshot } from "../../../../shared/workspaces";

export function WorkspaceHome() {
  const session = useSession((state) => state.session);
  const principal = session?.principal;
  // A new identity gets fresh state, even if the auth gate never unmounted.
  const identity =
    principal?.kind === "machine"
      ? JSON.stringify([session?.apiUrl, principal.userId, principal.machineId])
      : "anonymous";
  return <WorkspaceHomeContent key={identity} />;
}

function WorkspaceHomeContent() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const run = useCallback(async (slug?: string) => {
    const id = ++request.current;
    setError(null);
    setLoading(slug === undefined);
    setSelecting(slug ?? null);
    try {
      const api = window.desktop?.workspaces;
      if (!api)
        throw new Error("This window is not connected to the desktop app.");
      const next =
        slug === undefined ? await api.load() : await api.select(slug);
      if (request.current !== id) return;
      setSnapshot(next);
      if (slug !== undefined) setChoosing(false);
    } catch (cause) {
      if (request.current !== id) return;
      const message =
        cause instanceof Error
          ? cause.message
          : "Could not load your workspaces. Try again.";
      setError(
        message.replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          "",
        ),
      );
    } finally {
      if (request.current === id) {
        setLoading(false);
        setSelecting(null);
      }
    }
  }, []);

  useEffect(() => {
    void run();
    return () => {
      request.current++;
    };
  }, [run]);

  const active = snapshot?.active;
  const showActive = active && !choosing;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col items-start gap-3">
        <Badge variant="secondary">Your desktop workspace</Badge>
        <h1 className="text-4xl font-semibold tracking-tight">
          Your workspaces
        </h1>
        <p className="text-muted-foreground">
          Pick up where you left off, or choose a space to work in.
        </p>
      </div>
      <Card aria-busy={loading || selecting !== null}>
        <CardHeader>
          <CardTitle>
            {showActive ? "Current workspace" : "Choose a workspace"}
          </CardTitle>
          <CardDescription>
            {showActive
              ? "This workspace will be ready the next time you open Lanework."
              : "Workspaces from your account. Your choice is remembered on this machine."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {loading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading your workspaces…
            </p>
          ) : (
            <>
              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Could not update workspaces</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {error && (
                <Button
                  variant="outline"
                  className="self-start"
                  disabled={selecting !== null}
                  onClick={() => void run()}
                >
                  Try again
                </Button>
              )}
              {showActive ? (
                <div className="flex flex-col items-start gap-4">
                  <Badge variant="secondary">Active workspace</Badge>
                  <h2 className="max-w-full break-words text-2xl font-semibold">
                    {active.name}
                  </h2>
                  <p className="max-w-full break-all text-sm text-muted-foreground">
                    {active.path ?? "No local folder linked on this machine"}
                  </p>
                  {active.baseBranch && (
                    <p className="text-sm text-muted-foreground">
                      Branch: {active.baseBranch}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => {
                      setChoosing(true);
                      void run();
                    }}
                  >
                    Change workspace
                  </Button>
                </div>
              ) : snapshot && snapshot.workspaces.length > 0 ? (
                <>
                  <ul aria-label="Workspaces" className="flex flex-col gap-4">
                    {snapshot.workspaces.map((workspace, index) => (
                      <li key={workspace.slug} className="flex flex-col gap-4">
                        {index > 0 && <Separator />}
                        <div className="flex items-center justify-between gap-5">
                          <div className="flex min-w-0 flex-col gap-1">
                            <h2 className="break-words text-sm font-medium">
                              {workspace.name}
                            </h2>
                            <p className="break-all text-xs text-muted-foreground">
                              {workspace.path ??
                                "No local folder linked on this machine"}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            className="shrink-0"
                            disabled={selecting !== null}
                            aria-label={`Open ${workspace.name}`}
                            onClick={() => void run(workspace.slug)}
                          >
                            {selecting === workspace.slug ? "Opening…" : "Open"}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {selecting && (
                    <p role="status" className="text-sm text-muted-foreground">
                      Saving your workspace selection…
                    </p>
                  )}
                  {!error && (
                    <Button
                      variant="ghost"
                      className="self-start"
                      disabled={selecting !== null}
                      onClick={() => void run()}
                    >
                      Refresh list
                    </Button>
                  )}
                  {active && (
                    <Button
                      variant="ghost"
                      className="self-start"
                      disabled={selecting !== null}
                      onClick={() => setChoosing(false)}
                    >
                      Keep current workspace
                    </Button>
                  )}
                </>
              ) : snapshot && !error ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No workspaces yet</EmptyTitle>
                    <EmptyDescription>
                      Workspaces will appear here once they have been synced to
                      your account.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="outline" onClick={() => void run()}>
                      Refresh list
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
