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
/** Lane looks by role, mirroring the board's own defaults. */
const LANE_LOOK: Record<string, { icon: string; tone: string }> = {
  intake: { icon: "idea", tone: "violet" },
  start: { icon: "circle-dashed", tone: "amber" },
  active: { icon: "progress", tone: "blue" },
  done: { icon: "check", tone: "emerald" },
  archive: { icon: "archive", tone: "neutral" },
};

export interface StubCategory {
  key: string;
  name: string;
  prefix: string;
  tone: string;
}

export interface StubCard {
  id: string;
  revision: number;
  /** The board's change cursor for this card. Set by the stub on every write. */
  seq?: number;
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
    group?: string | null;
  }[];
}

/**
 * The `{ done, total }` the real `GET /items` states for every card.
 *
 * ⚠️ `{ 0, 0 }` for a card with no checklist, never a missing key — the API
 * counts what it can always count, and a stub that answered `undefined` here
 * would let the desktop's "service too old to send it" branch pass as the
 * normal case in every test.
 */
function summarize(checklist: StubCard["checklist"]) {
  return {
    done: (checklist ?? []).filter((item) => item.checked).length,
    total: (checklist ?? []).length,
  };
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
      categories?: StubCategory[];
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
      categories: StubCategory[];
      cards: StubCard[];
      /** Monotonic per board, the way `changeSeq` is on a real one. */
      seq: number;
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

    // ⚠️ The machine surface's DELETE, which answers 200 whether or not the
    // row was there: "already gone" and "just deleted" are the same state to a
    // caller, and the real service is deliberately built that way.
    //
    // ⚠️ Keyed by ID, and a SLUG is refused with a 400 — the same answer the
    // service gives, and the reason this route changed keyspace. The real
    // validator checks the uuid shape, which a uuid-shaped slug would pass, so
    // the old slug-keyed route met a mistaken id by deleting nothing and
    // replying 200. These fixture ids are readable rather than uuids, so the
    // stub catches the one mix-up a test can actually make: a key that names a
    // row by its slug.
    if (
      req.method === "DELETE" &&
      req.url?.startsWith("/v1/sync/state/workspace/")
    ) {
      const key = decodeURIComponent(
        req.url.slice("/v1/sync/state/workspace/".length),
      );
      const json = (status: number, body: unknown) =>
        res
          .writeHead(status, { "Content-Type": "application/json" })
          .end(JSON.stringify(body));
      if (revoked) {
        json(401, { error: "revoked" });
        return;
      }
      const gone = workspaces.find((entry) => entry.id === key) ?? null;
      if (!gone && workspaces.some((entry) => entry.slug === key)) {
        json(400, { error: "a workspace id is required, not a slug" });
        return;
      }
      workspaces = workspaces.filter((entry) => entry.id !== key);
      // The SLUG comes back, not the id the caller already sent: it is the one
      // fact a registry keyed by slug may not have.
      json(200, { deleted: gone?.slug ?? null, id: key });
      return;
    }

    // ⚠️ The machine surface's RENAME, keyed by ID as the DELETE above now is
    // too. The stub refuses the other keyspace on both for the same reason: a
    // uuid matches the real service's slug shape, so a stub that accepted either
    // key would let a client that mixed the two up pass green and, in
    // production, quietly do nothing.
    if (
      req.method === "PATCH" &&
      req.url?.startsWith("/v1/sync/state/workspace/")
    ) {
      const id = decodeURIComponent(
        req.url.slice("/v1/sync/state/workspace/".length),
      );
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
        const input = JSON.parse(raw || "{}") as {
          name?: string;
          slug?: string;
        };
        // Refused rather than ignored, as the real validator does: accepting the
        // field and dropping it would report a rename that did not happen.
        if ("slug" in input)
          return json(400, { error: "slug cannot be changed" });
        const name = input.name?.trim();
        if (!name) return json(400, { error: "name must be 1-200 characters" });
        const target = workspaces.find((entry) => entry.id === id);
        if (!target) {
          // The real service checks the uuid SHAPE; these ids are readable, so
          // the stub catches the one mix-up a test can actually make instead.
          return workspaces.some((entry) => entry.slug === id)
            ? json(400, { error: "a workspace id is required, not a slug" })
            : json(404, { error: "not found" });
        }
        // The account's list really changes, so the app's next read sees the new
        // name — and the SLUG stays put, which is the fact the app relies on.
        workspaces = workspaces.map((entry) =>
          entry.id === id ? { ...entry, name } : entry,
        );
        return json(200, {
          workspace: {
            id: target.id,
            slug: target.slug,
            name,
            baseBranch: target.baseBranch,
          },
        });
      });
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
            // ⚠️ A lane's icon and tone follow its ROLE, as the board's own
            // defaults do. The stub used to send `circle-dashed`/`neutral` for
            // every lane, which made a board of five identical grey circles
            // look correct in every test.
            columns: state.columns.map((column, position) => ({
              ...column,
              role: column.role ?? null,
              icon: LANE_LOOK[column.role ?? ""]?.icon ?? "circle-dashed",
              tone: LANE_LOOK[column.role ?? ""]?.tone ?? "neutral",
              position,
            })),
            categories: state.categories,
          },
        });
        return;
      }
      if (req.method === "GET" && rest === "/items") {
        // ⚠️ WITHOUT the checklist, because the real `GET /items` serializes
        // without `parts`. This stub used to send it, and that is exactly how
        // the app shipped a board whose checkboxes could never appear: the
        // fixture was more generous than the API it stood in for. A card's
        // parts are read one card at a time, below.
        //
        // ⚠️ WITH `checklistProgress`, because the real route does send that —
        // the cheap count is the whole reason a lane can draw `3/7` while the
        // rows themselves stay behind a single-card read. Stripping both would
        // make this fixture STINGIER than the API, which fails the same way
        // round the other side: dead UI that every test says is fine.
        json(200, {
          // ⚠️ Ordered by (column, rank, id), the way the real route's
          // `orderBy` is. A stub that answered in insertion order would let a
          // reorder that never touched the rank pass as green — which is
          // precisely the bug `placement` exists to prevent.
          items: [...state.cards]
            .sort(
              (a, b) =>
                a.columnKey.localeCompare(b.columnKey) ||
                a.rank.localeCompare(b.rank) ||
                a.id.localeCompare(b.id),
            )
            .map(({ checklist, ...card }) => ({
              ...card,
              checklistProgress: summarize(checklist),
            })),
          cursor: null,
          head: state.seq,
        });
        return;
      }
      if (req.method === "GET" && rest === "/changes") {
        const since = Number(
          new URL(req.url ?? "", "http://x").searchParams.get("since") ?? "0",
        );
        json(200, {
          head: state.seq,
          // The server's own cursor, never `since + 1`: the feed is monotonic
          // but not contiguous.
          nextSince: state.seq,
          hasMore: false,
          // Ordered by seq, ascending — a change feed's only useful order.
          items: [...state.cards]
            .filter((card) => (card.seq ?? 0) > since)
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            .map(({ checklist, ...card }) => ({
              ...card,
              checklistProgress: summarize(checklist),
            })),
          events: [],
        });
        return;
      }
      const lookup = rest === "/lookup";
      if (req.method === "GET" && lookup) {
        const taskId = new URL(req.url ?? "", "http://x").searchParams.get(
          "taskId",
        );
        const card = state.cards.find((entry) => entry.taskId === taskId);
        // A 404 where the list route would answer `[]` — the distinction the
        // real route exists to make.
        if (!card)
          return json(404, {
            error: "no card on this board carries that identity",
          });
        return json(200, { item: card });
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
          const parsed = JSON.parse(raw || "{}") as {
            columnKey?: string;
            placement?: { after?: string; before?: string };
          };
          card.columnKey = parsed.columnKey ?? card.columnKey;
          // ⚠️ The RANK is what the client sorts on, so a placement has to
          // change it — a stub that accepted `placement` and left the rank
          // alone would let a broken reorder pass as green.
          const neighbour = parsed.placement?.after ?? parsed.placement?.before;
          if (neighbour) {
            const lane = state.cards
              .filter(
                (entry) =>
                  entry.columnKey === card.columnKey && entry.id !== card.id,
              )
              .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
            const at = lane.findIndex((entry) => entry.id === neighbour);
            if (at !== -1)
              lane.splice(parsed.placement?.after ? at + 1 : at, 0, card);
            else lane.push(card);
            lane.forEach((entry, index) => {
              entry.rank = String(index + 1).padStart(4, "0");
            });
          }
          card.revision += 1;
          card.seq = ++state.seq;
          json(200, { item: card });
        });
        return;
      }
      const one = /^\/items\/([^/]+)$/.exec(rest);
      if (req.method === "GET" && one) {
        const card = state.cards.find((entry) => entry.id === one[1]);
        // WITH its parts — the read that can answer "what are this card's
        // decisions", which the list deliberately cannot. The summary rides
        // along too, exactly as the real route states it: one shape everywhere,
        // so a client never computes the same fraction two different ways.
        if (!card) return json(404, { error: "not found" });
        return json(200, {
          item: { ...card, checklistProgress: summarize(card.checklist) },
        });
      }
      if (req.method === "PATCH" && one) {
        const precondition = req.headers["if-match"];
        boardPreconditions.push(precondition ?? "");
        const card = state.cards.find((entry) => entry.id === one[1]);
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          if (!card) return json(404, { error: "not found" });
          // ⚠️ 428 before anything else, exactly as the API does. An edit with
          // no precondition is refused rather than applied: this endpoint
          // rewrites text a human wrote.
          if (precondition === undefined)
            return json(428, {
              error: "If-Match with the revision you read is required",
            });
          if (Number(precondition) !== card.revision)
            return json(409, {
              error: "that card changed since you read it",
              item: { ...card, revision: card.revision + 1 },
            });
          const parsed = JSON.parse(raw || "{}") as {
            title?: string;
            body?: string;
            priority?: StubCard["priority"];
            tags?: string[];
            categoryKey?: string | null;
          };
          if (parsed.title !== undefined) card.title = parsed.title;
          if (parsed.body !== undefined) card.body = parsed.body;
          if (parsed.priority !== undefined) card.priority = parsed.priority;
          if (parsed.categoryKey !== undefined)
            card.categoryKey = parsed.categoryKey;
          if (parsed.tags !== undefined)
            // The board's own policy: normalize, de-duplicate, cap at three.
            card.tags = [
              ...new Set(
                parsed.tags.map((tag) =>
                  tag
                    .trim()
                    .toLowerCase()
                    .replace(/[\s_]+/g, "-"),
                ),
              ),
            ].slice(0, 3);
          card.revision += 1;
          card.seq = ++state.seq;
          json(200, { item: card });
        });
        return;
      }
      const replace = /^\/items\/([^/]+)\/checklist$/.exec(rest);
      if (req.method === "PUT" && replace) {
        const precondition = req.headers["if-match"];
        boardPreconditions.push(precondition ?? "");
        const card = state.cards.find((entry) => entry.id === replace[1]);
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          if (!card) return json(404, { error: "not found" });
          if (precondition === undefined)
            return json(428, {
              error: "If-Match with the revision you read is required",
            });
          if (Number(precondition) !== card.revision)
            return json(409, {
              error: "that card changed since you read it",
              item: { ...card, revision: card.revision + 1 },
            });
          const parsed = JSON.parse(raw || "{}") as {
            items?: {
              key?: string | null;
              section?: string;
              text: string;
              checked?: boolean;
              note?: string | null;
              group?: string | null;
            }[];
          };
          // ⚠️ Ticked boxes are matched BY KEY and survive the rewrite, which is
          // the whole reason `key` travels on the way in. A stub that re-created
          // every row unticked would let a rewrite that silently clears the
          // board's approvals pass as green.
          const before = new Map(
            (card.checklist ?? []).map((row) => [row.key, row.checkedAt]),
          );
          let minted = 0;
          card.checklist = (parsed.items ?? []).map((item) => {
            const key = item.key ?? `N${++minted}`;
            const checkedAt =
              item.checked === undefined
                ? (before.get(key) ?? null)
                : item.checked
                  ? (before.get(key) ?? "2026-09-08T09:00:00.000Z")
                  : null;
            return {
              key,
              section: item.section ?? "decisions",
              text: item.text,
              checked: checkedAt !== null,
              checkedAt,
              note: item.note ?? null,
              group: item.group ?? null,
            };
          });
          card.revision += 1;
          card.seq = ++state.seq;
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
          card.seq = ++state.seq;
          json(200, { item: card });
        });
        return;
      }
      // ⚠️ The service ARCHIVES rather than dropping the row, and answers 200
      // whether or not it was already archived. The stub splices instead — it
      // has no archived view to show — but it keeps the two facts that matter to
      // a client: the card stops coming back from `/items`, and a second delete
      // still succeeds.
      if (req.method === "DELETE" && /^\/items\/[^/]+$/.test(rest)) {
        const id = rest.slice("/items/".length);
        state.cards = state.cards.filter((entry) => entry.id !== id);
        state.seq += 1;
        json(200, { archived: id, seq: state.seq });
        return;
      }
      if (req.method === "POST" && rest === "/items") {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(raw || "{}") as {
            title?: string;
            body?: string;
            columnKey?: string;
            categoryKey?: string;
            priority?: StubCard["priority"];
            tags?: string[];
          };
          const category =
            state.categories.find(
              (entry) => entry.key === parsed.categoryKey,
            ) ?? null;
          // ⚠️ The KEY is minted here, and only from a category — exactly as the
          // service does (`boards.ts`: `category && taskSeq !== null`). A stub
          // that handed out a task id regardless would hide the whole reason the
          // composer asks for a category: without one there is no `FE-06`, and
          // nothing can deep-link to or ⌘K its way to the card.
          const seq =
            state.cards.filter((entry) => entry.categoryKey === category?.key)
              .length + 1;
          const card: StubCard = {
            id: `card-${state.cards.length + 1}`,
            revision: 1,
            title: parsed.title ?? "Untitled",
            body: parsed.body ?? "",
            // The board's own first lane when the caller named none, which is
            // the default the service applies.
            columnKey: parsed.columnKey ?? state.columns[0]?.key ?? "todo",
            categoryKey: category?.key ?? null,
            taskId: category
              ? `${category.prefix}-${String(seq).padStart(2, "0")}`
              : null,
            priority: parsed.priority ?? null,
            // ⚠️ Capped at 3, as the real board caps silently. The write reports
            // what it dropped, and a stub with no cap would leave that path
            // untested on the one screen that can send four tags.
            tags: (parsed.tags ?? []).slice(0, 3),
            rank: `V${state.cards.length}`,
            createdAt: null,
            updatedAt: null,
            checklist: [],
            seq: ++state.seq,
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
        categories: board.categories ?? [],
        // Every seeded card starts at seq 1, so `changes?since=0` returns the
        // whole board — which is what a real first poll does.
        cards: board.cards.map((card) => ({ seq: 1, ...card })),
        seq: 1,
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
