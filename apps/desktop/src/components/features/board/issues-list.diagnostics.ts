// Board diagnostics (FE-116): the broken states a board can drift into, found
// by reading the cards already loaded. Read-only by design (FE-116/D7): every
// rule here only says what is wrong and what somebody could do about it. None
// of them moves, unlinks or edits a card.
//
// NOTE: Lanes are judged by their ROLE, never their key. Lanes are the
// board's own (`In Progress` may be `doing`, `wip` or a word in another
// language), so a rule written against `"in-progress"` would go quiet on
// every board that named it otherwise.
//
// A `review` lane (BE-23) is waiting on a person, not on an agent: no rule
// here reads it as under way, so a card in review is never stale.
import type { CardLink, ColumnRole } from "@lanework/protocol";
import type { BoardCard, BoardColumn } from "#/../shared/projects";
import { relativeTime } from "#/lib/relative-time";

/** What a rule found. One card can have several. */
export type DiagnosisKind = "stale" | "open-parent" | "cycle" | "forgot-status";

export interface Diagnosis {
  kind: DiagnosisKind;
  /** What is wrong, as a sentence. */
  reason: string;
  /** What somebody could do about it. A suggestion, never an action taken. */
  action: string;
}

/** The kinds in the order the banner and the filter list them. */
export const DIAGNOSIS_KINDS: readonly DiagnosisKind[] = [
  "stale",
  "open-parent",
  "cycle",
  "forgot-status",
];

/** A kind's name, for the filter and the banner's counts. */
export const DIAGNOSIS_LABEL: Record<DiagnosisKind, string> = {
  stale: "Stale",
  "open-parent": "Open parent",
  cycle: "Dependency cycle",
  "forgot-status": "Not moved to done",
};

/**
 * How long every verify box may sit ticked on an active card before the
 * status counts as forgotten (FE-116/D6).
 */
export const FORGOT_STATUS_AFTER_MS = 60 * 60 * 1000;

/** A card's links, by card id. Only a single-card read carries them. */
export type CardLinks = ReadonlyMap<
  string,
  readonly Pick<CardLink, "type" | "direction" | "itemId">[]
>;

interface Context {
  byId: ReadonlyMap<string, BoardCard>;
  roleOf: (card: BoardCard) => ColumnRole | null;
  now: number;
  links: CardLinks | undefined;
  /** The board's first `review` lane, by name, or null when it has none. */
  reviewLane: string | null;
}

const FINISHED: ReadonlySet<ColumnRole> = new Set(["done", "archive"]);

const label = (card: BoardCard) =>
  card.taskId ? `${card.taskId} ${card.title}` : card.title;

/** The cards that block `card`, by id, from either side of a `blocks` link. */
function blockersOf(card: BoardCard, links: CardLinks | undefined): string[] {
  const out = new Set<string>();
  for (const link of links?.get(card.id) ?? []) {
    // `blocked_by` is stored flipped, so it reads back as the incoming side
    // of a `blocks` row; both spellings mean "itemId blocks this card".
    if (
      (link.type === "blocks" && link.direction === "incoming") ||
      link.type === "blocked_by"
    )
      out.add(link.itemId);
  }
  // The other card's own links say the same thing from its side.
  for (const [id, rows] of links ?? []) {
    if (id === card.id) continue;
    for (const link of rows)
      if (
        link.itemId === card.id &&
        link.type === "blocks" &&
        link.direction === "outgoing"
      )
        out.add(id);
  }
  return [...out];
}

/**
 * The nodes that sit on a cycle: every strongly connected component with more
 * than one node, plus any node that points at itself (Tarjan).
 */
export function cyclicNodes(
  nodes: Iterable<string>,
  edges: (node: string) => Iterable<string>,
): Set<string> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out = new Set<string>();
  const known = new Set(nodes);
  let next = 0;

  const visit = (node: string) => {
    index.set(node, next);
    low.set(node, next);
    next += 1;
    stack.push(node);
    onStack.add(node);
    for (const to of edges(node)) {
      if (!known.has(to)) continue;
      if (to === node) out.add(node);
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(to) ?? 0));
      } else if (onStack.has(to)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(to) ?? 0));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1) for (const entry of component) out.add(entry);
  };

  for (const node of known) if (!index.has(node)) visit(node);
  return out;
}

/** D3: an active card the service marked stale (BE-21). */
function staleRule(card: BoardCard, ctx: Context): Diagnosis | null {
  if (ctx.roleOf(card) !== "active" || !card.stale) return null;
  const since = relativeTime(card.stale.since, ctx.now) || "a while ago";
  const who = card.stale.lastAgent;
  return {
    kind: "stale",
    reason: who
      ? `Under way, but ${who} last worked on it ${since}.`
      : `Under way, but no agent has worked on it since it went quiet ${since}.`,
    action:
      "Resume it from its last checkpoint, or move it back until somebody picks it up.",
  };
}

/**
 * D4: an active card whose parent, or a card that blocks it, is not done.
 *
 * A parent or blocker that is not loaded says nothing: an unread card is not
 * an open one, and a lane that pages can hold the parent past its first page.
 */
function openParentRule(card: BoardCard, ctx: Context): Diagnosis | null {
  if (ctx.roleOf(card) !== "active") return null;
  const open = (id: string | null) => {
    if (!id) return null;
    const other = ctx.byId.get(id);
    if (!other) return null;
    const role = ctx.roleOf(other);
    return role && FINISHED.has(role) ? null : other;
  };
  const parent = open(card.parentId);
  if (parent)
    return {
      kind: "open-parent",
      reason: `Under way while its parent, ${label(parent)}, is not done.`,
      action: "Finish the parent first, or move this card back until it is.",
    };
  const blocker = blockersOf(card, ctx.links)
    .map((id) => open(id))
    .find((other) => other !== null);
  if (blocker)
    return {
      kind: "open-parent",
      reason: `Under way while ${label(blocker)}, which blocks it, is not done.`,
      action:
        "Finish the blocking card first, or unlink it if it no longer blocks this one.",
    };
  return null;
}

/** D5, inside one card: its streams wait on each other in a circle. */
function streamCycleRule(card: BoardCard): Diagnosis | null {
  const streams = card.streams ?? [];
  if (streams.length < 1) return null;
  const deps = new Map(streams.map((stream) => [stream.key, stream.dependsOn]));
  const looped = cyclicNodes(deps.keys(), (key) => deps.get(key) ?? []);
  if (!looped.size) return null;
  const keys = streams
    .map((stream) => stream.key)
    .filter((key) => looped.has(key));
  return {
    kind: "cycle",
    reason: `Streams ${keys.join(", ")} depend on each other in a circle, so none of them can start.`,
    action: "Remove one of their dependencies so the streams can run in waves.",
  };
}

/**
 * D6: every verify box ticked over an hour ago, and the card still active.
 *
 * Read from the boxes' `checkedAt` when the card carries its checklist (a
 * single-card read). A list read carries only the count, so there it falls
 * back to "everything ticked, and the card untouched for an hour": the last
 * tick is no later than the card's last edit, so that never fires early on a
 * service that records a tick as an edit.
 */
function forgotStatusRule(card: BoardCard, ctx: Context): Diagnosis | null {
  if (ctx.roleOf(card) !== "active") return null;
  let last: number;
  if (card.checklist) {
    const verify = card.checklist.filter((item) => item.section === "verify");
    if (!verify.length || verify.some((item) => !item.checked)) return null;
    last = Math.max(
      ...verify.map((item) =>
        item.checkedAt ? Date.parse(item.checkedAt) : Number.NaN,
      ),
    );
  } else {
    const progress = card.checklistProgress;
    if (!progress || progress.total === 0 || progress.done < progress.total)
      return null;
    last = card.updatedAt ? Date.parse(card.updatedAt) : Number.NaN;
  }
  if (!Number.isFinite(last) || ctx.now - last <= FORGOT_STATUS_AFTER_MS)
    return null;
  const when = relativeTime(new Date(last).toISOString(), ctx.now);
  return {
    kind: "forgot-status",
    reason: `Every verify item was ticked ${when}, yet the card is still under way.`,
    action: ctx.reviewLane
      ? `Move it to ${ctx.reviewLane} if the work is finished.`
      : "Move it to a done lane if the work shipped.",
  };
}

/**
 * Every diagnosis on the loaded cards, by card id. A card with none is absent.
 *
 * `links` are optional: a board read does not carry them, so without them the
 * `blocks` half of D4 and D5 stays quiet rather than guessing.
 */
export function diagnoseBoard(
  cards: readonly BoardCard[],
  columns: readonly BoardColumn[],
  now: number,
  links?: CardLinks,
): Map<string, Diagnosis[]> {
  const byId = new Map<string, BoardCard>(cards.map((card) => [card.id, card]));
  const roles = new Map(columns.map((column) => [column.key, column.role]));
  const ctx: Context = {
    byId,
    roleOf: (card) => roles.get(card.columnKey) ?? null,
    now,
    links,
    reviewLane:
      columns.find((column) => column.role === "review")?.name ?? null,
  };

  // D5 across cards: a circle of `blocks` links. Edges run blocker → blocked.
  const blocked = new Map<string, string[]>();
  if (links)
    for (const card of cards)
      for (const blocker of blockersOf(card, links))
        blocked.set(blocker, [...(blocked.get(blocker) ?? []), card.id]);
  const looped = links
    ? cyclicNodes(byId.keys(), (id) => blocked.get(id) ?? [])
    : new Set<string>();

  const out = new Map<string, Diagnosis[]>();
  for (const card of cards) {
    const found: Diagnosis[] = [];
    const stale = staleRule(card, ctx);
    if (stale) found.push(stale);
    const parent = openParentRule(card, ctx);
    if (parent) found.push(parent);
    if (looped.has(card.id))
      found.push({
        kind: "cycle",
        reason:
          "Part of a circle of blocking links, so no card in it can finish first.",
        action: "Unlink one of the blocking links to break the circle.",
      });
    const streams = streamCycleRule(card);
    if (streams) found.push(streams);
    const forgot = forgotStatusRule(card, ctx);
    if (forgot) found.push(forgot);
    if (found.length) out.set(card.id, found);
  }
  return out;
}

/** How many cards each kind flags. A card with two kinds counts in both. */
export function diagnosisCounts(
  found: ReadonlyMap<string, readonly Diagnosis[]>,
): Record<DiagnosisKind, number> {
  const counts: Record<DiagnosisKind, number> = {
    stale: 0,
    "open-parent": 0,
    cycle: 0,
    "forgot-status": 0,
  };
  for (const list of found.values())
    for (const kind of new Set(list.map((entry) => entry.kind)))
      counts[kind] += 1;
  return counts;
}

/** The "Needs attention" filter: any kind, one kind, or off. */
export type AttentionFilter = "any" | DiagnosisKind;

export const isAttentionFilter = (value: unknown): value is AttentionFilter =>
  value === "any" ||
  (DIAGNOSIS_KINDS as readonly unknown[]).includes(value as DiagnosisKind);

/** Whether a card passes the attention filter. */
export function needsAttention(
  found: ReadonlyMap<string, readonly Diagnosis[]>,
  card: BoardCard,
  filter: AttentionFilter,
): boolean {
  const list = found.get(card.id);
  if (!list) return false;
  return filter === "any" || list.some((entry) => entry.kind === filter);
}
