import { create } from "zustand";
import { byRank } from "#/lib/board-view";
import { ipcMessage } from "#/lib/ipc-error";
import type {
  BoardCard,
  BoardCardDraft,
  BoardCardPatch,
  BoardChecklistDraft,
  BoardConflict,
  BoardView,
  Workspace,
} from "../../shared/workspaces";

const api = () => {
  const surface = window.desktop?.workspaces;
  if (!surface)
    throw new Error("This window is not connected to the desktop app.");
  return surface;
};

/**
 * Request tickets, one counter per read that can be in flight twice.
 *
 * ⚠️ Without these, two overlapping reads land in whatever order the network
 * returns them, and the OLDER one wins. It is not hypothetical: press "Try
 * again" while a slow failure is still running and the failure arrives last,
 * replacing the list it just fetched with the error it started before. The
 * screen this store replaced carried the same counter for the same reason.
 */
const ticket = { workspaces: 0, board: 0, detail: 0 };

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
   * ⚠️ Its own field rather than an error string. The API's 409 carries the card
   * as it stands now, and a screen that can show both sides is the difference
   * between "try again" and a person deciding which version is right.
   */
  conflict: BoardConflict | null;
  /** The key of the write in flight, so exactly one control shows as busy. */
  busy: string | null;
  /** The change cursor, echoed from the server. Never derived. */
  cursor: number;
  /** True when the URL names a project this account does not have. */
  notFound: boolean;

  /** The open card, WITH its checklist — a read the board list cannot give. */
  detail: BoardCard | null;
  detailLoading: boolean;
  detailError: string | null;

  hydrate: () => Promise<void>;
  open: (slug: string) => Promise<void>;
  reload: () => Promise<void>;
  poll: () => Promise<void>;
  /**
   * ⚠️ Answers with the failure instead of parking it in `error`. The switcher
   * is a popover with the field still in it, and "that key is taken" belongs
   * beside the name that was refused — not in a banner on the page behind it.
   */
  createProject: (
    name: string,
    /** `PickedFolder` ids, primary first. Empty when none were chosen. */
    folders?: string[],
  ) => Promise<{ workspace: Workspace | null } | { error: string }>;
  /**
   * Rename a project on the account, by cloud workspace id.
   *
   * ⚠️ Answers with the failure rather than parking it in `error`, for the same
   * reason `createProject` does: the caller is a field with the refused name
   * still in it.
   */
  renameProject: (id: string, name: string) => Promise<{ error?: string }>;
  /**
   * Delete a project from the account.
   *
   * ⚠️ Answers with the failure rather than parking it in `error`, for the same
   * reason `createProject` does: the caller is a dialog, and "that did not
   * work" belongs beside the button that was pressed.
   */
  deleteProject: (id: string, slug: string) => Promise<{ error?: string }>;
  /**
   * Put a new card on the board.
   *
   * ⚠️ Answers with the card the board minted rather than just succeeding. The
   * composer navigates to the issue it just created, and the key it navigates
   * by (`FE-06`) is the server's to mint — finding it again by title in the
   * reloaded list would be a guess, and wrong the moment two cards share one.
   */
  createCard: (
    draft: BoardCardDraft,
  ) => Promise<{ card?: BoardCard; error?: string }>;
  /**
   * Take a card off the board.
   *
   * ⚠️ Answers with the failure rather than only parking it in `error`: the
   * caller is a confirmation dialog, and a dialog that closed on a delete that
   * did not happen would be the last place anyone looks for the reason.
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
  openIssue: (taskId: string) => Promise<void>;
  /** Re-read the open card by id, after a write that changed its parts. */
  refreshDetail: (cardId: string) => Promise<void>;
  closeIssue: () => void;
  dismiss: () => void;
}

/**
 * Re-rank one lane locally, so a dropped card sits where it was dropped.
 *
 * ⚠️ Local ranks are provisional and always replaced by the server's on the next
 * read. They are padded indices rather than an attempt at a fractional index:
 * two clients computing their own real ranks eventually pick the same one, which
 * is why `placement` exists and why nothing here is ever sent to the board.
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
 * True when a lane came out of `reorder` in the order it went in.
 *
 * ⚠️ Compares IDS, not ranks. `reorder` rewrites the lane's ranks to padded
 * indices whatever happens, so two ranks are always different from the
 * server's and comparing them would call every drop a change.
 */
const sameOrder = (before: string[], after: string[]): boolean =>
  before.length === after.length &&
  before.every((id, index) => id === after[index]);

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
  notFound: false,
  detail: null,
  detailLoading: false,
  detailError: null,

  hydrate: async () => {
    const mine = ++ticket.workspaces;
    try {
      const snapshot = await api().load();
      if (mine !== ticket.workspaces) return;
      set({
        ready: true,
        workspaces: snapshot.workspaces,
        active: snapshot.active,
        error: null,
      });
    } catch (error) {
      if (mine !== ticket.workspaces) return;
      set({
        ready: true,
        error: ipcMessage(error, "Could not load your workspaces. Try again."),
      });
    }
  },

  /**
   * Open one project by SLUG, because that is what the URL carries.
   *
   * ⚠️ The slug is the address a person can read and link to; every board call
   * underneath is still keyed by the cloud workspace id. Resolving one to the
   * other happens here, once, rather than in every screen.
   */
  open: async (slug) => {
    const known =
      get().workspaces.find((workspace) => workspace.slug === slug) ?? null;
    if (!known) await get().hydrate();
    const workspace =
      get().workspaces.find((entry) => entry.slug === slug) ?? null;
    if (!workspace) {
      // ⚠️ A flag rather than an error banner. The project in the URL is gone —
      // usually because it was deleted on the account, sometimes because a
      // remembered selection was cleared — and the useful answer is the picker,
      // not a red box on a board that cannot load.
      set({ active: null, view: null, notFound: true });
      return;
    }
    set({
      active: workspace,
      view: null,
      cursor: 0,
      error: null,
      notFound: false,
    });
    // Remembered on this machine, so the next launch opens the same project.
    await api()
      .select(workspace.id ?? workspace.slug)
      .catch(() => undefined);
    await get().reload();
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
      const view = await api().board.load(workspace.id);
      if (mine !== ticket.board) return;
      set({ view, loading: false, error: null });
      // The board read hands back a head; start the change cursor there so the
      // first poll reports what happened AFTER this read, not the whole board.
      const changes = await api()
        .board.changes(workspace.id, get().cursor)
        .catch(() => null);
      if (changes && mine === ticket.board) set({ cursor: changes.head });
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
   * ⚠️ A board-level event means the LANES changed, and no amount of patching
   * cards can express that — so it re-reads everything rather than guessing.
   */
  poll: async () => {
    const { active, view, cursor } = get();
    if (!active?.id || !view || get().loading) return;
    try {
      const changes = await api().board.changes(active.id, cursor);
      if (changes.events.length) {
        await get().reload();
        return;
      }
      if (!changes.cards.length) {
        set({ cursor: changes.nextSince });
        return;
      }
      const byId = new Map(changes.cards.map((card) => [card.id, card]));
      const merged = view.cards.map((card) => byId.get(card.id) ?? card);
      for (const card of changes.cards)
        if (!view.cards.some((entry) => entry.id === card.id))
          merged.push(card);
      set({
        view: { ...view, cards: merged },
        cursor: changes.nextSince,
      });
    } catch {
      // A failed poll is not an error the user has to see: the board on screen
      // is still the last thing the server actually said.
    }
  },

  createProject: async (name, folders) => {
    set({ busy: "project", error: null });
    try {
      const snapshot = await api().create(name.trim(), folders);
      set({
        workspaces: snapshot.workspaces,
        active: snapshot.active,
        busy: null,
        notFound: false,
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
      const snapshot = await api().rename(id, name.trim());
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

  // ⚠️ `id` for the service, `slug` for everything on this machine — the folder
  // link main drops, the busy key below, and the open-board check. They are two
  // keyspaces and the service refuses the wrong one, so neither is derivable
  // from the other here.
  deleteProject: async (id, slug) => {
    set({ busy: `delete:${slug}`, error: null });
    try {
      const snapshot = await api().remove(id, slug);
      set({
        workspaces: snapshot.workspaces,
        active: snapshot.active,
        busy: null,
        // ⚠️ The open board is dropped when it was the one deleted. Leaving the
        // cards on screen would let somebody keep editing a project that no
        // longer exists, and every write would fail one at a time.
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

  createCard: async (draft) => {
    const workspace = get().active;
    if (!workspace?.id)
      return { error: "Open a project before adding a card to it." };
    set({ busy: "create", error: null, conflict: null });
    try {
      const result = await api().board.create(workspace.id, draft);
      if (result.kind !== "ok") {
        set({ error: result.message });
        return { error: result.message };
      }
      // ⚠️ Reported as an error even though the write SUCCEEDED. The board caps
      // tags and applies the cap silently, so this is the only moment somebody
      // learns the fourth tag they typed is not on the card they just made.
      if (result.droppedTags.length)
        set({
          error: `Tags capped at 3 — ${result.droppedTags.join(", ")} not saved.`,
        });
      await get().reload();
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
      await api().board.archive(workspace.id, cardId);
      // ⚠️ A full re-read, NOT a splice. An archive moves every rank and count
      // below it, and a client that removed one row from its own copy would be
      // guessing at the rest of a board it can simply ask for.
      await get().reload();
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
   * ⚠️ The ONE optimistic write in this app, and the exception is deliberate: a
   * card that snaps back to where it was and then jumps to where it was dropped
   * reads as broken rather than slow. Everything else here still waits for the
   * server. A refusal restores the exact list this started from.
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
    /**
     * ⚠️ A move that moves nothing is not a move, and must not be SENT. Lifting
     * a card and putting it back where it was — dropping it on the boundary it
     * already sits against, or choosing the lane it is already in — resolves to
     * the lane exactly as it stands, and forwarding that anyway had the board
     * stamp `updatedAt` on a card nothing happened to. Every such card then
     * claimed to be the most recently touched work on the project.
     */
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
      const result = await api().board.move(
        workspace.id,
        cardId,
        columnKey,
        placement,
      );
      if (result.kind === "ok") {
        await get().reload();
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
      const result = await api().board.update(
        workspace.id,
        cardId,
        patch,
        revision,
      );
      if (result.kind === "ok") {
        // ⚠️ The card the SERVER returned, not the patch that was sent: tags
        // come back capped and normalized, and showing what was typed would
        // leave the screen disagreeing with the board.
        set((state) => ({
          detail:
            state.detail?.id === cardId
              ? { ...result.card, checklist: state.detail.checklist }
              : state.detail,
          error: result.droppedTags.length
            ? `Tags capped at 3 — ${result.droppedTags.join(", ")} not saved.`
            : null,
        }));
        await get().reload();
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
      const result = await api().board.toggle(
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
      const result = await api().board.setChecklist(
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

  refreshDetail: async (cardId) => {
    const workspace = get().active;
    if (!workspace?.id || get().detail?.id !== cardId) return;
    try {
      set({ detail: await api().board.card(workspace.id, cardId) });
    } catch {
      // The card on screen is still the last thing the server said; a failed
      // re-read must not blank it.
    }
  },

  /** The card a URL names — `FE-06`, the way a person says it. */
  openIssue: async (taskId) => {
    const workspace = get().active;
    if (!workspace?.id) return;
    const mine = ++ticket.detail;
    set({ detailLoading: true, detailError: null });
    try {
      const card = await api().board.lookup(workspace.id, taskId);
      if (mine !== ticket.detail) return;
      set({
        detail: card,
        detailLoading: false,
        detailError: card ? null : `No card called ${taskId}.`,
      });
    } catch (error) {
      if (mine !== ticket.detail) return;
      set({
        detailLoading: false,
        detailError: ipcMessage(error, "Could not load that card. Try again."),
      });
    }
  },

  closeIssue: () => set({ detail: null, detailError: null }),
  dismiss: () => set({ error: null, conflict: null }),
}));
