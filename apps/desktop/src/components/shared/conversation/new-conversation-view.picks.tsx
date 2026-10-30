import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type { TeamLead } from "#/../shared/orchestration";
import type { BoardCard, BoardView } from "#/../shared/projects";
import {
  ChecklistProgress,
  PriorityIcon,
  StatusIcon,
} from "#/components/shared/board/glyphs";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { leadIcon } from "#/lib/orchestration-prompt";
import { cn } from "#/lib/utils";

/** Cards offered before "See board" (FE-98/D2a). */
const SHOWN = 5;

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

const HEADING =
  "text-muted-foreground px-1 text-[11px] font-medium tracking-wide uppercase";

/**
 * The cards worth picking up (FE-98/D2a): the board's In Progress lane, then
 * its To-Do, highest priority first within each, newest after that.
 */
export function pickableCards(view: BoardView): BoardCard[] {
  const lane = (role: string) =>
    view.columns.find((column) => column.role === role)?.key;
  const order = [lane("active"), lane("start")].filter(
    (key): key is string => key !== undefined,
  );
  return view.cards
    .filter((card) => !card.archivedAt && order.includes(card.columnKey))
    .sort(
      (a, b) =>
        order.indexOf(a.columnKey) - order.indexOf(b.columnKey) ||
        (PRIORITY_RANK[a.priority ?? ""] ?? 3) -
          (PRIORITY_RANK[b.priority ?? ""] ?? 3) ||
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
}

/**
 * What a picked card puts in the composer (FE-98/D1a): a card already in
 * progress is resumed from its checkpoint, the rest are started.
 */
export function cardPrompt(view: BoardView, card: BoardCard): string {
  const role = view.columns.find((c) => c.key === card.columnKey)?.role;
  const verb = role === "active" ? "Resume" : "Work on";
  // An unfiled card has no task id; its title alone names it.
  return card.taskId
    ? `${verb} ${card.taskId}: ${card.title}`
    : `${verb} ${card.title}`;
}

/**
 * "Hand it to" (FE-98/D3a): the project's conductors as chips. Picking one
 * makes this page that conductor's; picking it again lets it go.
 */
export function ConductorPicks({
  conductors,
  picked,
  hasConversation,
  onPick,
}: {
  conductors: readonly TeamLead[];
  picked: TeamLead | null;
  /** Its own conversation already exists: the chip opens that instead. */
  hasConversation: (lead: TeamLead) => boolean;
  onPick: (lead: TeamLead | null) => void;
}) {
  if (conductors.length === 0) return null;
  return (
    <section aria-label="Hand it to" className="flex flex-col gap-2">
      <h3 className={HEADING}>Hand it to</h3>
      <div className="flex flex-wrap gap-1.5">
        {conductors.map((lead) => {
          const on = picked?.id === lead.id;
          const opens = hasConversation(lead);
          return (
            <button
              key={lead.id}
              type="button"
              aria-pressed={on}
              title={
                opens
                  ? `${lead.name} is already on a conversation: open it`
                  : on
                    ? `Starting as ${lead.name}. Click again to start as yourself`
                    : `Start this conversation as ${lead.name}`
              }
              onClick={() => onPick(on ? null : lead)}
              className={cn(
                "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors",
                on &&
                  "border-tone-teal/50 bg-tone-teal/[0.06] text-tone-teal hover:text-tone-teal hover:bg-tone-teal/[0.08]",
              )}
            >
              <HugeiconsIcon
                icon={leadIcon(lead.icon)}
                className="size-3.5 shrink-0"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              {lead.name}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * "Pick up from the board" (FE-98): the live cards, each a row that puts
 * its task in the composer. Not drawn without cards (D5); a skeleton of its
 * rows while the board is still read.
 */
export function BoardPicks({
  slug,
  view,
  loading,
  onPick,
}: {
  slug: string;
  view: BoardView | null;
  loading: boolean;
  onPick: (card: BoardCard) => void;
}) {
  if (!view)
    return loading ? (
      <section
        aria-label="Pick up from the board"
        className="flex flex-col gap-1"
      >
        <h3 className={HEADING}>Pick up from the board</h3>
        <ListSkeleton
          label="Reading the board"
          rows={3}
          className="px-0 py-0"
        />
      </section>
    ) : null;
  const cards = pickableCards(view);
  if (cards.length === 0) return null;
  const column = (card: BoardCard) =>
    view.columns.find((entry) => entry.key === card.columnKey);
  return (
    <section
      aria-label="Pick up from the board"
      className="flex flex-col gap-1"
    >
      <div className="flex items-center justify-between">
        <h3 className={HEADING}>Pick up from the board</h3>
        {cards.length > SHOWN && (
          <Link
            to="/w/$slug/issues"
            params={{ slug }}
            className="text-muted-foreground hover:text-foreground px-1 text-xs transition-colors"
          >
            See board ({cards.length})
          </Link>
        )}
      </div>
      <ul className="flex flex-col">
        {cards.slice(0, SHOWN).map((card) => (
          <li key={card.id}>
            <button
              type="button"
              onClick={() => onPick(card)}
              title={`Put ${card.taskId ?? "this card"} in the composer`}
              className="hover:bg-foreground/[0.04] flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left text-[13px] transition-colors"
            >
              <StatusIcon column={column(card)} />
              {card.taskId && (
                <span className="text-muted-foreground w-12 shrink-0 font-mono text-xs tabular-nums">
                  {card.taskId}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{card.title}</span>
              <ChecklistProgress card={card} />
              <PriorityIcon priority={card.priority} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
