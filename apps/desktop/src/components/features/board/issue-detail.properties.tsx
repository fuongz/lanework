import type { BoardCard, BoardMember } from "#/../shared/projects";
import {
  CategoryDot,
  PriorityIcon,
  StatusIcon,
} from "#/components/shared/board/glyphs";
import { LabelChip } from "#/components/shared/board/label-chip";
import { LabelPicker } from "#/components/shared/board/label-picker";
import { Avatar, memberOf } from "#/components/shared/board/people";
import {
  NONE,
  PRIORITY_LABEL,
  RAIL,
  RailValue,
  Row,
} from "#/components/shared/board/properties";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/shared/navigation/select";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Separator } from "#/components/ui/separator";
import { categoryOf, columnOf } from "#/lib/board-view";
import { useBoard } from "#/stores/board";
import { presenceKind } from "#/stores/board-presence";
import {
  SECTION_NAME,
  sections,
  useChecklistDraft,
} from "./issue-detail.checklist";

/**
 * A moment in the rail: the day and the time of day.
 *
 * On a board where a card is created and worked in the same afternoon, the
 * date alone is the one fact you already knew. `dateStyle: "medium"` also
 * drops the 9/7 vs 7/9 ambiguity a numeric date carries between locales.
 */
function Stamp({ value }: { value: string | null }) {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return <RailValue>—</RailValue>;
  return (
    <RailValue>
      {/* The rail is 288px wide, so the seconds and the timezone live in the
          tooltip rather than wrapping the row. */}
      <time dateTime={at.toISOString()} title={at.toString()}>
        {at.toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </time>
    </RailValue>
  );
}

/**
 * Who the card is on.
 *
 * NOTE: `onChange` gets the users only, and the caller must write both lists,
 * because the service replaces the whole set. Sending only `users` clears
 * every agent assignment as a side effect of naming a person, and the agents
 * on a card are how work is dispatched.
 */
function AssigneeRow({
  card,
  members,
  disabled,
  onChange,
}: {
  card: BoardCard;
  members: BoardMember[];
  disabled: boolean;
  onChange: (users: string[]) => void;
}) {
  const users = card.assignees?.users ?? [];
  const on = new Set(users);
  const first = memberOf(members, users[0]);
  // Agents are shown, never edited here (FE-34/D2): an agent is put on a card
  // by handing it the card, which starts it. A menu entry that only
  // relabelled the card would claim work nobody is doing.
  const agents = (card.assignees?.agents ?? []).map((agent) => ({
    agent,
    kind: presenceKind(agent),
  }));
  const agentNames = agents
    .map(({ agent, kind }) => (kind ? TERMINAL_KIND_LABELS[kind] : agent))
    .join(", ");
  const label =
    users.length === 0
      ? agentNames || "Unassigned"
      : users.length === 1
        ? (first?.name ?? users[0])
        : `${first?.name ?? users[0]} +${users.length - 1}`;
  const agentIcons = agents.map(({ agent, kind }) =>
    kind ? (
      <TerminalKindIcon key={agent} kind={kind} className="size-4 shrink-0" />
    ) : null,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="hover:bg-foreground/[0.06] focus-visible:ring-accent-brand flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors focus-visible:ring-2 disabled:opacity-50"
      >
        {users.length === 0 && agents.length > 0 ? (
          agentIcons
        ) : (
          <Avatar member={first} size="sm" />
        )}
        <span className="truncate">{label}</span>
        {users.length > 0 && agents.length > 0 && (
          <span
            className="ml-auto flex shrink-0 items-center gap-1"
            title={agentNames}
          >
            {agentIcons}
            <span className="sr-only">and {agentNames}</span>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem closeOnClick={false} onClick={() => onChange([])}>
          <Avatar size="sm" />
          Unassigned
        </DropdownMenuItem>
        {members.map((member) => (
          <DropdownMenuItem
            key={member.userId}
            // Three people on one card is one task; a menu that shut after
            // each would make it three.
            closeOnClick={false}
            onClick={() =>
              onChange(
                on.has(member.userId)
                  ? users.filter((id) => id !== member.userId)
                  : [...users, member.userId],
              )
            }
          >
            <Avatar member={member} size="sm" />
            <span className="truncate">{member.name}</span>
            {on.has(member.userId) && (
              <span className="text-muted-foreground ml-auto text-xs">✓</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The card's properties, in the rail's own shape.
 *
 * - Status, Priority, Assignee, Labels: the order the design draws, and the
 *   order the New issue page follows. The two rails read as one panel to
 *   anyone who creates a card and then opens it, and a field that moves
 *   between them is a field they look for twice.
 * - Category stays, though the design has no such row: it is what mints a
 *   card's task id.
 */
export function Fields({ card }: { card: BoardCard }) {
  const checklist = useChecklistDraft(card).items;
  const view = useBoard((state) => state.view);
  const update = useBoard((state) => state.update);
  const busy = useBoard((state) => state.busy);
  const stale = view?.stale ?? false;
  const writing = stale || busy === card.id;
  const members = view?.members ?? [];
  const labels = view?.labels ?? [];

  const save = (patch: Parameters<typeof update>[1]) =>
    void update(card.id, patch, card.revision);

  return (
    <>
      <Row label="Status">
        <StatusIcon column={columnOf(view?.columns ?? [], card.columnKey)} />
        <Select
          value={card.columnKey}
          onValueChange={(value) =>
            void useBoard.getState().move(card.id, value)
          }
        >
          <SelectTrigger
            size="sm"
            aria-label="Status"
            disabled={writing}
            className={RAIL}
          >
            <SelectValue>
              {(value: string) =>
                columnOf(view?.columns ?? [], value)?.name ?? value
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(view?.columns ?? []).map((column) => (
              <SelectItem key={column.key} value={column.key}>
                {column.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row label="Priority">
        <PriorityIcon priority={card.priority} />
        <Select
          value={card.priority ?? NONE}
          onValueChange={(value) =>
            save({
              priority:
                value === NONE ? null : (value as BoardCard["priority"]),
            })
          }
        >
          <SelectTrigger
            size="sm"
            aria-label="Priority"
            disabled={writing}
            className={RAIL}
          >
            <SelectValue>
              {(value: string) => PRIORITY_LABEL[value] ?? value}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No priority</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      <Row label="Assignee">
        <AssigneeRow
          card={card}
          members={members}
          disabled={writing}
          onChange={(users) =>
            save({
              assignees: { users, agents: card.assignees?.agents ?? [] },
            })
          }
        />
      </Row>

      <Row label="Labels">
        {/* Disabled by `stale` only, unlike the menus above it. Bound to
            `busy` as well, the control goes dead for each round trip, which
            on a board being edited is most of the time. A second label chosen
            before the first write lands can still lose the revision race;
            that is what the conflict banner is for. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {card.tags.map((tag) => (
            <LabelChip
              key={tag}
              tag={tag}
              labels={labels}
              onRemove={
                stale
                  ? undefined
                  : () => save({ tags: card.tags.filter((t) => t !== tag) })
              }
            />
          ))}
          <LabelPicker
            tags={card.tags}
            labels={labels}
            disabled={stale}
            onChange={(tags) => save({ tags })}
          />
        </div>
      </Row>

      <Row label="Category">
        <CategoryDot
          category={categoryOf(view?.categories ?? [], card.categoryKey)}
        />
        <Select
          value={card.categoryKey ?? NONE}
          onValueChange={(value) =>
            save({ categoryKey: value === NONE ? null : value })
          }
        >
          <SelectTrigger
            size="sm"
            aria-label="Category"
            disabled={writing}
            className={RAIL}
          >
            <SelectValue>
              {(value: string) =>
                value === NONE
                  ? "No category"
                  : (categoryOf(view?.categories ?? [], value)?.name ?? value)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {/* A sentinel, not `""`: see `NONE`. */}
            <SelectItem value={NONE}>No category</SelectItem>
            {(view?.categories ?? []).map((category) => (
              <SelectItem key={category.key} value={category.key}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      {/* Facts, not fields, but read as the same table, so they keep the
          row. */}
      <Separator className="my-1.5" />
      {/* In the rail, not only above the list. The rail is a pane of its
          own, so this is the one place a card's progress stays on screen
          while a body that runs for pages is being read. */}
      {sections(checklist).map(({ section, rows, done }) => (
        <Row key={section} label={SECTION_NAME[section] ?? section}>
          <RailValue>
            {done}/{rows.length}
          </RailValue>
        </Row>
      ))}
      <Row label="Created">
        <Stamp value={card.createdAt} />
      </Row>
      <Row label="Updated">
        <Stamp value={card.updatedAt} />
      </Row>
      {card.dueAt && (
        <Row label="Due">
          <Stamp value={card.dueAt} />
        </Row>
      )}
      {card.estimate !== null && (
        <Row label="Estimate">
          <RailValue>{card.estimate}</RailValue>
        </Row>
      )}
    </>
  );
}
