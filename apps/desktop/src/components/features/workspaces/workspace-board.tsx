import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import type {
  BoardCard,
  BoardConflict,
  BoardView,
  Workspace,
} from "../../../../shared/workspaces";
import { LocalFolderPanel } from "./local-folder-panel";

/** Strip Electron's IPC wrapper so a user reads the message main actually sent. */
function message(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message : fallback;
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

const when = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? "an unknown time"
    : at.toLocaleTimeString();
};

/**
 * The board of one cloud workspace.
 *
 * ⚠️ Nothing here asks whether the workspace has a local folder. Cards live in
 * the cloud; a folder is for running code, and gating the board on one is the
 * requirement BE-02 D1 removed and FE-06 D1 exists to finish.
 */
export function WorkspaceBoard({ workspace }: { workspace: Workspace }) {
  return workspace.id === null ? (
    <BoardUnavailable workspace={workspace} />
  ) : (
    <CloudBoard workspace={workspace} workspaceId={workspace.id} />
  );
}

/**
 * A workspace this service cannot open a board for.
 *
 * ⚠️ This is the "older control plane" case, and it exists because the app
 * shipped a version that refused the whole workspace list over it. A board needs
 * `/v1/sync/state` to carry the workspace id; until the service has it, the
 * project is still selectable, still remembered, and this says exactly which
 * half is missing instead of failing the screen.
 */
function BoardUnavailable({ workspace }: { workspace: Workspace }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="max-w-full break-words text-2xl font-semibold">
        {workspace.name}
      </h2>
      <Alert>
        <AlertTitle>This board is not available yet</AlertTitle>
        <AlertDescription>
          The service did not send an id for this workspace, so its cards cannot
          be opened from here. Update the Lanework service, then reopen this
          workspace.
        </AlertDescription>
      </Alert>
      {/* ⚠️ The cards are not gone — on a service this old they were never in
          the cloud to begin with, and the copy above says nothing about where
          they actually are. This lets the user point at the folder and read
          what is in it, which is the difference between "wait for a deploy" and
          "wait for a deploy, and here is your project". */}
      <LocalFolderPanel workspace={workspace} />
    </div>
  );
}

function CloudBoard({
  workspace,
  workspaceId,
}: {
  workspace: Workspace;
  workspaceId: string;
}) {
  const [view, setView] = useState<BoardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<BoardConflict | null>(null);
  const [title, setTitle] = useState("");
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const api = window.desktop?.workspaces.board;
      if (!api)
        throw new Error("This window is not connected to the desktop app.");
      const next = await api.load(workspaceId);
      if (request.current !== id) return;
      setView(next);
    } catch (cause) {
      if (request.current !== id) return;
      setError(message(cause, "Could not load this board. Try again."));
    } finally {
      if (request.current === id) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load]);

  /**
   * Run one write and fold the answer back in.
   *
   * ⚠️ A `conflict` is kept as its own state rather than turned into an error
   * string: the API's 409 carries the card as it stands now, so the user can be
   * shown both sides and decide. And nothing is applied optimistically — the
   * board only changes once the server has said it did (FE-06 D2).
   */
  const write = useCallback(
    async (
      key: string,
      run: (
        api: NonNullable<typeof window.desktop>["workspaces"]["board"],
      ) => Promise<
        Awaited<
          ReturnType<
            NonNullable<typeof window.desktop>["workspaces"]["board"]["move"]
          >
        >
      >,
    ) => {
      setBusy(key);
      setError(null);
      setConflict(null);
      try {
        const api = window.desktop?.workspaces.board;
        if (!api)
          throw new Error("This window is not connected to the desktop app.");
        const result = await run(api);
        if (result.kind === "conflict") {
          setConflict(result);
          await load();
          return;
        }
        if (result.kind === "error") {
          setError(result.message);
          return;
        }
        await load();
      } catch (cause) {
        setError(message(cause, "That change did not save. Try again."));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  // ⚠️ The workspace's NAME is rendered before anything else can fail. A board
  // that could not be read still has to say which project you are looking at —
  // a screen that answers "could not load" and nothing else leaves the user
  // unsure they even opened the right one.
  const heading = (
    <h2 className="max-w-full break-words text-2xl font-semibold">
      {workspace.name}
    </h2>
  );

  if (loading && !view)
    return (
      <div className="flex flex-col gap-3">
        {heading}
        <p role="status" className="text-sm text-muted-foreground">
          Loading this board…
        </p>
      </div>
    );

  if (!view)
    return (
      <div className="flex flex-col gap-4">
        {heading}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not load this board</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button
          variant="outline"
          className="self-start"
          onClick={() => void load()}
        >
          Try again
        </Button>
      </div>
    );

  const byColumn = (key: string): BoardCard[] =>
    view.cards
      .filter((card) => card.columnKey === key)
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {heading}
        {/* ⚠️ Says so when the data is a saved copy. "Nothing here" and "I could
            not ask" look identical on screen, and a developer who trusts an
            empty board starts typing a card that already exists. */}
        {view.stale ? (
          <Badge variant="secondary">
            Saved copy from {when(view.fetchedAt)}
          </Badge>
        ) : (
          <Badge variant="secondary">Live · {when(view.fetchedAt)}</Badge>
        )}
        {!view.migrated && (
          <Badge variant="outline">Cards not migrated yet</Badge>
        )}
        <Button variant="ghost" disabled={loading} onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {view.stale && (
        <Alert>
          <AlertTitle>You are looking at a saved copy</AlertTitle>
          <AlertDescription>
            The board could not be reached, so this is the last version this
            machine saw. Changes are not saved while it is offline.
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>That change did not save</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {conflict && (
        <Alert>
          <AlertTitle>Someone else changed this card</AlertTitle>
          <AlertDescription>
            {conflict.message} The board now shows “{conflict.current.title}” as
            it stands on the server; your change was not applied.
          </AlertDescription>
        </Alert>
      )}

      <form
        className="flex items-start gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const next = title.trim();
          if (!next) return;
          setTitle("");
          void write("create", (api) => api.create(workspaceId, next));
        }}
      >
        <Input
          aria-label="New card title"
          placeholder="Add a card"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={view.stale}
        />
        <Button
          type="submit"
          disabled={!title.trim() || busy === "create" || view.stale}
        >
          {busy === "create" ? "Adding…" : "Add"}
        </Button>
      </form>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {view.columns.map((column) => {
          const cards = byColumn(column.key);
          return (
            <Card key={column.key} aria-label={`${column.name} column`}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-3 text-base">
                  <span>{column.name}</span>
                  <Badge variant="secondary">{cards.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {cards.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing here.</p>
                ) : (
                  cards.map((card) => (
                    <div
                      key={card.id}
                      className="flex flex-col gap-2 rounded-md border p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium">
                          {card.taskId ? `${card.taskId} · ` : ""}
                          {card.title}
                        </p>
                        {card.priority && (
                          <Badge variant="outline">{card.priority}</Badge>
                        )}
                      </div>
                      {card.checklist.length > 0 && (
                        <ul className="flex flex-col gap-1">
                          {card.checklist.map((item) => (
                            <li key={item.key} className="text-xs">
                              <label className="flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  checked={item.checked}
                                  disabled={
                                    busy === `${card.id}:${item.key}` ||
                                    view.stale
                                  }
                                  onChange={(event) =>
                                    void write(
                                      `${card.id}:${item.key}`,
                                      (api) =>
                                        api.toggle(
                                          workspaceId,
                                          card.id,
                                          item.key,
                                          event.target.checked,
                                          // The revision this screen is showing —
                                          // sent as `If-Match` so a tick cannot
                                          // land on a card that moved on.
                                          card.revision,
                                        ),
                                    )
                                  }
                                />
                                <span>
                                  {item.key}. {item.text}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {view.columns
                          .filter((target) => target.key !== card.columnKey)
                          .map((target) => (
                            <Button
                              key={target.key}
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              disabled={busy === card.id || view.stale}
                              aria-label={`Move ${card.title} to ${target.name}`}
                              onClick={() =>
                                void write(card.id, (api) =>
                                  api.move(workspaceId, card.id, target.key),
                                )
                              }
                            >
                              {target.name}
                            </Button>
                          ))}
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {view.cards.length === 0 && !view.stale && (
        <>
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No cards yet</EmptyTitle>
              <EmptyDescription>
                {view.migrated
                  ? "Add one above, or open this board on another machine."
                  : "This workspace has not been migrated yet, so its cards are still files in the repository."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
          {/* ⚠️ Only before the cutover. Once the cloud owns the cards, the
              files on disk are a frozen copy (BE-04 D6) and offering them here
              would point somebody at the version that stopped being true. */}
          {!view.migrated && (
            // ⚠️ `onMigrated` is not optional here: after a cutover the board
            // reads a different SOURCE, and without a re-read the switch appears
            // to have done nothing until the next navigation.
            <LocalFolderPanel
              workspace={workspace}
              onMigrated={() => void load()}
            />
          )}
        </>
      )}
    </div>
  );
}
