// The offline MCP server's tools (FE-52/W3): the cloud server's 14 board tools,
// same names, same parameter names and types, run against the local SQLite
// board instead of the API.
//
// ⚠️ Thin. Every rule a card obeys (task-id minting, checklist keys, stream
// validation, checkpoint trimming, tombstones) lives in `../local-store`, which
// the app also writes through — a rule spelled twice here would drift. What
// lives here is only what the cloud does ABOVE its store: pick-ONE groups for
// `review_card`, the lifecycle roll-up, the stream-plan checks a card is
// refused on, and the answer shapes.
//
// ⚠️ Every write goes through the store, which bumps `dataVersion()` in the
// same transaction: that is how the app sees an agent's write (it polls).
//
// ⚠️ `board_id` is the local workspace id. There are no accounts, machines,
// members, comments, attachments or subscriptions offline, so those tools do
// not exist here and `assignees.users` is accepted and ignored.
import type {
  BoardColumn,
  CardDetail,
  ChecklistItem,
  ChecklistItemInput,
  ChecklistItemPatchRequest,
  CheckpointRequest,
  Priority,
  StreamInput,
} from "@lanework/protocol";
import { normalizeStreams, streamWaves } from "../local-store/cards";
import {
  type LocalStore,
  LocalStoreError,
  type LocalWorkspace,
  normalizeRepo,
} from "../local-store/index";
import type { Param, Shape } from "./schema";

export interface ToolContext {
  store: LocalStore;
  /** The writer's agent slug, from the client's `initialize` (`claude-code`, `codex`). */
  agent: string;
  /** This machine's name — every offline checkpoint was written here. */
  host: string;
}

interface ToolSpec extends Shape {
  name: string;
  description: string;
  readOnly: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): unknown;
}

// ── Shared parameter shapes ─────────────────────────────────────────────────

const BOARD_ID: Param = {
  type: "string",
  description:
    "The board's id (the local workspace id) from list_boards. There is no default.",
};
const CARD: Param = {
  type: "string",
  description: "Card id or task id (e.g. BE-07)",
};
const REPO: Param = {
  type: "string",
  description:
    "Output of `git remote get-url origin`, unmodified (ssh or https)",
};
const PRIORITY: Param = {
  type: "string",
  enum: ["low", "medium", "high"],
};
const ASSIGNEES: Param = {
  type: "object",
  description:
    "Agents assigned to the card. `users` is accepted and ignored: a local board has no accounts.",
  properties: {
    agents: { type: "string[]" },
    users: { type: "string[]" },
  },
};
const STREAMS: Param = {
  type: "object[]",
  description:
    "Sub-agent streams (BE-19). Only for 2+ independent write areas. `owns`: exact paths or directories ending in `/`, no globs; two streams never own the same path. Shared files go in a W0 stream the others depend on. At most 4 streams per wave. Every stream needs at least one verify item tagged with its key.",
  properties: {
    key: { type: "string", description: "W0…W999; minted when absent" },
    title: { type: "string" },
    goal: { type: "string" },
    role: { type: "string", enum: ["research", "implement", "test"] },
    owns: { type: "string[]" },
    reads: { type: "string[]" },
    depends_on: { type: "string[]", description: "Stream keys" },
    isolation: {
      type: "string",
      enum: ["worktree", "shared"],
      description: "Default worktree",
    },
  },
  required: ["title", "goal", "role"],
};
const CHECKLIST: Param = {
  type: "object[]",
  description:
    "Decisions (what the user approves) and verify items (how the work is proved). Boxes sharing a `group` are pick-ONE options.",
  properties: {
    section: { type: "string", enum: ["decisions", "verify"] },
    text: { type: "string" },
    checked: { type: "boolean" },
    group: { type: "string" },
    key: { type: "string", description: "D1, V3…; minted if omitted" },
    note: { type: "string" },
    stream: {
      type: "string",
      description: "Verify items only: the stream key this item proves",
    },
  },
  required: ["section", "text"],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function fail(
  code: "not_found" | "invalid" | "conflict",
  message: string,
): never {
  throw new LocalStoreError(code, message);
}

function boardOf(store: LocalStore, boardId: unknown): LocalWorkspace {
  const workspace = store.getWorkspace(String(boardId));
  if (!workspace)
    fail(
      "not_found",
      `board ${String(boardId)} not found; call list_boards for its id`,
    );
  return workspace;
}

function cardOf(store: LocalStore, board: LocalWorkspace, card: unknown) {
  const detail = store.getWorkItem(String(card), { workspace: board.id });
  if (!detail)
    fail("not_found", `card ${String(card)} not found on this board`);
  return detail;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The lane `create_review` lands a card in when none is named: the start lane. */
function startColumn(board: LocalWorkspace): string | undefined {
  return board.config.columns.find((column) => column.role === "start")?.key;
}

function columnOrder(board: LocalWorkspace): Map<string, BoardColumn> {
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

/** A checklist as `updateWorkItem` takes it back: everything kept, keys included. */
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
function decisionState(checklist: ChecklistItem[]): {
  ready: boolean;
  pending: string[];
} {
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

function brief(card: CardDetail) {
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

export const TOOLS: ToolSpec[] = [
  {
    name: "list_boards",
    description:
      "Every board on this machine, with its board id and linked repo. Call this FIRST: every other tool needs a `board_id` and there is no default. Pass `repo` (your `git remote get-url origin`, as is) to get only the board(s) linked to the repo you are working in.",
    readOnly: true,
    properties: { repo: REPO },
    run(args, { store }) {
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
  },
  {
    name: "create_board",
    description:
      "Create a new board and link it to the git repo in one step. ONLY after the user chose to create a new board, never on your own initiative. Suggest `owner/name` from the remote as the name. Returns board_id for every other tool.",
    readOnly: false,
    properties: {
      name: {
        type: "string",
        description:
          "Board name the user agreed to, e.g. `hiip/headless-controller`",
      },
      repo: REPO,
      slug: {
        type: "string",
        description:
          "Lower-case hyphenated key; omitted = derived from the name.",
      },
    },
    required: ["name", "repo"],
    run(args, { store }) {
      const workspace = store.createWorkspace({
        name: String(args.name),
        slug: str(args.slug),
        repo: String(args.repo),
      });
      return {
        board_id: workspace.id,
        board: {
          workspaceId: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          repo: workspace.repo,
        },
        next: "Use this board_id for every other tool. Read board_summary before creating a card.",
      };
    },
  },
  {
    name: "link_repo",
    description:
      "Link a board to a git repo so list_boards({ repo }) finds it. Only after the USER confirmed which board the repo belongs to. A board links to ONE repo; refuses to replace a different linked repo unless `replace` is true. A repo another board held moves to this one.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      repo: REPO,
      replace: {
        type: "boolean",
        description:
          "Move the link from the repo it has now. Only when the user asked.",
      },
    },
    required: ["board_id", "repo"],
    run(args, { store }) {
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
  },
  {
    name: "board_summary",
    description:
      "Lane-by-lane counts of live cards, plus the board's categories and tag policy. Read this before creating a card so its category and tags match what the board already uses.",
    readOnly: true,
    properties: { board_id: BOARD_ID },
    required: ["board_id"],
    run(args, { store }) {
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
  },
  {
    name: "list_reviews",
    description:
      "Cards on a board, in the order the board draws them. Filter by lane, category, tag or priority. Archived cards are excluded unless asked for.",
    readOnly: true,
    properties: {
      board_id: BOARD_ID,
      category: { type: "string", description: "Category key, e.g. backend" },
      column: {
        type: "string",
        description: "Lane key, e.g. todo | processing | done",
      },
      include_archived: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      priority: PRIORITY,
      tag: { type: "string" },
      task_id: {
        type: "string",
        description:
          "Exact task id such as BE-07, matched on the field, not the title",
      },
    },
    required: ["board_id"],
    run(args, { store }) {
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
  },
  {
    name: "get_review",
    description:
      "One card with its checklist, tags and `streams`, plus the latest `checkpoint` another agent left on it (or null) and `dispatch`: the card's run plan, `{ waves, briefs }`, or null when it has no streams. `card` takes either the card's id or its task id (e.g. BE-07).",
    readOnly: true,
    properties: { board_id: BOARD_ID, card: CARD },
    required: ["board_id", "card"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const item = cardOf(store, board, args.card);
      const { latest } = store.listCheckpoints(item.id, {
        workspace: board.id,
      });
      return { item, checkpoint: latest, dispatch: item.dispatch };
    },
  },
  {
    name: "create_review",
    description:
      "Open a new card on a board. Setting `category` also mints the card's permanent task id. Split into `streams` only for 2+ independent write areas. Shared files go in a W0 stream the others depend on. At most 4 streams per wave, no two streams in one wave own the same path, every stream needs at least one verify item tagged with its key. Isolation defaults to worktree.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      title: { type: "string" },
      body: { type: "string", description: "Markdown" },
      category: {
        type: "string",
        description: "Category key; mints the task id",
      },
      checklist: CHECKLIST,
      column: {
        type: "string",
        description: "Lane key; defaults to the board's start lane",
      },
      parent_id: { type: "string" },
      priority: PRIORITY,
      streams: STREAMS,
      tags: { type: "string[]" },
      type: { type: "string", enum: ["epic", "issue", "task"] },
      assignees: ASSIGNEES,
    },
    required: ["board_id", "title"],
    run(args, { store }) {
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
  },
  {
    name: "update_review",
    description:
      "Patch a card's title, body, priority, tags, assignees, category or streams. Omitted fields are left alone; `tags`, `assignees` and `streams` replace what is there (`streams: []` clears the plan). Streams are checked against the checklist: each needs a verify item tagged with its key (tag them in the same call with `checklist_streams`). Use set_status to move between lanes.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      title: { type: "string" },
      body: { type: "string" },
      category: {
        type: "string",
        description: "Setting this on a card with no task id yet mints one",
      },
      priority: PRIORITY,
      tags: { type: "string[]", description: "Replaces the card's tags" },
      assignees: ASSIGNEES,
      streams: STREAMS,
      checklist_streams: {
        type: "string-map",
        description:
          'Verify item key → stream key (null removes the tag), e.g. { "V3": "W1", "V4": null }',
      },
      expected_revision: {
        type: "integer",
        description: "Refuse unless the card is still at this revision",
      },
    },
    required: ["board_id", "card"],
    run(args, { store }) {
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
      // ⚠️ One write, at the revision read above: the retagged checklist was
      // built from it, so a box ticked in between must refuse, not vanish.
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
        { workspace: board.id, ifRevision: current.revision },
      );
      return { item };
    },
  },
  {
    name: "toggle_item",
    description:
      "Tick or untick one checklist box on a card, and optionally leave a note under it, or tag a verify item with the stream it proves. `key` is the item's stable id, e.g. D1 or V3.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      key: { type: "string", description: "Checklist item key, e.g. D1 or V3" },
      checked: {
        type: "boolean",
        description: "Omit to leave the tick alone",
      },
      note: { type: "string", description: "Empty string clears it" },
      stream: {
        type: "nullable-string",
        description: "Verify items only; null removes the tag",
      },
      text: {
        type: "string",
        description: "Reword the item, keeping its key and tick",
      },
    },
    required: ["board_id", "card", "key"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const patch: ChecklistItemPatchRequest = {};
      if (typeof args.checked === "boolean") patch.checked = args.checked;
      if (typeof args.note === "string") patch.note = args.note;
      if (typeof args.text === "string") patch.text = args.text;
      if (args.stream !== undefined)
        patch.stream = args.stream as string | null;
      const item = store.toggleChecklistItem(
        String(args.card),
        String(args.key),
        patch,
        { workspace: board.id },
      );
      return { item, ...decisionState(item.checklist) };
    },
  },
  {
    name: "review_card",
    description:
      "Write the user's review of a card's checklist in one call. ONLY with picks the user just made. Ticking one option of a pick-ONE group unticks the others; boxes not named are left as they are. Free text goes in `note`. Returns `ready: true` once every decision is settled; it does not move the card.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      picks: {
        type: "object[]",
        minItems: 1,
        properties: {
          key: { type: "string" },
          checked: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["key", "checked"],
      },
      revision: {
        type: "integer",
        description: "Refused if the card's revision changed since",
      },
    },
    required: ["board_id", "card", "picks"],
    run(args, { store }) {
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
          workspace: board.id,
          ifRevision:
            typeof args.revision === "number"
              ? args.revision
              : current.revision,
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
  },
  {
    name: "set_status",
    description:
      "Move a card to another lane, the board's status columns. Moving it to a done or archive lane clears its checkpoints.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      status: {
        type: "string",
        description: "Lane key, e.g. todo | processing | done | dropped",
      },
    },
    required: ["board_id", "card", "status"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const item = store.setStatus(String(args.card), String(args.status), {
        workspace: board.id,
      });
      return { item: brief(item) };
    },
  },
  {
    name: "delete_review",
    description:
      "Take a card off the board. This ARCHIVES it: the card and its history stay in the database and can be restored. Nothing here deletes rows.",
    readOnly: false,
    properties: { board_id: BOARD_ID, card: CARD },
    required: ["board_id", "card"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const item = store.deleteWorkItem(String(args.card), {
        workspace: board.id,
      });
      return { archived: item.id, item: brief(item) };
    },
  },
  {
    name: "checkpoint",
    description:
      "Record where you stopped on a card so another agent can resume it. Call after each checklist item you finish, and before you stop mid-task. `get_review` returns the latest checkpoint. Summarise; never paste transcripts, secrets, tokens or .env values. Refused on a finished or archived card.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      summary: { type: "string" },
      request: { type: "string" },
      next_step: { type: "string" },
      files: { type: "string[]" },
      commands: {
        type: "object[]",
        properties: {
          command: { type: "string" },
          ok: { type: "boolean" },
        },
        required: ["command"],
      },
      git: {
        type: "object",
        properties: {
          branch: { type: "string" },
          head: { type: "string" },
          wip_ref: { type: "string" },
          wip_sha: { type: "string" },
        },
      },
    },
    required: ["board_id", "card", "summary"],
    run(args, { store, agent, host }) {
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
        workspace: board.id,
        agent,
      });
      return { checkpoint };
    },
  },
  {
    name: "lifecycle_status",
    description:
      "What the board is waiting on: cards whose decisions are not all ticked (waiting), cards cleared to start (ready), and cards being worked (in flight).",
    readOnly: true,
    properties: { board_id: BOARD_ID },
    required: ["board_id"],
    run(args, { store }) {
      const board = boardOf(store, args.board_id);
      const order = columnOrder(board);
      const waiting: unknown[] = [];
      const ready: unknown[] = [];
      const inFlight: unknown[] = [];
      for (const card of store.listWorkItems(board.id)) {
        const role = order.get(card.columnKey)?.role ?? null;
        if (role === "done" || role === "archive") continue;
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
      return { waiting, ready, inFlight };
    },
  },
];
