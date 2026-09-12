export interface Workspace {
  /**
   * The cloud workspace id — the key everything board-related is addressed by.
   *
   * ⚠️ Not the slug. Every board endpoint is `/v1/boards/:workspaceId/…`, and so
   * is a rename (`PATCH /v1/sync/state/workspace/:id`). It arrives on
   * `/v1/sync/state` (the machine surface); `/v1/workspaces` is `sessionAuth`
   * and refuses this app's credential by design.
   *
   * ⚠️ NULL against a control plane that predates the field, and that case is
   * not hypothetical: this app shipped a version that required it and refused
   * every workspace a live service returned. A missing id means "no board yet",
   * never "no workspace" — the picker still works, the selection is still
   * remembered by slug, and only opening a board says what is wrong.
   */
  id: string | null;
  slug: string;
  name: string;
  /**
   * Where this machine keeps a checkout, or null.
   *
   * ⚠️ Display and code-execution only. A workspace with no path is a complete,
   * openable workspace — its cards live in the cloud — so nothing about the
   * board may gate on this being set.
   */
  path: string | null;
  baseBranch: string | null;
}

export interface WorkspaceSnapshot {
  workspaces: Workspace[];
  active: Workspace | null;
}

/** One lane of a board, as the cloud states it. */
export interface BoardColumn {
  key: string;
  name: string;
  role: string | null;
  icon: string;
  tone: string;
  position: number;
}

export interface BoardCategory {
  key: string;
  name: string;
  prefix: string;
  tone: string;
}

/**
 * The two sections a checklist row can belong to.
 *
 * ⚠️ The board's own closed set, not free text: a row filed under anything else
 * is refused at the API with "unknown section". Stated here so a caller finds
 * out while typing rather than from a 400.
 */
export const CHECKLIST_SECTIONS = ["decisions", "verify"] as const;
export type ChecklistSection = (typeof CHECKLIST_SECTIONS)[number];

/** One checklist row. `checked` is derived from `checkedAt` by the server. */
export interface BoardChecklistItem {
  key: string;
  section: string;
  text: string;
  checked: boolean;
  checkedAt: string | null;
  note: string | null;
  /**
   * The "pick ONE" group this row belongs to, or null.
   *
   * ⚠️ Two rows sharing a group are alternatives — exactly one may be ticked.
   * The review cards in this very repo are written that way, so a screen that
   * renders every box as an independent checkbox misreads its own board.
   */
  group: string | null;
}

/**
 * One row on the way IN, as `PUT /checklist` takes it.
 *
 * ⚠️ `key` is optional and stable once minted. A rewrite that sends the keys it
 * read back keeps the boxes a human already ticked — they are matched by key,
 * so a reworded item stays ticked. Dropping the keys silently un-ticks the card.
 */
export interface BoardChecklistDraft {
  key?: string | null;
  section?: ChecklistSection;
  text: string;
  checked?: boolean;
  note?: string | null;
  group?: string | null;
}

/** The board's limits on a checklist, so a caller can refuse before the API does. */
export const CHECKLIST_LIMITS = {
  items: 200,
  text: 2000,
  key: 40,
  note: 4000,
} as const;

/**
 * Who a card is on, split by what kind of actor they are.
 *
 * ⚠️ Two lists rather than one tagged list, because that is how the board
 * addresses them: a `user` is a GitHub login and an `agent` is a Lanework agent
 * name, and `agents[0]` is the dispatch role rather than just the first one.
 */
export interface BoardAssignees {
  users: string[];
  agents: string[];
}

/** A card, trimmed to what this app renders and writes. */
export interface BoardCard {
  id: string;
  /** The precondition an edit must carry. See `BoardConflict`. */
  revision: number;
  taskId: string | null;
  title: string;
  body: string;
  columnKey: string;
  categoryKey: string | null;
  priority: "low" | "medium" | "high" | null;
  tags: string[];
  rank: string;
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * `issue` unless the board says otherwise — the axis a hierarchy is drawn on.
   *
   * ⚠️ Free text, not a union. The board's own config names the types, so
   * hard-coding a set here would make this app refuse a card whose type is
   * perfectly valid on the board that sent it.
   */
  type: string;
  /** The card this one hangs under, or null for a top-level card. */
  parentId: string | null;
  estimate: number | null;
  dueAt: string | null;
  /**
   * The checklist, or NULL when this card was read from a list.
   *
   * ⚠️ Null and `[]` are different answers and the difference is load-bearing.
   * `GET /items` serializes without `parts`, so every card on a board read comes
   * back with no checklist key at all — and the previous shape turned that into
   * `[]`, which rendered as "this card has no decisions" for cards that have
   * seven. A card with a checklist is read one at a time (`card` / `lookup`).
   */
  checklist: BoardChecklistItem[] | null;
  /**
   * How far through its checklist this card is — on EVERY read, list included.
   *
   * ⚠️ Not derivable from `checklist` and not a duplicate of it. A list read
   * still carries no checklist at all (see above); this is the cheap count the
   * board sends instead, so a lane can say `3/7` without shipping seven rows
   * per card. `{ done: 0, total: 0 }` means the card has no checklist — the API
   * never leaves this one unstated. Null only for a service too old to send it.
   */
  checklistProgress: BoardChecklistProgress | null;
  /** Null for the same reason as `checklist`: absent from a list read. */
  assignees: BoardAssignees | null;
}

/** A card's checklist as one fraction. */
export interface BoardChecklistProgress {
  done: number;
  total: number;
}

/**
 * The fields a person may edit from this app.
 *
 * ⚠️ Deliberately NOT `Partial<BoardCard>`. `revision`, `rank`, `taskId` and the
 * timestamps are the server's to set, and a patch type that could name them is
 * one a caller will eventually fill in. An absent key means "leave it"; `null`
 * on a nullable field means "clear it".
 */
export interface BoardCardPatch {
  title?: string;
  body?: string;
  priority?: "low" | "medium" | "high" | null;
  tags?: string[];
  categoryKey?: string | null;
}

/**
 * Where a card lands among its neighbours.
 *
 * ⚠️ Stated as a NEIGHBOUR, never as a rank string. The board generates the
 * fractional index itself, and two clients that computed their own would
 * eventually pick the same one; `after`/`before` is a request the server can
 * always satisfy. Absent means "append to the lane".
 */
export type BoardPlacement = { after: string } | { before: string };

export interface BoardView {
  workspaceId: string;
  columns: BoardColumn[];
  categories: BoardCategory[];
  cards: BoardCard[];
  /** True when this board has been migrated and the cloud owns its cards. */
  migrated: boolean;
  /**
   * When this data was read, and whether it came from the last good copy.
   *
   * ⚠️ The UI must say so. "Nothing here" and "I could not ask" look identical
   * on screen, and a developer who trusts an empty board starts typing a card
   * that already exists.
   */
  fetchedAt: string;
  stale: boolean;
}

/**
 * What the server said when an edit lost a race.
 *
 * ⚠️ It carries the card as it stands NOW, because the API's 409 does. A
 * conflict dialog that could only say "you are out of date" would make the user
 * go and look; this one can show both sides.
 */
export interface BoardConflict {
  kind: "conflict";
  message: string;
  current: BoardCard;
}

/**
 * A card as somebody composed it, before the board has one.
 *
 * ⚠️ Deliberately NOT `Partial<BoardCard>`. A card carries an id, a revision, a
 * rank and a task id — all of them the board's to mint — and a draft that
 * borrowed that shape would invite a caller to send one back.
 *
 * ⚠️ `columnKey` absent means "the board's first lane", which is the service's
 * own default rather than a guess made here. Sending a lane the composer never
 * showed would put cards somewhere nobody chose.
 */
export interface BoardCardDraft {
  title: string;
  body?: string | null;
  categoryKey?: string | null;
  columnKey?: string | null;
  priority?: BoardCard["priority"];
  /** Capped and normalized by the board; what it dropped comes back on the write. */
  tags?: string[];
}

/**
 * The board's own tag rule, mirrored.
 *
 * ⚠️ Duplicated from the API's `normalizeTag` on purpose, and it has to stay in
 * step. It lives HERE rather than in the main process because both sides need
 * the same answer: main compares what a write asked for against what came back
 * to name a dropped tag, and the renderer shows the chip a tag is ABOUT to
 * become. Two copies of this function would eventually disagree, and the screen
 * would promise a tag the board does not store.
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
}

export type BoardWrite =
  /**
   * ⚠️ `droppedTags` rides along on SUCCESS, which is the only place it can be
   * useful. The board caps tags (3 by default) and applies the cap silently —
   * so a write that "worked" is exactly the moment a user needs telling that
   * two of the five tags they typed are not on the card. Empty on every write
   * that named no tags.
   */
  | { kind: "ok"; card: BoardCard; droppedTags: string[] }
  | BoardConflict
  | { kind: "error"; message: string };

/**
 * What changed on a board since a cursor.
 *
 * ⚠️ `nextSince` is the cursor to send back — NOT `since + 1`, and not the last
 * card's seq. The feed is monotonic but not contiguous, and board-level events
 * carry no card to advance past, so a client that derived its own cursor would
 * ask for the same delta forever.
 */
export interface BoardChanges {
  /** The board's current head, for "am I caught up?" without another read. */
  head: number;
  nextSince: number;
  hasMore: boolean;
  /**
   * The cards that changed. Read from a list, so their `checklist` and
   * `assignees` are null — see `BoardCard`.
   */
  cards: BoardCard[];
  /**
   * Board-level changes, which carry no card: lanes or categories were edited.
   * A client seeing one re-reads the whole board rather than patching it.
   */
  events: { seq: number; verb: string }[];
}

/**
 * What an import would do, before it does any of it.
 *
 * ⚠️ Read from the FOLDER on this machine, not from the cloud. Every number
 * here is about files that have not been migrated yet — which is why the screen
 * showing it is the one that says a board has no cards.
 */
export interface ImportPreview {
  workspaceId: string;
  /** The folder these numbers came from, or null when none is linked. */
  folder: string | null;
  cards: number;
  byColumn: Record<string, number>;
  checklistItems: number;
  withTaskId: number;
  duplicateTaskIds: string[];
  /** Ticked boxes whose moment has to be inferred — never a fact. */
  inferredCheckedAt: number;
  /** Options belonging to a "pick ONE" group, which travel as a group. */
  groups: number;
  /** Items decided against; they travel as unchecked rows keeping the marker. */
  dropped: number;
  attachments: number;
  auditEventsLeftBehind: number | null;
  /**
   * Why this project must not be migrated from this app, or null.
   *
   * ⚠️ Not an error — a refusal with a reason. A repo carrying its own
   * `.agents/reviews/config.json` can rename lanes and re-map statuses, and this
   * app reads the defaults only; importing it from here would file cards into
   * lanes the board does not have.
   */
  blocked: string | null;
  problems: { path: string; reason: string }[];
}

export interface ImportReport {
  summary: Record<string, number>;
  receipts: {
    ref: string;
    status: string;
    taskId?: string | null;
    error?: string;
  }[];
  /** Set once the cutover has been sealed against a verified count. */
  migratedAt?: string | null;
  /** Set when the whole run stopped; records already accepted are on the board. */
  error?: string | null;
}

/**
 * One review card as read from a FILE, without opening its body.
 *
 * ⚠️ Front matter and the first heading, and nothing else. The definition of
 * "what a checklist item is" lives in one place — `scanTaskBlocks`/`parseDoc` in
 * the Lanework board — and a second reader of a card's BODY in this app is how
 * the two start disagreeing on a hand-edited card. Front matter is a fixed set
 * of `key: value` lines that no parser has an opinion about, so reading it
 * cannot drift; that is the whole reason this stops where it does.
 */
export interface LocalFolderCard {
  /** Path relative to the folder, so it reads like the file it came from. */
  ref: string;
  taskId: string | null;
  title: string;
  status: string | null;
  category: string | null;
  createdAt: string | null;
}

/**
 * What a folder on this machine turned out to hold.
 *
 * ⚠️ Deliberately NOT a board. There is no checklist progress here and no card
 * body — this exists to answer "did I point at the right project, and what is
 * in it", so the user can decide whether to migrate it. Rendering cards from
 * files is a different feature with a different cost (it needs the board's own
 * parsers, which live in another repo).
 */
export interface LocalFolderSummary {
  path: string;
  /** Where the cards were found, relative to `path`, or null when there are none. */
  reviewRoot: string | null;
  cards: number;
  /** Card counts by front-matter `status`, e.g. `{ done: 9, todo: 5 }`. */
  byStatus: Record<string, number>;
  /** Card counts by front-matter `category`, e.g. `{ backend: 6 }`. */
  byCategory: Record<string, number>;
  /** The newest `created_at` seen, or null when no card carries one. */
  newest: string | null;
  /** Files under the review root this reader could not read at all. */
  unreadable: number;
  /**
   * True when the scan stopped at its own limit, so every count above is a
   * FLOOR rather than a total.
   *
   * ⚠️ Reported rather than swallowed. A cap that silently truncates makes a
   * big repo look small, and "you have 2000 cards" would then be the one number
   * on screen that is wrong in the direction that matters.
   */
  capped: boolean;
  /** True when the folder has no `.agents` directory — a different sentence. */
  looksUnrelated: boolean;
  /** The first few cards, for a "is this the right project" glance. */
  sample: LocalFolderCard[];
}

/**
 * Whether this workspace has a folder on this machine, and what is in it.
 *
 * ⚠️ `missing` is its own case rather than falling back to `none`. A folder that
 * was linked and has since been moved or deleted is a fact worth saying — "no
 * folder linked" would invite the user to link it again and be surprised.
 */
export type LocalFolderState =
  | { kind: "none" }
  /**
   * ⚠️ `summary` describes the PRIMARY folder; `others` are the rest, path only.
   * A project can be assembled from several folders — that is what the create
   * dialog asks for — but only one of them holds the `.agents/reviews` a
   * migration reads, so reading all of them would produce a count that belongs
   * to no folder in particular.
   */
  | { kind: "linked"; summary: LocalFolderSummary; others: string[] }
  | { kind: "missing"; path: string };

/**
 * A folder the user just chose in the OS chooser, on its way back to a window.
 *
 * ⚠️ `id` is what travels BACK to main, never `path`. The chooser runs in main
 * and mints an id per chosen folder; `path` rides along so the dialog can show
 * what was picked. A create call that took paths would be a channel that reads
 * any folder the renderer names — see `DesktopFolderApi`.
 */
export interface PickedFolder {
  id: string;
  path: string;
  /** The last path segment, which is what a list of folders reads by. */
  name: string;
}

export const workspaceChannels = {
  load: "workspaces:load",
  select: "workspaces:select",
  board: "workspaces:board",
  move: "workspaces:board:move",
  toggle: "workspaces:board:toggle",
  setChecklist: "workspaces:board:checklist",
  create: "workspaces:board:create",
  archive: "workspaces:board:archive",
  importPreview: "workspaces:import:preview",
  importRun: "workspaces:import:run",
  importSeal: "workspaces:import:seal",
  update: "workspaces:board:update",
  card: "workspaces:board:card",
  lookup: "workspaces:board:lookup",
  changes: "workspaces:board:changes",
  createWorkspace: "workspaces:new",
  renameWorkspace: "workspaces:rename",
  deleteWorkspace: "workspaces:delete",
  folderState: "workspaces:folder:state",
  folderPick: "workspaces:folder:pick",
  folderChoose: "workspaces:folder:choose",
  folderList: "workspaces:folder:list",
  folderLink: "workspaces:folder:link",
  folderForget: "workspaces:folder:forget",
  folderReveal: "workspaces:folder:reveal",
} as const;

export interface DesktopBoardApi {
  load: (workspaceId: string) => Promise<BoardView>;
  /**
   * One card WITH its checklist and assignees, by id.
   *
   * ⚠️ A second read, and not a redundant one: `load` reads the board through
   * `GET /items`, which serializes without parts. Every screen that shows a
   * card's decisions has to ask for that card by itself.
   */
  card: (workspaceId: string, cardId: string) => Promise<BoardCard>;
  /**
   * The same card, addressed the way a human says it — `FE-06`.
   *
   * ⚠️ Answers null for "no such card", which is a real answer here rather than
   * a failure: a deep link can name a task id that was never minted, and the
   * board's own route makes that a 404 precisely so it cannot be confused with
   * a read that failed.
   */
  lookup: (workspaceId: string, taskId: string) => Promise<BoardCard | null>;
  /**
   * Edit a card, against the revision the caller is looking at.
   *
   * ⚠️ `revision` is not optional. The endpoint answers 428 without `If-Match`,
   * and making the precondition a parameter rather than a convenience is what
   * stops an edit from silently landing on somebody else's newer card.
   */
  update: (
    workspaceId: string,
    cardId: string,
    patch: BoardCardPatch,
    revision: number,
  ) => Promise<BoardWrite>;
  /**
   * Move a card between lanes, within a lane, or both.
   *
   * ⚠️ `columnKey: null` means "stay in this lane" — a pure reorder. A single
   * atomic request either way, because a move that changed the lane and then
   * the position would be two writes a second client could interleave with.
   */
  move: (
    workspaceId: string,
    cardId: string,
    columnKey: string | null,
    placement?: BoardPlacement,
  ) => Promise<BoardWrite>;
  /** What changed since `since`; pass 0 for a first read. */
  changes: (workspaceId: string, since: number) => Promise<BoardChanges>;
  toggle: (
    workspaceId: string,
    cardId: string,
    key: string,
    checked: boolean,
    /** The revision the user is looking at — sent as `If-Match`. */
    revision: number,
  ) => Promise<BoardWrite>;
  /**
   * Replace a card's whole checklist — the one call that creates, edits,
   * reorders and deletes rows.
   *
   * ⚠️ A REPLACE, not a set of row operations, because that is what the board
   * offers and it is the honest shape: a checklist is an ordered document, and
   * "delete row 3" is ambiguous the moment a second person is editing. Send
   * back the keys you read and ticked boxes survive the rewrite.
   */
  setChecklist: (
    workspaceId: string,
    cardId: string,
    items: BoardChecklistDraft[],
    revision: number,
  ) => Promise<BoardWrite>;
  /**
   * Put a new card on the board.
   *
   * ⚠️ A DRAFT, not a title. The board mints a card's issue key from its
   * CATEGORY (`taskId` stays null without one), so a create that could only
   * send a title produced cards with no key — unreachable by ⌘K, undeep-linkable
   * and unnamed in every list that shows one. Every field here is one the
   * service already accepts on `POST /items`; only `title` is required, and the
   * board picks its own first lane when `columnKey` is absent.
   */
  create: (workspaceId: string, draft: BoardCardDraft) => Promise<BoardWrite>;
  /**
   * Take a card off the board.
   *
   * ⚠️ The service ARCHIVES rather than deletes — a tombstone with its own `seq`
   * — because a row that simply vanished could not be reported by the change
   * feed, and every other client holding that card would keep drawing it. It is
   * called `archive` here for that reason and "Delete" on screen, where the
   * word has to mean what a person meant by right-clicking a card.
   *
   * ⚠️ Answers nothing. The board is re-read afterwards rather than patched from
   * a response: an archive changes what every lane's ranks and counts say, and
   * a client that spliced one row out of its own copy would be guessing at the
   * rest.
   */
  archive: (workspaceId: string, cardId: string) => Promise<void>;
  importPreview: (workspaceId: string) => Promise<ImportPreview>;
  importRun: (workspaceId: string) => Promise<ImportReport>;
  /**
   * Hand the board over: the cloud owns these cards from now on.
   *
   * ⚠️ A SECOND call, after `importRun`, on purpose. The cutover is what puts
   * every local writer into read-only, so it is taken with the receipts of the
   * import already on screen — one button that did both would change a board's
   * source of truth while somebody was still reading whether it worked.
   */
  importSeal: (workspaceId: string) => Promise<ImportReport>;
}

/**
 * The folder on this machine a workspace's cards still live in.
 *
 * ⚠️ Every method is keyed by SLUG, not by the cloud workspace id. The id is
 * absent exactly when this surface matters most — a service that predates the
 * field sends none, and that is the screen where a user is told the board
 * cannot be opened — so keying on the id would make the feature unavailable in
 * its own main case. And a slug is STABLE: no route on the service can change
 * one — the rename validator refuses the field outright — so a link keyed by it
 * is not something a rename can strand.
 *
 * ⚠️ No method takes a PATH from the renderer. `pick` opens the OS folder
 * chooser in the main process, so the only paths this app ever reads are ones a
 * human selected or ones it wrote down itself.
 */
export interface DesktopFolderApi {
  state: (slug: string) => Promise<LocalFolderState>;
  /**
   * Open the OS chooser and answer with what was picked — many folders at once.
   *
   * ⚠️ Bound to no workspace, because the main caller is the create dialog:
   * the folders are chosen BEFORE the project they belong to exists. Nothing is
   * written down here; the ids are spent by `create`.
   */
  choose: () => Promise<PickedFolder[]>;
  /**
   * The folders linked to a workspace, primary first, as addressable ids.
   *
   * ⚠️ The same shape `choose` answers with, and that is the point: an editor
   * works on ONE list — what is linked plus what was just picked — and hands
   * the whole thing back to `link`. Ids for folders this app already holds are
   * minted here, so nothing has to accept a path to keep one.
   */
  list: (slug: string) => Promise<PickedFolder[]>;
  /**
   * Replace a workspace's folders with exactly these, primary first.
   *
   * ⚠️ A REPLACE. The editor states the whole set — that is what makes remove
   * and reorder expressible at all — and an empty list unlinks the workspace,
   * which is the same thing `forget` does.
   */
  link: (slug: string, folders: string[]) => Promise<LocalFolderState>;
  pick: (slug: string) => Promise<LocalFolderState>;
  forget: (slug: string) => Promise<LocalFolderState>;
  reveal: (slug: string) => Promise<void>;
}

export interface DesktopWorkspacesApi {
  load: () => Promise<WorkspaceSnapshot>;
  select: (id: string) => Promise<WorkspaceSnapshot>;
  /**
   * Create a project on the account and open it.
   *
   * ⚠️ Takes the NAME a human typed, not a slug. The slug is derived in main
   * (`slug.ts`) because the service refuses to derive one, and asking a user
   * for a url-safe key is asking them to do a computer's job.
   *
   * ⚠️ `folders` are `PickedFolder` IDS, in order, and the first one is the
   * primary — the folder every single-folder surface (the migration, "open in
   * file manager") means. Ids rather than paths so this channel cannot be asked
   * to link a folder the user never chose.
   */
  create: (name: string, folders?: string[]) => Promise<WorkspaceSnapshot>;
  /**
   * Rename a project on the account, by CLOUD WORKSPACE ID.
   *
   * ⚠️ Only the display name moves. The SLUG is immutable service-wide — the
   * rename validator refuses the field rather than ignoring it — so the folder
   * link, the remembered selection and every other slug-keyed row survive a
   * rename untouched. A rename here is not the local-folder equivalent either:
   * it changes the project on the account, for every machine.
   *
   * ⚠️ Keyed by ID, unlike `remove`, and the asymmetry is deliberate. A delete
   * has to reach a project with no cloud id — that is the project someone most
   * wants rid of — while a rename is a cloud write that a service old enough to
   * send no id has no route for anyway. A workspace whose `id` is null is
   * therefore un-renameable, and the screen says which rather than calling.
   */
  rename: (id: string, name: string) => Promise<WorkspaceSnapshot>;
  /**
   * Delete a project from the ACCOUNT, by slug, and answer with what is left.
   *
   * ⚠️ Not "remove it from this machine": the service deletes the row and
   * cascades the paths every machine reported for it. It cannot be undone from
   * here — the human surface archives, this one deletes — so the only caller is
   * behind a confirmation that says so.
   *
   * ⚠️ Takes BOTH keys. The machine surface deletes by cloud id and refuses a
   * slug with a 400 — it took the slug until the service moved it, precisely
   * because a uuid matches its slug shape and the mix-up used to answer "200,
   * deleted nothing". The slug is still needed on this side: the folder link
   * this machine drops afterwards is keyed by it.
   *
   * ⚠️ So a project with NO cloud id cannot be deleted from here, and the button
   * is disabled with that reason on it. That is a service older than the `id`
   * field, the same state that stops the project's board from opening.
   */
  remove: (id: string, slug: string) => Promise<WorkspaceSnapshot>;
  board: DesktopBoardApi;
  folder: DesktopFolderApi;
}
