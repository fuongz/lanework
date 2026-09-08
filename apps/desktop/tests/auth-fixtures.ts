import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Workspace } from "../shared/workspaces";

/** A port nothing listens on, so a probe fails fast instead of reaching prod. */
export const DEAD_API = "http://127.0.0.1:1";

/**
 * Write a credential the app will accept, without needing safeStorage.
 *
 * `store.ts` reads `enc: false` records — the documented fallback for a platform
 * with no OS keyring — and a test cannot produce a safeStorage blob from
 * outside the app.
 *
 * With `apiUrl` pointed at a dead port the probe reports `unreachable`, which
 * by FE-01 O1 keeps the principal a `machine`: an enrolled install stays usable
 * offline. So this seeds an UNLOCKED app that touches no network.
 */
export async function seedCredential(
  home: string,
  apiUrl: string = DEAD_API,
): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({
      v: 1,
      machineId: "test-machine",
      apiUrl,
      name: "test-machine",
      userId: "test-user",
      enc: false,
      secret: "lw_mch_test-secret",
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

/**
 * The environment an Electron launch needs to stay off the real control plane
 * and out of the developer's real `~/.lanew`.
 *
 * ⚠️ `LANEWORK_HOME` is not optional. `LANEWORK_TEST_USER_DATA` moves only
 * Electron's `userData`; the app home is a fixed dotfolder under `$HOME` and
 * does not follow it, so a launch without this reads and writes the real
 * credential.
 */
export function launchEnv(options: {
  profile: string;
  home: string;
  apiUrl?: string;
  heartbeatMs?: number;
}): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    LANEWORK_TEST_USER_DATA: options.profile,
    LANEWORK_HOME: options.home,
    LANEWORK_API_URL: options.apiUrl ?? DEAD_API,
  };
  if (options.heartbeatMs)
    env.LANEWORK_HEARTBEAT_MS = String(options.heartbeatMs);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  return env;
}

/**
 * The one control-plane route the app polls: `/v1/machines/me`, whose 401 is
 * how a revocation becomes visible. Enough to drive the gate open and shut.
 */
/** A card as the board API serializes one — the fields this app reads. */
export interface StubCard {
  id: string;
  revision: number;
  title: string;
  body: string;
  columnKey: string;
  categoryKey: string | null;
  taskId: string | null;
  priority: "low" | "medium" | "high" | null;
  tags: string[];
  rank: string;
  createdAt: string | null;
  updatedAt: string | null;
  checklist?: {
    key: string;
    section: string;
    text: string;
    checked: boolean;
    checkedAt: string | null;
    note: string | null;
  }[];
}

export async function startStubPlane(
  options: {
    /** Omit the owner block, standing in for a control plane older than it. */
    owner?: boolean;
    workspaces?: Workspace[];
  } = {},
): Promise<{
  origin: string;
  setRevoked: (value: boolean) => void;
  /** Every request seen, as `METHOD /path` — so a test can prove a call happened. */
  calls: string[];
  setWorkspaces: (value: Workspace[]) => void;
  setWorkspaceResponse: (
    status: number,
    body?: unknown,
    delayMs?: number,
  ) => void;
  workspaceAuth: string[];
  /** Seed the board one workspace id serves. */
  setBoard: (
    workspaceId: string,
    board: {
      migratedAt?: string | null;
      columns: { key: string; name: string; role?: string | null }[];
      cards: StubCard[];
    },
  ) => void;
  /** Make the next checklist write answer 409 with the server's copy. */
  setChecklistConflict: (value: boolean) => void;
  /** Fail every board read, so the app has to fall back to its saved copy. */
  setBoardOffline: (value: boolean) => void;
  /** `If-Match` headers the board saw, so a test can prove the precondition. */
  boardPreconditions: string[];
  /**
   * Answer `POST /v1/sync/state/workspace` with 404, as a deployment that
   * predates the route does. The app has to report an out-of-date service
   * rather than a bad name.
   */
  setCreateMissing: (value: boolean) => void;
  /** Records the import surface accepted, in the order they arrived. */
  imported: { ref: string; columnKey: string; checklist: number }[];
  /** The board config the migration pushed, or null. */
  pushedConfig: { columns: number; categories: number; tagMax: number } | null;
  /** Make the next import batch fail, so a stopped run can be asserted. */
  setImportBroken: (value: boolean) => void;
  /** What the seal was asked to agree to, and what the board will claim. */
  sealed: { items: number; manifest: string }[];
  setSealMismatch: (value: number | null) => void;
  close: () => Promise<void>;
}> {
  let revoked = false;
  let workspaces = options.workspaces ?? [];
  const boards = new Map<
    string,
    {
      migratedAt: string | null;
      columns: { key: string; name: string; role?: string | null }[];
      cards: StubCard[];
    }
  >();
  let checklistConflict = false;
  let boardOffline = false;
  let createMissing = false;
  let importBroken = false;
  let sealMismatch: number | null = null;
  const imported: { ref: string; columnKey: string; checklist: number }[] = [];
  const sealed: { items: number; manifest: string }[] = [];
  let pushedConfig: {
    columns: number;
    categories: number;
    tagMax: number;
  } | null = null;
  const boardPreconditions: string[] = [];
  let workspaceStatus = 200;
  let workspaceBody: unknown;
  let workspaceDelay = 0;
  const workspaceAuth: string[] = [];
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);

    if (req.method === "GET" && req.url === "/v1/sync/state") {
      workspaceAuth.push(req.headers.authorization ?? "");
      const status = revoked ? 401 : workspaceStatus;
      const body = workspaceBody ?? { workspaces };
      setTimeout(
        () =>
          res
            .writeHead(status, { "Content-Type": "application/json" })
            .end(JSON.stringify(body)),
        workspaceDelay,
      );
      return;
    }

    if (req.method === "POST" && req.url === "/v1/sync/state/workspace") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const json = (status: number, body: unknown) =>
          res
            .writeHead(status, { "Content-Type": "application/json" })
            .end(JSON.stringify(body));
        if (revoked) return json(401, { error: "revoked" });
        if (createMissing) return json(404, { error: "not found" });
        const input = JSON.parse(raw || "{}") as {
          slug?: string;
          name?: string;
        };
        if (!input.slug || !input.name)
          return json(400, { error: "a slug and a name are required" });
        const clash = workspaces.find((entry) => entry.slug === input.slug);
        if (clash) return json(409, { error: "taken", id: clash.id });
        const created = {
          id: `ws-${input.slug}`,
          slug: input.slug,
          name: input.name,
          path: null,
          baseBranch: null,
        };
        // The account's list really grows, so the app's next read sees it —
        // which is what makes "created and opened" testable end to end.
        workspaces = [...workspaces, created];
        return json(201, { workspace: created });
      });
      return;
    }

    // The board surface, enough of it to drive the desktop end to end.
    const board = /^\/v1\/boards\/([^/?]+)(\/[^?]*)?/.exec(req.url ?? "");
    if (board && !revoked) {
      const state = boards.get(board[1]);
      const rest = (board[2] ?? "").split("?")[0];
      if (boardOffline || !state) {
        res
          .writeHead(boardOffline ? 503 : 404, {
            "Content-Type": "application/json",
          })
          .end(JSON.stringify({ error: "not found" }));
        return;
      }
      const json = (status: number, body: unknown) =>
        res
          .writeHead(status, { "Content-Type": "application/json" })
          .end(JSON.stringify(body));

      if (req.method === "GET" && rest === "/config") {
        json(200, {
          board: {
            workspaceId: board[1],
            migratedAt: state.migratedAt,
            columns: state.columns.map((column, position) => ({
              ...column,
              role: column.role ?? null,
              icon: "circle-dashed",
              tone: "neutral",
              position,
            })),
            categories: [],
          },
        });
        return;
      }
      if (req.method === "GET" && rest === "/items") {
        json(200, { items: state.cards, cursor: null });
        return;
      }
      if (req.method === "PUT" && rest === "/config") {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          const body = JSON.parse(raw || "{}") as {
            columns?: unknown[];
            categories?: unknown[];
            tags?: { max?: number };
          };
          pushedConfig = {
            columns: body.columns?.length ?? 0,
            categories: body.categories?.length ?? 0,
            tagMax: body.tags?.max ?? 0,
          };
          json(200, { board: { workspaceId: board[1] } });
        });
        return;
      }
      if (req.method === "POST" && rest === "/import") {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          if (importBroken) return json(503, { error: "unavailable" });
          const body = JSON.parse(raw || "{}") as {
            records?: {
              source?: { ref?: string };
              columnKey?: string;
              restore?: { checklist?: unknown[] };
            }[];
          };
          const receipts = (body.records ?? []).map((record) => {
            imported.push({
              ref: record.source?.ref ?? "?",
              columnKey: record.columnKey ?? "?",
              checklist: record.restore?.checklist?.length ?? 0,
            });
            return { ref: record.source?.ref ?? "?", status: "imported" };
          });
          json(200, {
            receipts,
            summary: { imported: receipts.length },
          });
        });
        return;
      }
      if (req.method === "POST" && rest === "/migrated") {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          const body = JSON.parse(raw || "{}") as {
            items?: number;
            manifest?: string;
          };
          sealed.push({
            items: body.items ?? 0,
            manifest: body.manifest ?? "",
          });
          // ⚠️ The real service COUNTS its own table and refuses a mismatch
          // with both numbers, which is the case the app has to report
          // verbatim rather than smooth over.
          if (sealMismatch !== null)
            return json(409, {
              error: "the board does not hold what the import reported",
              expected: body.items ?? 0,
              actual: sealMismatch,
            });
          state.migratedAt = "2026-09-08T07:00:00.000Z";
          json(200, {
            migratedAt: state.migratedAt,
            items: body.items ?? 0,
          });
        });
        return;
      }
      const move = /^\/items\/([^/]+)\/move$/.exec(rest);
      if (req.method === "POST" && move) {
        const card = state.cards.find((entry) => entry.id === move[1]);
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          if (!card) return json(404, { error: "not found" });
          const parsed = JSON.parse(raw || "{}") as { columnKey?: string };
          card.columnKey = parsed.columnKey ?? card.columnKey;
          card.revision += 1;
          json(200, { item: card });
        });
        return;
      }
      const toggle = /^\/items\/([^/]+)\/checklist\/([^/]+)$/.exec(rest);
      if (req.method === "PATCH" && toggle) {
        boardPreconditions.push(req.headers["if-match"] ?? "");
        const card = state.cards.find((entry) => entry.id === toggle[1]);
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          if (!card) return json(404, { error: "not found" });
          if (checklistConflict) {
            // What the real 409 carries: the card as it stands NOW, so the app
            // can show both sides rather than only "you are out of date".
            return json(409, {
              error: "that card changed since you read it",
              revision: card.revision + 1,
              item: { ...card, revision: card.revision + 1 },
            });
          }
          const parsed = JSON.parse(raw || "{}") as { checked?: boolean };
          const item = card.checklist?.find(
            (entry) => entry.key === decodeURIComponent(toggle[2]),
          );
          if (item) item.checked = parsed.checked ?? item.checked;
          card.revision += 1;
          json(200, { item: card });
        });
        return;
      }
      if (req.method === "POST" && rest === "/items") {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(raw || "{}") as { title?: string };
          const card: StubCard = {
            id: `card-${state.cards.length + 1}`,
            revision: 1,
            title: parsed.title ?? "Untitled",
            body: "",
            columnKey: state.columns[0]?.key ?? "todo",
            categoryKey: null,
            taskId: null,
            priority: null,
            tags: [],
            rank: `V${state.cards.length}`,
            createdAt: null,
            updatedAt: null,
            checklist: [],
          };
          state.cards.push(card);
          json(201, { item: card });
        });
        return;
      }
      json(404, { error: "not found" });
      return;
    }

    // What sign-out calls. Revoking is the server's doing, not a local delete.
    if (req.method === "DELETE" && req.url === "/v1/machines/me") {
      revoked = true;
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ revoked: "test-machine" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/machines/me" && !revoked) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          machineId: "test-machine",
          name: "test-machine",
          userId: "test-user",
          // The owner block the real control plane now returns from this route.
          ...(options.owner === false
            ? {}
            : {
                user: {
                  name: "Test Person",
                  email: "test@example.test",
                  image: null,
                },
              }),
        }),
      );
      return;
    }
    res
      .writeHead(revoked ? 401 : 404, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "unknown or revoked machine" }));
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    workspaceAuth,
    setWorkspaces: (value) => {
      workspaces = value;
      workspaceStatus = 200;
      workspaceBody = undefined;
      workspaceDelay = 0;
    },
    setBoard: (workspaceId, board) => {
      boards.set(workspaceId, {
        migratedAt: board.migratedAt ?? null,
        columns: board.columns,
        cards: board.cards,
      });
    },
    setChecklistConflict: (value) => {
      checklistConflict = value;
    },
    setBoardOffline: (value) => {
      boardOffline = value;
    },
    setCreateMissing: (value) => {
      createMissing = value;
    },
    imported,
    get pushedConfig() {
      return pushedConfig;
    },
    setImportBroken: (value) => {
      importBroken = value;
    },
    sealed,
    setSealMismatch: (value) => {
      sealMismatch = value;
    },
    boardPreconditions,
    setWorkspaceResponse: (status, body, delayMs = 0) => {
      workspaceStatus = status;
      workspaceBody = body;
      workspaceDelay = delayMs;
    },
    setRevoked: (value) => {
      revoked = value;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Delete a launch profile, tolerating Electron's parting writes.
 *
 * ⚠️ `maxRetries` is the whole point. Electron keeps flushing `GPUCache` for a
 * moment after its process has exited, so a bare `rm` loses the race and throws
 * `ENOTEMPTY` — out of a `finally`, which turns a passing test red for reasons
 * that have nothing to do with what it tested.
 */
export async function removeProfile(...dirs: string[]): Promise<void> {
  for (const dir of dirs)
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 120,
    }).catch(() => {});
}
