import type {
  BoardCard,
  BoardCategory,
  BoardChecklistItem,
  BoardColumn,
  BoardWrite,
  Workspace,
} from "../../../shared/workspaces";
import { resolveApi } from "../auth/client";
import type { MachineRecord } from "../auth/store";

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate the whole list: a malformed response must never look like no projects. */
export function parseWorkspaces(value: unknown): Workspace[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("workspaces" in value) ||
    !Array.isArray(value.workspaces)
  )
    throw new Error(
      "The service returned an invalid workspace list. Try again.",
    );
  const slugs = new Set<string>();
  return value.workspaces.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new Error("The service returned an invalid workspace. Try again.");
    const row = entry as Record<string, unknown>;
    if (
      !text(row.slug) ||
      !text(row.name) ||
      slugs.has(row.slug) ||
      !(row.path === null || text(row.path)) ||
      !(row.baseBranch === null || text(row.baseBranch))
    )
      throw new Error("The service returned an invalid workspace. Try again.");
    slugs.add(row.slug);
    return {
      // ⚠️ Absent, not invalid, on a control plane older than the field. This
      // parser DID require it for one commit, and the result was every real
      // workspace refused with "invalid workspace" — a strict reader turning a
      // deploy-order problem into a broken app. The board is what needs an id;
      // the list is not.
      id: text(row.id) ? row.id : null,
      slug: row.slug,
      name: row.name,
      path: row.path,
      baseBranch: row.baseBranch,
    };
  });
}

/** One request against the control plane, with this app's error vocabulary. */
async function call(
  record: MachineRecord,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${resolveApi(record.apiUrl)}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${record.secret}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    throw new Error(
      "Could not reach your board. Check your connection and try again.",
    );
  }
  if (response.status === 401)
    throw new Error(
      "This machine no longer has access. Sign in again to load your board.",
    );
  return response;
}

async function body(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("The service returned an invalid response. Try again.");
  }
}

export async function fetchWorkspaces(
  record: MachineRecord,
): Promise<Workspace[]> {
  // ⚠️ `/v1/sync/state`, the MACHINE surface. `/v1/workspaces` is `sessionAuth`
  // end to end and answers this app's credential with 401 by design.
  const response = await call(record, "/v1/sync/state");
  if (!response.ok)
    throw new Error(
      `Could not load your workspaces (HTTP ${response.status}). Try again.`,
    );
  return parseWorkspaces(await body(response));
}

const priority = (value: unknown): BoardCard["priority"] =>
  value === "low" || value === "medium" || value === "high" ? value : null;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => text(entry))
    : [];

function parseChecklist(value: unknown): BoardChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (!text(row.key)) return [];
    return [
      {
        key: row.key,
        section: text(row.section) ? row.section : "decisions",
        text: text(row.text) ? row.text : "",
        checked: row.checked === true,
        checkedAt: text(row.checkedAt) ? row.checkedAt : null,
        note: text(row.note) ? row.note : null,
      },
    ];
  });
}

/**
 * One card.
 *
 * ⚠️ A card whose `id`, `revision` or `columnKey` is missing is DROPPED rather
 * than defaulted. Those three are what an edit is addressed by — a card with a
 * guessed revision would send `If-Match: NaN` and a card with a guessed lane
 * would render in the wrong column — so a malformed row is better absent than
 * plausible.
 */
export function parseCard(value: unknown): BoardCard | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    !text(row.id) ||
    typeof row.revision !== "number" ||
    !Number.isInteger(row.revision) ||
    !text(row.columnKey)
  )
    return null;
  return {
    id: row.id,
    revision: row.revision,
    taskId: text(row.taskId) ? row.taskId : null,
    title: text(row.title) ? row.title : "Untitled",
    body: typeof row.body === "string" ? row.body : "",
    columnKey: row.columnKey,
    categoryKey: text(row.categoryKey) ? row.categoryKey : null,
    priority: priority(row.priority),
    tags: strings(row.tags),
    rank: text(row.rank) ? row.rank : "",
    createdAt: text(row.createdAt) ? row.createdAt : null,
    updatedAt: text(row.updatedAt) ? row.updatedAt : null,
    checklist: parseChecklist(row.checklist),
  };
}

export function parseBoardConfig(value: unknown): {
  columns: BoardColumn[];
  categories: BoardCategory[];
  migratedAt: string | null;
} {
  const board =
    value && typeof value === "object" && "board" in value
      ? ((value as { board: unknown }).board as Record<string, unknown>)
      : null;
  if (!board)
    throw new Error("The service returned an invalid board. Try again.");

  const columns = (Array.isArray(board.columns) ? board.columns : []).flatMap(
    (entry, index) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      if (!text(row.key)) return [];
      return [
        {
          key: row.key,
          name: text(row.name) ? row.name : row.key,
          role: text(row.role) ? row.role : null,
          icon: text(row.icon) ? row.icon : "circle-dashed",
          tone: text(row.tone) ? row.tone : "neutral",
          position: typeof row.position === "number" ? row.position : index,
        },
      ];
    },
  );
  // ⚠️ A board with no lanes cannot be drawn, so an empty list is an error
  // rather than an empty screen — the same call the API's own validator makes.
  if (!columns.length)
    throw new Error("This board has no columns. Open it on the web to fix it.");

  const categories = (
    Array.isArray(board.categories) ? board.categories : []
  ).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (!text(row.key)) return [];
    return [
      {
        key: row.key,
        name: text(row.name) ? row.name : row.key,
        prefix: text(row.prefix) ? row.prefix : "",
        tone: text(row.tone) ? row.tone : "neutral",
      },
    ];
  });

  return {
    columns: [...columns].sort((a, b) => a.position - b.position),
    categories,
    migratedAt: text(board.migratedAt) ? board.migratedAt : null,
  };
}

/** Every card on a board, following the cursor rather than one page. */
export async function fetchCards(
  record: MachineRecord,
  workspaceId: string,
): Promise<BoardCard[]> {
  const cards: BoardCard[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const response = await call(
      record,
      `/v1/boards/${workspaceId}/items?limit=200${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    if (!response.ok)
      throw new Error(
        `Could not load this board (HTTP ${response.status}). Try again.`,
      );
    const payload = (await body(response)) as {
      items?: unknown[];
      cursor?: unknown;
    };
    for (const entry of payload.items ?? []) {
      const card = parseCard(entry);
      if (card) cards.push(card);
    }
    cursor = text(payload.cursor) ? payload.cursor : null;
    if (!cursor) break;
  }
  return cards;
}

export async function fetchBoardConfig(
  record: MachineRecord,
  workspaceId: string,
): Promise<ReturnType<typeof parseBoardConfig>> {
  const response = await call(record, `/v1/boards/${workspaceId}/config`);
  if (!response.ok)
    throw new Error(
      `Could not load this board (HTTP ${response.status}). Try again.`,
    );
  return parseBoardConfig(await body(response));
}

/**
 * Turn a write response into something the UI can act on.
 *
 * ⚠️ A 409 becomes a `conflict` carrying the server's own copy of the card, not
 * an error string. The API sends the card back for exactly this reason, and a
 * dialog that can show both sides is the difference between "try again" and a
 * user deciding which version is right.
 *
 * ⚠️ There is deliberately NO automatic retry here, unlike the agent-facing
 * path. A person is looking at this card; silently replaying their edit on top
 * of somebody else's is the one outcome nobody asked for.
 */
async function readWrite(response: Response): Promise<BoardWrite> {
  const payload = (await body(response)) as {
    item?: unknown;
    error?: unknown;
    revision?: unknown;
  };
  if (response.ok) {
    const card = parseCard(payload.item);
    return card
      ? { kind: "ok", card }
      : { kind: "error", message: "The service returned an invalid card." };
  }
  if (response.status === 409) {
    const current = parseCard(payload.item);
    if (current)
      return {
        kind: "conflict",
        message: text(payload.error)
          ? payload.error
          : "Someone else changed this card.",
        current,
      };
  }
  return {
    kind: "error",
    message: text(payload.error)
      ? payload.error
      : `The board refused the change (HTTP ${response.status}).`,
  };
}

export async function moveCard(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  columnKey: string,
): Promise<BoardWrite> {
  return readWrite(
    await call(record, `/v1/boards/${workspaceId}/items/${cardId}/move`, {
      method: "POST",
      body: JSON.stringify({ columnKey }),
    }),
  );
}

export async function toggleChecklistItem(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  key: string,
  checked: boolean,
  revision: number,
): Promise<BoardWrite> {
  return readWrite(
    await call(
      record,
      `/v1/boards/${workspaceId}/items/${cardId}/checklist/${encodeURIComponent(key)}`,
      {
        method: "PATCH",
        // ⚠️ Sent even though this endpoint treats it as optional: the user is
        // looking at a specific revision of this card, and a tick that lands on
        // a newer one is a decision they did not make.
        headers: { "if-match": String(revision) },
        body: JSON.stringify({ checked }),
      },
    ),
  );
}

export async function createCard(
  record: MachineRecord,
  workspaceId: string,
  title: string,
): Promise<BoardWrite> {
  return readWrite(
    await call(record, `/v1/boards/${workspaceId}/items`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  );
}

/**
 * What a migration would bring over.
 *
 * ⚠️ This app cannot RUN the import: building the records means reading
 * `.agents/reviews/**
 * Create one project on the account.
 *
 * ⚠️ `POST /v1/sync/state/workspace`, the MACHINE surface. `POST /v1/workspaces`
 * is `sessionAuth` and refuses this app's credential by design — the same trap
 * that made the workspace-id resolver 401 on every call until it was moved.
 *
 * ⚠️ A 404 is reported as an out-of-date SERVICE, not as a failure of the
 * request. This route is newer than some deployments, and "could not create the
 * project" would send somebody looking for the mistake in the name they typed.
 */
export async function createWorkspace(
  record: MachineRecord,
  input: { slug: string; name: string },
  // ⚠️ `id` is non-nullable in the RETURN type, unlike `Workspace` itself. A
  // service that just created a project on request has no older-shape excuse
  // for not naming it, and the caller opens its board with that id straight
  // after — a nullable id here would push the check into the caller, which is
  // where it was missed the first time.
): Promise<Workspace & { id: string }> {
  const response = await call(record, "/v1/sync/state/workspace", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (response.status === 404)
    throw new Error(
      "This Lanework service cannot create projects yet. Update it, then try again.",
    );
  if (response.status === 409)
    throw new Error(
      `Another project on your account already uses the key “${input.slug}”. Try a different name.`,
    );
  if (response.status === 400)
    throw new Error("That name cannot be used. Try letters and numbers.");
  if (!response.ok)
    throw new Error("Could not create that project. Try again.");

  const payload = await body(response);
  if (
    !payload ||
    typeof payload !== "object" ||
    !("workspace" in payload) ||
    !payload.workspace ||
    typeof payload.workspace !== "object"
  )
    throw new Error("The service returned an invalid workspace. Try again.");
  const row = payload.workspace as Record<string, unknown>;
  // ⚠️ Validated as strictly as a listed row, and the id is REQUIRED here
  // unlike in `parseWorkspaces`: a service that just created a project on
  // request has no older-shape excuse for not naming it, and the id is what the
  // next call — opening its board — is addressed by.
  if (!text(row.id) || !text(row.slug) || !text(row.name))
    throw new Error("The service returned an invalid workspace. Try again.");
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    path: text(row.path) ? (row.path as string) : null,
    baseBranch: text(row.baseBranch) ? (row.baseBranch as string) : null,
  };
}

/**
 * Create or update the board's lanes, categories and tag cap.
 *
 * ⚠️ It goes FIRST in a migration, and the tag cap travels with it: without the
 * cap the cloud's default of 3 would silently drop the fourth tag of every card
 * on a board that raised its own limit.
 */
export async function putBoardConfig(
  record: MachineRecord,
  workspaceId: string,
  config: unknown,
): Promise<void> {
  const response = await call(record, `/v1/boards/${workspaceId}/config`, {
    method: "PUT",
    body: JSON.stringify(config),
  });
  if (!response.ok)
    throw new Error(
      `The board refused its configuration (${response.status}). Nothing was imported.`,
    );
}

/**
 * Send one batch of import records.
 *
 * ⚠️ Returns the server's receipts rather than a boolean. A card the cloud
 * refused — because somebody edited it there — comes back as a `conflict`
 * receipt, and a run reported as a plain success with three conflicts inside it
 * is how a board quietly loses a card.
 */
export async function importRecords(
  record: MachineRecord,
  workspaceId: string,
  records: unknown[],
): Promise<{
  receipts: {
    ref: string;
    status: string;
    taskId?: string | null;
    error?: string;
  }[];
  summary: Record<string, number>;
}> {
  const response = await call(record, `/v1/boards/${workspaceId}/import`, {
    method: "POST",
    body: JSON.stringify({ records }),
  });
  if (!response.ok) {
    // ⚠️ The service's OWN reason, and the file it is about. Reporting only
    // "refused (400)" is what turned a card with one over-long checklist item
    // into a dead button: the API had named the record and the item, and this
    // client threw the explanation away. `records[N]` indexes the batch that
    // was just sent, which is this array.
    const detail = (
      (await body(response).catch(() => null)) as {
        error?: string;
      } | null
    )?.error;
    const index = detail?.match(/records\[(\d+)\]/)?.[1];
    const named =
      index === undefined
        ? undefined
        : (records[Number(index)] as { source?: { ref?: string } } | undefined)
            ?.source?.ref;
    throw new Error(
      [
        `The board refused ${records.length} record(s) (${response.status}).`,
        named ? `In ${named}:` : "",
        detail ?? "",
        "Records already accepted are on the board; run it again to continue.",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  const payload = (await body(response)) as {
    receipts?: {
      ref: string;
      status: string;
      taskId?: string | null;
      error?: string;
    }[];
    summary?: Record<string, number>;
  };
  return { receipts: payload.receipts ?? [], summary: payload.summary ?? {} };
}

/**
 * Seal the cutover: the cloud owns these cards from now on.
 *
 * ⚠️ The server COUNTS before it agrees, and a mismatch is a 409 naming both
 * numbers — which this reports verbatim. "Migrated" must never come to mean
 * "somebody clicked a button": every local writer goes read-only on the
 * strength of this flag.
 */
export async function sealBoardMigration(
  record: MachineRecord,
  workspaceId: string,
  items: number,
  manifest: string,
): Promise<{ migratedAt: string | null; error?: string }> {
  const response = await call(record, `/v1/boards/${workspaceId}/migrated`, {
    method: "POST",
    body: JSON.stringify({ items, manifest }),
  });
  const payload = (await body(response).catch(() => ({}))) as {
    migratedAt?: string;
    error?: string;
    expected?: number;
    actual?: number;
  };
  if (!response.ok) {
    const counted =
      payload.expected === undefined || payload.actual === undefined
        ? ""
        : ` — the run accounted for ${payload.expected}, the board holds ${payload.actual}`;
    return {
      migratedAt: null,
      error: `${payload.error ?? `the cutover was refused (${response.status})`}${counted}`,
    };
  }
  return { migratedAt: payload.migratedAt ?? null };
}
