import { create } from "zustand";
import { byRank } from "#/lib/board-view";
import { ipcMessage } from "#/lib/ipc-error";
import { desktopSurface } from "#/server/desktop";
import {
  type BoardActivity,
  type BoardCard,
  type BoardCardDraft,
  type BoardCardPatch,
  type BoardChecklistDraft,
  type BoardConflict,
  type BoardQuery,
  type BoardView,
  boardQueryKey,
  DEFAULT_BOARD_QUERY,
  type Workspace,
} from "../../shared/workspaces";

/**
 * Request tickets, one counter per read that can be in flight twice.
 *
 * NOTE: Without these, two overlapping reads land in whatever order the
 * network returns them, and the older one can win. Press "Try again" while a
 * slow failure is still running: the failure arrives last and replaces the
 * list just fetched with the error it started before.
 */
const ticket = { workspaces: 0, board: 0, detail: 0 };

/** The workspace read in flight, so overlapping callers share one request. */
let inflight: Promise<void> | null = null;

/**
 * The boards this window has shown, by workspace id, most recent last.
 *
 * Kept so a project draws at once when you come back to it (FE-15/D2).
 *
 * NOTE: In memory only, and never trusted on its own. Coming back to a
 * project draws its last board at once, then asks the change feed what
 * happened since its cursor: one small read instead of three, and no
 * skeleton. A board-level event in that feed still re-reads everything, as
 * `poll` does. The saved copy on disk (for offline) is main's, and separate.
 */
const boards = new Map<string, { view: BoardView; cursor: number }>();
const MAX_BOARDS = 8;

function remember(view: BoardView, cursor: number): void {
  boards.delete(view.workspaceId);
  boards.set(view.workspaceId, { view, cursor });
  if (boards.size > MAX_BOARDS) {
    const oldest = boards.keys().next().value;
    if (oldest !== undefined) boards.delete(oldest);
  }
}

interface BoardState {
  /** True once the workspace list has settled, successfully or not. */
  ready: boolean;
  workspaces: Workspace[];
  active: Workspace | null;
  view: BoardView | null;
  loading: boolean;
  error: string | null;
  /**
   * A write that lost a race, kept whole.
   *
   * Its own field rather than an error string. The API's 409 carries the card
   * as it stands now, so the screen can show both sides and let a person pick
   * the right version, instead of just "try again".
   */
  conflict: BoardConflict | null;
  /** The key of the write in flight, so exactly one control shows as busy. */
  busy: string | null;
  /**
   * The change cursor, echoed from the server.
   *
   * Never derived.
   */
  cursor: number;
  /**
   * The slug the account does not have, or null.
   *
   * NOTE: The slug, not a boolean. It is set while one URL is open and read on
   * the next screen's first render. A flag would outlive its project: opening
   * a project that exists could bounce back to the picker on an answer about a
   * different one. A value that names its project cannot be misread.
   */
  notFound: string | null;
  /**
   * True once a workspace list was read successfully at least once.
   *
   * NOTE: Distinct from `ready`, which only means the first attempt settled,
   * and is true after a failure too. The difference decides whether "this
   * project is not in the list" is a fact about the account or a request that
   * did not come back. Those two need different answers.
   */
  listLoaded: boolean;

  /** The open card with its checklist, which the board list does not carry. */
  detail: BoardCard | null;
  detailLoading: boolean;
  detailError: string | null;

  /**
   * The open card's history and thread, oldest first.
   *
   * NOTE: Keyed by card id alongside the entries, because the feed and the
   * card are two reads that land separately. Without it, opening a second card
   * shows the first one's activity until the new read lands.
   */
  activity: { cardId: string; events: BoardActivity[] } | null;
  activityCursor: string | null;
  activityLoading: boolean;

  /**
   * What the open board is read under: its grouping and filters.
   *
   * The issues screen sets it from its URL; every other screen reads the
   * default.
   */
  query: BoardQuery;
  /** The group whose next page is on its way, so one button shows busy. */
  moreLoading: string | null;
  hydrate: () => Promise<void>;
  open: (slug: string) => Promise<void>;
  reload: () => Promise<void>;
  poll: () => Promise<void>;
  /**
   * Read the board under a new query, when it is the open one and the groups
   * on screen were read under another.
   */
  setQuery: (slug: string, query: BoardQuery) => void;
  /** Read the next page of one group: the "Load more" row at its end. */
  loadMore: (group: string) => Promise<void>;
  /** Read the counts again, after something on the board changed. */
  refreshStats: () => Promise<void>;
  /**
   * Create a project on the account and make it the active one.
   *
   * Answers with the failure instead of setting `error`. The switcher is a
   * popover with the field still in it, and "that key is taken" belongs beside
   * the refused name, not in a banner on the page behind it.
   *
   * @returns The new project, or the failure, ready to show.
   */
  createProject: (
    name: string,
    /**
     * `PickedFolder` ids, primary first.
     *
     * Empty or missing when none were chosen.
     */
    folders?: string[],
  ) => Promise<{ workspace: Workspace | null } | { error: string }>;
  /**
   * Rename a project on the account, by cloud workspace id.
   *
   * Answers with the failure rather than setting `error`, as `createProject`
   * does: the caller is a field with the refused name still in it.
   *
   * @returns The failure, ready to show, when it did not save.
   */
  renameProject: (id: string, name: string) => Promise<{ error?: string }>;
  /**
   * Put the account's projects in this order, by slug, first to last.
   *
   * Optimistic: the list moves at once and the write follows. A failure puts
   * back the order from before and answers with why, to the list that just
   * moved.
   *
   * @returns The failure, ready to show, when it did not save.
   */
  reorderProjects: (slugs: string[]) => Promise<{ error?: string }>;
  /**
   * Delete a project from the account.
   *
   * Answers with the failure rather than setting `error`, as `createProject`
   * does: the caller is a dialog, and "that did not work" belongs beside the
   * button that was pressed.
   *
   * @param id The cloud workspace id, for the service.
   * @param slug The project's slug, for everything on this machine.
   * @returns The failure, ready to show, when it did not delete.
   */
  deleteProject: (id: string, slug: string) => Promise<{ error?: string }>;
  /**
   * Permanently remove every issue on a project's board.
   *
   * Busy as `purge:<slug>`.
   *
   * @returns How many cards went, or the reason nothing did.
   */
  purgeIssues: (
    id: string,
    slug: string,
  ) => Promise<{ error?: string; deleted?: number }>;
  /**
   * Put a new card on the board.
   *
   * NOTE: Answers with the card the board minted. The composer navigates to
   * the issue it just created, and the server mints the key it navigates by
   * (`FE-06`). Finding it again by title in the reloaded list would be a
   * guess, and wrong as soon as two cards share a title.
   *
   * @returns The new card, or the failure, ready to show.
   */
  createCard: (
    draft: BoardCardDraft,
  ) => Promise<{ card?: BoardCard; error?: string }>;
  /**
   * Take a card off the board.
   *
   * Answers with the failure as well as setting `error`. The caller is a
   * confirmation dialog, and one that closed on a delete that did not happen
   * would hide the reason.
   *
   * @returns The failure, ready to show, when it did not delete.
   */
  archiveCard: (cardId: string) => Promise<{ error?: string }>;
  move: (
    cardId: string,
    columnKey: string | null,
    placement?: { after: string } | { before: string },
  ) => Promise<void>;
  update: (
    cardId: string,
    patch: BoardCardPatch,
    revision: number,
  ) => Promise<void>;
  toggle: (
    cardId: string,
    key: string,
    checked: boolean,
    revision: number,
  ) => Promise<void>;
  setChecklist: (
    cardId: string,
    items: BoardChecklistDraft[],
    revision: number,
  ) => Promise<void>;
  /**
   * Tick `keys` on `card` in one write, each with `note` under it.
   *
   * These are the recommendations a person just approved in the
   * hand-to-agent dialog (FE-34/D4a).
   *
   * @returns The card as the service now has it, or null when it was refused.
   * The reason is then in `error` or `conflict`, as for any other write.
   */
  approve: (
    card: BoardCard,
    keys: string[],
    note: string,
  ) => Promise<BoardCard | null>;
  /**
   * Read a card with its checklist, by id.
   *
   * For a lane card, whose list read carries none.
   *
   * @returns Null when it cannot be read.
   */
  readCard: (cardId: string) => Promise<BoardCard | null>;
  /**
   * Checklist ticks made on the open card and not saved yet (FE-13/D7).
   *
   * NOTE: The desired state per key, compared against the card when it is
   * read, never a list of clicks. A tick flipped back, or one a poll shows
   * someone else already made, stops being a change by itself; nothing has to
   * prune it. It lives beside `detail`, not inside it, so a poll that re-reads
   * the card cannot overwrite what is being decided.
   */
  draft: { cardId: string; checked: Record<string, boolean> } | null;
  /** Tick or untick one box in the draft. */
  stageTick: (cardId: string, key: string, checked: boolean) => void;
  /**
   * Pick one option of a "pick ONE" group in the draft.
   *
   * @param group Every key of the group; all but `key` go off.
   */
  stagePick: (cardId: string, group: string[], key: string) => void;
  discardDraft: () => void;
  /** Send the draft as one checklist write. */
  saveDraft: () => Promise<void>;
  openIssue: (taskId: string) => Promise<void>;
  /** Re-read the open card by id, after a write that changed its parts. */
  refreshDetail: (cardId: string) => Promise<void>;
  /**
   * Read the card's activity.
   *
   * @param more Append the next page instead of reading the first again.
   */
  loadActivity: (cardId: string, more?: boolean) => Promise<void>;
  comment: (cardId: string, body: string) => Promise<{ error?: string }>;
  editComment: (
    cardId: string,
    commentId: string,
    body: string,
  ) => Promise<{ error?: string }>;
  deleteComment: (
    cardId: string,
    commentId: string,
  ) => Promise<{ error?: string }>;
  setSubscribed: (cardId: string, subscribed: boolean) => Promise<void>;
  setFavorite: (cardId: string, favorite: boolean) => Promise<void>;
  closeIssue: () => void;
  dismiss: () => void;
}

/**
 * Re-rank one lane locally, so a dropped card sits where it was dropped.
 *
 * NOTE: Local ranks are provisional; the server's replace them on the next
 * read. They are padded indices, not a fractional index: two clients that
 * compute real ranks themselves end up picking the same one. That is why
 * `placement` exists and why nothing here is ever sent to the board.
 */
function reorder(
  cards: BoardCard[],
  cardId: string,
  columnKey: string,
  placement?: { after: string } | { before: string },
): BoardCard[] {
  const moving = cards.find((card) => card.id === cardId);
  if (!moving) return cards;
  const lane = cards
    .filter((card) => card.columnKey === columnKey && card.id !== cardId)
    .sort(byRank);
  const anchor =
    placement && "after" in placement ? placement.after : placement?.before;
  const at = anchor ? lane.findIndex((card) => card.id === anchor) : -1;
  const next = { ...moving, columnKey };
  if (at === -1) lane.push(next);
  else lane.splice(placement && "after" in placement ? at + 1 : at, 0, next);
  const ranked = new Map(
    lane.map((card, index) => [card.id, String(index + 1).padStart(6, "0")]),
  );
  return cards.map((card) => {
    const rank = ranked.get(card.id);
    if (!rank) return card;
    return card.id === cardId ? { ...next, rank } : { ...card, rank };
  });
}

/** The ids of one lane, in board order. */
const laneOrder = (cards: BoardCard[], columnKey: string): string[] =>
  cards
    .filter((card) => card.columnKey === columnKey)
    .sort(byRank)
    .map((card) => card.id);

/**
 * Whether a lane came out of {@link reorder} in the order it went in.
 *
 * NOTE: Compares ids, not ranks. {@link reorder} always rewrites the lane's
 * ranks to padded indices, so they never match the server's, and comparing
 * them would call every drop a change.
 */
const sameOrder = (before: string[], after: string[]): boolean =>
  before.length === after.length &&
  before.every((id, index) => id === after[index]);

/**
 * The request ticket for project reorders.
 *
 * Bumped by every reorder, so only the newest one's answer is applied.
 */
let reorders = 0;

export const useBoard = create<BoardState>()((set, get) => ({
  ready: false,
  workspaces: [],
  active: null,
  view: null,
  loading: false,
  error: null,
  conflict: null,
  busy: null,
  cursor: 0,
  notFound: null,
  listLoaded: false,
  query: DEFAULT_BOARD_QUERY,
  moreLoading: null,
  detail: null,
  draft: null,
  detailLoading: false,
  detailError: null,
  activity: null,
  activityCursor: null,
  activityLoading: false,

  hydrate: async () => {
    // Everyone waiting on the list waits on the same read. Two screens can
    // ask at once (the landing page and the project layout do on a cold
    // navigation), and two requests for one answer only double main's log
    // when the service is down.
    if (inflight !== null) return inflight;
    const mine = ++ticket.workspaces;
    inflight = (async () => {
      try {
        const snapshot = await desktopSurface("workspaces").load();
        if (mine !== ticket.workspaces) return;
        set({
          ready: true,
          listLoaded: true,
          workspaces: snapshot.workspaces,
          active: snapshot.active,
          error: null,
        });
      } catch (error) {
        if (mine !== ticket.workspaces) return;
        // NOTE: `workspaces` and `listLoaded` are left alone. A failed read
        // says nothing about the list it could not fetch, and the last one
        // read is still the best answer.
        set({
          ready: true,
          error: ipcMessage(
            error,
            "Could not load your workspaces. Try again.",
          ),
        });
      }
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  },

  /**
   * Open one project by its slug, which is what the URL carries.
   *
   * The slug is the address a person can read and link to; every board call
   * underneath is keyed by the cloud workspace id. One is resolved to the
   * other here, once, rather than in every screen.
   */
  open: async (slug) => {
    // NOTE: The list refresh lives here, not in the layout that calls this.
    // Doing it in both asks twice and logs twice on every failed load.
    //
    // The list is read again only when it cannot answer (FE-15/D4): never read
    // yet, or the slug is not on it (a project made on another machine since).
    // Re-reading it on every switch costs a round trip per click. "Try again"
    // reaches `hydrate` on its own.
    const known = (entry: Workspace) => entry.slug === slug;
    if (!get().listLoaded || !get().workspaces.some(known))
      await get().hydrate();
    const workspace = get().workspaces.find(known) ?? null;
    if (!workspace) {
      // NOTE: "Gone" is a claim about the account, and only a list this app
      // has read can support it. Concluded from a failed read, it sends the
      // picker a project that exists, and the picker navigates straight back:
      // a loop of requests, "Opening your project…" on screen, and main's log
      // filling with the same failure. Leave the error on screen instead.
      if (!get().listLoaded) {
        set({ view: null, loading: false });
        return;
      }
      // A flag rather than an error banner. The project in the URL is gone
      // (deleted on the account, or a remembered selection was cleared), and
      // the useful answer is the picker, not a red box on a board that cannot
      // load.
      set({ active: null, view: null, notFound: slug });
      return;
    }
    const cached = workspace.id ? boards.get(workspace.id) : undefined;
    // NOTE: A new ticket, so a read still in flight for the project being
    // left cannot land on this one.
    ++ticket.board;
    set({
      active: workspace,
      view: cached?.view ?? null,
      cursor: cached?.cursor ?? 0,
      loading: false,
      error: null,
      notFound: null,
    });
    // Remembered on this machine, so the next launch opens the same project.
    await desktopSurface("workspaces")
      .select(workspace.id ?? workspace.slug)
      .catch(() => undefined);
    if (get().active?.id !== workspace.id) return;
    // The board on screen is the cached one; the feed says what changed since.
    // Cached under another grouping or filter, its groups are the wrong ones:
    // it stays on screen while the right ones are read.
    if (cached && cached.view.query === boardQueryKey(get().query))
      await get().poll();
    else await get().reload();
  },

  reload: async () => {
    const workspace = get().active;
    if (!workspace?.id) {
      set({ loading: false });
      return;
    }
    const mine = ++ticket.board;
    set({ loading: true });
    try {
      const view = await desktopSurface("workspaces").board.load(
        workspace.id,
        get().query,
      );
      if (mine !== ticket.board) return;
      set({ view, loading: false, error: null });
      // The board read hands back a head; start the change cursor there so the
      // first poll reports what happened after this read, not the whole board.
      // A grouped read already carries it; asking the feed from zero would
      // scan a page of the feed for one number.
      if (typeof view.head === "number") set({ cursor: view.head });
      else {
        const changes = await desktopSurface("workspaces")
          .board.changes(workspace.id, get().cursor)
          .catch(() => null);
        if (changes && mine === ticket.board) set({ cursor: changes.head });
      }
      if (mine === ticket.board) remember(view, get().cursor);
    } catch (error) {
      if (mine !== ticket.board) return;
      set({
        loading: false,
        error: ipcMessage(error, "Could not load this board. Try again."),
      });
    }
  },

  /**
   * Catch up on what changed elsewhere.
   *
   * A board-level event means the lanes changed, which patching cards cannot
   * express, so it re-reads everything rather than guessing.
   */
  poll: async () => {
    const { active, view, cursor } = get();
    if (!active?.id || !view || get().loading) return;
    const mine = ticket.board;
    try {
      const changes = await desktopSurface("workspaces").board.changes(
        active.id,
        cursor,
      );
      // NOTE: The project may have changed while this was in flight; its
      // cards must not be merged into the next one's board.
      if (mine !== ticket.board || get().active?.id !== active.id) return;
      // More than one page behind (a cached board after a long absence) is
      // cheaper and safer to read whole than to page through.
      if (changes.events.length || changes.hasMore) {
        await get().reload();
        return;
      }
      if (!changes.cards.length) {
        set({ cursor: changes.nextSince });
        remember(view, changes.nextSince);
        return;
      }
      const byId = new Map(changes.cards.map((card) => [card.id, card]));
      const merged = view.cards.map((card) => byId.get(card.id) ?? card);
      for (const card of changes.cards)
        if (!view.cards.some((entry) => entry.id === card.id))
          merged.push(card);
      // NOTE: A tombstone leaves the board. The feed is the only place a card
      // archived elsewhere is reported; merged back in, it would draw a card
      // that no longer exists until the next whole-board read.
      const next = {
        ...view,
        cards: merged.filter((card) => !card.archivedAt),
      };
      set({ view: next, cursor: changes.nextSince });
      remember(next, changes.nextSince);
      // Cards moved, arrived or left: the counts are stale now.
      await get().refreshStats();
    } catch {
      // A failed poll is not an error the user has to see: the board on screen
      // is still the last thing the server said.
    }
  },

  setQuery: (slug, query) => {
    if (boardQueryKey(query) === boardQueryKey(get().query)) return;
    set({ query });
    const { active, view } = get();
    // Only the open board is re-read, and only once it has one. On the way
    // into a project the issues screen sets its query before the layout has
    // opened anything, and `open` reads under it anyway.
    if (active?.slug === slug && view && view.query !== boardQueryKey(query))
      void get().reload();
  },

  loadMore: async (group) => {
    const { active, view, query, moreLoading } = get();
    const cursor = view?.groups?.[group]?.cursor;
    if (!active?.id || !view || !cursor || moreLoading) return;
    const mine = ticket.board;
    set({ moreLoading: group });
    try {
      const page = await desktopSurface("workspaces").board.more(
        active.id,
        query,
        group,
        cursor,
      );
      const current = get().view;
      if (mine !== ticket.board || !current || current.query !== view.query)
        return;
      const known = new Set(current.cards.map((card) => card.id));
      const next: BoardView = {
        ...current,
        cards: [
          ...current.cards,
          ...page.cards.filter((card) => !known.has(card.id)),
        ],
        groups: {
          ...current.groups,
          [group]: {
            limit: current.groups?.[group]?.limit ?? page.cards.length,
            cursor: page.cursor,
          },
        },
      };
      set({ view: next });
      remember(next, get().cursor);
    } catch (error) {
      set({
        error: ipcMessage(error, "Could not load more cards. Try again."),
      });
    } finally {
      set({ moreLoading: null });
    }
  },

  refreshStats: async () => {
    const { active, view, query } = get();
    if (!active?.id || !view || view.stats === undefined || view.stats === null)
      return;
    const mine = ticket.board;
    const counts = await desktopSurface("workspaces")
      .board.stats(active.id, query)
      .catch(() => null);
    const current = get().view;
    if (!counts || mine !== ticket.board || !current) return;
    const next = { ...current, stats: counts.stats, total: counts.total };
    set({ view: next });
    remember(next, get().cursor);
  },

  createProject: async (name, folders) => {
    set({ busy: "project", error: null });
    try {
      const snapshot = await desktopSurface("workspaces").create(
        name.trim(),
        folders,
      );
      set({
        workspaces: snapshot.workspaces,
        active: snapshot.active,
        busy: null,
        notFound: null,
      });
      return { workspace: snapshot.active };
    } catch (error) {
      set({ busy: null });
      return {
        error: ipcMessage(error, "Could not create that project. Try again."),
      };
    }
  },

  renameProject: async (id, name) => {
    set({ busy: `rename:${id}`, error: null });
    try {
      const snapshot = await desktopSurface("workspaces").rename(
        id,
        name.trim(),
      );
      set({
        workspaces: snapshot.workspaces,
        active: snapshot.active,
        busy: null,
      });
      return {};
    } catch (error) {
      set({ busy: null });
      return {
        error: ipcMessage(error, "Could not rename that project. Try again."),
      };
    }
  },

  reorderProjects: async (slugs) => {
    const before = get().workspaces;
    const bySlug = new Map(before.map((entry) => [entry.slug, entry]));
    const next = slugs.flatMap((slug) => {
      const found = bySlug.get(slug);
      return found ? [found] : [];
    });
    // Only a permutation of what is on screen; anything else is a stale caller.
    if (next.length !== before.length) return {};
    const ids = next.map((entry) => entry.id);
    if (ids.some((id) => id === null))
      return {
        error:
          "A project here has no cloud id yet, so the order cannot be saved.",
      };
    const mine = ++reorders;
    set({ workspaces: next });
    try {
      const snapshot = await desktopSurface("workspaces").reorder(
        ids as string[],
      );
      // NOTE: Only the latest move's answer lands. Two quick moves are two
      // writes, and the first one's reply arriving last would put the list
      // back one step.
      if (mine === reorders)
        set({ workspaces: snapshot.workspaces, active: snapshot.active });
      return {};
    } catch (error) {
      if (mine === reorders) set({ workspaces: before });
      return {
        error: ipcMessage(
          error,
          "Could not save the project order. Try again.",
        ),
      };
    }
  },

  // NOTE: `id` for the service, `slug` for everything on this machine: the
  // folder link main drops, the busy key below, and the open-board check. They
  // are two keyspaces, the service refuses the wrong one, and neither can be
  // derived from the other here.
  deleteProject: async (id, slug) => {
    set({ busy: `delete:${slug}`, error: null });
    try {
      const snapshot = await desktopSurface("workspaces").remove(id, slug);
      boards.delete(id);
      set({
        workspaces: snapshot.workspaces,
        active: snapshot.active,
        busy: null,
        // NOTE: The open board is dropped when it was the one deleted. Cards
        // left on screen would invite edits to a project that no longer
        // exists, and every write would fail one at a time.
        ...(get().active?.slug === slug ? { view: null, cursor: 0 } : {}),
      });
      return {};
    } catch (error) {
      set({ busy: null });
      return {
        error: ipcMessage(error, "Could not delete that project. Try again."),
      };
    }
  },

  purgeIssues: async (id, slug) => {
    set({ busy: `purge:${slug}`, error: null });
    try {
      const { deleted } = await desktopSurface("workspaces").board.purge(
        id,
        slug,
      );
      set({ busy: null });
      // Re-read when it was the open board, rather than emptying `view` here.
      // The lanes, categories and counts come from the service; an empty
      // local copy would be right about the cards and wrong about the rest.
      if (get().active?.id === id) await get().reload();
      return { deleted };
    } catch (error) {
      set({ busy: null });
      return {
        error: ipcMessage(error, "Could not remove the issues. Try again."),
      };
    }
  },

  createCard: async (draft) => {
    const workspace = get().active;
    if (!workspace?.id)
      return { error: "Open a project before adding a card to it." };
    set({ busy: "create", error: null, conflict: null });
    try {
      const result = await desktopSurface("workspaces").board.create(
        workspace.id,
        draft,
      );
      if (result.kind !== "ok") {
        set({ error: result.message });
        return { error: result.message };
      }
      // Reported as an error even though the write succeeded. The board caps
      // tags silently, so this is the only moment somebody learns the fourth
      // tag they typed is not on the card.
      if (result.droppedTags.length)
        set({
          error: `Tags capped at 3 — ${result.droppedTags.join(", ")} not saved.`,
        });
      // NOTE: The change feed, not a whole-board read: the new card is on it,
      // and a re-read would fold every group opened with "Load more" back to
      // its first page.
      await get().poll();
      return { card: result.card };
    } catch (error) {
      const message = ipcMessage(
        error,
        "That card was not created. Try again.",
      );
      set({ error: message });
      return { error: message };
    } finally {
      set({ busy: null });
    }
  },

  archiveCard: async (cardId) => {
    const workspace = get().active;
    if (!workspace?.id) return { error: "This project has no cloud board." };
    set({ busy: cardId, error: null, conflict: null });
    try {
      await desktopSurface("workspaces").board.archive(workspace.id, cardId);
      // NOTE: The server's word, not a splice: the feed carries the tombstone,
      // `poll` takes it off the board, then the counts are asked again. A
      // client that removed the row itself would be guessing. A whole-board
      // read would reset "Load more".
      await get().poll();
      return {};
    } catch (error) {
      const message = ipcMessage(
        error,
        "That card was not deleted. Try again.",
      );
      set({ error: message });
      return { error: message };
    } finally {
      set({ busy: null });
    }
  },

  /**
   * Move a card, and show it moved before the server has said so.
   *
   * One of the few optimistic writes here. A card that snaps back to where it
   * was and then jumps to where it was dropped reads as broken, not slow. A
   * refusal restores the exact list this started from.
   */
  move: async (cardId, columnKey, placement) => {
    const workspace = get().active;
    const view = get().view;
    if (!workspace?.id || !view) return;
    const before = view.cards;
    const card = before.find((entry) => entry.id === cardId);
    if (!card) return;
    const destination = columnKey ?? card.columnKey;
    const cards = reorder(before, cardId, destination, placement);
    // NOTE: A move that moves nothing must not be sent. Putting a card back
    // where it was (on the boundary it already sits against, or into its own
    // lane) leaves the lane as it stands. Sent anyway, the board stamps
    // `updatedAt` on an untouched card, which then claims to be the most
    // recently touched work on the project.
    if (
      destination === card.columnKey &&
      sameOrder(laneOrder(before, destination), laneOrder(cards, destination))
    )
      return;
    set({
      view: { ...view, cards },
      busy: cardId,
      error: null,
      conflict: null,
    });
    try {
      const result = await desktopSurface("workspaces").board.move(
        workspace.id,
        cardId,
        columnKey,
        placement,
      );
      if (result.kind === "ok") {
        // The properties rail reads detail, independently of the board list.
        // Refresh it after a saved move so its status and revision stay
        // current.
        await get().refreshDetail(cardId);
        await get().poll();
        return;
      }
      // Put it back exactly where it was, then say what happened.
      const current = get().view;
      set({
        view: current ? { ...current, cards: before } : current,
        ...(result.kind === "conflict"
          ? { conflict: result }
          : { error: result.message }),
      });
      if (result.kind === "conflict") await get().reload();
    } catch (error) {
      const current = get().view;
      set({
        view: current ? { ...current, cards: before } : current,
        error: ipcMessage(error, "That move did not save. Try again."),
      });
    } finally {
      set({ busy: null });
    }
  },

  update: async (cardId, patch, revision) => {
    const workspace = get().active;
    if (!workspace?.id) return;
    set({ busy: cardId, error: null, conflict: null });
    try {
      const result = await desktopSurface("workspaces").board.update(
        workspace.id,
        cardId,
        patch,
        revision,
      );
      if (result.kind === "ok") {
        // NOTE: The card the server returned, not the patch that was sent:
        // tags come back capped and normalized, and showing what was typed
        // would leave the screen disagreeing with the board.
        set((state) => ({
          detail:
            state.detail?.id === cardId
              ? { ...result.card, checklist: state.detail.checklist }
              : state.detail,
          error: result.droppedTags.length
            ? `Tags capped at 3 — ${result.droppedTags.join(", ")} not saved.`
            : null,
        }));
        await get().poll();
      } else if (result.kind === "conflict") {
        set({ conflict: result });
        await get().reload();
      } else set({ error: result.message });
    } catch (error) {
      set({ error: ipcMessage(error, "That change did not save. Try again.") });
    } finally {
      set({ busy: null });
    }
  },

  toggle: async (cardId, key, checked, revision) => {
    const workspace = get().active;
    if (!workspace?.id) return;
    set({ busy: `${cardId}:${key}`, error: null, conflict: null });
    try {
      const result = await desktopSurface("workspaces").board.toggle(
        workspace.id,
        cardId,
        key,
        checked,
        revision,
      );
      if (result.kind === "ok") await get().refreshDetail(cardId);
      else if (result.kind === "conflict") {
        set({ conflict: result });
        await get().refreshDetail(cardId);
      } else set({ error: result.message });
    } catch (error) {
      set({ error: ipcMessage(error, "That tick did not save. Try again.") });
    } finally {
      set({ busy: null });
    }
  },

  setChecklist: async (cardId, items, revision) => {
    const workspace = get().active;
    if (!workspace?.id) return;
    set({ busy: `${cardId}:checklist`, error: null, conflict: null });
    try {
      const result = await desktopSurface("workspaces").board.setChecklist(
        workspace.id,
        cardId,
        items,
        revision,
      );
      if (result.kind === "ok") set({ detail: result.card });
      else if (result.kind === "conflict") {
        set({ conflict: result });
        await get().refreshDetail(cardId);
      } else set({ error: result.message });
      await get().reload();
    } catch (error) {
      set({
        error: ipcMessage(error, "That checklist did not save. Try again."),
      });
    } finally {
      set({ busy: null });
    }
  },

  approve: async (card, keys, note) => {
    const workspace = get().active;
    if (!workspace?.id || !card.checklist) return null;
    // NOTE: The same shape `saveDraft` sends: every row back, `checked` and
    // `note` only on the boxes being approved. Every other box keeps its
    // tick, its timestamp and a note the MCP may have written a second ago.
    const wanted = new Set(keys);
    const payload: BoardChecklistDraft[] = card.checklist.map((item) => ({
      key: item.key,
      section: item.section === "verify" ? "verify" : "decisions",
      text: item.text,
      group: item.group,
      // Sent as it is, so saving a tick never strips a stream tag (BE-19).
      stream: item.stream ?? null,
      ...(wanted.has(item.key) ? { checked: true, note } : {}),
    }));
    set({ busy: `${card.id}:checklist`, error: null, conflict: null });
    try {
      const result = await desktopSurface("workspaces").board.setChecklist(
        workspace.id,
        card.id,
        payload,
        card.revision,
      );
      if (result.kind === "ok") {
        set((state) => ({
          detail: state.detail?.id === card.id ? result.card : state.detail,
        }));
        // The lane's progress count is a list read's; it moves with a poll.
        void get().poll();
        return result.card;
      }
      if (result.kind === "conflict") set({ conflict: result });
      else set({ error: result.message });
      await get().refreshDetail(card.id);
      return null;
    } catch (error) {
      set({
        error: ipcMessage(error, "Those approvals did not save. Try again."),
      });
      return null;
    } finally {
      set({ busy: null });
    }
  },

  readCard: async (cardId) => {
    const workspace = get().active;
    if (!workspace?.id) return null;
    try {
      return await desktopSurface("workspaces").board.card(
        workspace.id,
        cardId,
      );
    } catch (error) {
      set({ error: ipcMessage(error, "Could not read that card.") });
      return null;
    }
  },

  stageTick: (cardId, key, checked) =>
    set((state) => {
      const same = state.draft?.cardId === cardId;
      return {
        draft: {
          cardId,
          checked: { ...(same ? state.draft?.checked : {}), [key]: checked },
        },
      };
    }),

  stagePick: (cardId, group, key) =>
    set((state) => {
      const same = state.draft?.cardId === cardId;
      const checked = { ...(same ? state.draft?.checked : {}) };
      for (const option of group) checked[option] = option === key;
      return { draft: { cardId, checked } };
    }),

  discardDraft: () => set({ draft: null }),

  saveDraft: async () => {
    const workspace = get().active;
    const { draft, detail } = get();
    if (!workspace?.id || !draft || detail?.id !== draft.cardId) return;
    const items = detail.checklist ?? [];
    const changed = items.filter(
      (item) =>
        item.key in draft.checked && draft.checked[item.key] !== item.checked,
    );
    if (!changed.length) {
      set({ draft: null });
      return;
    }

    // One request for the whole set: `PUT …/checklist` with the revision on
    // screen as `If-Match`. A PATCH per box writes one "updated the checklist"
    // line per tick into the card's activity, and can leave half a decision
    // applied when a later box fails.
    //
    // NOTE: Every row goes back, but `checked` only on the boxes this draft
    // changed. The service reads an absent `checked` (and an absent `note`) as
    // "keep what it says". A box nobody touched keeps the moment it was
    // approved, and a note edited through the MCP a second ago is kept.
    const wanted = new Set(changed.map((item) => item.key));
    const payload: BoardChecklistDraft[] = items.map((item) => ({
      key: item.key,
      // The card only ever holds these two; anything else would be refused.
      section: item.section === "verify" ? "verify" : "decisions",
      text: item.text,
      group: item.group,
      // Sent as it is, so saving a tick never strips a stream tag (BE-19).
      stream: item.stream ?? null,
      ...(wanted.has(item.key) ? { checked: draft.checked[item.key] } : {}),
    }));

    set({ busy: `${detail.id}:checklist`, error: null, conflict: null });
    try {
      const result = await desktopSurface("workspaces").board.setChecklist(
        workspace.id,
        detail.id,
        payload,
        detail.revision,
      );
      if (result.kind === "ok") {
        set({ detail: result.card, draft: null });
        return;
      }
      // Refused as a whole, so nothing landed: the draft stays as it was,
      // still marked, to compare against the new card.
      if (result.kind === "conflict") set({ conflict: result });
      else set({ error: result.message });
      await get().refreshDetail(detail.id);
    } catch (error) {
      set({
        error: ipcMessage(error, "Those ticks did not save. Try again."),
      });
    } finally {
      set({ busy: null });
    }
  },

  refreshDetail: async (cardId) => {
    const workspace = get().active;
    if (!workspace?.id || get().detail?.id !== cardId) return;
    const mine = ticket.detail;
    try {
      const card = await desktopSurface("workspaces").board.card(
        workspace.id,
        cardId,
      );
      if (
        mine === ticket.detail &&
        get().active?.id === workspace.id &&
        get().detail?.id === cardId
      )
        set({ detail: card });
    } catch {
      // The card on screen is still the last thing the server said; a failed
      // re-read must not blank it.
    }
  },

  /**
   * Open the card a URL names.
   *
   * @param taskId The id a person says, such as `FE-06`.
   */
  openIssue: async (taskId) => {
    const workspace = get().active;
    if (!workspace?.id) return;
    const mine = ++ticket.detail;
    set({ detailLoading: true, detailError: null });
    try {
      const card = await desktopSurface("workspaces").board.lookup(
        workspace.id,
        taskId,
      );
      if (mine !== ticket.detail) return;
      set({
        detail: card,
        // A draft belongs to the card it was made on; the page only gets here
        // for a different card once the leave-without-saving prompt let it.
        draft: null,
        detailLoading: false,
        detailError: card ? null : `No card called ${taskId}.`,
        // NOTE: Cleared here, not only in `closeIssue`. Opening a card from
        // another one (a sub-issue link) never unmounts the page, so a stale
        // thread would sit under the new card until its own read landed.
        activity: null,
        activityCursor: null,
      });
      // The thread is not read here (FE-15/D5). `IssueActivity` reads it when
      // it mounts under this card and when the card id changes; reading it
      // here too sends every open twice. As a second read, it lets the card
      // draw without waiting for a history that can run for pages.
    } catch (error) {
      if (mine !== ticket.detail) return;
      set({
        detailLoading: false,
        detailError: ipcMessage(error, "Could not load that card. Try again."),
      });
    }
  },

  /**
   * One page of the open card's activity.
   *
   * NOTE: Guarded by the same `ticket.detail` the card read uses, and by the
   * card id on the way in. Otherwise two cards opened in quick succession
   * race, and the loser's thread is appended to the winner's card.
   */
  loadActivity: async (cardId, more = false) => {
    const workspace = get().active;
    if (!workspace?.id) return;
    const cursor = more ? get().activityCursor : null;
    // "More" with nothing more to read is a no-op, not a re-read of page one.
    if (more && !cursor) return;
    const mine = ticket.detail;
    set({ activityLoading: true });
    try {
      const page = await desktopSurface("workspaces").board.activity(
        workspace.id,
        cardId,
        cursor,
      );
      if (mine !== ticket.detail || get().detail?.id !== cardId) return;
      set((state) => ({
        activity: {
          cardId,
          events:
            more && state.activity?.cardId === cardId
              ? [...state.activity.events, ...page.events]
              : page.events,
        },
        activityCursor: page.cursor,
        activityLoading: false,
      }));
    } catch {
      if (mine !== ticket.detail) return;
      // Silent, and the thread already on screen is kept. Activity is context
      // around a card; replacing a conversation with an error banner loses
      // more than it explains.
      set({ activityLoading: false });
    }
  },

  comment: async (cardId, body) => {
    const workspace = get().active;
    if (!workspace?.id) return { error: "No project is open." };
    set({ busy: `${cardId}:comment`, error: null });
    try {
      await desktopSurface("workspaces").board.comment(
        workspace.id,
        cardId,
        body,
      );
      // Re-read rather than appended locally. The service stamps the time and
      // the author; a comment spliced in here would carry this machine's
      // clock, next to audit rows the server ordered by its own.
      await get().loadActivity(cardId);
      await get().refreshDetail(cardId);
      return {};
    } catch (error) {
      const message = ipcMessage(
        error,
        "That comment did not post. Try again.",
      );
      set({ error: message });
      return { error: message };
    } finally {
      set({ busy: null });
    }
  },

  editComment: async (cardId, commentId, body) => {
    const workspace = get().active;
    if (!workspace?.id) return { error: "No project is open." };
    set({ busy: `${cardId}:${commentId}`, error: null });
    try {
      await desktopSurface("workspaces").board.editComment(
        workspace.id,
        cardId,
        commentId,
        body,
      );
      await get().loadActivity(cardId);
      return {};
    } catch (error) {
      const message = ipcMessage(error, "That edit did not save. Try again.");
      set({ error: message });
      return { error: message };
    } finally {
      set({ busy: null });
    }
  },

  deleteComment: async (cardId, commentId) => {
    const workspace = get().active;
    if (!workspace?.id) return { error: "No project is open." };
    set({ busy: `${cardId}:${commentId}`, error: null });
    try {
      await desktopSurface("workspaces").board.deleteComment(
        workspace.id,
        cardId,
        commentId,
      );
      await get().loadActivity(cardId);
      await get().refreshDetail(cardId);
      return {};
    } catch (error) {
      const message = ipcMessage(error, "That comment was not deleted.");
      set({ error: message });
      return { error: message };
    } finally {
      set({ busy: null });
    }
  },

  /**
   * Follow or star the open card.
   *
   * Written optimistically, unlike most writes in this store. They are the
   * caller's own state, idempotent on the service and carry no revision, so
   * there is no race to lose and nothing to overwrite. A star that waits for a
   * round trip before filling in feels broken. The server's answer still wins.
   */
  setSubscribed: async (cardId, subscribed) => {
    const workspace = get().active;
    if (!workspace?.id) return;
    const flip = (value: boolean | null) =>
      set((state) =>
        state.detail?.id === cardId
          ? { detail: { ...state.detail, subscribed: value } }
          : {},
      );
    flip(subscribed);
    try {
      const now = await desktopSurface("workspaces").board.subscribe(
        workspace.id,
        cardId,
        subscribed,
      );
      flip(now);
      await get().refreshDetail(cardId);
    } catch (error) {
      flip(!subscribed);
      set({
        error: ipcMessage(error, "That did not save. Try again."),
      });
    }
  },

  setFavorite: async (cardId, favorite) => {
    const workspace = get().active;
    if (!workspace?.id) return;
    const flip = (value: boolean | null) =>
      set((state) =>
        state.detail?.id === cardId
          ? { detail: { ...state.detail, favorite: value } }
          : {},
      );
    flip(favorite);
    try {
      flip(
        await desktopSurface("workspaces").board.favorite(
          workspace.id,
          cardId,
          favorite,
        ),
      );
    } catch (error) {
      flip(!favorite);
      set({ error: ipcMessage(error, "That did not save. Try again.") });
    }
  },

  closeIssue: () =>
    set({
      detail: null,
      draft: null,
      detailError: null,
      activity: null,
      activityCursor: null,
    }),
  dismiss: () => set({ error: null, conflict: null }),
}));
