import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { matchesSearch, type Workspace } from "../shared/workspaces";

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
 * Where a launched app may read and write the coding agents' own config
 * (FE-28, FE-29): Claude Code's settings, Codex's hooks.json / config.toml,
 * and the hook's credential — all inside `profile`.
 *
 * ⚠️ EVERY launch needs this, including one that builds its env by hand. The
 * app rewrites these files at startup, and a launch that skipped it once
 * pointed a developer's real `~/.claude` and `~/.codex` hooks at a temp dir
 * the test then deleted.
 */
export function agentConfigEnv(profile: string): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: join(profile, "claude"),
    CODEX_HOME: join(profile, "codex"),
    LANEWORK_HOOK_SECRET_FILE: join(profile, "hook-secret"),
  };
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
    ...agentConfigEnv(options.profile),
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
  /** Set by the stub's DELETE: the card is a tombstone from then on. */
  archivedAt?: string | null;
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
  parentId?: string | null;
  assignees?: { users: string[]; agents: string[] };
  /**
   * The per-reader state, and the thread.
   *
   * ⚠️ Served ONLY from the single-card read, the same way the real service
   * does. A stub that put them on `GET /items` too would let the desktop's
   * "absent means not asked" branch pass as the normal case in every test —
   * exactly the failure `checklist` here is commented against.
   */
  subscribers?: string[];
  favorite?: boolean;
  attachments?: {
    id: string;
    name: string;
    reference: string;
    mimeType?: string | null;
    sizeBytes?: number | null;
  }[];
  comments?: StubComment[];
}

export interface StubComment {
  id: string;
  authorUserId: string;
  body: string;
  at: string;
  editedAt?: string | null;
  deletedAt?: string | null;
}

export interface StubLabel {
  key: string;
  name: string;
  tone: string;
}

/** One row of `GET /presence` (BE-16), as the real route serializes it. */
export interface StubPresence {
  workItemId: string;
  userId: string;
  agent: string;
  machineId?: string | null;
  lastSeenAt: string;
}

export interface StubMember {
  userId: string;
  name: string;
  image?: string | null;
  role?: string;
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

/**
 * Whether a card matches the list's filters, the way the real route reads
 * them — `none` included, for the "No priority" and "No category" groups.
 */
function matches(card: StubCard, query: URLSearchParams): boolean {
  const column = query.get("column");
  const category = query.get("category");
  const priority = query.get("priority");
  const tag = query.get("tag");
  const q = query.get("q");
  return (
    // FE-18's search, by the same prefix rule the FTS query and the app use.
    (!q || matchesSearch(card, q)) &&
    (!column || card.columnKey === column) &&
    (!category ||
      (category === "none"
        ? card.categoryKey === null
        : card.categoryKey === category)) &&
    (!priority ||
      (priority === "none"
        ? card.priority === null
        : card.priority === priority)) &&
    (!tag || card.tags.includes(tag))
  );
}

/**
 * One page of `GET /items`: filtered, ordered by (column, rank, id), and cut at
 * `limit` with an opaque cursor — the way the real route pages (FE-17). Without
 * a `limit` it still answers at most 50, the service's default.
 */
function listPage(cards: StubCard[], url: string) {
  const query = new URL(url, "http://x").searchParams;
  const limit = Math.min(Number(query.get("limit") ?? "50") || 50, 200);
  const offset = Number(query.get("cursor")?.replace(/^o:/, "") ?? "0") || 0;
  const live = cards
    .filter((card) => !card.archivedAt && matches(card, query))
    .sort(
      (a, b) =>
        a.columnKey.localeCompare(b.columnKey) ||
        a.rank.localeCompare(b.rank) ||
        a.id.localeCompare(b.id),
    );
  const page = live.slice(offset, offset + limit);
  return {
    items: page.map(({ checklist, ...card }) => ({
      ...card,
      checklistProgress: summarize(checklist),
    })),
    cursor: offset + limit < live.length ? `o:${offset + limit}` : null,
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
      labels?: StubLabel[];
      members?: StubMember[];
      cards: StubCard[];
    },
  ) => void;
  /**
   * A card written by someone else — it lands on the change feed with a new
   * seq, the way another machine's create does.
   */
  addCard: (workspaceId: string, card: StubCard) => void;
  /** One card as the stub now holds it, so a test can assert what a write did. */
  readCard: (workspaceId: string, cardId: string) => StubCard | undefined;
  /** Make the next checklist write answer 409 with the server's copy. */
  setChecklistConflict: (value: boolean) => void;
  /** Fail every board read, so the app has to fall back to its saved copy. */
  setBoardOffline: (value: boolean) => void;
  /**
   * What `GET /v1/boards?repo=` answers (FE-30): the boards linked to any
   * repo, by workspace id. Empty — linked to nothing — until set. `delayMs`
   * holds the answer back, to prove nothing else waits for it.
   */
  setRepoBoards: (
    value: { workspaceId: string; name: string }[],
    delayMs?: number,
  ) => void;
  /**
   * `PUT /v1/boards/:id/repo` (BE-20): the board a call names becomes the one
   * `setRepoBoards` answers. With a repo set here, a call without `replace`
   * gets the 409 a board on a different repo gets, naming it.
   */
  setBoardRepo: (repo: string | null) => void;
  /** Every `PUT /v1/boards/:id/repo` so far, in order. */
  repoMoves: () => { workspaceId: string; repo: string; replace: boolean }[];
  /** Answer `POST /purge` with 404, the way a service older than FE-14 does. */
  setPurgeMissing: (value: boolean) => void;
  /** Answer `GET /stats` with 404, the way a service older than FE-17 does. */
  setStatsMissing: (value: boolean) => void;
  /** The agents `GET /presence` reports on one board (BE-16). */
  setPresence: (workspaceId: string, rows: StubPresence[]) => void;
  /** What `GET /icon` serves for one board (BE-18); null is no icon. */
  setIcon: (
    workspaceId: string,
    icon: { key: string; bytes: Buffer } | null,
  ) => void;
  /**
   * The `latest` of `GET /items/:card/checkpoints` (BE-17, FE-28), keyed by
   * the card's id or task id. Null clears it.
   */
  setCheckpoint: (card: string, latest: Record<string, unknown> | null) => void;
  /** Fail every `GET /items?q=` with 500, so search has to fall back. */
  setSearchFailing: (value: boolean) => void;
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
      labels: StubLabel[];
      members: StubMember[];
      cards: StubCard[];
      /** Monotonic per board, the way `changeSeq` is on a real one. */
      seq: number;
    }
  >();
  // Who the stub's machine credential belongs to — the "me" every per-reader
  // field on a card answers for.
  const VIEWER = "u-viewer";
  let checklistConflict = false;
  let boardOffline = false;
  let repoBoards: { workspaceId: string; name: string }[] = [];
  let repoBoardsDelay = 0;
  let boardRepo: string | null = null;
  const repoMoves: { workspaceId: string; repo: string; replace: boolean }[] =
    [];
  let purgeMissing = false;
  let statsMissing = false;
  // BE-18's icons, by workspace id: the key the service names it by and its bytes.
  const icons = new Map<string, { key: string; bytes: Buffer }>();
  const presence = new Map<string, StubPresence[]>();
  const checkpoints = new Map<string, Record<string, unknown>>();
  let searchFailing = false;
  // Board-level events (`purged`) per board, the way the service keeps them:
  // audit rows with no card, reported by the feed above the client's cursor.
  const boardEvents = new Map<string, { seq: number; verb: string }[]>();
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

    // The owner's project order (FE-32): the list is REWRITTEN in the order
    // given, as the real service's `position` sort answers it. All or nothing,
    // like the service: an id that is not a listed project refuses the body.
    if (req.method === "PUT" && req.url === "/v1/sync/state/workspace-order") {
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
        const { ids } = JSON.parse(raw || "{}") as { ids?: string[] };
        const placed = (ids ?? []).map((id) =>
          workspaces.find((entry) => entry.id === id),
        );
        if (!ids?.length || placed.some((entry) => !entry))
          return json(400, { error: "not every id is one of your projects" });
        const rest = workspaces.filter(
          (entry) => !ids.includes(entry.id ?? ""),
        );
        workspaces = [...(placed as Workspace[]), ...rest];
        json(200, { ids });
      });
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

    // `GET /v1/boards?repo=` — which boards a git remote is linked to (FE-30).
    if (/^\/v1\/boards\/?\?/.test(req.url ?? "") && !revoked) {
      const answer = repoBoards;
      setTimeout(
        () =>
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ repo: null, boards: answer })),
        repoBoardsDelay,
      );
      return;
    }

    // `PUT /v1/boards/:id/repo` — make one board THE board for a repo (BE-20).
    const moving = /^\/v1\/boards\/([^/?]+)\/repo$/.exec(req.url ?? "");
    if (moving && req.method === "PUT" && !revoked) {
      const json = (status: number, body: unknown) =>
        res
          .writeHead(status, { "Content-Type": "application/json" })
          .end(JSON.stringify(body));
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const input = JSON.parse(raw || "{}") as {
          repo: string;
          replace?: boolean;
        };
        const workspaceId = moving[1];
        repoMoves.push({
          workspaceId,
          repo: input.repo,
          replace: input.replace === true,
        });
        if (boardRepo !== null && input.replace !== true)
          return json(409, {
            error: `this board is already linked to ${boardRepo}.`,
            code: "conflict",
            linked: boardRepo,
          });
        const unlinked = repoBoards.filter(
          (row) => row.workspaceId !== workspaceId,
        );
        const name =
          workspaces.find((entry) => entry.id === workspaceId)?.name ??
          workspaceId;
        repoBoards = [{ workspaceId, name }];
        boardRepo = null;
        return json(200, { repo: input.repo, previous: null, unlinked });
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

      /**
       * One card as a SINGLE-card read states it — with its parts.
       *
       * ⚠️ Used by `/lookup` and by every single-card WRITE response too, not
       * only `/items/:id`, because the real service serializes all of them the
       * same way. The stub answered `/lookup` with the bare row for a while, and
       * since a deep link opens a card through `lookup`, every per-reader field
       * arrived absent: the page drew no star and no Unsubscribe, and a fixture
       * stingier than the API had made that look correct.
       */
      const withParts = (entry: StubCard) => ({
        ...entry,
        checklistProgress: summarize(entry.checklist),
        assignees: entry.assignees ?? { users: [], agents: [] },
        subscribers: entry.subscribers ?? [],
        subscribed: (entry.subscribers ?? []).includes(VIEWER),
        favorite: entry.favorite ?? false,
        commentCount: (entry.comments ?? []).filter((c) => !c.deletedAt).length,
        attachments: (entry.attachments ?? []).map((file) => ({
          mimeType: null,
          sizeBytes: null,
          sourceKind: null,
          ...file,
        })),
      });

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
            labels: state.labels.map((label, position) => ({
              ...label,
              position,
            })),
            members: state.members.map((member) => ({
              ...member,
              image: member.image ?? null,
              role: member.role ?? "member",
            })),
          },
        });
        return;
      }
      if (req.method === "GET" && rest === "/items") {
        if (
          searchFailing &&
          new URL(req.url ?? "", "http://x").searchParams.has("q")
        )
          return json(500, { error: "search is down" });
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
          ...listPage(state.cards, req.url ?? ""),
          head: state.seq,
        });
        return;
      }
      // FE-17's counts. Absent (404) while `statsMissing` is set, the way a
      // service older than the route answers — the app then reads the whole
      // board, as it used to.
      // BE-18's icon: 404 for none, 304 for the key the app already holds.
      if (req.method === "GET" && rest === "/icon") {
        const icon = icons.get(board[1]);
        if (!icon) return json(404, { error: "no icon" });
        const headers = {
          "content-type": "image/png",
          etag: `"${icon.key}"`,
          "x-icon-key": icon.key,
        };
        if (req.headers["if-none-match"] === `"${icon.key}"`)
          res.writeHead(304, headers).end();
        else res.writeHead(200, headers).end(icon.bytes);
        return;
      }
      // BE-16's presence: whatever the test seeded, already inside the TTL —
      // the real route filters expired rows before answering.
      if (req.method === "GET" && rest === "/presence") {
        json(200, {
          presence: (presence.get(board[1]) ?? []).map((row) => ({
            machineId: null,
            ...row,
          })),
        });
        return;
      }
      // BE-17's checkpoints, as `latest` — the only part the app reads.
      const checkpointOf = /^\/items\/([^/]+)\/checkpoints$/.exec(rest ?? "");
      if (req.method === "GET" && checkpointOf?.[1]) {
        const latest = checkpoints.get(decodeURIComponent(checkpointOf[1]));
        json(200, {
          checkpoints: latest ? [latest] : [],
          latest: latest ?? null,
        });
        return;
      }
      if (req.method === "GET" && rest === "/stats") {
        if (statsMissing) return json(404, { error: "not found" });
        const query = new URL(req.url ?? "", "http://x").searchParams;
        const counted = state.cards.filter(
          (card) => !card.archivedAt && matches(card, query),
        );
        const tally = (key: (card: StubCard) => string) => {
          const out: Record<string, number> = {};
          for (const card of counted)
            out[key(card)] = (out[key(card)] ?? 0) + 1;
          return out;
        };
        json(200, {
          stats: {
            total: counted.length,
            byColumn: {
              ...Object.fromEntries(state.columns.map((c) => [c.key, 0])),
              ...tally((card) => card.columnKey),
            },
            byCategory: tally((card) => card.categoryKey ?? "none"),
            byPriority: tally((card) => card.priority ?? "none"),
          },
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
          events: (boardEvents.get(board[1]) ?? []).filter(
            (event) => event.seq > since,
          ),
        });
        return;
      }
      // ⚠️ A real removal, unlike the archive below — and the only change the
      // feed can carry for it is the board-level event, exactly as the service
      // does it. `confirm` must be the project's slug, or nothing goes.
      if (req.method === "POST" && rest === "/purge") {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          if (purgeMissing) return json(404, { error: "not found" });
          const slug = workspaces.find((entry) => entry.id === board[1])?.slug;
          const confirm = (JSON.parse(raw || "{}") as { confirm?: unknown })
            .confirm;
          if (!slug || confirm !== slug)
            return json(400, {
              error: "confirm must be this project's slug, exactly",
            });
          const deleted = state.cards.filter((card) => !card.archivedAt).length;
          state.cards = [];
          state.seq += 1;
          boardEvents.set(board[1], [
            ...(boardEvents.get(board[1]) ?? []),
            { seq: state.seq, verb: "purged" },
          ]);
          json(200, { deleted, seq: state.seq });
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
        return json(200, { item: withParts(card) });
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
          json(200, { item: withParts(card) });
        });
        return;
      }
      // ── The card surfaces a person reads ──────────────────────────────────
      //
      // ⚠️ Matched BEFORE `/^\/items\/([^/]+)$/` below, because `/items/x/…` is
      // not that pattern but `rest.startsWith` checks written the other way
      // round would swallow it.
      const social =
        /^\/items\/([^/]+)\/(subscription|favorite|activity|comments)(\/([^/]+))?$/.exec(
          rest,
        );
      if (social) {
        const card = state.cards.find((entry) => entry.id === social[1]);
        if (!card) return json(404, { error: "not found" });
        const what = social[2];
        const commentId = social[4];

        if (what === "subscription" || what === "favorite") {
          const on = req.method === "PUT";
          if (req.method !== "PUT" && req.method !== "DELETE") {
            return json(405, { error: "method not allowed" });
          }
          if (what === "favorite") {
            card.favorite = on;
            return json(200, { favorite: on });
          }
          const following = new Set(card.subscribers ?? []);
          if (on) following.add(VIEWER);
          else following.delete(VIEWER);
          card.subscribers = [...following];
          return json(200, { subscribed: on });
        }

        if (what === "activity" && req.method === "GET") {
          // ⚠️ ONE ordered sequence, the way the real route merges the audit
          // log with the thread. A stub that served the comments alone would
          // let a feed that dropped every audit line pass as green.
          const events = [
            {
              kind: "audit",
              id: `${card.id}-created`,
              seq: 1,
              verb: "created",
              actorKind: "user",
              actorUserId: VIEWER,
              actorMachineId: null,
              diff: null,
              at: card.createdAt ?? new Date(0).toISOString(),
            },
            ...(card.comments ?? []).map((comment) => ({
              kind: "comment",
              id: comment.id,
              authorKind: "user",
              authorRef: comment.authorUserId,
              authorUserId: comment.authorUserId,
              body: comment.deletedAt ? null : comment.body,
              at: comment.at,
              editedAt: comment.deletedAt ? null : (comment.editedAt ?? null),
              deletedAt: comment.deletedAt ?? null,
            })),
          ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
          return json(200, { events, cursor: null });
        }

        if (what === "comments") {
          let raw = "";
          req.on("data", (chunk) => {
            raw += chunk;
          });
          req.on("end", () => {
            const body = JSON.parse(raw || "{}") as { body?: string };
            card.comments = card.comments ?? [];
            if (req.method === "POST") {
              const id = `c-${card.comments.length + 1}`;
              card.comments.push({
                id,
                authorUserId: VIEWER,
                body: body.body ?? "",
                at: new Date().toISOString(),
              });
              // Commenting subscribes you, as the service does.
              card.subscribers = [
                ...new Set([...(card.subscribers ?? []), VIEWER]),
              ];
              return json(201, { comment: { id } });
            }
            const comment = card.comments.find(
              (entry) => entry.id === commentId,
            );
            if (!comment) return json(404, { error: "not found" });
            // Only the author, the way the service decides it.
            if (comment.authorUserId !== VIEWER) {
              return json(403, { error: "only the author may edit a comment" });
            }
            if (req.method === "PATCH") {
              if (comment.deletedAt)
                return json(409, { error: "that comment was deleted" });
              comment.body = body.body ?? comment.body;
              comment.editedAt = new Date().toISOString();
              return json(200, { comment: { id: comment.id } });
            }
            if (req.method === "DELETE") {
              comment.deletedAt = new Date().toISOString();
              return json(200, { deleted: comment.id });
            }
            return json(405, { error: "method not allowed" });
          });
          return;
        }
        return json(405, { error: "method not allowed" });
      }

      const one = /^\/items\/([^/]+)$/.exec(rest);
      if (req.method === "GET" && one) {
        const card = state.cards.find((entry) => entry.id === one[1]);
        // WITH its parts — the read that can answer "what are this card's
        // decisions", which the list deliberately cannot. The summary rides
        // along too, exactly as the real route states it: one shape everywhere,
        // so a client never computes the same fraction two different ways.
        if (!card) return json(404, { error: "not found" });
        // ⚠️ Stated on a single-card read only, as the real route does:
        // `subscribed` and `favorite` answer for the CALLER rather than about
        // the card, so they cannot come off a list.
        return json(200, { item: withParts(card) });
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
            assignees?: { users: string[]; agents: string[] };
          };
          if (parsed.assignees !== undefined) {
            card.assignees = parsed.assignees;
            // Being assigned subscribes you, as the service does — and only for
            // people the board actually knows.
            card.subscribers = [
              ...new Set([
                ...(card.subscribers ?? []),
                ...parsed.assignees.users.filter((id) =>
                  state.members.some((member) => member.userId === id),
                ),
              ]),
            ];
          }
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
          json(200, { item: withParts(card) });
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
          if (checklistConflict)
            return json(409, {
              error: "that card changed since you read it",
              revision: card.revision + 1,
              item: { ...card, revision: card.revision + 1 },
            });
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
          json(200, { item: withParts(card) });
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
          json(200, { item: withParts(card) });
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
        // ⚠️ A TOMBSTONE, as the service keeps: the card stays with
        // `archivedAt` and a new seq, so the change feed reports it — which is
        // the only way another window learns it is gone.
        const gone = state.cards.find((entry) => entry.id === id);
        state.seq += 1;
        if (gone) {
          gone.archivedAt = new Date().toISOString();
          gone.seq = state.seq;
        }
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
          json(201, { item: withParts(card) });
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
    addCard: (workspaceId, card) => {
      const state = boards.get(workspaceId);
      if (!state) throw new Error(`no board seeded for ${workspaceId}`);
      state.cards.push({ ...card, seq: ++state.seq });
    },
    readCard: (workspaceId, cardId) =>
      boards.get(workspaceId)?.cards.find((card) => card.id === cardId),
    setBoard: (workspaceId, board) => {
      boards.set(workspaceId, {
        migratedAt: board.migratedAt ?? null,
        columns: board.columns,
        categories: board.categories ?? [],
        labels: board.labels ?? [],
        members: board.members ?? [
          { userId: VIEWER, name: "Viewer", image: null, role: "owner" },
        ],
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
    setRepoBoards: (value, delayMs = 0) => {
      repoBoards = value;
      repoBoardsDelay = delayMs;
    },
    setBoardRepo: (repo) => {
      boardRepo = repo;
    },
    repoMoves: () => [...repoMoves],
    setSearchFailing: (value) => {
      searchFailing = value;
    },
    setStatsMissing: (value) => {
      statsMissing = value;
    },
    setPresence: (workspaceId, rows) => {
      presence.set(workspaceId, rows);
    },
    setIcon: (workspaceId, icon) => {
      if (icon) icons.set(workspaceId, icon);
      else icons.delete(workspaceId);
    },
    setCheckpoint: (card, latest) => {
      if (latest) checkpoints.set(card, latest);
      else checkpoints.delete(card);
    },
    setPurgeMissing: (value) => {
      purgeMissing = value;
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
