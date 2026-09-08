export interface Workspace {
  /**
   * The cloud workspace id — the key everything board-related is addressed by.
   *
   * ⚠️ Not the slug. Every board endpoint is `/v1/boards/:workspaceId/…`, and a
   * slug is a per-account display key that a rename can move. It arrives on
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

/** One checklist row. `checked` is derived from `checkedAt` by the server. */
export interface BoardChecklistItem {
  key: string;
  section: string;
  text: string;
  checked: boolean;
  checkedAt: string | null;
  note: string | null;
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
  checklist: BoardChecklistItem[];
}

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

export type BoardWrite =
  | { kind: "ok"; card: BoardCard }
  | BoardConflict
  | { kind: "error"; message: string };

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
  | { kind: "linked"; summary: LocalFolderSummary }
  | { kind: "missing"; path: string };

export const workspaceChannels = {
  load: "workspaces:load",
  select: "workspaces:select",
  board: "workspaces:board",
  move: "workspaces:board:move",
  toggle: "workspaces:board:toggle",
  create: "workspaces:board:create",
  importPreview: "workspaces:import:preview",
  importRun: "workspaces:import:run",
  importSeal: "workspaces:import:seal",
  createWorkspace: "workspaces:new",
  folderState: "workspaces:folder:state",
  folderPick: "workspaces:folder:pick",
  folderForget: "workspaces:folder:forget",
  folderReveal: "workspaces:folder:reveal",
} as const;

export interface DesktopBoardApi {
  load: (workspaceId: string) => Promise<BoardView>;
  move: (
    workspaceId: string,
    cardId: string,
    columnKey: string,
  ) => Promise<BoardWrite>;
  toggle: (
    workspaceId: string,
    cardId: string,
    key: string,
    checked: boolean,
    /** The revision the user is looking at — sent as `If-Match`. */
    revision: number,
  ) => Promise<BoardWrite>;
  create: (workspaceId: string, title: string) => Promise<BoardWrite>;
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
 * its own main case. A renamed slug loses the link and the user picks the
 * folder again, which is a smaller cost than not being able to link it at all.
 *
 * ⚠️ No method takes a PATH from the renderer. `pick` opens the OS folder
 * chooser in the main process, so the only paths this app ever reads are ones a
 * human selected or ones it wrote down itself.
 */
export interface DesktopFolderApi {
  state: (slug: string) => Promise<LocalFolderState>;
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
   */
  create: (name: string) => Promise<WorkspaceSnapshot>;
  board: DesktopBoardApi;
  folder: DesktopFolderApi;
}
