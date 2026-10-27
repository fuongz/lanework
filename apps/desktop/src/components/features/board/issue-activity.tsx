// A card's history and its thread, as the one sequence a reader sees.
//
// NOTE: The merge happens on the service, not here. Two independently paged
// reads stitched together on this side are correct only while both fit in one
// page; past that the seam silently drops whatever fell between them.
// Everything in this file renders an already-ordered list.
import {
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import type {
  BoardActivity,
  BoardCard,
  BoardColumn,
  BoardLabel,
  BoardMember,
} from "#/../shared/workspaces";
import { labelOf } from "#/components/shared/board/label-chip";
import { Avatar, memberOf, personName } from "#/components/shared/board/people";
import { ComposerCard } from "#/components/shared/common/composer-card";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { MarkdownEditor } from "#/components/shared/common/markdown-editor";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { columnOf } from "#/lib/board-view";
import { relativeTime } from "#/lib/relative-time";
import { useBoard } from "#/stores/board";
import { useCloudFeatures, useSession } from "#/stores/session";

const PRIORITY_NAME: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** A diff entry the service writes as `[before, after]`. */
function pair(value: unknown): [unknown, unknown] | null {
  return Array.isArray(value) && value.length === 2
    ? [value[0], value[1]]
    : null;
}

const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

/** Everyone in a diff half's `{ users, agents }`, users first. */
function people(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  return [...list(row.users), ...list(row.agents)];
}

/**
 * What an audit row says, in a sentence.
 *
 * The service's verbs are free text and this app is not deployed in lock step
 * with it. An unknown verb is a line this version cannot narrate, and "decio
 * patched the issue" for something that was an import is worse than a gap.
 *
 * @returns Null for a verb it does not recognise, or one drawn elsewhere; the
 * caller drops that row.
 */
function sentence(
  event: Extract<BoardActivity, { kind: "audit" }>,
  columns: BoardColumn[],
  labels: BoardLabel[],
  members: BoardMember[],
): React.ReactNode | null {
  const diff = event.diff ?? {};
  const laneName = (key: unknown) =>
    typeof key === "string" ? (columnOf(columns, key)?.name ?? key) : null;

  switch (event.verb) {
    case "created":
      return <>created the issue.</>;
    case "imported":
      return <>imported the issue.</>;
    case "archived":
      return <>deleted the issue.</>;
    case "restored":
      return <>restored the issue.</>;
    case "attached":
      return <>attached a file.</>;
    case "detached":
      return <>removed a file.</>;
    case "linked":
      return <>linked another issue.</>;
    case "unlinked":
      return <>removed a link.</>;
    case "checklist":
      return <>updated the checklist.</>;
    case "config":
      return <>changed the board's settings.</>;
    // A comment is in this feed as itself (`CommentEntry`). Narrating it here
    // as well would report one sentence twice.
    case "commented":
      return null;
    case "moved": {
      const from = laneName(diff.from);
      const to = laneName(diff.to);
      if (!to) return <>moved the issue.</>;
      return from ? (
        <>
          changed status from <Strong>{from}</Strong> to <Strong>{to}</Strong>.
        </>
      ) : (
        <>
          changed status to <Strong>{to}</Strong>.
        </>
      );
    }
    case "patched":
      return <>{patched(diff, labels, members)}</>;
    default:
      return null;
  }
}

/**
 * What one `patched` row changed.
 *
 * A patch can move several fields at once, and this states every one of them
 * rather than picking the first. Setting the priority and the due date in one
 * save is one event, and reporting half of it makes the feed a record you
 * cannot trust to be complete.
 */
function patched(
  diff: Record<string, unknown>,
  labels: BoardLabel[],
  members: BoardMember[],
): React.ReactNode {
  const parts: React.ReactNode[] = [];

  for (const [field, raw] of Object.entries(diff)) {
    const both = pair(raw);
    if (!both) continue;
    const [before, after] = both;

    if (field === "tags") {
      const was = new Set(list(before));
      const now = new Set(list(after));
      const added = [...now].filter((tag) => !was.has(tag));
      const removed = [...was].filter((tag) => !now.has(tag));
      if (added.length)
        parts.push(
          <Part key="tags-add">
            added {added.length > 1 ? "labels" : "label"}{" "}
            <Names names={added.map((t) => labelOf(labels, t)?.name ?? t)} />
          </Part>,
        );
      if (removed.length)
        parts.push(
          <Part key="tags-remove">
            removed {removed.length > 1 ? "labels" : "label"}{" "}
            <Names names={removed.map((t) => labelOf(labels, t)?.name ?? t)} />
          </Part>,
        );
      continue;
    }

    if (field === "assignees") {
      const was = new Set(people(before));
      const now = new Set(people(after));
      const added = [...now].filter((ref) => !was.has(ref));
      const removed = [...was].filter((ref) => !now.has(ref));
      if (added.length)
        parts.push(
          <Part key="assign">
            assigned{" "}
            <Names names={added.map((ref) => personName(members, ref, ref))} />
          </Part>,
        );
      if (removed.length && !added.length)
        parts.push(<Part key="unassign">unassigned the issue</Part>);
      continue;
    }

    if (field === "priority") {
      parts.push(
        typeof after === "string" ? (
          <Part key="priority">
            set priority to <Strong>{PRIORITY_NAME[after] ?? after}</Strong>
          </Part>
        ) : (
          <Part key="priority">removed the priority</Part>
        ),
      );
      continue;
    }

    const SIMPLE: Record<string, string> = {
      title: "renamed the issue",
      body: "updated the description",
      categoryKey: "changed the category",
      estimate: "changed the estimate",
      dueAt: "changed the due date",
      parentId: "changed the parent issue",
      type: "changed the issue type",
      metadata: "updated the issue's metadata",
    };
    if (SIMPLE[field]) parts.push(<Part key={field}>{SIMPLE[field]}</Part>);
  }

  if (!parts.length) return <>updated the issue.</>;
  return (
    <>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional
        <span key={index}>
          {index > 0 && (index === parts.length - 1 ? " and " : ", ")}
          {part}
        </span>
      ))}
      .
    </>
  );
}

/** One clause of a multi-field change, joined by the caller. */
const Part = ({ children }: { children: React.ReactNode }) => <>{children}</>;

const Strong = ({ children }: { children: React.ReactNode }) => (
  <span className="text-foreground font-medium">{children}</span>
);

/** "Bug, Feature and Improvement": a list a person would say out loud. */
function Names({ names }: { names: string[] }) {
  return (
    <>
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 && (index === names.length - 1 ? " and " : ", ")}
          <Strong>{name}</Strong>
        </span>
      ))}
    </>
  );
}

/** The moment, spelled out, with the exact one in the tooltip. */
function When({ at }: { at: string }) {
  const stamp = new Date(at);
  if (Number.isNaN(stamp.getTime())) return null;
  return (
    <time
      dateTime={stamp.toISOString()}
      title={stamp.toString()}
      className="text-muted-foreground shrink-0 text-xs"
    >
      {relativeTime(at, Date.now())}
    </time>
  );
}

function AuditEntry({
  event,
  columns,
  labels,
  members,
}: {
  event: Extract<BoardActivity, { kind: "audit" }>;
  columns: BoardColumn[];
  labels: BoardLabel[];
  members: BoardMember[];
}) {
  const said = sentence(event, columns, labels, members);
  if (!said) return null;
  const member = memberOf(members, event.actorUserId);
  // An agent or a machine has no directory row; the ref it acted under is the
  // honest name for it.
  const who = personName(
    members,
    event.actorUserId,
    event.actorMachineId ?? event.actorKind,
  );
  return (
    <li className="flex items-baseline gap-2.5">
      <span className="flex w-5 shrink-0 justify-center self-start pt-0.5">
        <Avatar member={member} name={who} size="sm" />
      </span>
      <p className="text-muted-foreground min-w-0 flex-1 text-[13px] leading-relaxed">
        <Strong>{who}</Strong> {said} <When at={event.at} />
      </p>
    </li>
  );
}

function CommentEntry({
  event,
  card,
  members,
}: {
  event: Extract<BoardActivity, { kind: "comment" }>;
  card: BoardCard;
  members: BoardMember[];
}) {
  const deleteComment = useBoard((state) => state.deleteComment);
  const editComment = useBoard((state) => state.editComment);
  const busy = useBoard((state) => state.busy);
  const stale = useBoard((state) => state.view?.stale ?? false);
  const [draft, setDraft] = useState<string | null>(null);

  const member = memberOf(members, event.authorUserId);
  const who = personName(members, event.authorUserId, event.authorRef);
  const writing = stale || busy === `${card.id}:${event.id}`;

  if (event.deletedAt) {
    return (
      <li className="flex items-baseline gap-2.5">
        <span className="flex w-5 shrink-0 justify-center self-start pt-0.5">
          <Avatar size="sm" />
        </span>
        <p className="text-muted-foreground min-w-0 flex-1 text-[13px] italic">
          <Strong>{who}</Strong> deleted a comment. <When at={event.at} />
        </p>
      </li>
    );
  }

  return (
    <li className="flex gap-2.5">
      <span className="flex w-5 shrink-0 justify-center self-start pt-0.5">
        <Avatar member={member} name={who} size="sm" />
      </span>
      <div className="border-border bg-foreground/[0.02] min-w-0 flex-1 rounded-lg border px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium">{who}</span>
          <When at={event.at} />
          {event.editedAt && (
            <span
              className="text-muted-foreground text-xs"
              title={new Date(event.editedAt).toString()}
            >
              (edited)
            </span>
          )}
          {/* Shown for everyone, not only the author. The service decides who
              may edit (it answers 403), and hiding the menu on a guess would
              mean this app deciding authorship a second time, from a
              different field. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Comment actions"
                  disabled={writing}
                  className="ml-auto size-6"
                />
              }
            >
              <HugeiconsIcon
                icon={MoreHorizontalIcon}
                className="size-4"
                strokeWidth={1.8}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setDraft(event.body ?? "")}>
                <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={1.8} />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => void deleteComment(card.id, event.id)}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {draft === null ? (
          <div className="mt-1">
            <MarkdownBody source={event.body ?? ""} />
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              label="Edit comment"
              onCancel={() => setDraft(null)}
              onSubmit={() => {
                const next = draft.trim();
                if (next && next !== event.body)
                  void editComment(card.id, event.id, next).then((result) => {
                    if (!result.error) setDraft(null);
                  });
                else setDraft(null);
              }}
              className="min-h-20"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft(null)}
                disabled={writing}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={writing || !draft.trim()}
                onClick={() => {
                  const next = draft.trim();
                  if (!next || next === event.body) return setDraft(null);
                  void editComment(card.id, event.id, next).then((result) => {
                    if (!result.error) setDraft(null);
                  });
                }}
              >
                Save
              </Button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The box a reply is written in.
 *
 * NOTE: Not optimistic, unlike the star and the follow beside it. The service
 * stamps a comment's moment and orders it against the audit log with its own
 * counter; a comment spliced in here would sit in the feed at a time this
 * machine's clock invented, and jump when the real one arrived.
 */
function Composer({ card }: { card: BoardCard }) {
  const comment = useBoard((state) => state.comment);
  const busy = useBoard((state) => state.busy);
  const stale = useBoard((state) => state.view?.stale ?? false);
  const [draft, setDraft] = useState("");
  const writing = busy === `${card.id}:comment`;
  // Whose reply it is: the account that owns this machine, as the control
  // plane named it. Null when it never said, and the card draws "?".
  const owner = useSession((state) =>
    state.session?.principal.kind === "machine"
      ? state.session.principal.owner
      : null,
  );

  const send = () => {
    const body = draft.trim();
    if (!body || writing || stale) return;
    void comment(card.id, body).then((result) => {
      // The draft survives a failure. Clearing it on the way out would throw
      // away what someone wrote the moment the network was worst.
      if (!result.error) setDraft("");
    });
  };

  return (
    <div className="flex gap-2.5 pt-1">
      <span className="w-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <ComposerCard
          initial={owner?.name ?? owner?.email ?? null}
          who={owner?.name ?? owner?.email}
          ready={draft.trim() !== "" && !writing && !stale}
          sending={writing}
          onSend={send}
        >
          {/* `-mx-1.5` cancels CodeMirror's own 6px content padding, so the
              text starts where the pull request's textarea does. */}
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            onSubmit={send}
            label="Leave a comment"
            placeholder="Leave a comment"
            readOnly={stale}
            className="-mx-1.5 min-h-12"
          />
        </ComposerCard>
      </div>
    </div>
  );
}

/** Entries shown when a card opens, and how many each "Show more" adds. */
const RECENT = 3;
const MORE = 10;

export function IssueActivity({ card }: { card: BoardCard }) {
  const view = useBoard((state) => state.view);
  const activity = useBoard((state) => state.activity);
  const cursor = useBoard((state) => state.activityCursor);
  const loading = useBoard((state) => state.activityLoading);
  const loadActivity = useBoard((state) => state.loadActivity);
  const setSubscribed = useBoard((state) => state.setSubscribed);
  // A local board has no comments and no subscribers (FE-52/D10).
  const active = useBoard((state) => state.active);
  const { comments, subscribers: canSubscribe } = useCloudFeatures(active);

  // NOTE: Read again when the card id changes, not only when the page mounts.
  // Following a sub-issue link swaps the card under a page that never
  // unmounts.
  useEffect(() => {
    void loadActivity(card.id);
  }, [card.id, loadActivity]);

  const members = view?.members ?? [];
  const labels = view?.labels ?? [];
  const columns = view?.columns ?? [];
  // NOTE: Only for this card. The store keys the feed by card id so the
  // previous card's history is not drawn under a new one while its read is in
  // flight.
  const events = activity?.cardId === card.id ? activity.events : [];
  // How many of the newest entries are drawn. Reset per card for the same
  // reason the read is: the page outlives the card under it.
  const [shown, setShown] = useState(RECENT);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new card
  useEffect(() => setShown(RECENT), [card.id]);
  // NOTE: The feed is oldest first and its cursor pages forward in time, so
  // the newest entries are on the last page. Every page is read before
  // slicing: three rows off the end of page one would be three rows from the
  // middle. A failed page leaves the cursor where it was; remembering which
  // one was asked for keeps that from turning into a request loop.
  const tried = useRef<string | null>(null);
  const loaded = activity?.cardId === card.id;
  useEffect(() => {
    if (!loaded || !cursor || loading || tried.current === cursor) return;
    tried.current = cursor;
    void loadActivity(card.id, true);
  }, [loaded, cursor, loading, card.id, loadActivity]);
  // Counted in rows a reader sees: a `commented` audit row or an unknown verb
  // draws nothing, and slicing before dropping them would show fewer than
  // three.
  const rows = events.filter(
    (event) =>
      event.kind === "comment" ||
      sentence(event, columns, labels, members) !== null,
  );
  const visible = rows.slice(-shown);
  const hidden = rows.length - visible.length;
  const subscribers = card.subscribers ?? [];

  return (
    <section className="flex flex-col gap-3 pt-2">
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-medium">Activity</h2>
        <div className="ml-auto flex items-center gap-2">
          {/* `subscribed === null` means a list read, which never reaches
              this page. It is still not `false`, so no button is drawn rather
              than one inviting a click that would do the opposite. */}
          {canSubscribe && card.subscribed !== null && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 text-xs"
              onClick={() => void setSubscribed(card.id, !card.subscribed)}
            >
              {card.subscribed ? "Unsubscribe" : "Subscribe"}
            </Button>
          )}
          {canSubscribe && subscribers.length > 0 && (
            <span className="flex items-center">
              {subscribers.slice(0, 3).map((userId) => (
                <Avatar
                  key={userId}
                  member={memberOf(members, userId)}
                  name={userId}
                  size="sm"
                  className="ring-background -mr-1 ring-2 last:mr-0"
                />
              ))}
              {subscribers.length > 3 && (
                <span className="text-muted-foreground ml-2 text-xs tabular-nums">
                  +{subscribers.length - 3}
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {hidden > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground self-start text-xs"
          onClick={() => setShown((n) => n + MORE)}
        >
          Show {Math.min(hidden, MORE)} more
        </Button>
      )}

      <ul className="flex flex-col gap-2.5">
        {visible.map((event) =>
          event.kind === "comment" ? (
            <CommentEntry
              key={event.id}
              event={event}
              card={card}
              members={members}
            />
          ) : (
            <AuditEntry
              key={event.id}
              event={event}
              columns={columns}
              labels={labels}
              members={members}
            />
          ),
        )}
      </ul>

      {comments && <Composer card={card} />}
    </section>
  );
}
