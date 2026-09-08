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
import { Input } from "#/components/ui/input";
import { Separator } from "#/components/ui/separator";
import { useSession } from "#/stores/session";
import type { WorkspaceSnapshot } from "../../../../shared/workspaces";
import { WorkspaceBoard } from "./workspace-board";

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
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const request = useRef(0);

  // ⚠️ Selection travels as the CLOUD WORKSPACE ID, not the slug: every board
  // call is `/v1/boards/:workspaceId/…`, and a slug is a display key a rename
  // can move.
  const run = useCallback(async (workspaceId?: string) => {
    const id = ++request.current;
    setError(null);
    setLoading(workspaceId === undefined);
    setSelecting(workspaceId ?? null);
    try {
      const api = window.desktop?.workspaces;
      if (!api)
        throw new Error("This window is not connected to the desktop app.");
      const next =
        workspaceId === undefined
          ? await api.load()
          : await api.select(workspaceId);
      if (request.current !== id) return;
      setSnapshot(next);
      if (workspaceId !== undefined) setChoosing(false);
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

  /**
   * Create a project on the account and open it.
   *
   * ⚠️ It goes through the same `snapshot` the picker reads, because creating a
   * project IS a selection: main creates it, remembers it and answers with the
   * new list. A screen that added a row and left the user to click "Open" would
   * be two steps for one intention.
   */
  const create = useCallback(async () => {
    const typed = name.trim();
    if (!typed) return;
    const id = ++request.current;
    setCreating(true);
    setError(null);
    try {
      const api = window.desktop?.workspaces;
      if (!api)
        throw new Error("This window is not connected to the desktop app.");
      const next = await api.create(typed);
      if (request.current !== id) return;
      setSnapshot(next);
      setName("");
      setChoosing(false);
    } catch (cause) {
      if (request.current !== id) return;
      const message =
        cause instanceof Error
          ? cause.message
          : "Could not create that project. Try again.";
      // ⚠️ The name is KEPT on failure. "That key is taken" is an invitation to
      // edit what you typed, and a field this clears makes the user retype it
      // to find out what was wrong with it.
      setError(
        message.replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          "",
        ),
      );
    } finally {
      if (request.current === id) setCreating(false);
    }
  }, [name]);

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
                  {/* ⚠️ The BOARD, not a folder path. Opening a workspace means
                      seeing its cards — that is the whole point of FE-06 D1, and
                      the path subtitle it replaces made a folderless workspace
                      read as broken. */}
                  <WorkspaceBoard workspace={active} />
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
                            {/* ⚠️ The slug, not the path. A workspace with no
                                folder is a complete workspace — its cards are in
                                the cloud — and telling the user a folder is
                                "missing" is the framing FE-06 D1 removes. The
                                path belongs where code actually runs. */}
                            <p className="break-all text-xs text-muted-foreground">
                              {workspace.slug}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            className="shrink-0"
                            disabled={selecting !== null}
                            aria-label={`Open ${workspace.name}`}
                            // ⚠️ The id when the service sends one, else the
                            // slug — an older control plane still has to be
                            // usable, and `readActive` already understands both.
                            onClick={() =>
                              void run(workspace.id ?? workspace.slug)
                            }
                          >
                            {selecting === (workspace.id ?? workspace.slug)
                              ? "Opening…"
                              : "Open"}
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
                  <Separator />
                  {/* ⚠️ Under the list, not above it: the list is what the user
                      came for, and a create field at the top reads as "you have
                      no projects" on a screen that is showing several. */}
                  <NewProjectForm
                    name={name}
                    setName={setName}
                    busy={creating}
                    disabled={selecting !== null}
                    onSubmit={() => void create()}
                  />
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
                  <EmptyContent className="w-full max-w-sm gap-3">
                    {/* ⚠️ The first thing on an empty account is a way to make
                        a project, not a refresh button. "Nothing here" plus
                        "try again" leaves somebody waiting for a list that is
                        correct — they have no projects yet. */}
                    <NewProjectForm
                      name={name}
                      setName={setName}
                      busy={creating}
                      disabled={false}
                      onSubmit={() => void create()}
                    />
                    <Button variant="ghost" onClick={() => void run()}>
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

/**
 * Name a project into existence.
 *
 * ⚠️ One field, and it asks for a NAME rather than a slug. The service needs a
 * url-safe key and refuses to derive one, so main derives it (`slug.ts`) —
 * asking the user for `du-an-cua-toi` would be asking them to do that job by
 * hand, in a field where a typo is permanent (a slug cannot be patched).
 */
function NewProjectForm({
  name,
  setName,
  busy,
  disabled,
  onSubmit,
}: {
  name: string;
  setName: (value: string) => void;
  busy: boolean;
  disabled: boolean;
  onSubmit: () => void;
}) {
  return (
    <form
      className="flex w-full items-start gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Input
        aria-label="New project name"
        placeholder="New project name"
        value={name}
        maxLength={200}
        disabled={busy || disabled}
        onChange={(event) => setName(event.target.value)}
      />
      <Button type="submit" disabled={!name.trim() || busy || disabled}>
        {busy ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}
