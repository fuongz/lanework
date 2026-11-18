// The offline MCP server's tools: the cloud server's 14 board tools, with the
// same names, descriptions and parameters, run against the local SQLite board
// instead of the API. Names, descriptions and parameters live in the tool
// contract (`BOARD_TOOLS` in `@lanework/contracts`); this file holds only what
// each tool does, keyed by name, and must answer `BoardToolOutputs`.
//
// `board_id` is the local project id. There are no accounts, machines,
// members, comments, attachments or subscriptions offline, so those tools do
// not exist here and `assignees.users` is accepted and ignored.
//
// NOTE: `search_sessions` (FE-149) moved to lanework-kit (FE-152), with the
// other tools that read this machine's disk. This server serves the board
// only.
//
// NOTE: Keep this layer thin. Every rule a card obeys (task-id minting,
// checklist keys, stream validation, checkpoint trimming, tombstones) lives in
// `../local-store`, which the app also writes through; a rule spelled twice
// here would drift. Only what the cloud does ABOVE its store lives here:
// pick-ONE groups for `review_card`, the lifecycle roll-up, the stream-plan
// checks a card is refused on, and the answer shapes.
//
// NOTE: The answers are the cloud's (`@lanework/contracts` 0.3.0,
// `BoardToolOutputs`; `apps/mcp/src/mcp/tools/` in the cloud repo is the
// reference). Where the cloud reads a value the local store does not keep,
// the closest honest one stands in, each marked `OFFLINE:` below:
// - `head` (board_summary, list_reviews) and `seq` (delete_review) are the
//   store's change counter, `dataVersion()` / the card's `change_seq`;
// - `stale` (board_summary) is 0: there is no presence offline;
// - `retro` (set_status) is never sent: there is no move history offline.
//
// NOTE: Every write goes through the store, which bumps `dataVersion()` in the
// same transaction. The app polls that, so a write around the store never
// shows up in the app.
import {
  BOARD_TOOLS,
  type BoardColumn,
  type BoardToolName,
  type BoardToolOutputs,
  type CardDetail,
  type CardRef,
  type ChecklistItem,
  type ChecklistItemInput,
  type ChecklistItemPatchRequest,
  type CheckpointRequest,
  type Priority,
  type StreamInput,
  type ToolContract,
} from "@lanework/contracts";
import { normalizeStreams, streamWaves } from "../local-store/cards";
import {
  type LocalProject,
  type LocalStore,
  LocalStoreError,
  normalizeRepo,
} from "../local-store/index";

export interface ToolContext {
  store: LocalStore;
  /** The writer's agent slug from the client's `initialize`: `claude-code`. */
  agent: string;
  /** This machine's name, where every offline checkpoint was written. */
  host: string;
}

type Run<Name extends BoardToolName> = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => BoardToolOutputs[Name];

/** A board tool's contract and what it does. */
export interface ToolSpec extends ToolContract<BoardToolName> {
  run(args: Record<string, unknown>, ctx: ToolContext): unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fail(
  code: "not_found" | "invalid" | "conflict",
  message: string,
): never {
  throw new LocalStoreError(code, message);
}

function boardOf(store: LocalStore, boardId: unknown): LocalProject {
  const project = store.getProject(String(boardId));
  if (!project)
    fail(
      "not_found",
      `board ${String(boardId)} not found; call list_boards for its id`,
    );
  return project;
}

function cardOf(store: LocalStore, board: LocalProject, card: unknown) {
  const detail = store.getWorkItem(String(card), { project: board.id });
  if (!detail)
    fail("not_found", `card ${String(card)} not found on this board`);
  return detail;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The start lane, where `create_review` lands a card when none is named. */
function startColumn(board: LocalProject): string | undefined {
  return board.config.columns.find((column) => column.role === "start")?.key;
}

function columnOrder(board: LocalProject): Map<string, BoardColumn> {
  return new Map(board.config.columns.map((column) => [column.key, column]));
}

/**
 * The BE-19 plan rules the cloud refuses a card on, beyond what the store
 * already checks (shape, unique keys and owners, known dependencies, cycles):
 * at most 4 streams per wave, and a verify item tagged with every stream.
 */
function checkStreamPlan(
  streams: StreamInput[] | undefined,
  checklist: { section?: string | null; stream?: string | null }[],
): void {
  if (!streams || streams.length === 0) return;
  const normalized = normalizeStreams(streams);
  for (const wave of streamWaves(normalized))
    if (wave.length > 4)
      fail(
        "invalid",
        `a wave runs at most 4 streams; ${wave.join(", ")} would run at once`,
      );
  const proved = new Set(
    checklist
      .filter((item) => item.section === "verify" && item.stream)
      .map((item) => item.stream),
  );
  const unproved = normalized
    .map((stream) => stream.key)
    .filter((key) => !proved.has(key));
  if (unproved.length > 0)
    fail(
      "invalid",
      `every stream needs at least one verify item tagged with its key; untagged: ${unproved.join(", ")}`,
    );
}

/**
 * A checklist in the shape `updateWorkItem` takes back: everything kept, keys
 * included.
 */
function asInput(checklist: ChecklistItem[]): ChecklistItemInput[] {
  return checklist.map((item) => ({
    key: item.key,
    section: item.section,
    text: item.text,
    checked: item.checked,
    note: item.note,
    group: item.group,
    stream: item.stream,
  }));
}

/**
 * The decisions a card still waits on, as the cloud's `openDecisions` names
 * them: an unticked ungrouped decision by its key, a pick-ONE group with no
 * option ticked as `group (D1/D2)`. Empty means work may start.
 */
function openDecisions(checklist: ChecklistItem[]): string[] {
  const open: string[] = [];
  const groups = new Map<string, { keys: string[]; settled: boolean }>();
  for (const item of checklist) {
    if (item.section !== "decisions") continue;
    if (!item.group) {
      if (!item.checked) open.push(item.key);
      continue;
    }
    const group = groups.get(item.group) ?? { keys: [], settled: false };
    group.keys.push(item.key);
    group.settled ||= item.checked;
    groups.set(item.group, group);
  }
  for (const [name, group] of groups)
    if (!group.settled) open.push(`${name} (${group.keys.join("/")})`);
  return open;
}

function ref(card: {
  id: string;
  taskId: string | null;
  title: string;
}): CardRef {
  return { id: card.id, taskId: card.taskId, title: card.title };
}

// ── The tools ───────────────────────────────────────────────────────────────

const RUNS: { [Name in BoardToolName]: Run<Name> } = {
  list_boards(args, { store }) {
    const remote = str(args.repo);
    // As on the cloud: `next` only when `repo` was passed.
    if (remote === undefined) return { boards: store.boardSummaries() };
    const repo = normalizeRepo(remote);
    if (!repo) fail("invalid", `not a git remote: ${remote}`);
    const boards = store.boardSummaries(remote);
    return {
      repo,
      boards,
      next:
        boards.length === 1
          ? "Use this board."
          : boards.length === 0
            ? "No board is linked to this repo. Call list_boards without repo and ask the user which board it belongs to, or whether to create a new one; then link_repo or create_board."
            : "Several boards are linked to this repo. Ask the user which one.",
    };
  },
  create_board(args, { store }) {
    const project = store.createProject({
      name: String(args.name),
      slug: str(args.slug),
      repo: String(args.repo),
    });
    return {
      board_id: project.id,
      name: project.name,
      slug: project.slug,
      // Never null here: `createProject` refuses a remote it cannot read.
      repo: project.repo ?? normalizeRepo(String(args.repo)) ?? "",
    };
  },
  link_repo(args, { store }) {
    const board = boardOf(store, args.board_id);
    const repo = normalizeRepo(String(args.repo));
    if (!repo) fail("invalid", `not a git remote: ${String(args.repo)}`);
    if (board.repo && board.repo !== repo && args.replace !== true)
      fail(
        "conflict",
        `board is linked to ${board.repo}; pass replace: true only if the user asked to move it`,
      );
    store.linkRepo(board.id, String(args.repo));
    // Every board now linked to `repo`, as the cloud lists them.
    return {
      repo,
      previous: board.repo ?? null,
      boards: store.boardSummaries(repo),
    };
  },
  board_summary(args, { store }) {
    const board = boardOf(store, args.board_id);
    const counts = new Map<string, number>();
    for (const card of store.listWorkItems(board.id))
      counts.set(card.columnKey, (counts.get(card.columnKey) ?? 0) + 1);
    const columns = [...board.config.columns].sort(
      (a, b) => a.position - b.position,
    );
    return {
      workspaceId: board.id,
      role: "owner",
      // OFFLINE: the store's change counter stands in for the board's
      // change sequence.
      head: store.dataVersion(),
      lanes: columns.map((column) => ({
        key: column.key,
        label: column.name,
        role: column.role,
        count: counts.get(column.key) ?? 0,
      })),
      // OFFLINE: stale means no agent heard from (presence) for 2 hours;
      // there is no presence offline, so no card is stale.
      stale: 0,
      categories: board.config.categories.map((category) => ({
        key: category.key,
        name: category.name,
      })),
      tags: board.config.tags,
      labels: board.config.labels.map((label) => ({
        tag: label.key,
        name: label.name,
        tone: label.tone,
      })),
    };
  },
  list_reviews(args, { store }) {
    const board = boardOf(store, args.board_id);
    const order = columnOrder(board);
    const taskId = str(args.task_id)?.toUpperCase();
    const cards = store
      .listWorkItems(board.id, {
        column: str(args.column),
        category: str(args.category),
        priority: str(args.priority) as Priority | undefined,
        tag: str(args.tag),
        includeDeleted: args.include_archived === true,
      })
      .filter((card) => !taskId || card.taskId === taskId)
      .sort(
        (a, b) =>
          (order.get(a.columnKey)?.position ?? 999) -
            (order.get(b.columnKey)?.position ?? 999) ||
          a.rank.localeCompare(b.rank) ||
          a.id.localeCompare(b.id),
      );
    const limit = typeof args.limit === "number" ? args.limit : 50;
    return {
      items: cards.slice(0, limit),
      // OFFLINE: the store's change counter, as `board_summary`.
      head: store.dataVersion(),
      columns: board.config.columns.map((column) => ({
        key: column.key,
        name: column.name,
        role: column.role,
      })),
    };
  },
  get_review(args, { store }) {
    const board = boardOf(store, args.board_id);
    const item = cardOf(store, board, args.card);
    const { latest } = store.listCheckpoints(item.id, {
      project: board.id,
    });
    // The run plan once, beside the card, not inside it as well.
    const { dispatch, ...card } = item;
    return { item: card, checkpoint: latest, dispatch };
  },
  create_review(args, { store }) {
    const board = boardOf(store, args.board_id);
    const checklist = (args.checklist ?? []) as ChecklistItemInput[];
    const streams = args.streams as StreamInput[] | undefined;
    checkStreamPlan(streams, checklist);
    let parentId = str(args.parent_id);
    if (parentId) parentId = cardOf(store, board, parentId).id;
    const item = store.createWorkItem(board.id, {
      title: String(args.title),
      body: str(args.body),
      categoryKey: str(args.category),
      checklist,
      columnKey: str(args.column) ?? startColumn(board),
      parentId,
      priority: str(args.priority) as Priority | undefined,
      streams,
      tags: args.tags as string[] | undefined,
      type: str(args.type) as CardDetail["type"] | undefined,
    });
    return { item };
  },
  update_review(args, { store }) {
    const board = boardOf(store, args.board_id);
    const current = cardOf(store, board, args.card);
    if (
      typeof args.expected_revision === "number" &&
      args.expected_revision !== current.revision
    )
      fail(
        "conflict",
        `card is at revision ${current.revision}, not ${args.expected_revision}`,
      );
    const retag = args.checklist_streams as
      | Record<string, string | null>
      | undefined;
    let checklist: ChecklistItemInput[] | undefined;
    if (retag && Object.keys(retag).length > 0) {
      const keys = new Set(current.checklist.map((item) => item.key));
      const unknown = Object.keys(retag).filter((key) => !keys.has(key));
      if (unknown.length > 0)
        fail("not_found", `checklist item ${unknown.join(", ")} not found`);
      checklist = asInput(current.checklist).map((item) =>
        item.key && item.key in retag
          ? { ...item, stream: retag[item.key] ?? null }
          : item,
      );
    }
    const streams = args.streams as StreamInput[] | undefined;
    if (streams)
      checkStreamPlan(streams, checklist ?? asInput(current.checklist));
    // NOTE: One write, at the revision read above. The retagged checklist
    // was built from it, so a box ticked in between must refuse, not vanish.
    const item = store.updateWorkItem(
      current.id,
      {
        title: str(args.title),
        body: str(args.body),
        categoryKey: str(args.category),
        priority: str(args.priority) as Priority | undefined,
        tags: args.tags as string[] | undefined,
        streams,
        checklist,
      },
      { project: board.id, ifRevision: current.revision },
    );
    return { item };
  },
  toggle_item(args, { store }) {
    const board = boardOf(store, args.board_id);
    const patch: ChecklistItemPatchRequest = {};
    if (typeof args.checked === "boolean") patch.checked = args.checked;
    if (typeof args.note === "string") patch.note = args.note;
    if (typeof args.text === "string") patch.text = args.text;
    if (args.stream !== undefined) patch.stream = args.stream as string | null;
    const item = store.toggleChecklistItem(
      String(args.card),
      String(args.key),
      patch,
      { project: board.id },
    );
    const changed = item.checklist.find((box) => box.key === String(args.key));
    if (!changed)
      fail(
        "not_found",
        `checklist item ${String(args.key)} not found on this card`,
      );
    const open = openDecisions(item.checklist);
    return {
      checklistItem: changed,
      card: {
        ...ref(item),
        columnKey: item.columnKey,
        revision: item.revision,
        done: item.checklistProgress.done,
        total: item.checklistProgress.total,
      },
      ready: open.length === 0,
      ...(open.length === 0 ? {} : { open }),
    };
  },
  review_card(args, { store }) {
    const board = boardOf(store, args.board_id);
    const current = cardOf(store, board, args.card);
    const picks = args.picks as {
      key: string;
      checked: boolean;
      note?: string;
    }[];
    const items = asInput(current.checklist);
    const byKey = new Map(items.map((item) => [item.key, item]));
    const missing = picks.filter((pick) => !byKey.has(pick.key));
    if (missing.length > 0)
      fail(
        "not_found",
        `checklist item ${missing.map((pick) => pick.key).join(", ")} not found`,
      );
    const tickedGroups = new Map<string, string>();
    for (const pick of picks) {
      const item = byKey.get(pick.key) as ChecklistItemInput;
      item.checked = pick.checked;
      if (pick.note !== undefined) item.note = pick.note || null;
      if (pick.checked && item.group) {
        const other = tickedGroups.get(item.group);
        if (other)
          fail(
            "invalid",
            `${other} and ${pick.key} are options of the same pick-ONE group "${item.group}"; pick one`,
          );
        tickedGroups.set(item.group, pick.key);
      }
    }
    for (const [group, key] of tickedGroups)
      for (const item of items)
        if (item.group === group && item.key !== key) item.checked = false;
    const item = store.updateWorkItem(
      current.id,
      { checklist: items },
      {
        project: board.id,
        ifRevision:
          typeof args.revision === "number" ? args.revision : current.revision,
      },
    );
    const open = openDecisions(item.checklist);
    return {
      ready: open.length === 0,
      ...(open.length === 0
        ? { next: readyNext(board.config.columns, item.columnKey) }
        : { open }),
      item,
    };
  },
  set_status(args, { store }) {
    const board = boardOf(store, args.board_id);
    const item = store.setStatus(String(args.card), String(args.status), {
      project: board.id,
    });
    // OFFLINE: no `retro`. The cloud reads send-backs, a person's notes and
    // verify items that failed before passing from the card's history; the
    // store keeps none, and an empty retro is never sent.
    return { item };
  },
  delete_review(args, { store }) {
    const board = boardOf(store, args.board_id);
    const item = store.deleteWorkItem(String(args.card), {
      project: board.id,
    });
    // OFFLINE: `seq` is the change counter the tombstone was stamped with.
    // An already archived card is refused (not_found), as before, so it is
    // never the cloud's `null`.
    return { archived: item.id, seq: item.seq };
  },
  checkpoint(args, { store, agent, host }) {
    const board = boardOf(store, args.board_id);
    const git = args.git as Record<string, string> | undefined;
    const request: CheckpointRequest = {
      summary: String(args.summary),
      request: str(args.request) ?? null,
      nextStep: str(args.next_step) ?? null,
      files: args.files as string[] | undefined,
      commands: args.commands as CheckpointRequest["commands"],
      host,
      git: git
        ? {
            branch: git.branch ?? null,
            head: git.head ?? null,
            wipRef: git.wip_ref ?? null,
            wipSha: git.wip_sha ?? null,
          }
        : null,
    };
    const checkpoint = store.addCheckpoint(String(args.card), request, {
      project: board.id,
      agent,
    });
    return { checkpoint };
  },
  lifecycle_status(args, { store }) {
    const board = boardOf(store, args.board_id);
    const order = columnOrder(board);
    const out: BoardToolOutputs["lifecycle_status"] = {
      waiting: [],
      ready: [],
      inFlight: [],
      // BE-23: written and verified, waiting on a person. Neither ready nor
      // in flight, as on the cloud.
      review: [],
    };
    const { waiting, ready, inFlight, review } = out;
    // As on the cloud: only the start lane is waiting or ready, and only its
    // decision boxes count; intake, done and archive lanes are not listed.
    const start = startColumn(board);
    for (const card of store.listWorkItems(board.id)) {
      const role = order.get(card.columnKey)?.role ?? null;
      if (role === "active") {
        inFlight.push({ ...ref(card), columnKey: card.columnKey });
        continue;
      }
      if (role === "review") {
        review.push({ ...ref(card), columnKey: card.columnKey });
        continue;
      }
      if (!start || card.columnKey !== start) continue;
      const detail = store.getWorkItem(card.id) as CardDetail;
      const decisions = detail.checklist.filter(
        (item) => item.section === "decisions",
      );
      if (openDecisions(decisions).length > 0)
        waiting.push({
          ...ref(card),
          done: decisions.filter((item) => item.checked).length,
          total: decisions.length,
        });
      else ready.push(ref(card));
    }
    return out;
  },
};

/** The board tools, in the contract's order, each with what it does. */

/**
 * What to do once every decision is settled, said for the lane the card is
 * in: a card already being built is not told to start.
 */
function readyNext(
  columns: readonly { key: string; role: string | null }[],
  columnKey: string,
): string {
  const role = columns.find((column) => column.key === columnKey)?.role;
  if (role === "active")
    return "Every decision is settled, and the card is already in progress: carry on, and move it to the review lane with set_status once it is built and verified.";
  if (role === "review" || role === "done")
    return "Every decision is settled. The card is past implementation already; nothing to start.";
  return "Every decision is settled — ready to implement. Move the card with set_status when work starts.";
}

export const TOOLS: ToolSpec[] = BOARD_TOOLS.map((contract) => ({
  ...contract,
  run: RUNS[contract.name],
}));
