// The 14 board tools (FE-152): names, descriptions and parameters as the
// cloud MCP (`mcp.lanework.dev`) and the offline one (`electron/mcp-local/`)
// both serve them, and the answer each one returns.
//
// NOTE: The offline server was written to match the cloud's. A change here
// is a change to the cloud's tools too; make it there in the same release.
// `board_id` is the board's id: the workspace id on the cloud, the local
// project id offline.
import type {
  BoardLabel,
  BoardSummary,
  Card,
  CardDetail,
  ChecklistItem,
  ColumnRole,
  Dispatch,
  Priority,
  TagPolicy,
} from "../boards";
import type { Checkpoint, LatestCheckpoint } from "../checkpoints";
import type { ToolContract, ToolParam } from "./schema";

export type BoardToolName =
  | "list_boards"
  | "create_board"
  | "link_repo"
  | "board_summary"
  | "list_reviews"
  | "get_review"
  | "create_review"
  | "update_review"
  | "toggle_item"
  | "review_card"
  | "set_status"
  | "delete_review"
  | "checkpoint"
  | "lifecycle_status";

// ── Shared parameter shapes ─────────────────────────────────────────────────

const BOARD_ID: ToolParam = {
  type: "string",
  description:
    "The board's id (the local project id) from list_boards. There is no default.",
};
const CARD: ToolParam = {
  type: "string",
  description: "Card id or task id (e.g. BE-07)",
};
const REPO: ToolParam = {
  type: "string",
  description:
    "Output of `git remote get-url origin`, unmodified (ssh or https)",
};
const PRIORITY: ToolParam = {
  type: "string",
  enum: ["low", "medium", "high"],
};
const ASSIGNEES: ToolParam = {
  type: "object",
  description:
    "Agents assigned to the card. `users` is accepted and ignored: a local board has no accounts.",
  properties: {
    agents: { type: "string[]" },
    users: { type: "string[]" },
  },
};
const STREAMS: ToolParam = {
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
const CHECKLIST: ToolParam = {
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

// ── The tools ───────────────────────────────────────────────────────────────

/** The board tools, in the order `tools/list` advertises them. */
export const BOARD_TOOLS: readonly ToolContract<BoardToolName>[] = [
  {
    name: "list_boards",
    description:
      "Every board on this machine, with its board id and linked repo. Call this FIRST: every other tool needs a `board_id` and there is no default. Pass `repo` (your `git remote get-url origin`, as is) to get only the board(s) linked to the repo you are working in.",
    readOnly: true,
    properties: { repo: REPO },
  },
  {
    name: "create_board",
    description:
      "Create a new board and link it to the git repo in one step. ONLY after the user chose to create a new board, never on your own initiative. Suggest `owner/name` from the remote as the name. Returns board_id for every other tool.",
    readOnly: false,
    properties: {
      name: {
        type: "string",
        description: "Board name the user agreed to, e.g. `acme/widgets`",
      },
      repo: REPO,
      slug: {
        type: "string",
        description:
          "Lower-case hyphenated key; omitted = derived from the name.",
      },
    },
    required: ["name", "repo"],
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
  },
  {
    name: "board_summary",
    description:
      "Lane-by-lane counts of live cards, plus the board's categories and tag policy. Read this before creating a card so its category and tags match what the board already uses.",
    readOnly: true,
    properties: { board_id: BOARD_ID },
    required: ["board_id"],
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
  },
  {
    name: "get_review",
    description:
      "One card with its checklist, tags and `streams`, plus the latest `checkpoint` another agent left on it (or null) and `dispatch`: the card's run plan, `{ waves, briefs }`, or null when it has no streams. `card` takes either the card's id or its task id (e.g. BE-07).",
    readOnly: true,
    properties: { board_id: BOARD_ID, card: CARD },
    required: ["board_id", "card"],
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
  },
  {
    name: "set_status",
    description:
      "Move a card to another lane, the board's status columns. Finished, verified work goes to the review lane, not done. Moving it to a done or archive lane clears its checkpoints.",
    readOnly: false,
    properties: {
      board_id: BOARD_ID,
      card: CARD,
      status: {
        type: "string",
        description: "Lane key, e.g. todo | processing | review | done",
      },
      // BE-23: the cloud's parameter, accepted so a call written for the
      // cloud runs offline. A local board keeps no history, so it is not
      // stored there and not required.
      reason: {
        type: "string",
        description:
          "What to change when sending a card back from review. Accepted and not stored on a local board, which keeps no history.",
      },
    },
    required: ["board_id", "card", "status"],
  },
  {
    name: "delete_review",
    description:
      "Take a card off the board. This ARCHIVES it: the card and its history stay in the database and can be restored. Nothing here deletes rows.",
    readOnly: false,
    properties: { board_id: BOARD_ID, card: CARD },
    required: ["board_id", "card"],
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
  },
  {
    name: "lifecycle_status",
    description:
      "What the board is waiting on: cards whose decisions are not all ticked (waiting), cards cleared to start (ready), cards being worked (in flight), and cards waiting for a human to review (review).",
    readOnly: true,
    properties: { board_id: BOARD_ID },
    required: ["board_id"],
  },
];

// ── The answers ─────────────────────────────────────────────────────────────

/** A board as the board tools name it: its id is `workspaceId` on both servers. */
export interface ToolBoardRef {
  workspaceId: string;
  name: string;
  repo: string | null;
}

/** A card in one line, as `set_status`, `delete_review` and `lifecycle_status` state it. */
export interface CardBrief {
  id: string;
  taskId: string | null;
  title: string;
  /** The lane key. */
  column: string;
  priority: Priority | null;
  revision: number;
}

/** Whether a card's decisions are settled; `pending` names box keys or `group:<name>`. */
export interface DecisionState {
  ready: boolean;
  pending: string[];
}

/** What each board tool answers, inside its text content, as JSON. */
export interface BoardToolOutputs {
  list_boards: {
    /** The normalized remote, when `repo` was passed. */
    repo?: string;
    boards: BoardSummary[];
    next: string;
  };
  create_board: {
    board_id: string;
    board: ToolBoardRef & { slug: string };
    next: string;
  };
  link_repo: {
    board: ToolBoardRef;
    /** The repo the board was linked to before, when it moved. */
    replaced: string | null;
  };
  board_summary: {
    board: ToolBoardRef;
    total: number;
    lanes: {
      key: string;
      name: string;
      role: ColumnRole | null;
      count: number;
    }[];
    categories: { key: string; name: string; prefix: string; next: number }[];
    tagPolicy: TagPolicy;
    tags: { tag: string; count: number }[];
    labels: BoardLabel[];
  };
  list_reviews: { total: number; items: Card[]; truncated: boolean };
  get_review: {
    item: CardDetail;
    checkpoint: LatestCheckpoint | null;
    dispatch: Dispatch | null;
  };
  create_review: { item: CardDetail; next: string };
  update_review: { item: CardDetail };
  toggle_item: DecisionState & { item: CardDetail };
  review_card: DecisionState & {
    revision: number;
    checklist: ChecklistItem[];
    next: string;
  };
  set_status: { item: CardBrief };
  delete_review: { archived: string; item: CardBrief };
  checkpoint: { checkpoint: Checkpoint };
  lifecycle_status: {
    waiting: (CardBrief & { pending: string[] })[];
    ready: CardBrief[];
    /** `verified` is ticked/total verify boxes, e.g. `2/5`. */
    inFlight: (CardBrief & { verified: string })[];
    review: CardBrief[];
  };
}
