// The offline MCP server's tools: the cloud server's 14 board tools, with the
// same names, descriptions and parameters, run against the local SQLite board
// instead of the API. Names, descriptions and parameters live in the tool
// contract (`BOARD_TOOLS` in `@lanework/protocol`); this file holds only what
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
// NOTE: Every write goes through the store, which bumps `dataVersion()` in the
// same transaction. The app polls that, so a write around the store never
// shows up in the app.
import {
  BOARD_TOOLS,
  type BoardColumn,
  type BoardToolName,
  type BoardToolOutputs,
  type Card,
  type CardBrief,
  type CardDetail,
  type ChecklistItem,
  type ChecklistItemInput,
  type ChecklistItemPatchRequest,
  type CheckpointRequest,
  type DecisionState,
  type Priority,
  type StreamInput,
  type ToolContract,
} from "@lanework/protocol";
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
 * Are the card's decisions settled? Every ungrouped decision ticked, and
 * exactly one option of every pick-ONE group. `pending` names what is not:
 * a box key, or `group:<name>`.
 */
function decisionState(checklist: ChecklistItem[]): DecisionState {
  const pending: string[] = [];
  const groups = new Map<string, ChecklistItem[]>();
  for (const item of checklist) {
    if (item.section !== "decisions") continue;
    if (item.group) {
      const members = groups.get(item.group) ?? [];
      members.push(item);
      groups.set(item.group, members);
    } else if (!item.checked) pending.push(item.key);
  }
  for (const [group, members] of groups)
    if (members.filter((item) => item.checked).length !== 1)
      pending.push(`group:${group}`);
  return { ready: pending.length === 0, pending };
}

function brief(card: Card): CardBrief {
  return {
    id: card.id,
    taskId: card.taskId,
    title: card.title,
    column: card.columnKey,
    priority: card.priority,
    revision: card.revision,
  };
}

// ── The tools ───────────────────────────────────────────────────────────────

const RUNS: { [Name in BoardToolName]: Run<Name> } = {
  list_boards(args, { store }) {
    const remote = str(args.repo);
    if (remote === undefined) {
      const boards = store.boardSummaries();
      return {
        boards,
        next:
          boards.length === 0
            ? "No boards yet. Ask the user whether to create one for this repo (create_board)."
            : "Ask the user which board this repo belongs to; never pick one by its name.",
      };
    }
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
      // NOTE: `workspaceId`, as the cloud MCP's output names a board's id:
      // an agent reads either server the same way.
      board: {
        workspaceId: project.id,
        name: project.name,
        slug: project.slug,
        repo: project.repo,
      },
      next: "Use this board_id for every other tool. Read board_summary before creating a card.",
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
    const linked = store.linkRepo(board.id, String(args.repo));
    return {
      board: {
        workspaceId: linked.id,
        name: linked.name,
        repo: linked.repo,
      },
      replaced: board.repo && board.repo !== repo ? board.repo : null,
    };
  },
  board_summary(args, { store }) {
    const board = boardOf(store, args.board_id);
    const cards = store.listWorkItems(board.id);
    const counts = new Map<string, number>();
    const tags = new Map<string, number>();
    for (const card of cards) {
      counts.set(card.columnKey, (counts.get(card.columnKey) ?? 0) + 1);
      for (const tag of card.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    const columns = [...board.config.columns].sort(
      (a, b) => a.position - b.position,
    );
    return {
      board: { workspaceId: board.id, name: board.name, repo: board.repo },
      total: cards.length,
      lanes: columns.map((column) => ({
        key: column.key,
        name: column.name,
        role: column.role,
        count: counts.get(column.key) ?? 0,
      })),
      categories: board.config.categories.map((category) => ({
        key: category.key,
        name: category.name,
        prefix: category.prefix,
        next: (board.taskHeads[category.key] ?? 0) + 1,
      })),
      tagPolicy: board.config.tags,
      tags: [...tags.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag, count]) => ({ tag, count })),
      labels: board.config.labels,
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
      total: cards.length,
      items: cards.slice(0, limit),
      truncated: cards.length > limit,
    };
  },
  get_review(args, { store }) {
    const board = boardOf(store, args.board_id);
    const item = cardOf(store, board, args.card);
    const { latest } = store.listCheckpoints(item.id, {
      project: board.id,
    });
    return { item, checkpoint: latest, dispatch: item.dispatch };
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
    return {
      item,
      next: "Offer to review the new card with the user here (review_card).",
    };
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
    return { item, ...decisionState(item.checklist) };
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
    const state = decisionState(item.checklist);
    return {
      ...state,
      revision: item.revision,
      checklist: item.checklist,
      next: state.ready
        ? "Every decision is settled. Move the card with set_status when work starts."
        : "Some decisions are still open; work does not start until ready is true.",
    };
  },
  set_status(args, { store }) {
    const board = boardOf(store, args.board_id);
    const item = store.setStatus(String(args.card), String(args.status), {
      project: board.id,
    });
    return { item: brief(item) };
  },
  delete_review(args, { store }) {
    const board = boardOf(store, args.board_id);
    const item = store.deleteWorkItem(String(args.card), {
      project: board.id,
    });
    return { archived: item.id, item: brief(item) };
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
    for (const card of store.listWorkItems(board.id)) {
      const role = order.get(card.columnKey)?.role ?? null;
      if (role === "done" || role === "archive") continue;
      if (role === "review") {
        review.push(brief(card));
        continue;
      }
      const detail = store.getWorkItem(card.id) as CardDetail;
      const state = decisionState(detail.checklist);
      if (role === "active") {
        const verify = detail.checklist.filter(
          (item) => item.section === "verify",
        );
        inFlight.push({
          ...brief(detail),
          verified: `${verify.filter((item) => item.checked).length}/${verify.length}`,
        });
      } else if (state.ready) ready.push(brief(detail));
      else waiting.push({ ...brief(detail), pending: state.pending });
    }
    return out;
  },
};

/** The board tools, in the contract's order, each with what it does. */
export const TOOLS: ToolSpec[] = BOARD_TOOLS.map((contract) => ({
  ...contract,
  run: RUNS[contract.name],
}));
